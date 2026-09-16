// 事件级去重（内存聚合门控的第一道）：
// watchWithReconnect 的退避重建 + viem WS transport 在 socket 层的自动重连/重放，极端情况下会让
// 同一条链上日志被投递两次 → momentum(放量/净流入/买卖比/买家时间序) 与 trades 双计。
// 键 = chain:txHash:logIndex（同一 tx 内多条 Swap 有不同 logIndex，天然区分，不会误杀）；插入序 LRU。
//
// 为什么不用「先 INSERT、changes==1 再更新内存」：seen 币只喂 momentum、不写 trades（两段式准入/曲线期），
// DB 幂等键覆盖不到它们的内存聚合。故在 onTrade/onSwap 入口做事件去重（覆盖 seen+active），
// DB 侧 INSERT OR IGNORE 作持久兜底（回填重叠/重启重放）。两道互补。
//
// 纯工厂：调用方各自持有一个实例，便于单测（构造独立实例、断言二次命中）。
export function makeEventDeduper(max = 50000) {
  const seen = new Set();
  return function isDup(chain, txHash, logIndex) {
    if (!txHash || logIndex == null) return false; // 无事件键(不该发生) → 不拦截，交给 DB UNIQUE 兜底
    const k = `${chain}:${String(txHash).toLowerCase()}:${logIndex}`;
    if (seen.has(k)) return true;
    seen.add(k);
    if (seen.size > max) seen.delete(seen.keys().next().value); // 淘汰最旧插入
    return false;
  };
}
