'use strict';

// ---------- 主题：跟随系统 / 手动切换 ----------
const root = document.documentElement;
const saved = localStorage.getItem('theme') || 'auto';
applyTheme(saved);
document.getElementById('themeBtn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const cur = localStorage.getItem('theme') || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem('theme', next);
  applyTheme(next);
});
function applyTheme(t) {
  root.setAttribute('data-theme', t);
  document.getElementById('themeBtn').textContent = t === 'auto' ? '🌓' : t === 'dark' ? '🌙' : '☀️';
}

// ---------- 状态 ----------
const feed = document.getElementById('feed');
const empty = document.getElementById('empty');
const cards = new Map(); // key -> element
const state = new Map(); // key -> data
// 筛选偏好持久化（避免刷新后又勾着「只看 T2+」而看不到刚 promote 的 T0/T1）
const savedFilters = JSON.parse(localStorage.getItem('filters') || '{}');
const filters = { minLiq: savedFilters.minLiq || 0, t2only: !!savedFilters.t2only, entryOnly: !!savedFilters.entryOnly, chain: savedFilters.chain || 'all', pause: false };
function persistFilters() {
  localStorage.setItem('filters', JSON.stringify({ minLiq: filters.minLiq, t2only: filters.t2only, entryOnly: filters.entryOnly, chain: filters.chain }));
}

const elMinLiq = document.getElementById('fMinLiq');
const elT2 = document.getElementById('fT2');
const elEntry = document.getElementById('fEntry');
const elChain = document.getElementById('fChain');
elMinLiq.value = String(filters.minLiq);
elT2.checked = filters.t2only;
elEntry.checked = filters.entryOnly;
elMinLiq.addEventListener('change', (e) => { filters.minLiq = +e.target.value; persistFilters(); render(); });
elT2.addEventListener('change', (e) => { filters.t2only = e.target.checked; persistFilters(); render(); });
elEntry.addEventListener('change', (e) => { filters.entryOnly = e.target.checked; persistFilters(); render(); });
elChain.addEventListener('change', (e) => { filters.chain = e.target.value; persistFilters(); reload(); loadStats(); });
document.getElementById('fPause').addEventListener('change', (e) => { filters.pause = e.target.checked; });

// 链标识：徽章文案 + 徽章 class（颜色见 style.css）
const CHAIN_LABEL = { bsc: 'BSC', robinhood: 'RBH', arc: 'ARC' };
function chainLabel(c) { return CHAIN_LABEL[c] || (c ? c.slice(0, 3).toUpperCase() : '?'); }

