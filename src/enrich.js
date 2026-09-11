import { getAddress, formatUnits } from 'viem';
import { httpClient } from './chain.js';
import { erc20Abi, pairAbi } from './abi.js';
import { chainConfig } from './config.js';
import { child } from './logger.js';

const log = child('enrich');

// 校验是否为合法 ERC20，并返回元数据。非 ERC20 返回 null（用于过滤 raw-log 噪声）。
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
    return null; // 不是标准 ERC20
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

// 读取池子储备 -> 流动性(USD) 与 价格(USD)。需要 pool 与 quote 已知。
export async function readPoolMetrics(chain, { pool, token, quote, decimals, totalSupply }) {
  if (!pool || !quote) return null;
  const cfg = chainConfig(chain);
  const client = httpClient(chain);
  try {
    const [reserves, token0] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: pool, abi: pairAbi, functionName: 'getReserves' },
        { address: pool, abi: pairAbi, functionName: 'token0' },
      ],
    });
    const [r0, r1] = reserves;
    const quoteIsToken0 = token0.toLowerCase() === quote.toLowerCase();
    const quoteReserveRaw = quoteIsToken0 ? r0 : r1;
    const tokenReserveRaw = quoteIsToken0 ? r1 : r0;

    const quoteSym = symbolOfQuote(cfg, quote);
    const quoteUsd = quoteUsdPrice(cfg, quoteSym);
    const quoteReserve = Number(formatUnits(quoteReserveRaw, 18)); // BSC 报价币多为 18 位
    const tokenReserve = Number(formatUnits(tokenReserveRaw, decimals || 18));

    const liquidityUsd = quoteReserve * quoteUsd * 2; // 双边估算
    const priceUsd = tokenReserve > 0 ? (quoteReserve * quoteUsd) / tokenReserve : 0;
    const supply = totalSupply ? Number(formatUnits(totalSupply, decimals || 18)) : 0;
    const marketCapUsd = supply * priceUsd;

    return { liquidityUsd, priceUsd, marketCapUsd, quoteSymbol: quoteSym };
  } catch (e) {
    log.debug({ err: e.message, pool }, '读取池子储备失败');
    return null;
  }
}

function symbolOfQuote(cfg, quote) {
  for (const [sym, addr] of Object.entries(cfg.quoteTokens)) {
    if (addr.toLowerCase() === quote.toLowerCase()) return sym;
  }
  return 'QUOTE';
}

function quoteUsdPrice(cfg, sym) {
  if (sym === 'USDT' || sym === 'USDC' || sym === 'BUSD') return 1;
  if (sym === 'WBNB') return cfg.wbnbUsdPriceFallback || 900;
  if (sym === 'USDC' && cfg.nativeSymbol === 'USDC') return 1;
  return cfg.wbnbUsdPriceFallback || 1;
}
