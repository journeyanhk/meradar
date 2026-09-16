// priceOf 价格来源抽象（M3-1 / M3-1b）—— 纯函数，无 RPC/无 DB，便于单测冻结真值表。
//
// 目标：三链、四池型(curve/v2/v3/v4)、任意报价币，都给出「带来源与新鲜度」的美元价，
// 且满足三条护栏（4FOUR / 币安镇长两次「归零」的教训）：
//  · 读失败(池读不到 / extsload=0 / 未定价) → 保上一次成功的价，按更新时刻判 stale，绝不写 0；
//  · 读成功但报价腿枯竭(drained) → 真归零：priceUsd=0 + state='withdrawn'(流动性已撤)，这是真实 rug 信号；
//  · 陈旧超上限(>24h) → state='unknown'，前端价格显示「未知」、深度显示「—」，纸面引擎按无价处理。
//
// M3-1b 两处语义修正：
//  · 新鲜度按「最后成交/最后成功读」的时刻算(updatedAt)，不再一律 now——死掉的曲线币也会 stale/unknown；
//  · v4 集中池「当前 tick 无活跃流动性」(noActiveLiquidity) ≠ 撤池：保旧价，不真归零。

export const PRICE_STALE_MS = 10 * 60_000;       // 距上次成功更新 >10min → stale(卡片灰标)
export const PRICE_UNKNOWN_MS = 24 * 3600_000;   // >24h 未更新 → 价格「未知」

// —— 合理性钳位（$MUMO 教训）——
// 报价币是代币化股票(MU/TSLA…)且无美元价来源时，某条历史路径曾把 quoteUsd 填成 10^17 量级常量/残留值，
// 导致市值 $1.7e20、深度 $1.8e18 这类离谱数字，并经 keepOld/peak 被保留。加一道单位错误通用护栏：
// 价格>$1e6、市值>$10 亿、或深度>市值×100(两腿被不同倍数放大) → 判 implausible，数值归零、不入 prev/peak。
export const IMPLAUSIBLE_PRICE_USD = 1e6;
export const IMPLAUSIBLE_MCAP_USD = 1e9;
export function isImplausibleUsd({ priceUsd = 0, marketCapUsd = 0, depthUsd = 0 } = {}) {
  if (priceUsd > IMPLAUSIBLE_PRICE_USD) return true;
  if (marketCapUsd > IMPLAUSIBLE_MCAP_USD) return true;
  if (marketCapUsd > 0 && depthUsd > marketCapUsd * 100) return true;
  return false;
}

// pool_type(v2/v3/v4) → priceOf 来源名。
export function sourceOf(poolType) {
  if (poolType === 'v4') return 'amm-v4';
  if (poolType === 'v3') return 'amm-v3';
  return 'amm-v2';
}

// 距上次成功更新的时长 → 新鲜度状态。at 缺失(从未成功)按 Infinity → unknown。
function stateFromAge(now, at) {
  const age = at ? now - at : Infinity;
  return age > PRICE_UNKNOWN_MS ? 'unknown' : (age > PRICE_STALE_MS ? 'stale' : 'ok');
}

/**
 * 综合本轮读数与上轮持久值，产出最终价格状态。纯函数、不发 RPC。
 * @param opts.hasPool  是否已毕业/接上 AMM 池(cand.pool 存在)
 * @param opts.poolType 'v2'|'v3'|'v4'
 * @param opts.poolM    本轮 readPoolMetrics 结果({priceUsd,liquidityUsd,marketCapUsd,priced,drained,noActiveLiquidity,updatedAt})；读失败为 null
 * @param opts.curve    本轮曲线指标({priceUsd,fundsUsd,marketCapUsd,updatedAt})；无为 null。updatedAt=最后成交时刻
 * @param opts.prev     上一轮候选行(price_usd/market_cap_usd/depth_usd/price_source/price_updated_at)
 * @returns {{ priceUsd:number, depthUsd:number, marketCapUsd:number, source:string|null,
 *            updatedAt:number|null, stale:boolean, state:'ok'|'stale'|'unknown'|'withdrawn' }}
 *          数值字段恒为 number(不返回 null，保护下游数学与 peak MAX)；unknown 时保旧值但 state 标出。
 */
