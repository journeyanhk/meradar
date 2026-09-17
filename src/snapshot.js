// snapshots 写放大治理：决定本轮是否真正为某候选落一行 snapshots。
// 纯函数、无副作用，供 track.js 调用与单测冻结边界。设计与 paper.js 的 mark 去重同构：
//   · 事件即时(event=true)：tier 变化 / entry 状态变化 / 撤池 / 归档 → 立即落行(不受任何间隔约束)
//   · 首行(无 last.ts)：落行
//   · 最小间隔：T1+ 60s、T0 120s(T0 是活跃基数大头，趋势图用不着更密)
//   · 有变化(|Δprice|≥1% 或 |Δdepth|≥2% 或 买家数变化) → 落行
//   · 无变化：仅到心跳(T1+ 5min、T0 15min)才补一行，保证冻结币曲线连续但稀疏
// 阈值可经 config.snapshots 覆盖；默认值即方案拍板值。
const DEFAULTS = {
  minIntervalSec: 60,       // T1+ 最小落行间隔
  minIntervalT0Sec: 120,    // T0 最小落行间隔
  dedupPricePct: 1,         // 价格变动阈值(%)
  dedupDepthPct: 2,         // 深度变动阈值(%)
  heartbeatSec: 300,        // T1+ 心跳(无变化也落行)
  heartbeatT0Sec: 900,      // T0 心跳
};

const isHot = (tier) => tier === 'T1' || tier === 'T2' || tier === 'T3';
const relDelta = (cur, prev) => {
  if (!(prev > 0)) return cur > 0 ? Infinity : 0; // 上次为 0/空、这次有值 → 视为大变化
  return Math.abs(cur - prev) / prev;
};

// opts: { tier, now, last:{ts,price,depth}, price, depth, buyers, prevBuyers, event, cfg }
export function shouldWriteSnapshot(opts) {
  const { tier, now, last, price, depth, buyers, prevBuyers, event } = opts;
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  if (event) return true;                       // 事件即时，绕过一切间隔
  if (!last || !last.ts) return true;           // 首行
  const since = now - last.ts;
  const minMs = (isHot(tier) ? cfg.minIntervalSec : cfg.minIntervalT0Sec) * 1000;
  if (since < minMs) return false;              // 未到最小间隔
  const changed =
    relDelta(price, last.price) >= cfg.dedupPricePct / 100 ||
    relDelta(depth, last.depth) >= cfg.dedupDepthPct / 100 ||
    (buyers | 0) !== (prevBuyers | 0);
  if (changed) return true;
  const heartbeatMs = (isHot(tier) ? cfg.heartbeatSec : cfg.heartbeatT0Sec) * 1000;
  return since >= heartbeatMs;                  // 无变化：仅到心跳才补行
}
