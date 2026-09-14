// 轻量运行时健康计数，供 /api/health 暴露
const rpcErrTimes = [];
const wsLastLog = new Map(); // chain -> ts
let seenTotal = 0;
let promotedTotal = 0;
let swapPoolsCount = 0;
let tradesWritten = 0;
const tradeWriteTimes = [];
const nativeUsdState = {}; // chain -> { price, live }  (live=false 表示 BSC 池不可用、退回 fallback 常量，需可见)

export function recordRpcError() {
  rpcErrTimes.push(Date.now());
  if (rpcErrTimes.length > 1000) rpcErrTimes.shift();
}
export function recordWsLog(chain) {
  wsLastLog.set(chain, Date.now());
}
export function recordSeen() { seenTotal++; }
export function recordPromoted() { promotedTotal++; }
export function setSwapPools(n) { swapPoolsCount = n; }
// 原生资产美元价来源可见性：live=false 表示 refreshNativeUsd 未拿到真实池价、退回 nativeUsdFallback。
export function setNativeUsd(chain, price, live) { nativeUsdState[chain] = { price, live: Boolean(live) }; }
export function recordTradeWrite() {
  tradesWritten++;
  tradeWriteTimes.push(Date.now());
  if (tradeWriteTimes.length > 2000) tradeWriteTimes.shift();
}

export function healthSnapshot() {
  const now = Date.now();
  const rpcErrors5m = rpcErrTimes.filter((t) => now - t < 5 * 60_000).length;
  const tradesPerMin = tradeWriteTimes.filter((t) => now - t < 60_000).length;
  const ws = {};
  for (const [c, ts] of wsLastLog) ws[c] = { lastLogAgoSec: Math.round((now - ts) / 1000) };
  return { rpcErrors5m, ws, seenTotal, promotedTotal, swapPools: swapPoolsCount, tradesWritten, tradesPerMin, nativeUsd: nativeUsdState };
}
