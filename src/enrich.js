import { getAddress, formatUnits, keccak256, encodeAbiParameters, hexToBigInt, toHex } from 'viem';
import { httpClient } from './chain.js';
import { erc20Abi, pairAbi, v3PoolAbi, tokenManagerAbi, poolManagerV4Abi } from './abi.js';
import { chainConfig } from './config.js';
import { recordRpcError } from './health.js';
import { child } from './logger.js';
// 动态报价币定价（Four.meme 允许任意代币计价，config 覆盖不到时回落到这里）。
// 循环依赖安全：quotePrice.js 也 import 本文件的 getBnbUsd，但两侧都只在函数体内用，模块加载期不触发。
import { lookupDynamicQuote, dynamicQuoteUsd, learnQuote } from './quotePrice.js';

const log = child('enrich');
const bnbUsdCache = new Map(); // chain -> price
const nativeUsdCache = new Map(); // chain -> 原生资产美元价(Robinhood ETH 等)；M1 空→用 cfg.nativeUsdFallback，M3 接真实池

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
      let q = resolveQuote(cfg, quoteAddr);
      // 未知报价币（config 覆盖不到，如 SPCXB 股票代币）：读链上 symbol/decimals 登记 + 定价一次，再解析。
      // 登记后 resolveQuote 下次即命中，quoteSym 落真实符号而非 'UNKNOWN'（4FOUR 归零修复核心）。
      if (!q && quoteAddr && !/^0x0+$/.test(String(quoteAddr))) {
        const learned = await learnQuote(chain, quoteAddr).catch(() => null);
        if (learned) q = { sym: learned.sym, address: learned.address, decimals: learned.decimals, dynamic: true };
      }
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
    // 原生资产计价：优先取 config 里标 native 且地址为 0x0 的报价币(Robinhood 的 ETH)；
    // 否则回落 WBNB(BSC 的 Four.meme BNB 曲线用 0x0 表示 BNB，映射到 WBNB 定价，18 位)。
    const nativeEntry = Object.entries(cfg.quoteTokens).find(([, q]) => q.native && /^0x0+$/.test(q.address));
    if (nativeEntry) return { sym: nativeEntry[0], address: nativeEntry[1].address, decimals: nativeEntry[1].decimals };
    const w = cfg.quoteTokens.WBNB;
    return w ? { sym: 'WBNB', address: w.address, decimals: w.decimals } : null;
  }
  for (const [sym, q] of Object.entries(cfg.quoteTokens)) {
    if (sym === symOrAddr || q.address.toLowerCase() === s) {
      return { sym, address: q.address, decimals: q.decimals };
    }
  }
  // config 未命中 → 回落动态报价币注册表（Four.meme 允许任意代币计价，如 SPCXB 股票代币）。
  // 尚未登记时返回 null（首次遇到，promote 时会 learnQuote 登记，下次即命中）。
  return lookupDynamicQuote(cfg.chainId, symOrAddr);
}

