// 事件驱动池状态缓存（M3-1b）——治 Robinhood(chainId 4663) HTTP RPC 的 429。
//
// v4 Swap 事件自带 sqrtPriceX96 + liquidity + tick，每笔成交即把池状态写内存；
// readPoolMetrics 在其新鲜(<FRESH_MS)时直接据此算价/深度，跳过 extsload RPC。
// 目标：活跃毕业币在有成交时对 PoolManager 的读数为 0。
//
// 作用域：目前仅 v4(Pons 毕业池，全区间 → 事件推价/深度均准)。v3(集中池)深度需按头寸区间还原，
// 且其 RPC 非 429 高发，故 v3/v2 仍走权威 RPC，v3 事件定价留待 M3-4(Arc)。

export const POOL_STATE_FRESH_MS = 60_000; // 距最后一笔成交 <60s 视为新鲜，可跳过 RPC

const state = new Map(); // `${chain}:${poolIdLower}` -> { sqrtPriceX96:bigint, liquidity:bigint, tick, ts }

// 记录一笔 Swap 后的池状态。sqrtPriceX96/liquidity 为 bigint；缺字段则忽略(不覆盖旧值)。
export function recordPoolState(chain, pool, { sqrtPriceX96, liquidity, tick = null, ts = Date.now() } = {}) {
  if (!pool || sqrtPriceX96 == null || liquidity == null) return;
  state.set(`${chain}:${String(pool).toLowerCase()}`, { sqrtPriceX96, liquidity, tick, ts });
}

// 取新鲜的池状态；无记录或已陈旧(>maxAgeMs)返回 null → 调用方回退 RPC。
export function getPoolState(chain, pool, maxAgeMs = POOL_STATE_FRESH_MS) {
  const s = state.get(`${chain}:${String(pool).toLowerCase()}`);
  if (!s) return null;
  if (Date.now() - s.ts > maxAgeMs) return null;
  return s;
}

// 归档池时清理，控内存。
export function forgetPoolState(chain, pool) {
  state.delete(`${chain}:${String(pool).toLowerCase()}`);
}

export function poolStateSize() { return state.size; }
