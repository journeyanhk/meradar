import { getAddress, formatUnits, keccak256, encodeAbiParameters, hexToBigInt, toHex } from 'viem';
import { httpClient } from './chain.js';
import { erc20Abi, pairAbi, v3PoolAbi, tokenManagerAbi, poolManagerV4Abi } from './abi.js';
import { chainConfig } from './config.js';
import { recordRpcError } from './health.js';
import { child } from './logger.js';
// 动态报价币定价（Four.meme 允许任意代币计价，config 覆盖不到时回落到这里）。
// 循环依赖安全：quotePrice.js 也 import 本文件的 getBnbUsd，但两侧都只在函数体内用，模块加载期不触发。
import { lookupDynamicQuote, dynamicQuoteUsd, learnQuote } from './quotePrice.js';
import { getPoolState } from './poolstate.js';

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
  if (sym === 'USDT' || sym === 'USDC' || sym === 'USDC_NATIVE' || sym === 'BUSD' || sym === 'USD1' || sym === 'USDG') return 1;
  if (sym === 'WBNB') return bnbUsdCache.get(chain) || (chain === 'bsc' ? cfg.wbnbUsdPriceFallback || 900 : null);
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
  const cached = bnbUsdCache.get(chain);
  if (cached) return cached;
  // 常量回落只对 BSC 有意义（WBNB 是 BSC 原生计价币）。其它链没有真实来源时返回 0，
  // 让上层按「无可信价格」处理，而不是套一个 BSC 的数字（见 $MUMO 教训）。
  return chain === 'bsc' ? cfg.wbnbUsdPriceFallback || 900 : 0;
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

// v4 池是否「全区间」。⚠️ 已不再用于撤池判定 —— 「tickSpacing≥200 = 全区间」这条从 Pons 带来的假设在 Arc
// 单边发射池上必然误判(见 readPoolMetrics)，撤池现改用「曾有流动性(max_liquidity_seen)」证据。此函数保留供
// 后续深度公式按真实区间(ModifyLiquidity 的 tickLower/tickUpper)判定的重构复用；纯函数、单测冻结。
export function isFullRangePool(cfg, hooks, tickSpacing) {
  const hookLc = (hooks || '').toLowerCase();
  if (hookLc && !/^0x0+$/.test(hookLc)) {
    for (const lp of cfg?.launchpads || []) {
      if ((lp.hook || '').toLowerCase() === hookLc) return true;
    }
  }
  return Number(tickSpacing || 0) >= 200;
}

