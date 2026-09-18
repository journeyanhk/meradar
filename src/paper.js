// M4 纸面引擎（只读模拟）——在信号点用名义 $100 模拟买入、追踪 horizon 内回报，评估各分组信号质量。
// 四组(非互斥)：baseline_seen(所有活跃候选=对照)/tier_t1/tier_t2/entry_pass。每组每币至多一仓(UNIQUE key,grp)。
// 不持有自己的 RPC：开仓价取该轮 metrics.priceUsd，后续 mark 优先用实时 metrics(轮询中)，否则用候选行 price_usd
// (归档后冻结=诚实标记)。往返成本开仓时固化，每次 mark 的 pnl 都是「此刻退出」的净值(已扣往返)。
import { config } from './config.js';
import { store } from './db.js';
import { child } from './logger.js';
import { createHash } from 'node:crypto';

const log = child('paper');
const cfg = config.paper || {};
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
const HOUR = 3600_000;
// 序C：用户仓分组(手动模拟/实盘/关注)。这些仓由用户经 API/Telegram 建立，不由自动分组开仓，
// 也不受 24h horizon 自动平仓约束——只在撤池或用户手动平仓时关闭。
const USER_GROUPS = new Set(['manual', 'real', 'watch']);

// 序B 报表预设：分时桶(分钟) + 三套退出规则(供回放对比)。可被 config.paper.timeBucketsMin/rules 覆盖。
const BUCKETS_MIN = cfg.timeBucketsMin ?? [5, 15, 60, 240, 1440];
const RULES = cfg.rules ?? [
  { name: 'tp50/sl30/追踪25', tp: 50, sl: 30, trail: 25, maxHoldMin: null },
  { name: 'tp100/sl50', tp: 100, sl: 50, trail: null, maxHoldMin: null },
  { name: '追踪30/持有4h', tp: null, sl: null, trail: 30, maxHoldMin: 240 },
];

// —— 纯函数(可单测) ——

// baseline 抽样：对照组只取全体的 1/oneIn(默认 20%)，把标记量降一个量级。
// 按 key 的 sha256 前 4 字节取模 → 确定性(同一币恒进恒不进，样本内无选择偏差)、跨重启稳定。
export function inBaselineSample(key, oneIn = cfg.baselineSampleOneIn ?? 5) {
  if (!key) return false;
  if (oneIn <= 1) return true;
  const h = createHash('sha256').update(String(key)).digest();
  return h.readUInt32BE(0) % oneIn === 0;
}

// 往返成本(%)：基础成本 + 2×池费率。费率未知(null)→仅基础成本；费率≥上限→返回 null(信号:不开仓 skip)。
// D4 锚点：费率未知=2%(base 2)；Arc 1% 池=4%(2 + 2×1)；≥10% 费率池不开仓。
export function roundtripCostPct(poolFeePct, c = cfg) {
  const base = c.baseCostPct ?? 2;
  if (poolFeePct == null) return base;
  if (poolFeePct >= (c.maxPoolFeePct ?? 10)) return null; // ≥上限 → skip
  return base + 2 * poolFeePct;
}

// 开仓门槛：价格状态 ok、深度≥下限、当前价位有流动性、价格>0。任一不满足 → 延期重试(deferred)。
export function openGate(metrics, c = cfg) {
  return metrics.priceState === 'ok'
    && (metrics.depthUsd || 0) >= (c.minDepthUsd ?? 500)
    && !metrics.noActiveLiquidity
    && (metrics.priceUsd || 0) > 0;
}

// 单次标记盈亏：gross=名义×(mark/entry)；net=gross×(1−往返成本%)；pnl=net−名义。往返成本已内含「若此刻退出」。
export function markPnl(entryPrice, markPrice, notionalUsd, rtCostPct) {
  const gross = notionalUsd * (markPrice / entryPrice);
  const net = gross * (1 - (rtCostPct || 0) / 100);
  const pnlUsd = net - notionalUsd;
  const pnlPct = (pnlUsd / notionalUsd) * 100;
  return { grossUsd: gross, netUsd: net, pnlUsd, pnlPct };
}

