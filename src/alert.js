import { chainConfig, config, tiersFor } from './config.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { sendTelegram } from './notify/telegram.js';
import { sendServerChan } from './notify/serverchan.js';
import { child } from './logger.js';

const log = child('alert');
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
const minTier = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const TRADE_FRESH_MS = 10 * 60_000; // 成交新鲜度：所有 T2 腿都要求近 10min 有成交
const GRAD_FRESH_MS = 60 * 60_000;  // 毕业新鲜度：毕业腿把「毕业」当强提示的有效期
const RT_FRESH_MS = 10 * 60_000;    // 往返新鲜度：毕业币强提示要求往返核验 ≤10min
// 告警标题/正文链名前置：多链后一眼区分来源
const CHAIN_TAG = { bsc: 'BSC', robinhood: 'RBH', arc: 'ARC' };

export function linksFor(chain, cand) {
  const cfg = chainConfig(chain);
  const out = { explorer: `${cfg.explorer}/token/${cand.address}` };
  if (cfg.gmgnBase) out.gmgn = `${cfg.gmgnBase}/${cand.address}`;
  if (chain === 'bsc') out.fourmeme = `https://four.meme/token/${cand.address}`;
  return out;
}

function usd(n) {
  if (!n) return '$0';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// 计算候选应处的告警级别。单出口：返回 { tier, rawTier, capTier, gaps, tradeFresh, gradFresh, rtFresh }。
//   rawTier = 纯发现信号（动量/体量/叙事/仿盘/毕业腿）；tier = min(rawTier, capTier) 入库。
//   capTier 由「贸易安全 WAIT」(m.capTier) + 三条独立新鲜度门共同决定，只降级不升级。
// 叙事不再单独构成 T2，而是「乘数」——命中叙事时按 narrativeMultiplier 放宽各档阈值。
// 仿盘热度只让「原版」升级（copy_of 的候选 isOriginal=false，不因仿盘数升级）。
// 新鲜度字段（m.lastTradeTs / m.graduatedAt / m.roundTripCheckedAt / m.now）缺省时视为不设限，
// 使纯动量单测聚焦分级本身；track 每轮显式传入真实时间戳启用门槛。
export function evaluateTier(cand, m) {
  const T = tiersFor(cand?.chain);
  const hasNarrative = !!(m.narrativeHits && m.narrativeHits.length > 0);
  const k = hasNarrative ? (T.narrativeMultiplier || 1) : 1; // <1 表示更容易触发

  const now = m.now ?? Date.now();
  const tradeFresh = m.lastTradeTs == null ? true : (now - m.lastTradeTs) <= TRADE_FRESH_MS;
  const gradFresh = m.graduatedAt == null ? true : (now - m.graduatedAt) <= GRAD_FRESH_MS;
  const rtFresh = m.roundTripCheckedAt == null ? true : (now - m.roundTripCheckedAt) <= RT_FRESH_MS;

  // —— rawTier：纯发现信号 ——
  let rawTier = 'T0';
  // 动量门槛与深度成比例：净流入需超过 max(绝对下限, 深度×百分比)，避免大币「买多卖少 1 美元」也算动量。
  const netInFloor = Math.max(
    T.T2.momentumMinNetInUsd || 2000,
    (m.depthUsd || 0) * (T.T2.momentumMinNetInDepthPct || 0.005),
  );
  const hasMomentum = (m.netIn30m || 0) >= netInFloor || (m.newBuyers30m || 0) >= (T.T2.momentumMinNewBuyers30m || 10);
  // 仿盘腿只做「放大器」而非独立触发器：同名 ≥ N 个仅在币本身已达 T1 级体量或有实时动量时才升 T2。
  const copycatQualifies =
    m.isOriginal &&
    m.copycats >= T.T2.copycatCount &&
    ((m.marketCapUsd || 0) >= T.T1.marketCapUsd * k || (m.netIn30m || 0) >= netInFloor);
  // 毕业腿：毕业新鲜(≤60min) 且 有动量才当强提示。高毕业率链(Pons 每小时毕业十余个)上
  // 「毕业」本身是流水线事件而非信号，只把币推到 T1；毕业后 30min 内真有资金/买家承接才 T2。
  // 也避免换库/换 VPS 回填一批老毕业币启动即 T2 刷屏。
  const gradLeg = !!m.graduated && gradFresh && hasMomentum;
  const t2 =
    (m.marketCapUsd >= T.T2.marketCapUsd * k && m.liquidityUsd >= T.T2.minLiquidityUsd * k && hasMomentum) ||
    copycatQualifies ||
    gradLeg;
  const t1 =
    m.uniqueBuyers >= T.T1.uniqueBuyers30m * k ||
    (m.uniqueBuyers >= (T.T1.growthMinBuyers || 20) && m.holderGrowthPct >= T.T1.holderGrowth10mPct) ||
    m.marketCapUsd >= T.T1.marketCapUsd * k;
  if (t2) rawTier = 'T2';
  else if (t1) rawTier = 'T1';

  // listing 是外部 CEX/Alpha 上币事件源的硬 T3，不受本地成交/往返新鲜度封顶。
  if (m.listing) return { tier: 'T3', rawTier: 'T3', capTier: null, gaps: [], tradeFresh, gradFresh, rtFresh };

  // —— capTier：贸易安全 WAIT + 三条独立新鲜度门（只降级）——
  const caps = [];
  const gaps = [];
  if (m.capTier) caps.push(m.capTier);                          // WAIT 关键字段封顶（通常 T1）
  if (!tradeFresh) { caps.push('T1'); gaps.push('成交不新鲜'); } // 所有 T2 腿都要求近 10min 有成交
  if (m.graduated && !rtFresh) { caps.push('T1'); gaps.push('往返未核验/过期'); } // 毕业币强提示要求往返新鲜

  let capTier = null;
  for (const c of caps) capTier = capTier == null ? c : minTier(capTier, c);
  const tier = capTier == null ? rawTier : minTier(rawTier, capTier);

  return { tier, rawTier, capTier, gaps, tradeFresh, gradFresh, rtFresh };
}

/**
 * 只在「升级」时告警：T0->T1 轻提示(Telegram)，->T2/T3 强提示(Telegram+Server酱)。
 * newTier = min(rawTier, capTier)：贸易安全 WAIT 与成交/往返/毕业新鲜度只会把强提示降级封顶。
 */
export async function maybeAlert(chain, cand, metrics) {
  const res = evaluateTier(cand, metrics);
  const newTier = res.tier;
  const cur = cand.tier || 'T0';
  if (RANK[newTier] <= RANK[cur]) return newTier;

  store.setTier(cand.key, newTier);
  const reason = buildReason(newTier, metrics);
  const links = linksFor(chain, cand);

  bus.emit(Events.ALERT, { ...cand, tier: newTier, metrics, reason, links });

  const chainTag = CHAIN_TAG[chain] || chain;
  const title = `[${chainTag}][${newTier}] ${cand.symbol || '新币'} ${usd(metrics.marketCapUsd)}`;
  const body = renderBody(chain, cand, metrics, reason, links, newTier);

  let tg = false, sc = false;
  if (newTier === 'T1') {
    tg = await sendTelegram(body, { silent: true });
  } else {
    tg = await sendTelegram(body, { silent: false });
    sc = await sendServerChan(title, renderMarkdown(chain, cand, metrics, reason, links));
  }

  store.addAlert({
    key: cand.key, chain, tier: newTier, ts: Date.now(), reason,
    sent_telegram: tg ? 1 : 0, sent_serverchan: sc ? 1 : 0,
  });
  log.info({ token: cand.symbol, tier: newTier, rawTier: res.rawTier, capTier: res.capTier, tg, sc }, '告警已发出');
  return newTier;
}

// 安全行文案：PASS 显示卖税/模板已核验；WAIT 显示未核验；REJECT 显示否决因。
function safetyLine(m) {
  const ts = m.tradeSafety;
  if (!ts) return null;
  if (ts.state === 'PASS') {
    if (ts.source === 'template') return '卖税 曲线期·平台模板 ✓';
    if (ts.source === 'factory') return '卖税 曲线期·平台工厂部署 ✓';
    if (ts.sellTaxBps != null) return `卖税 ✓ ${(ts.sellTaxBps / 100).toFixed(1)}%`;
    return '卖税 ✓ 已核验';
  }
  if (ts.state === 'WAIT') {
    if (ts.source === 'unverified') return '⚠ 未核验路径：v4 往返尚未实现';
    if (ts.softFlags?.includes('数据冲突')) return '卖税 数据冲突·待复核';
    return '卖税 未核验（退避复查）';
  }
  if (ts.state === 'REJECT') return `⛔ 已否决：${ts.reason || ''}`;
  return null;
}

function buildReason(tier, m) {
  const parts = [];
  if (m.narrativeHits?.length) parts.push(`叙事命中:${m.narrativeHits.join('/')}`);
  if (m.copycats >= 3) parts.push(`仿盘${m.copycats}个`);
  if (m.marketCapUsd) parts.push(`市值${usd(m.marketCapUsd)}`);
  if (m.liquidityUsd) parts.push(`流动性${usd(m.liquidityUsd)}`);
  if (m.uniqueBuyers) parts.push(`买家${m.uniqueBuyers}`);
  if (m.graduated) parts.push('已毕业Pancake');
  const safety = safetyLine(m);
  if (safety) parts.push(safety);
  return parts.join(' · ') || tier;
}

function renderBody(chain, cand, m, reason, links, tier) {
  const l = [];
  if (m.tradeSafety?.source === 'unverified') l.push('⚠ <b>未核验路径：v4 往返尚未实现</b>');
  l.push(`🛰️ <b>[${CHAIN_TAG[chain] || chain}][${tier}] ${escape(cand.symbol)}</b>  ${escape(cand.name || '')}`);
  l.push(`链: ${chain} · 发射台: ${cand.launchpad}`);
  l.push(reason);
  l.push(`<code>${cand.address}</code>`);
  const linkline = Object.entries(links).map(([k, v]) => `<a href="${v}">${k}</a>`).join(' · ');
  l.push(linkline);
  return l.join('\n');
}

function renderMarkdown(chain, cand, m, reason, links) {
  const l = [];
  if (m.tradeSafety?.source === 'unverified') l.push('> ⚠ 未核验路径：v4 往返尚未实现');
  l.push(`**${escape(cand.name || cand.symbol)}** (${escape(cand.symbol)})`);
  l.push(`- 链 / 发射台: ${chain} / ${cand.launchpad}`);
  l.push(`- ${reason}`);
  l.push(`- 合约: \`${cand.address}\``);
  for (const [k, v] of Object.entries(links)) l.push(`- [${k}](${v})`);
  return l.join('\n');
}

function escape(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
