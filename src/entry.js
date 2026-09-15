// 可试仓 v1（小资金试仓过滤）—— 纯函数，跨链通用，无 RPC / 无 DB / 不改分级阈值。
//
// 设计（见评审「可试仓 v1」拍板）：
//  · 只读本轮 metrics + 候选行 + 买家计数(softFlags) + 链级 entryFilter 配置，产出 {ok, tier, sizeUsd, ...}。
//  · 四段门：hard(硬门槛) → structure(买家结构) → momentum(动能) → safety(贸易安全)。任一硬失败即 ok=false。
//  · 仓位跟深度走：sizeUsd = min(tier 上限, depth×depthPct)，unverified 毕业币再减半——绝不给固定额度打穿小池。
//  · 分层只决定上限：A(安全 PASS + 强动能) 上限高；B(其余合格，含 unverified 减半) 上限低。
//  · v1 不含「疑似对倒」信号(拍板选 A：后续单独做)。auditVersion 落进结果，health 按版本统计命中数。
//  · 比率从落库计数现算(buyerRatios)，与 server.js API 层同一实现，避免漂移。
import { buyerRatios } from './buyer.js';

function floorTo(v, step) {
  const s = step > 0 ? step : 1;
  return Math.floor(v / s) * s;
}

/**
 * @param m      本轮 metrics(depthUsd/marketCapUsd/peakMcapUsd/priceState/netIn30m/graduated/tradeSafety/...)
 * @param ef     链级 entryFilter 配置(entryFilterFor(chain))
 * @param counts 本轮买家分级计数(track.js 的 softFlags：{buyerCount, naturalBuyers, sniper, ...})；缺失=数据不足
 * @returns { ok, tier:'A'|'B'|null, sizeUsd, reasons[], redFlags[], auditVersion } | null(未启用)
 */
export function evaluateEntry(m, ef, counts) {
  if (!ef || ef.enabled === false) return null;
  const hard = ef.hard || {};
  const structure = ef.structure || {};
  const momentum = ef.momentum || {};
  const sizing = ef.sizing || {};
  const auditVersion = ef.auditVersion || 'v1';

  const reasons = [];
  const redFlags = [];

  // —— 段1 硬门槛 ——
  const depthUsd = m.depthUsd || 0;
  const mcap = m.marketCapUsd || 0;
  if (hard.requirePriceOk && m.priceState && m.priceState !== 'ok') {
    redFlags.push(`价格状态:${m.priceState}`);
  }
  if (depthUsd < (hard.minDepthUsd || 0)) redFlags.push(`深度不足 ${Math.round(depthUsd)}<${hard.minDepthUsd}`);
  else reasons.push(`深度 $${Math.round(depthUsd)}`);
  if (hard.maxMcapUsd && mcap > hard.maxMcapUsd) redFlags.push(`市值超上限 ${Math.round(mcap)}>${hard.maxMcapUsd}`);

  // —— 段2 买家结构（比率从计数现算；无计数=数据不足，保守拒） ——
  if (!counts || !counts.buyerCount) {
    redFlags.push('买家数据不足');
  } else {
    const r = buyerRatios(counts);
    if ((counts.buyerCount || 0) < (structure.minBuyerCount || 0)) redFlags.push(`买家数少 ${counts.buyerCount}<${structure.minBuyerCount}`);
    if (structure.minNaturalRatio != null && r.naturalRatio < structure.minNaturalRatio) redFlags.push(`自然买家占比低 ${(r.naturalRatio * 100).toFixed(0)}%`);
    else reasons.push(`自然占比 ${(r.naturalRatio * 100).toFixed(0)}%`);
    if (structure.maxSniperRatio != null && r.sniperRatio > structure.maxSniperRatio) redFlags.push(`狙击占比高 ${(r.sniperRatio * 100).toFixed(0)}%`);
    if (structure.maxFarmRatio != null && r.farmRatio > structure.maxFarmRatio) redFlags.push(`工作室占比高 ${(r.farmRatio * 100).toFixed(0)}%`);
    if (structure.maxDustRatio != null && r.dustRatio > structure.maxDustRatio) redFlags.push(`粉尘占比高 ${(r.dustRatio * 100).toFixed(0)}%`);
    if (structure.minNaturalBuyers30m != null && (m.naturalBuyers30m || 0) < structure.minNaturalBuyers30m) redFlags.push(`30m自然买家少 ${m.naturalBuyers30m || 0}<${structure.minNaturalBuyers30m}`);
  }

  // —— 段3 动能（净流入 + 回撤） ——
  const netIn30m = m.netIn30m || 0;
  if (netIn30m < (momentum.minNetIn30m || 0)) redFlags.push(`30m净流入低 ${Math.round(netIn30m)}<${momentum.minNetIn30m}`);
  else reasons.push(`30m净流入 $${Math.round(netIn30m)}`);
  const peak = m.peakMcapUsd || 0;
  const drawdownPct = peak > 0 ? Math.max(0, ((peak - mcap) / peak) * 100) : 0;
  if (momentum.maxDrawdownPct != null && drawdownPct > momentum.maxDrawdownPct) redFlags.push(`回撤过深 ${drawdownPct.toFixed(0)}%>${momentum.maxDrawdownPct}%`);

  // —— 段4 贸易安全 ——
  // PASS → 放行(全额)；WAIT+unverified(v4 往返未实现，链级豁免期) → 放行但减半、封顶 B；
  // 拒绝软标记(数据冲突) / 其余 WAIT(none/graduating/roundtrip) / REJECT / 无安全 → 硬拒。
  const ts = m.tradeSafety || null;
  const tsState = ts?.state || null;
  const tsSource = ts?.source || null;
  const tsSoft = ts?.softFlags || [];
  let unverified = false;
  const rejSoft = (ef.rejectSoftFlags || []).filter((s) => tsSoft.includes(s));
  if (rejSoft.length) redFlags.push(...rejSoft.map((s) => `安全:${s}`));
  if (tsState === 'PASS') reasons.push('安全 PASS');
  else if (tsState === 'WAIT' && tsSource === 'unverified') { unverified = true; reasons.push('安全 未核验(减半)'); }
  else redFlags.push(`安全未过 ${tsState || '无'}${tsSource ? '/' + tsSource : ''}`);

  const ok = redFlags.length === 0;
  if (!ok) return { ok: false, tier: null, sizeUsd: 0, reasons, redFlags, auditVersion };

  // —— 分层 + 仓位 ——
  // A：安全 PASS 且 30m 净流入达强动能线；否则 B(含 unverified 减半路径始终封顶 B)。
  const strong = !unverified && netIn30m >= (momentum.tierANetIn30m || Infinity);
  const tier = strong ? 'A' : 'B';
  const cap = tier === 'A' ? (sizing.tierAMaxUsd || 0) : (sizing.tierBMaxUsd || 0);
  let sizeUsd = Math.min(cap, depthUsd * (sizing.depthPct || 0.02));
  if (unverified && sizing.unverifiedHalve) sizeUsd /= 2;
  sizeUsd = floorTo(sizeUsd, sizing.roundTo || 10);

  return { ok: true, tier, sizeUsd, reasons, redFlags, auditVersion };
}