// 该候选本轮所属分组(非互斥)。baseline_seen 恒含(对照组=所有被轮询的活跃候选)。
// tier_t1/tier_t2 用「首次到达该档」语义：tier_t1 仅当前恰为 T1(入场即 T1)，tier_t2 为 T2+。
// 若首次观察即 T2，则只开 tier_t2——否则同一批币在两组同价各开一仓(实测 T1≈T2)，对比无意义。
export function groupsFor(row, metrics) {
  const g = ['baseline_seen'];
  const rank = RANK[row.tier] ?? 0;
  if (rank === 1) g.push('tier_t1');
  if (rank >= 2) g.push('tier_t2');
  if (metrics.entry?.ok) g.push('entry_pass');
  return g;
}

// —— 序B 报表纯函数(可单测)：不等平仓，用轨迹出实时结论 ——

// 分时收益：给定该仓 marks(ts 升序，marks[0]=开仓 t0) + open_ts，取每个桶「≤该桶时刻的最后一个 mark」
// 的 pnl_pct(已扣往返=此刻退出净收益)。未平仓且仓龄不足该桶 → null(不计入，避免用当前值冒充未来)。
export function bucketReturns(marks, openTs, ageMs, isClosed, bucketsMin) {
  const pts = marks || [];
  const out = {};
  for (const b of bucketsMin) {
    const cutoffMs = b * 60000;
    if (!isClosed && cutoffMs > ageMs) { out[b] = null; continue; }
    let val = null;
    for (const m of pts) { if (m.ts - openTs <= cutoffMs) val = m.pnl_pct; else break; }
    out[b] = val;
  }
  return out;
}

// 退出规则回放：按 marks(ts 升序) 模拟一套 {tp,sl,trail,maxHoldMin}(百分比/分钟，null=不启用)。
// 每 mark 检查序：止损 → 追踪回撤 → 止盈 → 最长持有；都不触发则持有到最后一个 mark(reason='end')。
// 退出收益取触发 mark 的 pnl_pct(已扣往返)。maePct=持有期内相对入场价的最深回撤(%)。价格判定用 price_usd/entry。
// 单步规则判定(纯函数、就地更新 state.peak/state.mae)：给定累积状态与一条 mark，
// 返回退出决策 {exitPnlPct,exitReason,maePct,holdMin} 或 null(继续持有)。
// 实时监控(序C)与批量回放共用此函数，保证「触发线」两套口径完全一致。
// state = { entry, openTs, peak, mae }；rule = {tp,sl,trail,maxHoldMin}(百分比/分钟，null=不启用)。
export function evalRuleStep(state, m, rule = {}) {
  const { tp = null, sl = null, trail = null, maxHoldMin = null } = rule;
  const done = (reason) => ({ exitPnlPct: m.pnl_pct, exitReason: reason, maePct: state.mae, holdMin: (m.ts - state.openTs) / 60000 });
  // 撤池：先于所有规则，抽干即 −100% 退出(rug)。price=0 的平仓标记语义是 −100%，绝不回退。
  if (m.price_state === 'withdrawn' || !(m.price_usd > 0)) return done('rug');
  const p = m.price_usd;
  const ret = (p / state.entry - 1) * 100;
  if (ret < state.mae) state.mae = ret;
  if (p > state.peak) state.peak = p;
  if (sl != null && ret <= -sl) return done('sl');
  if (trail != null && state.peak > state.entry && (p / state.peak - 1) * 100 <= -trail) return done('trail');
  if (tp != null && ret >= tp) return done('tp');
  if (maxHoldMin != null && (m.ts - state.openTs) / 60000 >= maxHoldMin) return done('maxHold');
  return null;
}

