// 轻量运行时健康计数，供 /api/health 暴露
const rpcErrTimes = [];
const wsLastLog = new Map(); // chain -> ts
let seenTotal = 0;
let promotedTotal = 0;
let swapPoolsCount = 0;
let tradesWritten = 0;
const tradeWriteTimes = [];
const txFetchTimes = []; // v4 getTransaction(取 tx.from) 时刻，供 getTransactionPerMin 观测(Arc 全量订阅)
const nativeUsdState = {}; // chain -> { price, live }  (live=false 表示 BSC 池不可用、退回 fallback 常量，需可见)
// 每条订阅的健康画像(方案0-3/0-4)：键 `chain:label` → { chain, label, lastEventAt, errors, rebuilds }。
// 看门狗按 lastEventAt 判定静默、errors/rebuilds 反映抖动，/api/health 按链聚合暴露。
const subscriptions = new Map();
function subEntry(chain, label) {
  const k = `${chain}:${label}`;
  let e = subscriptions.get(k);
  if (!e) { e = { chain, label, lastEventAt: 0, errors: 0, rebuilds: 0 }; subscriptions.set(k, e); }
  return e;
}
export function recordSubEvent(chain, label) { subEntry(chain, label).lastEventAt = Date.now(); }
export function recordSubError(chain, label) { subEntry(chain, label).errors++; }
export function recordSubRebuild(chain, label) { subEntry(chain, label).rebuilds++; }

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
// v4 归一化每拉一次 getTransaction 记一笔，供观测 Arc 全量订阅下的 RPC 压力(阈值 ~600/min 触发降级评估)。
export function recordTxFetch() {
  txFetchTimes.push(Date.now());
  if (txFetchTimes.length > 5000) txFetchTimes.shift();
}

export function healthSnapshot() {
  const now = Date.now();
  const rpcErrors5m = rpcErrTimes.filter((t) => now - t < 5 * 60_000).length;
  const tradesPerMin = tradeWriteTimes.filter((t) => now - t < 60_000).length;
  const getTransactionPerMin = txFetchTimes.filter((t) => now - t < 60_000).length;
  const ws = {};
  for (const [c, ts] of wsLastLog) ws[c] = { lastLogAgoSec: Math.round((now - ts) / 1000) };
  // 按链聚合每条订阅画像(方案0-4)：三链结构一致，缺 wsLastLog 的链(尚无日志)也补出 ws[chain]。
  for (const e of subscriptions.values()) {
    const bucket = (ws[e.chain] ||= {});
    (bucket.subscriptions ||= {})[e.label] = {
      lastEventAt: e.lastEventAt || null,
      lastEventAgoSec: e.lastEventAt ? Math.round((now - e.lastEventAt) / 1000) : null,
      errors: e.errors,
      rebuilds: e.rebuilds,
    };
  }
  return { rpcErrors5m, ws, seenTotal, promotedTotal, swapPools: swapPoolsCount, tradesWritten, tradesPerMin, getTransactionPerMin, nativeUsd: nativeUsdState };
}