// ---------- 工具 ----------
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
function usd(n) {
  n = +n || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

function sparkline(snaps) {
  if (!snaps || snaps.length < 2) return '';
  const useMcap = snaps.some((s) => s.market_cap_usd > 0);
  const label = useMcap ? '市值走势' : '买家走势';
  const vals = snaps.map((s) => (useMcap ? s.market_cap_usd : s.unique_buyers) || 0);
  const max = Math.max(...vals), min = Math.min(...vals);
  const W = 300, H = 34, n = vals.length;
  const pts = vals.map((v, i) => {
    const x = (i / (n - 1)) * W;
    const y = max === min ? H / 2 : H - ((v - min) / (max - min)) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const col = up ? 'var(--ok)' : 'var(--t2)';
  return `<div class="spark-wrap"><span class="spark-lbl">${label}</span><svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline fill="none" stroke="${col}" stroke-width="1.5" points="${pts}"/></svg></div>`;
}

function visible(d) {
  if (d.status === 'rejected') return false;
  if (filters.chain !== 'all' && d.chain !== filters.chain) return false;
  if (filters.t2only && RANK[d.tier] < 2) return false;
  if (filters.entryOnly && !(d.entry && d.entry.ok)) return false;
  if ((d.liquidityUsd || 0) < filters.minLiq) return false;
  return true;
}

function signed(n) {
  n = +n || 0;
  const s = usd(Math.abs(n));
  return n >= 0 ? '+' + s : '-' + s;
}

function depthLabel(d) {
  const val = usd(d.depthUsd || d.liquidityUsd || 0);
  if (d.depthKind === 'amm') return `流动性 <b>${val}</b>`;
  const qs = d.quoteSymbol && d.quoteSymbol !== 'UNKNOWN' ? ` <small>${esc(d.quoteSymbol)}</small>` : '';
  // 曲线期：显示募集额 + 毕业进度(funds/maxRaising)，比「剩余供应%」直观
  const prog = d.curveProgressPct != null && d.curveProgressPct > 0 ? ` · 进度${(+d.curveProgressPct).toFixed(0)}%` : '';
  return `曲线募集 <b>${val}</b>${qs}${prog}`;
}

function cardHtml(d) {
  const tags = [];
  (d.narrativeHit || []).forEach((h) => tags.push(`<span class="tag">🔥${esc(h)}</span>`));
  if (d.copycats >= 3) tags.push(`<span class="tag">仿盘${d.copycats}</span>`);
  const badges = [`<span class="badge chain chain-${esc(d.chain)}">${chainLabel(d.chain)}</span>`, `<span class="badge ${d.tier}">${d.tier}</span>`];
  if (d.graduated) badges.push('<span class="badge grad">毕业</span>');
  if (d.lpLocked) badges.push('<span class="badge lplock" title="LP 锁仓合约存在">LP 已锁</span>');
  // 高费率池(Arc 反狙击 90.1% 等)：显红标提醒，进去必被高费吃穿。
  if (d.poolFeePct != null && d.poolFeePct > 10) badges.push(`<span class="badge feehigh" title="池动态费率">费率 ${(+d.poolFeePct).toFixed(1)}%</span>`);
  // 可试仓 v1：满足小资金试仓门时显绿标(A/B + 建议仓位)，供快速筛选。
  if (d.entry && d.entry.ok) badges.push(`<span class="badge entry" title="${esc((d.entry.reasons || []).join(' · '))}">可试仓 ${esc(d.entry.tier)} ${usd(d.entry.sizeUsd)}</span>`);
  // M3-1b 价格新鲜度/撤池状态：撤池(真归零) > 价格未知(>24h) > 陈旧(>10min)，只显最严重一档。
  if (d.liquidityWithdrawn) badges.push('<span class="badge withdrawn">已撤池</span>');
  else if (d.priceState === 'implausible') badges.push('<span class="badge implausible">数据异常·已隐藏</span>');
  else if (d.softFlags && d.softFlags.unpriced) badges.push(`<span class="badge unpriced">报价币${d.quoteSymbol ? ' ' + esc(d.quoteSymbol) : ''}·无美元价</span>`);
  else if (d.priceUnknown) badges.push('<span class="badge unknown">价格未知</span>');
  else if (d.priceStale) badges.push(`<span class="badge stale">更新于${ago(d.priceUpdatedAt)}前</span>`);
  if (d.softFlags && d.softFlags.noActiveLiquidity) badges.push('<span class="badge noliq" title="单边挂单/未开盘：当前价位无活跃流动性，可退出 $0">未开盘·单边流动性</span>');
  if (d.softFlags && d.softFlags.noSupply) badges.push('<span class="badge unpriced">供应量读取中</span>');
  const links = Object.entries(d.links || {}).map(([k, v]) => `<a href="${v}" target="_blank" rel="noopener">${k}</a>`).join('');
  const net = +d.netIn30m || 0;
  const netCls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  const dd = +d.drawdownPct || 0;
  return `
    <div class="row1">
      <div><span class="sym">${esc(d.symbol || '?')}</span><span class="name">${esc(d.name || '')}</span></div>
      <div>${badges.join(' ')}</div>
    </div>
    ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
    <div class="metrics">
      <span>市值 <b>${d.softFlags && d.softFlags.noSupply ? '读取中' : usd(d.marketCapUsd)}</b></span>
      <span>净流入30m <b class="${netCls}">${signed(net)}</b></span>
      <span>${depthLabel(d)}</span>
      <span>距峰值 <b>${dd > 0 ? '-' + dd.toFixed(0) + '%' : '—'}</b></span>
      <span>新买家<small>(监测期)</small> <b>${d.uniqueBuyers || 0}</b></span>
      <span>${esc(d.launchpad || '')}</span>
      <span>${ago(d.discoveredAt)}前</span>
    </div>
    <div class="spark-holder"></div>
    <div class="addr">${esc(d.address)}</div>
    <div class="links">${links}</div>`;
}

function upsert(d, highlight) {
  state.set(d.key, d);
  if (!visible(d)) { removeCard(d.key); return; }
  empty.style.display = 'none';
  let el = cards.get(d.key);
  if (!el) {
    el = document.createElement('div');
    cards.set(d.key, el);
  }
  el.className = `card ${d.tier}${d.status === 'rejected' ? ' rejected' : ''}`;
  el.innerHTML = cardHtml(d);
  // 位置：T2/T3 或高亮的置顶
  if (!el.parentNode || highlight || RANK[d.tier] >= 2) {
    if (!filters.pause) feed.prepend(el);
    else if (!el.parentNode) feed.prepend(el);
  }
  fetchSpark(d.key, el);
}

function removeCard(key) {
  const el = cards.get(key);
  if (el && el.parentNode) el.parentNode.removeChild(el);
  cards.delete(key);
}

async function fetchSpark(key, el) {
  try {
    const r = await fetch('/api/token/' + encodeURIComponent(key));
    if (!r.ok) return;
    const d = await r.json();
    const holder = el.querySelector('.spark-holder');
    if (holder) holder.innerHTML = sparkline(d.snapshots);
  } catch { /* noop */ }
}

function render() {
  for (const [key, d] of state) {
    if (visible(d)) upsert(d, false);
    else removeCard(key);
  }
  if (!feed.querySelector('.card')) updateEmptyHint();
}

// ---------- 数据加载 ----------
// 按当前链筛选拉取：选定单链时带 ?chain= 走 SQL 级筛选，避免 BSC 大量 active 把 Robinhood 挤出 200 条上限。
async function reload() {
  for (const key of [...cards.keys()]) removeCard(key);
  try {
    const q = filters.chain && filters.chain !== 'all' ? `&chain=${encodeURIComponent(filters.chain)}` : '';
    const r = await fetch(`/api/tokens?limit=200${q}`);
    const list = await r.json();
    list.reverse().forEach((d) => upsert(d, false));
  } catch { /* noop */ }
  if (!feed.querySelector('.card')) updateEmptyHint();
}

// 链下拉：用后端启用的链填充（/api/health.chains）
async function populateChains() {
  try {
    const h = await fetch('/api/health').then((r) => r.json());
    const chains = h.chains || [];
    for (const c of chains) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `${CHAIN_LABEL[c] || c}`;
      elChain.appendChild(opt);
    }
    elChain.value = filters.chain; // 恢复持久化选择（若该链已下线则回落 all）
    if (elChain.value !== filters.chain) { filters.chain = 'all'; persistFilters(); }
  } catch { /* noop */ }
}

async function loadInitial() {
  await populateChains();
  await reload();
  loadStats();
}
let lastStats = {}; // 最近一次 /api/stats 结果，供空列表提示读 seen 数
// 空列表提示(方案0-5)：选定单链且有 seen 候选时，提示「本链 N 个候选等待准入」，否则给通用等待文案。
function updateEmptyHint() {
  if (feed.querySelector('.card')) { empty.style.display = 'none'; return; }
  const seen = +lastStats.seen || 0;
  if (filters.chain && filters.chain !== 'all') {
    const name = CHAIN_LABEL[filters.chain] || filters.chain;
    empty.textContent = seen > 0
      ? `本链(${name}) ${seen} 个候选等待准入（买家数未达门槛，尚未进入跟踪列表）`
      : `本链(${name})暂无新币信号…（确保后端已连上该链 RPC）`;
  } else {
    empty.textContent = seen > 0
      ? `${seen} 个候选等待准入（买家数未达门槛，尚未进入跟踪列表）`
      : '等待新币信号…（确保后端已连上 RPC）';
  }
  empty.style.display = 'block';
}
async function loadStats() {
  try {
    const q = filters.chain && filters.chain !== 'all' ? `?chain=${encodeURIComponent(filters.chain)}` : '';
    const s = await fetch('/api/stats' + q).then((r) => r.json());
    lastStats = s;
    document.getElementById('s-total').textContent = s.total ?? 0;
    document.getElementById('s-24h').textContent = s.last24h ?? 0;
    document.getElementById('s-t1').textContent = s.t1 ?? 0;
    document.getElementById('s-t2').textContent = s.t2 ?? 0;
    document.getElementById('s-t3').textContent = s.t3 ?? 0;
    document.getElementById('s-missed').textContent = s.missed ?? 0;
    updateEmptyHint();
  } catch { /* noop */ }
}

// ---------- SSE ----------
const conn = document.getElementById('conn');
function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { conn.className = 'conn on'; };
  es.onerror = () => { conn.className = 'conn off'; };
  es.addEventListener('candidate', (e) => upsert(JSON.parse(e.data), true));
  es.addEventListener('update', (e) => upsert(JSON.parse(e.data), false));
  es.addEventListener('alert', (e) => { upsert(JSON.parse(e.data), true); loadStats(); });
}

loadInitial();
connect();
setInterval(loadStats, 30000);

// ---------- 纸面回报面板 ----------
const GROUP_LABEL = { baseline_seen: '对照(抽样)', tier_t1: 'T1', tier_t2: 'T2', entry_pass: '可试仓' };
function pctOf(v) { return v == null ? '—' : (v * 100).toFixed(0) + '%'; }
function spct(v) { if (v == null) return '—'; const s = Math.round(+v) + '%'; return +v > 0 ? '+' + s : s; }
function scls(v) { return v == null ? '' : (+v > 0 ? 'pos' : +v < 0 ? 'neg' : ''); }
async function loadPaper() {
  const body = document.getElementById('paperBody');
  const sub = document.getElementById('paperSub');
  try {
    const q = filters.chain && filters.chain !== 'all' ? `?chain=${encodeURIComponent(filters.chain)}` : '';
    const p = await fetch('/api/paper' + q).then((r) => r.json());
    const chainName = p.chain === 'all' ? '全部链' : (CHAIN_LABEL[p.chain] || p.chain);
    sub.textContent = `${chainName} · 对照组抽样 1/${p.config.baselineSampleOneIn} · 基础往返成本 ${p.config.baseCostPct}% · horizon ${p.config.horizonHours}h`;
    const entries = Object.entries(p.groups);
    const bkts = p.config.bucketsMin || [5, 15, 60, 240, 1440];
    const bLabel = (b) => b >= 1440 ? (b / 1440) + 'd' : b >= 60 ? (b / 60) + 'h' : b + 'm';

    // 表1：状态汇总 + 已平统计
    const summ = entries.map(([g, s]) => `
      <tr>
        <td>${GROUP_LABEL[g] || g}</td>
        <td>${s.open}</td><td>${s.closed}</td><td>${s.deferred}/${s.deferred_expired}/${s.skipped}</td>
        <td class="${scls(s.medianPnlPct)}">${spct(s.medianPnlPct)}</td>
        <td>${pctOf(s.winRate)}</td>
        <td class="${s.rugRate > 0 ? 'neg' : ''}">${pctOf(s.rugRate)}</td>
        <td>${s.avgMfePct == null ? '—' : '+' + Math.round(+s.avgMfePct) + '%'}</td>
        <td>${pctOf(s.hit2xRate)}</td>
      </tr>`).join('');

    // 表2：未平仓现值(不等平仓，1 小时就有数)
    const openRows = entries.map(([g, s]) => {
      const o = s.open || {};
      return `<tr>
        <td>${GROUP_LABEL[g] || g}</td>
        <td>${o.openCount ?? 0}</td>
        <td class="${scls(o.medianCurPct)}">${spct(o.medianCurPct)}</td>
        <td>${o.medianMfePct == null ? '—' : spct(o.medianMfePct)}</td>
        <td>${pctOf(o.hit15xRate)}</td>
        <td>${pctOf(o.hit2xRate)}</td>
        <td class="${o.dd50Rate > 0 ? 'neg' : ''}">${pctOf(o.dd50Rate)}</td>
      </tr>`; }).join('');

    // 表3：分时收益中位(开仓后 N 时刻此刻退出的净收益)；带样本数 n，防小样本被当结论
    const bktHead = bkts.map((b) => `<th>${bLabel(b)}</th>`).join('');
    const bktRows = entries.map(([g, s]) => {
      const tb = s.timeBuckets || {};
      const cells = bkts.map((b) => { const x = tb[b]; return `<td class="${scls(x && x.median)}" title="样本 ${x ? x.n : 0}">${x && x.n ? spct(x.median) + `<span class="paper-n">·${x.n}</span>` : '—'}</td>`; }).join('');
      return `<tr><td>${GROUP_LABEL[g] || g}</td>${cells}</tr>`; }).join('');

    // 表4：退出规则回放(哪套退出规则把 MFE 变成实现收益)；rug 率单列，样本区分已平/未平
    const ruleBlocks = entries.map(([g, s]) => {
      const rr = (s.rules || []).map((r) => `<tr>
        <td>${r.name}</td><td title="已平 ${r.nClosed} / 未平 ${r.nOpen}">${r.nClosed}/${r.nOpen}</td>
        <td class="${scls(r.medianPnlPct)}">${spct(r.medianPnlPct)}</td>
        <td class="${scls(r.avgPnlPct)}">${spct(r.avgPnlPct)}</td>
        <td>${pctOf(r.winRate)}</td>
        <td class="${r.rugRate > 0 ? 'neg' : ''}">${pctOf(r.rugRate)}</td>
        <td class="neg">${spct(r.avgMaePct)}</td>
      </tr>`).join('');
      return `<div class="paper-rule-grp"><div class="paper-rule-title">${GROUP_LABEL[g] || g}</div>
        <table class="paper-tbl"><thead><tr><th>规则</th><th>已平/未平</th><th>中位</th><th>均值</th><th>胜率</th><th>Rug</th><th>MAE均</th></tr></thead><tbody>${rr}</tbody></table></div>`;
    }).join('');

    body.innerHTML = `
      <div class="paper-sec-t">状态与已平仓</div>
      <table class="paper-tbl"><thead><tr><th>组</th><th>持仓</th><th>已平</th><th>延/过期/跳</th><th>中位</th><th>胜率</th><th>Rug</th><th>MFE均</th><th>2×率</th></tr></thead><tbody>${summ}</tbody></table>
      <div class="paper-sec-t">未平仓现值（无需等 24h）</div>
      <table class="paper-tbl"><thead><tr><th>组</th><th>持仓</th><th>现值中位</th><th>MFE中位</th><th>1.5×率</th><th>2×率</th><th>回撤&gt;50%</th></tr></thead><tbody>${openRows}</tbody></table>
      <div class="paper-sec-t">分时收益中位（开仓后 · 此刻退出净值）</div>
      <table class="paper-tbl"><thead><tr><th>组</th>${bktHead}</tr></thead><tbody>${bktRows}</tbody></table>
      <div class="paper-sec-t">退出规则回放（把 MFE 变实现收益）</div>
      ${ruleBlocks}`;
  } catch { body.textContent = '加载失败'; }
}
document.getElementById('paperBtn').addEventListener('click', () => { document.getElementById('paperOverlay').hidden = false; loadPaper(); });
document.getElementById('paperClose').addEventListener('click', () => { document.getElementById('paperOverlay').hidden = true; });
document.getElementById('paperOverlay').addEventListener('click', (e) => { if (e.target.id === 'paperOverlay') e.currentTarget.hidden = true; });
