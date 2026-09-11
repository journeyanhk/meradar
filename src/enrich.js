import { getAddress, formatUnits } from 'viem';
import { httpClient } from './chain.js';
import { erc20Abi, pairAbi, v3PoolAbi, tokenManagerAbi } from './abi.js';
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

// 读取 Four.meme Token Manager 的 _tokenInfos，解析每个代币的曲线报价币/毕业阈值/募集额。
// tokens: string[]（代币地址）。返回 Map(tokenLower -> { quoteSym, quoteAddr, quoteDecimals,
//   maxRaisingRaw:bigint, launchTimeMs:number|null, fundsRaw:bigint, lastPriceRaw:bigint })。
// 未识别的报价币 quoteSym='UNKNOWN'（调用方据此不定价、不落库，卡片标黄）。读取失败的代币不入 Map。
export async function readTokenInfos(chain, tokenManager, tokens) {
  if (!tokenManager || !tokens?.length) return new Map();
  const cfg = chainConfig(chain);
  const client = httpClient(chain);
  const out = new Map();
  try {
    const res = await client.multicall({
      allowFailure: true,
      contracts: tokens.map((t) => ({ address: tokenManager, abi: tokenManagerAbi, functionName: '_tokenInfos', args: [t] })),
    });
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r?.status !== 'success' || !r.result) continue;
      const info = r.result; // [base, quote, template, totalSupply, maxOffers, maxRaising, launchTime, offers, funds, lastPrice, K, T, status]
      const quoteAddr = info[1];
      const q = resolveQuote(cfg, quoteAddr);
      const launchSec = Number(info[6] || 0n);
      out.set(tokens[i].toLowerCase(), {
        quoteSym: q?.sym ?? 'UNKNOWN',
        quoteAddr: q?.address ?? quoteAddr,
        quoteDecimals: q?.decimals ?? 18,
        maxRaisingRaw: info[5] ?? 0n,
        launchTimeMs: launchSec > 0 ? launchSec * 1000 : null,
        fundsRaw: info[8] ?? 0n,
        lastPriceRaw: info[9] ?? 0n,
      });
    }
  } catch (e) {
    recordRpcError();
    log.warn({ chain, err: e.message }, 'readTokenInfos 失败');
  }
  return out;
}

// 单个代币的便捷封装（promote 时用），解析不到返回 null。
export async function readTokenInfo(chain, tokenManager, token) {
  const m = await readTokenInfos(chain, tokenManager, [token]);
  return m.get(token.toLowerCase()) || null;
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

// 统一解析报价币：既能吃符号(WBNB)也能吃地址(0xbb4c…)，历史库里两种都出现过。
// 特例：Four.meme 的 BNB 曲线报价币是零地址(0x0)，映射到 WBNB(价格=BNB 现价，18 位)。
// 返回 { sym, address, decimals }，解析不了返回 null（未知报价币，调用方应跳过定价）。
export function resolveQuote(cfg, symOrAddr) {
  if (!symOrAddr) return null;
  const s = String(symOrAddr).toLowerCase();
  if (/^0x0+$/.test(s)) {
    const w = cfg.quoteTokens.WBNB;
    return w ? { sym: 'WBNB', address: w.address, decimals: w.decimals } : null;
  }
  for (const [sym, q] of Object.entries(cfg.quoteTokens)) {
    if (sym === symOrAddr || q.address.toLowerCase() === s) {
      return { sym, address: q.address, decimals: q.decimals };
    }
  }
  return null;
}

function quoteUsdPrice(chain, cfg, sym) {
  if (sym === 'USDT' || sym === 'USDC' || sym === 'BUSD' || sym === 'USD1') return 1;
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
  const q = resolveQuote(cfg, quote);
  if (!q) { log.debug({ quote }, '无法解析报价币，跳过池子定价'); return null; }
  const client = httpClient(chain);
  const quoteUsd = quoteUsdPrice(chain, cfg, q.sym);
  const memeDec = decimals || 18;
  const supply = totalSupply ? Number(formatUnits(totalSupply, memeDec)) : 0;

  try {
    if (poolType === 'v3') {
      const [slot0, token0, qBal, tBal] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: pool, abi: v3PoolAbi, functionName: 'slot0' },
          { address: pool, abi: v3PoolAbi, functionName: 'token0' },
          { address: q.address, abi: erc20Abi, functionName: 'balanceOf', args: [pool] },
          { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pool] },
        ],
      });
      const sqrtP = slot0[0];
      const quoteIsT0 = token0.toLowerCase() === q.address.toLowerCase();
      const dec0 = quoteIsT0 ? q.decimals : memeDec;
      const dec1 = quoteIsT0 ? memeDec : q.decimals;
      const ratio = Number(sqrtP) / 2 ** 96;
      const pRaw = ratio * ratio; // token1/token0 (raw)
      const human1per0 = pRaw * 10 ** (dec0 - dec1); // token1 per token0 (human)
      // 价格 = quote per meme
      const priceInQuote = quoteIsT0 ? 1 / human1per0 : human1per0;
      const priceUsd = priceInQuote * quoteUsd;
      const quoteBalHuman = Number(formatUnits(qBal, q.decimals));
      const liquidityUsd = quoteBalHuman * quoteUsd * 2;
      return { liquidityUsd, priceUsd, marketCapUsd: supply * priceUsd, quoteSymbol: q.sym };
    }

    // V2
    const [reserves, token0] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: pool, abi: pairAbi, functionName: 'getReserves' },
        { address: pool, abi: pairAbi, functionName: 'token0' },
      ],
    });
    const quoteIsT0 = token0.toLowerCase() === q.address.toLowerCase();
    const quoteReserve = Number(formatUnits(quoteIsT0 ? reserves[0] : reserves[1], q.decimals));
    const tokenReserve = Number(formatUnits(quoteIsT0 ? reserves[1] : reserves[0], memeDec));
    const liquidityUsd = quoteReserve * quoteUsd * 2;
    const priceUsd = tokenReserve > 0 ? (quoteReserve * quoteUsd) / tokenReserve : 0;
    return { liquidityUsd, priceUsd, marketCapUsd: supply * priceUsd, quoteSymbol: q.sym };
  } catch (e) {
    recordRpcError();
    log.warn({ err: e.message, pool, poolType }, '读取池子指标失败');
    return null;
  }
}
