// priceOf 价格来源抽象（M3-1）—— 纯函数，无 RPC/无 DB，便于单测冻结真值表。
//
// 目标：三链、四池型(curve/v2/v3/v4)、任意报价币，都给出「带来源与新鲜度」的美元价，
// 且满足三条护栏（4FOUR / 币安镇长两次「归零」的教训）：
//  · 读失败(池读不到 / extsload=0 / 未定价) → 保上一次成功的价，按 price_updated_at 判 stale，绝不写 0；
//  · 读成功但报价腿枯竭(drained) → 真归零：priceUsd=0 + state='withdrawn'(流动性已撤)，这是真实 rug 信号；
//  · 陈旧超上限(>24h) → state='unknown'，前端价格显示「未知」、深度显示「—」，纸面引擎按无价处理。

export const PRICE_STALE_MS = 10 * 60_000;       // 距上次成功更新 >10min → stale(卡片灰标)
export const PRICE_UNKNOWN_MS = 24 * 3600_000;   // >24h 未更新 → 价格「未知」

// pool_type(v2/v3/v4) → priceOf 来源名。
export function sourceOf(poolType) {
  if (poolType === 'v4') return 'amm-v4';
  if (poolType === 'v3') return 'amm-v3';
  return 'amm-v2';
}

/**
 * 综合本轮读数与上轮持久值，产出最终价格状态。纯函数、不发 RPC。
 * @param opts.hasPool  是否已毕业/接上 AMM 池(cand.pool 存在)
 * @param opts.poolType 'v2'|'v3'|'v4'
 * @param opts.poolM    本轮 readPoolMetrics 结果({priceUsd,liquidityUsd,marketCapUsd,priced,drained})；读失败为 null
 * @param opts.curve    本轮曲线指标({priceUsd,fundsUsd,marketCapUsd})；无为 null
 * @param opts.prev     上一轮候选行(price_usd/market_cap_usd/depth_usd/price_source/price_updated_at)
 * @returns {{ priceUsd:number, depthUsd:number, marketCapUsd:number, source:string|null,
 *            updatedAt:number|null, stale:boolean, state:'ok'|'stale'|'unknown'|'withdrawn' }}
 *          数值字段恒为 number(不返回 null，保护下游数学与 peak MAX)；unknown 时保旧值但 state 标出。
 */
export function resolvePrice({ now = Date.now(), hasPool, poolType, poolM, curve, prev } = {}) {
  const prevPrice = prev?.price_usd || 0;
  const prevMcap = prev?.market_cap_usd || 0;
  const prevDepth = prev?.depth_usd || 0;
  const prevSource = prev?.price_source || null;
  const prevAt = prev?.price_updated_at || 0;

  const keepOld = () => {
    const age = prevAt ? now - prevAt : Infinity;
    const state = age > PRICE_UNKNOWN_MS ? 'unknown' : (age > PRICE_STALE_MS ? 'stale' : 'ok');
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
    // 读成功且有价 → 主源。
    if (poolM && poolM.priced && poolM.priceUsd > 0) {
      return {
        priceUsd: poolM.priceUsd, depthUsd: poolM.liquidityUsd || 0, marketCapUsd: poolM.marketCapUsd || 0,
        source, updatedAt: now, stale: false, state: 'ok',
      };
    }
    // 读失败(null) / 未定价(priced=false) → 保旧价。
    return keepOld();
  }

  // 曲线期：曲线有价即主源，否则保旧价。
  if (curve && curve.priceUsd > 0) {
    return {
      priceUsd: curve.priceUsd, depthUsd: curve.fundsUsd || 0, marketCapUsd: curve.marketCapUsd || 0,
      source: 'curve', updatedAt: now, stale: false, state: 'ok',
    };
  }
  return keepOld();
}