export function replayRule(marks, rule = {}) {
  // 撤池平仓标记 price=0 但语义是 −100%，必须保留(否则 rug 仓被当成末个正价 end 结束，规则统计系统性偏乐观)。
  const pts = (marks || []).filter((m) => m.price_usd > 0 || m.price_state === 'withdrawn');
  if (!pts.length) return null;
  const state = { entry: pts[0].price_usd, openTs: pts[0].ts, peak: pts[0].price_usd, mae: 0 };
  for (const m of pts) {
    const exit = evalRuleStep(state, m, rule);
    if (exit) return exit;
  }
  const last = pts[pts.length - 1];
  return { exitPnlPct: last.pnl_pct, exitReason: 'end', maePct: state.mae, holdMin: (last.ts - state.openTs) / 60000 };
}

// 未平仓现值统计(纯聚合)：现值收益中位、MFE 中位、1.5×/2× 命中率、当前自峰回撤>50% 占比。
// 用仓位上已存的 entry/peak/last，无需回扫 marks。
export function openPositionStats(rows) {
  const r = rows.filter((x) => x.entry_price_usd > 0);
  const cur = r.filter((x) => x.last_price_usd != null).map((x) => (x.last_price_usd / x.entry_price_usd - 1) * 100);
  const mfe = r.filter((x) => x.peak_price_usd != null).map((x) => (x.peak_price_usd / x.entry_price_usd - 1) * 100);
  const n = r.length;
  const hit = (mult) => r.filter((x) => x.peak_price_usd != null && x.peak_price_usd / x.entry_price_usd >= mult).length;
  const dd50 = r.filter((x) => x.peak_price_usd > 0 && x.last_price_usd != null && (x.last_price_usd / x.peak_price_usd - 1) <= -0.5).length;
  return {
    openCount: rows.length,
    medianCurPct: cur.length ? median(cur) : null,
    medianMfePct: mfe.length ? median(mfe) : null,
    hit15xRate: n ? hit(1.5) / n : null,
    hit2xRate: n ? hit(2) / n : null,
    dd50Rate: n ? dd50 / n : null,
  };
}

// —— 编排(有副作用) ——
function tryOpen(chain, row, metrics, grp, now) {
  const rt = roundtripCostPct(metrics.poolFeePct, cfg);
  if (rt == null || !openGate(metrics, cfg)) {
    // 费率≥上限(实测几乎全是 Pons 发射期反狙击费 79%–100%，会随成交衰减) 或 门槛未过 → 延期重试，
    // 不再终态 skip。到期(deferMinutes)仍不可开 → sweep 置 deferred_expired。tryReopenDeferred 用复评时费率。
    store.paperInsertPosition({
      key: row.key, chain, grp, status: 'deferred', signal_ts: now,
      notional_usd: cfg.notionalUsd ?? 100,
      defer_until_ts: now + (cfg.deferMinutes ?? 30) * 60_000,
    });
    return;
  }
  const price = metrics.priceUsd;
  const opened = store.paperInsertPosition({
    key: row.key, chain, grp, status: 'open', signal_ts: now, open_ts: now,
    entry_price_usd: price, entry_mcap_usd: metrics.marketCapUsd ?? null,
    notional_usd: cfg.notionalUsd ?? 100, roundtrip_cost_pct: rt,
    horizon_end_ts: now + (cfg.horizonHours ?? 24) * HOUR,
    peak_price_usd: price, trough_price_usd: price,
    last_price_usd: price, last_mcap_usd: metrics.marketCapUsd ?? null, last_mark_ts: now,
  });
  if (opened) {
    // 开仓即打 t0 标记(pnl≈-往返成本)。开仓门槛已保证 price_state==='ok'。
    const { pnlUsd, pnlPct } = markPnl(price, price, cfg.notionalUsd ?? 100, rt);
    const pos = store.paperPosition(row.key, grp);
    if (pos) store.paperAddMark({ position_id: pos.id, ts: now, price_usd: price, mcap_usd: metrics.marketCapUsd ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct, price_state: 'ok' });
  }
}