// v4 报价币与方向真源(纯函数)：以 v4_pools 的 currency0/currency1(Initialize/PoolRegistered 的链上事实)判定，
// 不依赖 candidates.quote_symbol(易被多条路径写坏 → 报价币错标 → memeIsCurrency0 翻转 → 价格倒数 → 触发钳位整批归零)。
//   memeIsCurrency0 = (currency0 === token)；报价币地址 = 另一侧；符号/小数位经 resolveQuote(地址) → 静态/动态表。
// token 不在两腿里(数据不一致) 或 currency 缺失 → 返回 null，调用方回退 quote_symbol 老路径。
export function resolveV4Quote(cfg, token, currency0, currency1) {
  if (!token || !currency0 || !currency1) return null;
  const tk = token.toLowerCase();
  const c0 = String(currency0).toLowerCase();
  const c1 = String(currency1).toLowerCase();
  let memeIsCurrency0, quoteAddr;
  if (c0 === tk) { memeIsCurrency0 = true; quoteAddr = c1; }
  else if (c1 === tk) { memeIsCurrency0 = false; quoteAddr = c0; }
  else return null; // token 不在池子两腿里 → 映射不一致，不猜
  const q = resolveQuote(cfg, quoteAddr); // 未识别报价币 → null(调用方 priced=false，绝不瞎猜方向)
  return { q, quoteAddr, memeIsCurrency0 };
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
export async function readPoolMetrics(chain, { pool, poolType, token, quote, decimals, totalSupply, tickSpacing = null, hooks = null, maxLiquiditySeen = 0n, currency0 = null, currency1 = null }) {
  if (!pool) return null;
  const cfg = chainConfig(chain);
  const client = httpClient(chain);
  const memeDec = decimals || 18;
  const supply = totalSupply ? Number(formatUnits(totalSupply, memeDec)) : 0;

  try {
    if (poolType === 'v4') {
      // 报价币与方向以 v4_pools.currency0/1 为真源；缺失或未识别才回退 quote_symbol(老行)。
      const v4q = resolveV4Quote(cfg, token, currency0, currency1);
      let qv, memeIsCurrency0;
      if (v4q && v4q.q) { qv = v4q.q; memeIsCurrency0 = v4q.memeIsCurrency0; }
      else {
        // 回退：无 currency 或报价币未识别 → 用 quote_symbol。仍拿不到方向真源时用地址序推(与历史一致)。
        qv = quote ? resolveQuote(cfg, quote) : null;
        if (!qv) { log.debug({ chain, pool, quote, currency0, currency1 }, 'v4 报价币无法解析(currency 与 quote_symbol 均缺) → 跳过定价'); return null; }
        // currency 已知但报价币未识别 → 方向仍按 currency 真源，避免地址序猜错(见 $MUMO 倒数教训)。
        memeIsCurrency0 = v4q ? v4q.memeIsCurrency0 : token.toLowerCase() < qv.address.toLowerCase();
      }
      const quoteUsdV4 = quoteUsdPrice(chain, cfg, qv.sym);
      const pricedV4 = quoteUsdV4 != null;
      // 事件驱动：优先用最近一笔 Swap 写入的池状态(零 RPC)；无新鲜状态才 extsload 直读。
      const cached = getPoolState(chain, pool);
      const st = cached || await readV4PoolState(chain, cfg.poolManagerV4, pool);
      if (!st) return null;
      const m = computeV4Metrics({
        sqrtPriceX96: st.sqrtPriceX96, liquidity: st.liquidity, memeIsCurrency0,
        memeDec, quoteDec: qv.decimals, quoteUsd: quoteUsdV4, supplyHuman: supply,
      });
      // v4 的 liquidity 是「当前 tick 活跃流动性」。撤池判定改用「曾有流动性」证据(从有到无 = 真 rug)，
      // 不再靠「tickSpacing≥200 = 全区间」这条从 Pons 带来的假设 —— 该假设在 Arc 单边发射池上必然误判：
      // 代币全挂在当前价之上、USDC 侧为 0，第一笔买入前当前 tick liquidity=0 是设计如此，不是被抽干。
      //   drained          = 现在为 0 且曾有过流动性(max_liquidity_seen>0) → 真撤池
      //   noActiveLiquidity = 现在为 0 且从未激活(单边挂单/未开盘) → 用初始 sqrtPrice 定价、深度记 0，不归零
      const empty = st.liquidity === 0n;
      const hadLiquidity = (maxLiquiditySeen ?? 0n) > 0n || st.liquidity > 0n;
      return {
        ...m, quoteSymbol: qv.sym, priced: pricedV4,
        drained: empty && hadLiquidity,
        noActiveLiquidity: empty && !hadLiquidity,
        observedLiquidity: st.liquidity,
        updatedAt: cached ? st.ts : Date.now(), source: cached ? 'event' : 'rpc',
      };
    }

    // V2/V3：报价币仍取 quote_symbol(这两类由 PairCreated 事件带 token0/token1，quote_symbol 可靠)。
    if (!quote) return null;
    const q = resolveQuote(cfg, quote);
    if (!q) { log.debug({ quote }, '无法解析报价币，跳过池子定价'); return null; }
    const quoteUsd = quoteUsdPrice(chain, cfg, q.sym);
    const priced = quoteUsd != null;

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
