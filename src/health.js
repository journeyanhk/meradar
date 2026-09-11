// 轻量运行时健康计数，供 /api/health 暴露
const rpcErrTimes = [];
const wsLastLog = new Map(); // chain -> ts
let seenTotal = 0;
let promotedTotal = 0;

export function recordRpcError() {
  rpcErrTimes.push(Date.now());
  if (rpcErrTimes.length > 1000) rpcErrTimes.shift();
}
export function recordWsLog(chain) {
  wsLastLog.set(chain, Date.now());
}
export function recordSeen() { seenTotal++; }
export function recordPromoted() { promotedTotal++; }

export function healthSnapshot() {
  const now = Date.now();
  const rpcErrors5m = rpcErrTimes.filter((t) => now - t < 5 * 60_000).length;
  const ws = {};
  for (const [c, ts] of wsLastLog) ws[c] = { lastLogAgoSec: Math.round((now - ts) / 1000) };
  return { rpcErrors5m, ws, seenTotal, promotedTotal };
}