function tryReopenDeferred(pos, metrics, now) {
  const rt = roundtripCostPct(metrics.poolFeePct, cfg);
  if (rt == null) return;              // 费率仍≥上限(反狙击费未衰减) → 继续等，sweep 到期置 deferred_expired
  if (!openGate(metrics, cfg)) return; // 仍不可开 → 继续等
  const price = metrics.priceUsd;
  const ok = store.paperOpenDeferred(pos.id, {
    open_ts: now, entry_price_usd: price, entry_mcap_usd: metrics.marketCapUsd ?? null,
    roundtrip_cost_pct: rt, horizon_end_ts: now + (cfg.horizonHours ?? 24) * HOUR,
    peak_price_usd: price, trough_price_usd: price,
    last_price_usd: price, last_mcap_usd: metrics.marketCapUsd ?? null, last_mark_ts: now,
  });
  if (ok) {
    const { pnlUsd, pnlPct } = markPnl(price, price, pos.notional_usd ?? cfg.notionalUsd ?? 100, rt);
    store.paperAddMark({ position_id: pos.id, ts: now, price_usd: price, mcap_usd: metrics.marketCapUsd ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct, price_state: 'ok' });
  }
}

// 记录一次标记。price 无效则跳过。
// 降量级：min 间隔内不落行；价格变动<markDedupPct% 且距上次落行<markDedupWindowSec 秒也不落行——
// 两种情况都仍更新仓位上的 peak/trough/last(轨迹不丢)，只是不写 marks 明细行(归档冻结价的仓位几乎不再写)。
// last_mark_ts 记「上次落行时刻」：持续跳过 → 到 markDedupWindowSec 后自动补一行心跳，曲线不至于全空。
function recordMark(pos, price, mcap, now, state) {
  if (!(price > 0)) return;
  const peak = Math.max(pos.peak_price_usd ?? price, price);
  const trough = Math.min(pos.trough_price_usd ?? price, price);
  const sinceRow = pos.last_mark_ts ? now - pos.last_mark_ts : Infinity;
  const updatePeakOnly = () => store.paperUpdatePeak(pos.id, { last_price_usd: price, last_mcap_usd: mcap ?? null, peak_price_usd: peak, trough_price_usd: trough });
  if (sinceRow < (cfg.markMinIntervalSec ?? 60) * 1000) { updatePeakOnly(); return; }
  const smallMove = pos.last_price_usd > 0 && Math.abs(price / pos.last_price_usd - 1) < (cfg.markDedupPct ?? 1) / 100;
  if (smallMove && sinceRow < (cfg.markDedupWindowSec ?? 300) * 1000) { updatePeakOnly(); return; }
  const { pnlUsd, pnlPct } = markPnl(pos.entry_price_usd, price, pos.notional_usd, pos.roundtrip_cost_pct);
  store.paperUpdateMark(pos.id, { last_price_usd: price, last_mcap_usd: mcap ?? null, last_mark_ts: now, peak_price_usd: peak, trough_price_usd: trough });
  store.paperAddMark({ position_id: pos.id, ts: now, price_usd: price, mcap_usd: mcap ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct, price_state: state ?? null });
}

// 平仓(不受最小间隔约束)。
// 撤池(reason==='withdrawn')：价归零就是 −100%，绝不回退到 rug 前价格(否则归零被记成不亏，是纸面引擎最不能有的偏差)。
// 其它原因(horizon)遇到暂时无价 → 用最后已知价平仓，避免瞬时读价失败误判归零。
function recordClose(pos, price, mcap, now, reason, state) {
  let p = price;
  if (!(p > 0) && reason !== 'withdrawn') p = pos.last_price_usd || pos.entry_price_usd;
  if (!(p >= 0)) p = 0;
  const { pnlUsd, pnlPct } = markPnl(pos.entry_price_usd, p, pos.notional_usd, pos.roundtrip_cost_pct);
  const peak = Math.max(pos.peak_price_usd ?? p, p);
  const trough = Math.min(pos.trough_price_usd ?? p, p);
  const ok = store.paperClose(pos.id, {
    close_ts: now, close_price_usd: p, close_mcap_usd: mcap ?? null, close_reason: reason,
    pnl_usd: pnlUsd, pnl_pct: pnlPct, peak_price_usd: peak, trough_price_usd: trough,
  });
  if (ok) store.paperAddMark({ position_id: pos.id, ts: now, price_usd: p, mcap_usd: mcap ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct, price_state: state ?? reason });
}