export function resolvePrice({ now = Date.now(), hasPool, poolType, poolM, curve, prev } = {}) {
  const r = resolvePriceInner({ now, hasPool, poolType, poolM, curve, prev });
  // 写库前最后一道：单位错误/污染残留一律归零，绝不让离谱数字进卡片、prev 或 peak。
  if (r.state !== 'implausible' && isImplausibleUsd(r)) {
    return { priceUsd: 0, depthUsd: 0, marketCapUsd: 0, source: r.source, updatedAt: now, stale: false, state: 'implausible' };
  }
  return r;
}

function resolvePriceInner({ now = Date.now(), hasPool, poolType, poolM, curve, prev } = {}) {
  const prevPrice = prev?.price_usd || 0;
  const prevMcap = prev?.market_cap_usd || 0;
  const prevDepth = prev?.depth_usd || 0;
  const prevSource = prev?.price_source || null;
  const prevAt = prev?.price_updated_at || 0;

  const keepOld = () => {
    const state = stateFromAge(now, prevAt);
    return {
      priceUsd: prevPrice, depthUsd: prevDepth, marketCapUsd: prevMcap,
      source: prevSource, updatedAt: prevAt || null,
      stale: state !== 'ok', state,
    };
  };

  if (hasPool) {
    const source = sourceOf(poolType);
    // 读成功但报价腿抽干 → 真归零(rug)，比保旧价有用。
    if (poolM && poolM.drained) {
      return { priceUsd: 0, depthUsd: 0, marketCapUsd: 0, source, updatedAt: now, stale: false, state: 'withdrawn' };
    }
    // 未激活/单边池：当前 tick 无活跃流动性但初始价(sqrtPrice)有效 → 用它定「起点市值」，深度归 0(单边/未开盘)。
    // ≠ 撤池(资金没被抽，只是还没人买进区间)。有初始价即 state='ok'、市值=价×供应；无价才保旧。
    // 这解决 Arc 单边发射池全 $0：卡片显示起点市值，深度 $0 标「未开盘」，真有人买入后随 Swap 更新。
    if (poolM && poolM.noActiveLiquidity) {
      if (poolM.priced && poolM.priceUsd > 0) {
        const at = poolM.updatedAt || now;
        const state = stateFromAge(now, at);
        return {
          priceUsd: poolM.priceUsd, depthUsd: 0, marketCapUsd: poolM.marketCapUsd || 0,
          source, updatedAt: at, stale: state !== 'ok', state,
        };
      }
      return keepOld();
    }
    // 读成功且有价 → 主源。updatedAt 取事件/读取时刻(事件驱动为成交时间)，据此判新鲜度。
    if (poolM && poolM.priced && poolM.priceUsd > 0) {
      const at = poolM.updatedAt || now;
      const state = stateFromAge(now, at);
      return {
        priceUsd: poolM.priceUsd, depthUsd: poolM.liquidityUsd || 0, marketCapUsd: poolM.marketCapUsd || 0,
        source, updatedAt: at, stale: state !== 'ok', state,
      };
    }
    // 读失败(null) / 未定价(priced=false) → 保旧价。
    return keepOld();
  }

  // 曲线期：曲线有价即主源，否则保旧价。updatedAt=最后成交时刻，死币会随时间转 stale/unknown。
  if (curve && curve.priceUsd > 0) {
    const at = curve.updatedAt || now;
    const state = stateFromAge(now, at);
    return {
      priceUsd: curve.priceUsd, depthUsd: curve.fundsUsd || 0, marketCapUsd: curve.marketCapUsd || 0,
      source: 'curve', updatedAt: at, stale: state !== 'ok', state,
    };
  }
  return keepOld();
}