function quoteUsdPrice(chain, cfg, sym) {
  if (sym === 'USDT' || sym === 'USDC' || sym === 'BUSD' || sym === 'USD1' || sym === 'USDG') return 1;
  if (sym === 'WBNB') return bnbUsdCache.get(chain) || cfg.wbnbUsdPriceFallback || 900;
  // Robinhood 原生 ETH 计价：M1 用 fallback 常量(nativeUsdFallback)，M3 接真实 ETH/USD 池刷新缓存。
  if (sym === 'ETH') return nativeUsdCache.get(chain) || cfg.nativeUsdFallback || 4500;
  // 动态报价币（SPCXB 等）：查缓存美元价；不可信/未定价 → null，调用方按「无可信价格」处理，不再瞎套 fallback。
  return dynamicQuoteUsd(cfg.chainId, sym);
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

// 原生资产(Robinhood 的 ETH)美元价：复用 BSC Pancake ETH/USDT 池(与 refreshBnbUsd 同源同模式，
// 只读、零成本)。Robinhood 链上暂无可信 ETH/USD 池，M2b 的 v4 定价同样要乘 ETH 价，故必须实时取真实价，
// 不能写死 4500(实盘 ~2500，写死会让所有美元数字高估 ~80%)。每 60s 刷新，缓存空才回落 nativeUsdFallback。
// 自动探测 token0，与池子内 token 顺序无关；结果做区间夹逼(200~20000)防脏读。
export async function refreshNativeUsd(chain) {
  const cfg = chainConfig(chain);
  const src = cfg.nativeUsdPool;
  if (!src?.pool || !src.chain) return;
  try {
    const client = httpClient(src.chain);
    const [reserves, token0] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: src.pool, abi: pairAbi, functionName: 'getReserves' },
        { address: src.pool, abi: pairAbi, functionName: 'token0' },
      ],
    });
    const usdtIsT0 = token0.toLowerCase() === String(src.usdt).toLowerCase();
    const usdtRaw = usdtIsT0 ? reserves[0] : reserves[1];
    const baseRaw = usdtIsT0 ? reserves[1] : reserves[0];
    if (baseRaw > 0n) {
      const price = Number(formatUnits(usdtRaw, src.usdtDecimals ?? 18)) / Number(formatUnits(baseRaw, src.baseDecimals ?? 18));
      if (price > 200 && price < 20000) nativeUsdCache.set(chain, price);
    }
  } catch (e) {
    log.debug({ chain, err: e.message }, 'refreshNativeUsd 失败(用 fallback)');
  }
}

export function getNativeUsd(chain) {
  const cfg = chainConfig(chain);
  return nativeUsdCache.get(chain) || cfg.nativeUsdFallback || null;
}

export function hasLiveNativeUsd(chain) {
  return nativeUsdCache.has(chain);
}

// Pons(curve-per-token) 曲线募集额：原生 ETH 计价读 curve 的 ETH 余额；ERC-20 计价读 balanceOf。
// 实测：原生曲线 curve 余额 == 累计(quoteIn−quoteOut)，是权威且自愈的募集额来源（毕业后归零）。
// 返回 { fundsRaw:bigint, fundsQuote:number(人类可读报价币) }；失败返回 null。
export async function readCurveFunds(chain, curve, quoteAddr, quoteDec = 18) {
  if (!curve) return null;
  const client = httpClient(chain);
  try {
    let raw;
    if (!quoteAddr || /^0x0+$/.test(String(quoteAddr))) {
      raw = await client.getBalance({ address: curve });
    } else {
      raw = await client.readContract({ address: quoteAddr, abi: erc20Abi, functionName: 'balanceOf', args: [curve] });
    }
    return { fundsRaw: raw, fundsQuote: Number(formatUnits(raw, quoteDec)) };
  } catch (e) {
    recordRpcError();
    log.debug({ chain, curve, err: e.message }, 'readCurveFunds 失败');
    return null;
  }
}

// 报价币 -> 美元单价（供成交额换算），稳定币=1，WBNB=现价。
export function quoteUsd(chain, sym) {
  const cfg = chainConfig(chain);
  return quoteUsdPrice(chain, cfg, sym);
}

// Uniswap v4 池状态直读（无独立池合约）：extsload 读 PoolManager 内部存储。
// POOLS_SLOT=6；base=keccak256(abi.encode(poolId, uint256(6)))；slot0@base 打包 sqrtPriceX96(低160位)|tick，
// liquidity@base+3(低128位)。布局已链上核验(读出 liquidity 与 Swap 事件完全一致)。失败返回 null。
async function readV4PoolState(chain, poolManager, poolId) {
  if (!poolManager || /^0x0+$/.test(poolManager) || !poolId) return null;
  const client = httpClient(chain);
  const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
  const liqSlot = toHex(hexToBigInt(base) + 3n, { size: 32 });
  try {
    const [slot0Raw, liqRaw] = await client.multicall({
      allowFailure: false,
      contracts: [
        { address: poolManager, abi: poolManagerV4Abi, functionName: 'extsload', args: [base] },
        { address: poolManager, abi: poolManagerV4Abi, functionName: 'extsload', args: [liqSlot] },
      ],
    });
    const slot0 = hexToBigInt(slot0Raw);
    const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
    const liquidity = hexToBigInt(liqRaw) & ((1n << 128n) - 1n);
    if (sqrtPriceX96 === 0n) return null;
    return { sqrtPriceX96, liquidity };
  } catch (e) {
    recordRpcError();
    log.debug({ chain, poolId, err: e.message }, 'readV4PoolState 失败');
    return null;
  }
}

