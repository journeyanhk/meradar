// M4 纸面引擎（只读模拟）——在信号点用名义 $100 模拟买入、追踪 horizon 内回报，评估各分组信号质量。
// 四组(非互斥)：baseline_seen(所有活跃候选=对照)/tier_t1/tier_t2/entry_pass。每组每币至多一仓(UNIQUE key,grp)。
// 不持有自己的 RPC：开仓价取该轮 metrics.priceUsd，后续 mark 优先用实时 metrics(轮询中)，否则用候选行 price_usd
// (归档后冻结=诚实标记)。往返成本开仓时固化，每次 mark 的 pnl 都是「此刻退出」的净值(已扣往返)。
import { config } from './config.js';
import { store } from './db.js';
import { child } from './logger.js';

const log = child('paper');
const cfg = config.paper || {};
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
const HOUR = 3600_000;

// —— 纯函数(可单测) ——

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
export function groupsFor(row, metrics) {
  const g = ['baseline_seen'];
  const rank = RANK[row.tier] ?? 0;
  if (rank >= 1) g.push('tier_t1');
  if (rank >= 2) g.push('tier_t2');
  if (metrics.entry?.ok) g.push('entry_pass');
  return g;
}

// —— 编排(有副作用) ——

function tryOpen(chain, row, metrics, grp, now) {
  const rt = roundtripCostPct(metrics.poolFeePct, cfg);
  if (rt == null) {
    // 费率≥上限 → 记录 skipped(不开仓)，保留信号点供统计「因高费率放弃」占比。
    store.paperInsertPosition({
      key: row.key, chain, grp, status: 'skipped', signal_ts: now,
      notional_usd: cfg.notionalUsd ?? 100,
      skip_reason: `pool_fee_${(metrics.poolFeePct ?? 0).toFixed(1)}pct_ge_${cfg.maxPoolFeePct ?? 10}`,
    });
    return;
  }
  if (openGate(metrics, cfg)) {
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
      // 开仓即打 t0 标记(pnl≈-往返成本)。
      const { pnlUsd, pnlPct } = markPnl(price, price, cfg.notionalUsd ?? 100, rt);
      const pos = store.paperPosition(row.key, grp);
      if (pos) store.paperAddMark({ position_id: pos.id, ts: now, price_usd: price, mcap_usd: metrics.marketCapUsd ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct });
    }
  } else {
    // 门槛未过 → 延期(deferred)。到期仍不可开 → sweep 置 deferred_expired。
    store.paperInsertPosition({
      key: row.key, chain, grp, status: 'deferred', signal_ts: now,
      notional_usd: cfg.notionalUsd ?? 100,
      defer_until_ts: now + (cfg.deferMinutes ?? 30) * 60_000,
    });
  }
}

function tryReopenDeferred(pos, metrics, now) {
  const rt = roundtripCostPct(metrics.poolFeePct, cfg);
  if (rt == null) { store.paperMarkSkipped(pos.id, `pool_fee_${(metrics.poolFeePct ?? 0).toFixed(1)}pct_ge_${cfg.maxPoolFeePct ?? 10}`); return; }
  if (!openGate(metrics, cfg)) return; // 仍不可开 → 继续等，sweep 处理到期
  const price = metrics.priceUsd;
  const ok = store.paperOpenDeferred(pos.id, {
    open_ts: now, entry_price_usd: price, entry_mcap_usd: metrics.marketCapUsd ?? null,
    roundtrip_cost_pct: rt, horizon_end_ts: now + (cfg.horizonHours ?? 24) * HOUR,
    peak_price_usd: price, trough_price_usd: price,
    last_price_usd: price, last_mcap_usd: metrics.marketCapUsd ?? null, last_mark_ts: now,
  });
  if (ok) {
    const { pnlUsd, pnlPct } = markPnl(price, price, pos.notional_usd ?? cfg.notionalUsd ?? 100, rt);
    store.paperAddMark({ position_id: pos.id, ts: now, price_usd: price, mcap_usd: metrics.marketCapUsd ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct });
  }
}