// 轮询钩子：track.pollCandidate 在 maybeAlert 之后调用。用本轮实时 metrics 开新仓、重试延期仓、即时标记/平仓已有仓。
export function onPoll(chain, row, metrics) {
  if (cfg.enabled === false) return;
  try {
    const now = metrics?.now || Date.now();
    const state = metrics?.priceState ?? null;
    const rugged = state === 'withdrawn';
    const groups = new Set(groupsFor(row, metrics));
    const existing = store.paperPositionsForKey(row.key);
    const have = new Set();
    for (const pos of existing) {
      have.add(pos.grp);
      if (pos.status === 'open') {
        if (rugged) recordClose(pos, 0, 0, now, 'withdrawn', state); // 撤池立即记 −100%
        else if (!USER_GROUPS.has(pos.grp) && now >= pos.horizon_end_ts) recordClose(pos, metrics.priceUsd, metrics.marketCapUsd, now, 'horizon', state);
        else recordMark(pos, metrics.priceUsd, metrics.marketCapUsd, now, state); // 事件即时标记(用户仓不受 horizon 约束)
      } else if (pos.status === 'deferred') {
        if (now >= pos.defer_until_ts) store.paperExpireDeferred(pos.id, now);
        else if (groups.has(pos.grp)) tryReopenDeferred(pos, metrics, now);
      }
    }
    for (const grp of groups) {
      if (have.has(grp)) continue;
      // baseline 对照组只取哈希抽样子集(降标记量级)；其它组(tier/entry)全量开仓。
      if (grp === 'baseline_seen' && !inBaselineSample(row.key)) continue;
      tryOpen(chain, row, metrics, grp, now);
    }
  } catch (e) {
    log.debug({ err: e.message, key: row?.key }, 'paper.onPoll 失败(忽略)');
  }
}

// 60s 扫描：覆盖已停止轮询(归档)的持仓——用候选行冻结价标记/平仓；处理延期到期。
function sweep() {
  const now = Date.now();
  for (const pos of store.paperActivePositions()) {
    try {
      if (pos.status === 'deferred') {
        if (now >= pos.defer_until_ts) store.paperExpireDeferred(pos.id, now);
        continue;
      }
      const cand = store.get(pos.key);
      const state = cand?.price_state ?? null;
      const price = cand?.price_usd ?? 0;
      const mcap = cand?.market_cap_usd ?? null;
      if (state === 'withdrawn') recordClose(pos, 0, 0, now, 'withdrawn', state); // 撤池立即记 −100%
      else if (!USER_GROUPS.has(pos.grp) && now >= pos.horizon_end_ts) recordClose(pos, price, mcap, now, 'horizon', state);
      else recordMark(pos, price, mcap, now, state);
    } catch (e) {
      log.debug({ err: e.message, id: pos.id }, 'paper.sweep 单仓失败(忽略)');
    }
  }
}

export function startPaper() {
  if (cfg.enabled === false) { log.info('纸面引擎未启用(paper.enabled=false)'); return; }
  const ms = (cfg.markLoopSec ?? 60) * 1000;
  setInterval(sweep, ms).unref?.();
  log.info({ notionalUsd: cfg.notionalUsd ?? 100, horizonHours: cfg.horizonHours ?? 24, markLoopSec: cfg.markLoopSec ?? 60 }, '纸面引擎已启动');
}

