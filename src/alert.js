import { chainConfig, config } from './config.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { sendTelegram } from './notify/telegram.js';
import { sendServerChan } from './notify/serverchan.js';
import { child } from './logger.js';

const log = child('alert');
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };

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

// 计算候选应处的告警级别
export function evaluateTier(cand, m) {
  const T = config.tiers;
  if (m.listing) return 'T3';
  const t2 =
    (m.marketCapUsd >= T.T2.marketCapUsd && m.liquidityUsd >= T.T2.minLiquidityUsd) ||
    m.copycats >= T.T2.copycatCount ||
    (m.narrativeHits && m.narrativeHits.length > 0);
  if (t2) return 'T2';
  const t1 =
    m.uniqueBuyers >= T.T1.uniqueBuyers30m ||
    m.holderGrowthPct >= T.T1.holderGrowth10mPct ||
    m.marketCapUsd >= T.T1.marketCapUsd;
  if (t1) return 'T1';
  return 'T0';
}

/**
 * 只在「升级」时告警：T0->T1 轻提示(Telegram)，->T2/T3 强提示(Telegram+Server酱)。
 */
export async function maybeAlert(chain, cand, metrics) {
  const newTier = evaluateTier(cand, metrics);
  const cur = cand.tier || 'T0';
  if (RANK[newTier] <= RANK[cur]) return newTier;

  store.setTier(cand.key, newTier);
  const reason = buildReason(newTier, metrics);
  const links = linksFor(chain, cand);

  bus.emit(Events.ALERT, { ...cand, tier: newTier, metrics, reason, links });

  const title = `[${newTier}] ${cand.symbol || '新币'} ${usd(metrics.marketCapUsd)}`;
  const body = renderBody(chain, cand, metrics, reason, links);

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
  log.info({ token: cand.symbol, tier: newTier, tg, sc }, '告警已发出');
  return newTier;
}

function buildReason(tier, m) {
  const parts = [];
  if (m.narrativeHits?.length) parts.push(`叙事命中:${m.narrativeHits.join('/')}`);
  if (m.copycats >= 3) parts.push(`仿盘${m.copycats}个`);
  if (m.marketCapUsd) parts.push(`市值${usd(m.marketCapUsd)}`);
  if (m.liquidityUsd) parts.push(`流动性${usd(m.liquidityUsd)}`);
  if (m.uniqueBuyers) parts.push(`买家${m.uniqueBuyers}`);
  if (m.graduated) parts.push('已毕业Pancake');
  return parts.join(' · ') || tier;
}

function renderBody(chain, cand, m, reason, links) {
  const l = [];
  l.push(`🛰️ <b>[${evaluateTier(cand, m)}] ${escape(cand.symbol)}</b>  ${escape(cand.name || '')}`);
  l.push(`链: ${chain} · 发射台: ${cand.launchpad}`);
  l.push(reason);
  l.push(`<code>${cand.address}</code>`);
  const linkline = Object.entries(links).map(([k, v]) => `<a href="${v}">${k}</a>`).join(' · ');
  l.push(linkline);
  return l.join('\n');
}

function renderMarkdown(chain, cand, m, reason, links) {
  const l = [];
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