// 记录一次标记(受最小间隔约束)。price 无效则跳过。
function recordMark(pos, price, mcap, now) {
  if (!(price > 0)) return;
  if (pos.last_mark_ts && now - pos.last_mark_ts < (cfg.markMinIntervalSec ?? 20) * 1000) return;
  const { pnlUsd, pnlPct } = markPnl(pos.entry_price_usd, price, pos.notional_usd, pos.roundtrip_cost_pct);
  const peak = Math.max(pos.peak_price_usd ?? price, price);
  const trough = Math.min(pos.trough_price_usd ?? price, price);
  store.paperUpdateMark(pos.id, { last_price_usd: price, last_mcap_usd: mcap ?? null, last_mark_ts: now, peak_price_usd: peak, trough_price_usd: trough });
  store.paperAddMark({ position_id: pos.id, ts: now, price_usd: price, mcap_usd: mcap ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct });
}

// 平仓(不受最小间隔约束)。无有效价则用最后已知价/开仓价平仓，避免因暂时无价永不平仓。
function recordClose(pos, price, mcap, now, reason) {
  let p = price;
  if (!(p > 0)) p = pos.last_price_usd || pos.entry_price_usd;
  const { pnlUsd, pnlPct } = markPnl(pos.entry_price_usd, p, pos.notional_usd, pos.roundtrip_cost_pct);
  const peak = Math.max(pos.peak_price_usd ?? p, p);
  const trough = Math.min(pos.trough_price_usd ?? p, p);
  const ok = store.paperClose(pos.id, {
    close_ts: now, close_price_usd: p, close_mcap_usd: mcap ?? null, close_reason: reason,
    pnl_usd: pnlUsd, pnl_pct: pnlPct, peak_price_usd: peak, trough_price_usd: trough,
  });
  if (ok) store.paperAddMark({ position_id: pos.id, ts: now, price_usd: p, mcap_usd: mcap ?? null, pnl_usd: pnlUsd, pnl_pct: pnlPct });
}

// 轮询钩子：track.pollCandidate 在 maybeAlert 之后调用。用本轮实时 metrics 开新仓、重试延期仓、即时标记/平仓已有仓。
export function onPoll(chain, row, metrics) {
  if (cfg.enabled === false) return;
  try {
    const now = metrics?.now || Date.now();
    const groups = new Set(groupsFor(row, metrics));
    const existing = store.paperPositionsForKey(row.key);
    const have = new Set();
    for (const pos of existing) {
      have.add(pos.grp);
      if (pos.status === 'open') {
        if (now >= pos.horizon_end_ts) recordClose(pos, metrics.priceUsd, metrics.marketCapUsd, now, 'horizon');
        else recordMark(pos, metrics.priceUsd, metrics.marketCapUsd, now); // 事件即时标记
      } else if (pos.status === 'deferred') {
        if (now >= pos.defer_until_ts) store.paperExpireDeferred(pos.id, now);
        else if (groups.has(pos.grp)) tryReopenDeferred(pos, metrics, now);
      }
    }
    for (const grp of groups) if (!have.has(grp)) tryOpen(chain, row, metrics, grp, now);
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
      const price = cand?.price_usd ?? 0;
      const mcap = cand?.market_cap_usd ?? null;
      if (now >= pos.horizon_end_ts) recordClose(pos, price, mcap, now, 'horizon');
      else recordMark(pos, price, mcap, now);
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

// —— 统计(供 /api/paper) ——
function avg(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function paperStats() {
  const groups = ['baseline_seen', 'tier_t1', 'tier_t2', 'entry_pass'];
  const byGrp = {};
  for (const g of groups) byGrp[g] = { open: 0, closed: 0, deferred: 0, deferred_expired: 0, skipped: 0 };
  for (const r of store.paperStatusCounts()) if (byGrp[r.grp]) byGrp[r.grp][r.status] = r.n;
  const out = {};
  for (const g of groups) {
    const closed = store.paperClosedPnls(g);
    const pnls = closed.map((r) => r.pnl_pct).filter((v) => v != null);
    const holds = closed.map((r) => r.hold_ms).filter((v) => v != null);
    out[g] = {
      ...byGrp[g],
      closedCount: pnls.length,
      avgPnlPct: pnls.length ? avg(pnls) : null,
      medianPnlPct: pnls.length ? median(pnls) : null,
      winRate: pnls.length ? pnls.filter((v) => v > 0).length / pnls.length : null,
      avgHoldH: holds.length ? avg(holds) / HOUR : null,
    };
  }
  return {
    config: { notionalUsd: cfg.notionalUsd ?? 100, horizonHours: cfg.horizonHours ?? 24, baseCostPct: cfg.baseCostPct ?? 2 },
    groups: out,
  };
}