// v4 定价/深度纯函数(无 RPC，供单测冻结断言)。sqrtPriceX96/liquidity 为 bigint。
// price：(sqrtP/2^96)²=currency1/currency0(raw) → ×10^(dec0−dec1) 得 human → 取 quote-per-meme → ×quoteUsd。
// depth：全区间(Pons)虚拟储备 currency0=L/sqrtP、currency1=L·sqrtP；报价腿×2。
//   ⚠️ 集中流动性(非全区间)池会高估深度(虚拟储备>实际储备)；Pons 毕业池为全区间时准确。
export function computeV4Metrics({ sqrtPriceX96, liquidity, memeIsCurrency0, memeDec = 18, quoteDec = 18, quoteUsd, supplyHuman = 0 }) {
  const priced = quoteUsd != null;
  const quoteIsCurrency0 = !memeIsCurrency0;
  const dec0 = quoteIsCurrency0 ? quoteDec : memeDec;
  const dec1 = quoteIsCurrency0 ? memeDec : quoteDec;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const pRaw = sqrtP * sqrtP;                        // currency1/currency0 (raw)
  const human1per0 = pRaw * 10 ** (dec0 - dec1);     // currency1 per currency0 (human)
  const priceInQuote = quoteIsCurrency0 ? 1 / human1per0 : human1per0; // quote per meme
  const priceUsd = (priceInQuote > 0 && priced) ? priceInQuote * quoteUsd : 0;
  const L = Number(liquidity);
  const quoteVirtualRaw = quoteIsCurrency0 ? L / sqrtP : L * sqrtP;
  const quoteHuman = quoteVirtualRaw / 10 ** quoteDec;
  const liquidityUsd = priced ? quoteHuman * quoteUsd * 2 : 0;
  return { liquidityUsd, priceUsd, marketCapUsd: (supplyHuman || 0) * priceUsd };
}

// 读池子 -> 流动性/价格/市值。支持 V2(getReserves)、V3(slot0)、v4(extsload)。
// v4：pool 传 poolId(bytes32)、poolType='v4'；池地址=cfg.poolManagerV4。currency 排序由地址推导(原生 0x0 恒为 currency0)。
export async function readPoolMetrics(chain, { pool, poolType, token, quote, decimals, totalSupply }) {
  if (!pool || !quote) return null;
  const cfg = chainConfig(chain);
  const q = resolveQuote(cfg, quote);
  if (!q) { log.debug({ quote }, '无法解析报价币，跳过池子定价'); return null; }
  const client = httpClient(chain);
  const quoteUsd = quoteUsdPrice(chain, cfg, q.sym);
  const priced = quoteUsd != null;
  const memeDec = decimals || 18;
  const supply = totalSupply ? Number(formatUnits(totalSupply, memeDec)) : 0;

  try {
    if (poolType === 'v4') {
      const st = await readV4PoolState(chain, cfg.poolManagerV4, pool);
      if (!st) return null;
      // v4 currency 按地址升序；原生 ETH(0x0) 恒为最小 → currency0。故 meme 是否 currency0 = memeAddr < quoteAddr。
      const memeIsCurrency0 = token.toLowerCase() < q.address.toLowerCase();
      const m = computeV4Metrics({
        sqrtPriceX96: st.sqrtPriceX96, liquidity: st.liquidity, memeIsCurrency0,
        memeDec, quoteDec: q.decimals, quoteUsd, supplyHuman: supply,
      });
      return { ...m, quoteSymbol: q.sym, priced, drained: st.liquidity === 0n };
    }

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
      return { liquidityUsd, priceUsd, marketCapUsd: supply * priceUsd, quoteSymbol: q.sym, priced, drained: quoteBalHuman === 0 };
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
    return { liquidityUsd, priceUsd, marketCapUsd: supply * priceUsd, quoteSymbol: q.sym, priced, drained: quoteReserve === 0 };
  } catch (e) {
    recordRpcError();
    log.warn({ err: e.message, pool, poolType }, '读取池子指标失败');
    return null;
  }
}
