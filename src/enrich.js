import { getAddress, formatUnits } from 'viem';
import { httpClient } from './chain.js';
import { erc20Abi, pairAbi, v3PoolAbi } from './abi.js';
import { chainConfig } from './config.js';
import { recordRpcError } from './health.js';
import { child } from './logger.js';

const log = child('enrich');
const bnbUsdCache = new Map(); // chain -> price

export async function readToken(chain, address) {
  const client = httpClient(chain);
  const base = { address, abi: erc20Abi };
  try {
    const [name, symbol, decimals, totalSupply] = await client.multicall({
      allowFailure: false,
      contracts: [
        { ...base, functionName: 'name' },
        { ...base, functionName: 'symbol' },
        { ...base, functionName: 'decimals' },
        { ...base, functionName: 'totalSupply' },
      ],
    });
    if (!symbol || decimals > 36) return null;
    return { name: String(name).slice(0, 80), symbol: String(symbol).slice(0, 32), decimals: Number(decimals), totalSupply };
  } catch {
    return null;
  }
}

export async function readCreator(chain, tx) {
  if (!tx) return null;
  try {
    const t = await httpClient(chain).getTransaction({ hash: tx });
    return t?.from ? getAddress(t.from) : null;
  } catch {
    return null;
  }
}

function quoteInfo(cfg, quoteAddr) {
  for (const [sym, q] of Object.entries(cfg.quoteTokens)) {
    if (q.address.toLowerCase() === quoteAddr.toLowerCase()) return { sym, decimals: q.decimals };
  }
  return { sym: 'QUOTE', decimals: 18 };
}

function quoteUsdPrice(chain, cfg, sym) {
  if (sym === 'USDT' || sym === 'USDC' || sym === 'BUSD') return 1;
  if (sym === 'WBNB') return bnbUsdCache.get(chain) || cfg.wbnbUsdPriceFallback || 900;
  return cfg.wbnbUsdPriceFallback || 1;
}

// 每 60s 读一次 Pancake WBNB/USDT 池，得到 BNB 现价（只读、零成本）
export async function refreshBnbUsd(chain) {
  const cfg = chainConfig(chain);
  if (!cfg.bnbUsdPool) return;
  try {
    const client = httpClient(chain);
    const [reserves, token0] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: cfg.bnbUsdPool, abi: pairAbi, functionName: 'getReserves' },
        { address: cfg.bnbUsdPool, abi: pairAbi, functionName: 'token0' },
      ],
    });
    const usdt = cfg.quoteTokens.USDT?.address?.toLowerCase();
    const usdtIsT0 = token0.toLowerCase() === usdt;
    const usdtRaw = usdtIsT0 ? reserves[0] : reserves[1];
    const wbnbRaw = usdtIsT0 ? reserves[1] : reserves[0];
    if (wbnbRaw > 0n) {
      const price = Number(usdtRaw) / Number(wbnbRaw);
      if (price > 50 && price < 5000) bnbUsdCache.set(chain, price);
    }
  } catch (e) {
    log.debug({ err: e.message }, 'refreshBnbUsd 失败(用 fallback)');
  }
}

export function getBnbUsd(chain) {
  const cfg = chainConfig(chain);
  return bnbUsdCache.get(chain) || cfg.wbnbUsdPriceFallback || 900;
}

// 报价币 -> 美元单价（供成交额换算），稳定币=1，WBNB=现价。
export function quoteUsd(chain, sym) {
  const cfg = chainConfig(chain);
  return quoteUsdPrice(chain, cfg, sym);
}

// 读池子 -> 流动性/价格/市值。支持 V2(getReserves) 与 V3(slot0)。
export async function readPoolMetrics(chain, { pool, poolType, token, quote, decimals, totalSupply }) {
  if (!pool || !quote) return null;
  const cfg = chainConfig(chain);
  const client = httpClient(chain);
  const qi = quoteInfo(cfg, quote);
  const quoteUsd = quoteUsdPrice(chain, cfg, qi.sym);
  const memeDec = decimals || 18;
  const supply = totalSupply ? Number(formatUnits(totalSupply, memeDec)) : 0;

  try {
    if (poolType === 'v3') {
      const [slot0, token0, qBal, tBal] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: pool, abi: v3PoolAbi, functionName: 'slot0' },
          { address: pool, abi: v3PoolAbi, functionName: 'token0' },
          { address: quote, abi: erc20Abi, functionName: 'balanceOf', args: [pool] },
          { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pool] },
        ],
      });
      const sqrtP = slot0[0];
      const quoteIsT0 = token0.toLowerCase() === quote.toLowerCase();
      const dec0 = quoteIsT0 ? qi.decimals : memeDec;
      const dec1 = quoteIsT0 ? memeDec : qi.decimals;
      const ratio = Number(sqrtP) / 2 ** 96;
      const pRaw = ratio * ratio; // token1/token0 (raw)
      const human1per0 = pRaw * 10 ** (dec0 - dec1); // token1 per token0 (human)
      // 价格 = quote per meme
      const priceInQuote = quoteIsT0 ? 1 / human1per0 : human1per0;
      const priceUsd = priceInQuote * quoteUsd;
      const quoteBalHuman = Number(formatUnits(qBal, qi.decimals));
      const liquidityUsd = quoteBalHuman * quoteUsd * 2;
      return { liquidityUsd, priceUsd, marketCapUsd: supply * priceUsd, quoteSymbol: qi.sym };
    }

    // V2
    const [reserves, token0] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: pool, abi: pairAbi, functionName: 'getReserves' },
        { address: pool, abi: pairAbi, functionName: 'token0' },
      ],
    });
    const quoteIsT0 = token0.toLowerCase() === quote.toLowerCase();
    const quoteReserve = Number(formatUnits(quoteIsT0 ? reserves[0] : reserves[1], qi.decimals));
    const tokenReserve = Number(formatUnits(quoteIsT0 ? reserves[1] : reserves[0], memeDec));
    const liquidityUsd = quoteReserve * quoteUsd * 2;
    const priceUsd = tokenReserve > 0 ? (quoteReserve * quoteUsd) / tokenReserve : 0;
    return { liquidityUsd, priceUsd, marketCapUsd: supply * priceUsd, quoteSymbol: qi.sym };
  } catch (e) {
    recordRpcError();
    log.warn({ err: e.message, pool, poolType }, '读取池子指标失败');
    return null;
  }
}