// —— 序C：用户仓编排(手动模拟 / 实盘记录 / 关注) ——
// 只读原则不变：仓位仅记录与追踪，绝不触发任何链上交易。key 必须是本站已存在的候选。
// 校验规则: {tp,sl,trail,maxHoldMin}，各项为正数或 null；至少一项非空才算有效绑定。
export function sanitizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null));
  const out = { tp: num(rule.tp), sl: num(rule.sl), trail: num(rule.trail), maxHoldMin: num(rule.maxHoldMin) };
  if (out.tp == null && out.sl == null && out.trail == null && out.maxHoldMin == null) return null;
  return out;
}

// 开一个用户仓。origin ∈ manual|real|watch。返回 {ok, error?, position?}。
export function openUserPosition(key, origin, opts = {}) {
  if (!USER_GROUPS.has(origin)) return { ok: false, error: `未知仓位类型: ${origin}` };
  const cand = store.get(key);
  if (!cand) return { ok: false, error: `未找到候选 ${key}` };
  const now = Date.now();
  const entry = opts.entryPriceUsd != null && Number(opts.entryPriceUsd) > 0 ? Number(opts.entryPriceUsd) : cand.price_usd;
  if (!(entry > 0)) return { ok: false, error: '当前无有效价格，无法开仓(可传 entryPriceUsd 指定入场价)' };
  const rule = sanitizeRule(opts.rule);
  const rtCost = origin === 'real' ? 0 : (cfg.baseCostPct ?? 2); // 实盘按真实成交，往返成本记 0；模拟/关注含基础成本
  const notional = opts.notionalUsd != null && Number(opts.notionalUsd) > 0 ? Number(opts.notionalUsd)
    : (opts.qty != null && Number(opts.qty) > 0 ? Number(opts.qty) * entry : (cfg.notionalUsd ?? 100));
  const created = store.paperUserOpen({
    key, chain: cand.chain, grp: origin, origin,
    signal_ts: now, open_ts: now, entry_price_usd: entry, entry_mcap_usd: cand.market_cap_usd ?? null,
    notional_usd: notional, qty: opts.qty != null && Number(opts.qty) > 0 ? Number(opts.qty) : null,
    roundtrip_cost_pct: rtCost, horizon_end_ts: null, // 用户仓无 horizon 自动平仓
    rule_json: rule ? JSON.stringify(rule) : null, notes: opts.notes || null,
  });
  if (!created) return { ok: false, error: `该币已存在 ${origin} 仓(先平仓再重开)` };
  const pos = store.paperPositionByKeyOrigin(key, origin);
  if (pos) {
    const { pnlUsd, pnlPct } = markPnl(entry, entry, notional, rtCost);
    store.paperAddMark({ position_id: pos.id, ts: now, price_usd: entry, mcap_usd: cand.market_cap_usd ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct, price_state: 'ok' });
  }
  log.info({ key, origin, entry, notional }, '用户仓已开');
  return { ok: true, position: pos };
}

// 平一个用户仓(按当前候选价)。返回 {ok, error?, position?}。
export function closeUserPosition(key, origin) {
  const pos = store.paperPositionByKeyOrigin(key, origin);
  if (!pos || pos.status !== 'open') return { ok: false, error: `未找到可平的 ${origin} 仓` };
  const cand = store.get(key);
  const now = Date.now();
  const price = cand?.price_usd ?? pos.last_price_usd ?? pos.entry_price_usd;
  recordClose(pos, price, cand?.market_cap_usd ?? null, now, 'manual_close', cand?.price_state ?? null);
  log.info({ key, origin }, '用户仓已平');
  return { ok: true, position: store.paperGetById(pos.id) };
}

// 给已开的用户仓绑定/更新退出规则(重置已触发标记)。
export function bindRuleToPosition(key, origin, rule) {
  const pos = store.paperPositionByKeyOrigin(key, origin);
  if (!pos || pos.status !== 'open') return { ok: false, error: `未找到可绑定的 ${origin} 仓` };
  const r = sanitizeRule(rule);
  if (!r) return { ok: false, error: '规则无效(tp/sl/trail/maxHoldMin 至少一项为正数)' };
  store.paperSetRule(pos.id, JSON.stringify(r));
  return { ok: true, position: store.paperGetById(pos.id), rule: r };
}

// —— 统计(供 /api/paper) ——
function avg(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// 序C：用户仓视图(手动/实盘/关注)——每仓当前净值 + MFE + 绑定规则 + 触发/风险状态。单列对比，不并入自动组统计。
export function userPositionsView(chain = null) {
  const rows = store.paperUserPositions(chain);
  return rows.map((r) => {
    const rule = r.rule_json ? safeParse(r.rule_json) : null;
    const closed = r.status === 'closed';
    const cur = closed ? r.pnl_pct
      : (r.entry_price_usd > 0 && r.last_price_usd != null ? markPnl(r.entry_price_usd, r.last_price_usd, r.notional_usd, r.roundtrip_cost_pct).pnlPct : null);
    const mfe = r.entry_price_usd > 0 && r.peak_price_usd != null ? (r.peak_price_usd / r.entry_price_usd - 1) * 100 : null;
    const cand = store.get(r.key);
    return {
      id: r.id, key: r.key, chain: r.chain, origin: r.origin, status: r.status,
      name: cand?.name ?? null, symbol: cand?.symbol ?? null,
      openTs: r.open_ts, entryPriceUsd: r.entry_price_usd, lastPriceUsd: r.last_price_usd,
      notionalUsd: r.notional_usd, qty: r.qty, curPct: cur, mfePct: mfe,
      closeReason: r.close_reason, closedPnlPct: closed ? r.pnl_pct : null,
      rule, ruleFiredReason: r.rule_fired_reason, ruleFiredTs: r.rule_fired_ts, notes: r.notes,
    };
  });
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function paperStats(chain = null) {  const key = chain || '__all__';
  const c = statsCache.get(key);
  const now = Date.now();
  if (c && now - c.at < STATS_TTL_MS) return c.val;
  const val = computePaperStats(chain);
  statsCache.set(key, { at: now, val });
  return val;
}

// marks 表数天后可达数十万行，每 30s 全量重算 4 组会与轮询争 SQLite → 按 chain 缓存 60s。
const statsCache = new Map();
const STATS_TTL_MS = (cfg.statsCacheSec ?? 60) * 1000;

function computePaperStats(chain = null) {
  const groups = ['baseline_seen', 'tier_t1', 'tier_t2', 'entry_pass'];
  const byGrp = {};
  for (const g of groups) byGrp[g] = { open: 0, closed: 0, deferred: 0, deferred_expired: 0, skipped: 0 };
  for (const r of store.paperStatusCounts(chain)) if (byGrp[r.grp]) byGrp[r.grp][r.status] = r.n;
  const out = {};
  for (const g of groups) {
    const closed = store.paperClosedPnls(g, chain);
    const pnls = closed.map((r) => r.pnl_pct).filter((v) => v != null);
    const holds = closed.map((r) => r.hold_ms).filter((v) => v != null);
    // MFE(最大浮盈)/MAE(最大浮亏)/2× 命中：用仓位存的峰谷价 ÷ 入场价，无需回扫 marks。
    const mfe = closed.filter((r) => r.entry_price_usd > 0 && r.peak_price_usd != null).map((r) => (r.peak_price_usd / r.entry_price_usd - 1) * 100);
    const mae = closed.filter((r) => r.entry_price_usd > 0 && r.trough_price_usd != null).map((r) => (r.trough_price_usd / r.entry_price_usd - 1) * 100);
    const hit2x = closed.filter((r) => r.entry_price_usd > 0 && r.peak_price_usd != null && r.peak_price_usd / r.entry_price_usd >= 2).length;
    const rugged = closed.filter((r) => r.close_reason === 'withdrawn').length;

    // —— 序B：未平仓现值 + 分时收益 + 退出规则回放(纯读轨迹) ——
    const positions = store.paperStatPositions(g, chain);
    const now = Date.now();
    const openRows = positions.filter((r) => r.status === 'open');
    const open = openPositionStats(openRows);
    // marks 按仓位分组
    const marksByPos = new Map();
    for (const m of store.paperMarksForGrp(g, chain)) {
      if (!marksByPos.has(m.position_id)) marksByPos.set(m.position_id, []);
      marksByPos.get(m.position_id).push(m);
    }
    // 分时桶累积 + 规则回放累积
    const bucketVals = Object.fromEntries(BUCKETS_MIN.map((b) => [b, []]));
    const ruleOut = RULES.map((r) => ({ name: r.name, pnls: [], maes: [], rug: 0, nClosed: 0, nOpen: 0 }));
    for (const pos of positions) {
      const marks = marksByPos.get(pos.id);
      if (!marks || !marks.length || !(pos.entry_price_usd > 0)) continue;
      const isClosed = pos.status === 'closed';
      const ageMs = (isClosed ? pos.close_ts : (pos.last_mark_ts || now)) - pos.open_ts;
      const br = bucketReturns(marks, pos.open_ts, ageMs, isClosed, BUCKETS_MIN);
      for (const b of BUCKETS_MIN) if (br[b] != null) bucketVals[b].push(br[b]);
      RULES.forEach((rule, i) => {
        const res = replayRule(marks, rule);
        if (!res) return;
        ruleOut[i].pnls.push(res.exitPnlPct);
        ruleOut[i].maes.push(res.maePct);
        if (res.exitReason === 'rug') ruleOut[i].rug += 1;
        if (isClosed) ruleOut[i].nClosed += 1; else ruleOut[i].nOpen += 1;
      });
    }
    const timeBuckets = {};
    for (const b of BUCKETS_MIN) {
      const v = bucketVals[b];
      timeBuckets[b] = v.length ? { n: v.length, median: median(v), p25: quantile(v, 0.25), p75: quantile(v, 0.75) } : { n: 0, median: null, p25: null, p75: null };
    }
    const rules = ruleOut.map((r) => ({
      name: r.name,
      n: r.pnls.length,
      nClosed: r.nClosed,
      nOpen: r.nOpen,
      avgPnlPct: r.pnls.length ? avg(r.pnls) : null,
      medianPnlPct: r.pnls.length ? median(r.pnls) : null,
      winRate: r.pnls.length ? r.pnls.filter((v) => v > 0).length / r.pnls.length : null,
      avgMaePct: r.maes.length ? avg(r.maes) : null,
      rugRate: r.pnls.length ? r.rug / r.pnls.length : null,
    }));

    out[g] = {
      ...byGrp[g],
      closedCount: pnls.length,
      avgPnlPct: pnls.length ? avg(pnls) : null,
      medianPnlPct: pnls.length ? median(pnls) : null,
      winRate: pnls.length ? pnls.filter((v) => v > 0).length / pnls.length : null,
      avgHoldH: holds.length ? avg(holds) / HOUR : null,
      ruggedCount: rugged,
      rugRate: pnls.length ? rugged / pnls.length : null,
      avgMfePct: mfe.length ? avg(mfe) : null,
      medianMaePct: mae.length ? median(mae) : null,
      hit2xRate: pnls.length ? hit2x / pnls.length : null,
      open,
      timeBuckets,
      rules,
    };
  }
  return {
    chain: chain || 'all',
    config: { notionalUsd: cfg.notionalUsd ?? 100, horizonHours: cfg.horizonHours ?? 24, baseCostPct: cfg.baseCostPct ?? 2, baselineSampleOneIn: cfg.baselineSampleOneIn ?? 5, bucketsMin: BUCKETS_MIN, ruleNames: RULES.map((r) => r.name) },
    groups: out,
    userPositions: userPositionsView(chain),
  };
}
