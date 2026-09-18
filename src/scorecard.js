// 序D：Meme 早期币评分卡 v0(方案二·工程化改写)。纯函数，权重冻结为 scoreVersion 'v0'。
// 拆双分：安全分 S(合约安全+筹码结构+开发者行为=50) / 机会分 O(流动性+资金动向+社区=50)。
// 显示 S/O 各 0–100，总分 = 0.6S + 0.4O。否决项触发→总分封顶 30(红标)；安全维度缺失≥2→总分封顶 70。
// 档位折算：优=1.0 / 良=0.7 / 中=0.4 / 差=0；数据缺失(未知)记「中(0.4)」并列入 gaps(未知≠及格)。
// 阈值按早期币($20K–$300K 市值、$3K–$30K 深度、发射后分钟级)重标定(见「T2+ 评分」拍板文档)。

export const SCORE_VERSION = 'v0';

// 高优(值越大越好)/低优(值越小越好)四档折算。v==null → 中(0.4)+gap。
function gradeHigh(v, a, b, c) {
  if (v == null || Number.isNaN(v)) return { frac: 0.4, gap: true };
  if (v >= a) return { frac: 1 };
  if (v >= b) return { frac: 0.7 };
  if (v >= c) return { frac: 0.4 };
  return { frac: 0 };
}
function gradeLow(v, a, b, c) {
  if (v == null || Number.isNaN(v)) return { frac: 0.4, gap: true };
  if (v < a) return { frac: 1 };
  if (v < b) return { frac: 0.7 };
  if (v < c) return { frac: 0.4 };
  return { frac: 0 };
}

// 冻结权重表(v0)。每维度总和：合约安全20/筹码20/开发者10/流动性25/资金20/社区5 = 100。
const W = {
  safety: { honeypot: 10, lpLock: 6, proxy: 4 },        // S
  chips: { top10: 8, devHold: 6, sniperBot: 3, holders: 3 }, // S
  dev: { history: 6, devSold: 4 },                       // S
  liq: { depth: 8, lpMcap: 5, buyers1h: 6, buyRatio: 3, wash: 3 }, // O
  flow: { netIn30m: 7, accel: 6, maxBuy: 3, drawdown: 4 }, // O
  community: { narrative: 3, socials: 2 },               // O
};

// 对一个维度累加：indicators = [{ key, weight, grade:{frac,gap}, veto? }]。返回 {pts, max, gaps:[], vetoes:[]}.
function foldDim(name, indicators) {
  let pts = 0, max = 0; const gaps = [], vetoes = [];
  for (const ind of indicators) {
    max += ind.weight;
    pts += ind.weight * ind.grade.frac;
    if (ind.grade.gap) gaps.push(`${name}.${ind.key}`);
    if (ind.veto) vetoes.push(ind.veto);
  }
  return { pts, max, frac: max ? pts / max : 0, gaps, vetoes };
}

// 主入口。input 为归一化快照(见 buildScoreInput)。返回 {version,S,O,total,capped,dims,vetoes,gaps}。
export function scoreToken(input = {}) {
  const s = input.safety || {}, c = input.chips || {}, d = input.dev || {};
  const l = input.liq || {}, f = input.flow || {}, cm = input.community || {};
  const vetoes = [];

  // —— 合约安全(20, S) ——
  // 蜜罐/卖税：REJECT 或卖税≥30% → 否决；否则按卖税档；PASS 无税值=已核验优；WAIT/未核验=中(gap)。
  let honeypot;
  if (s.state === 'REJECT') honeypot = { frac: 0, veto: '蜜罐/已否决' };
  else if (s.sellTaxBps != null) {
    if (s.sellTaxBps >= 3000) honeypot = { frac: 0, veto: '卖税≥30%(蜜罐)' };
    else honeypot = gradeLow(s.sellTaxBps, 500, 1000, 3000);
  } else if (s.state === 'PASS') honeypot = { frac: 1 };
  else honeypot = { frac: 0.4, gap: true }; // WAIT/未核验
  const lpLock = s.lpLocked || s.factory ? { frac: 1 } : { frac: 0.4, gap: true };
  const proxy = s.proxyKnownSafe === true ? { frac: 1 } : (s.proxyKnownSafe === false ? { frac: 0 } : { frac: 0.4, gap: true });
  const safety = foldDim('合约安全', [
    { key: 'honeypot', weight: W.safety.honeypot, grade: honeypot, veto: honeypot.veto },
    { key: 'lpLock', weight: W.safety.lpLock, grade: lpLock },
    { key: 'proxy', weight: W.safety.proxy, grade: proxy },
  ]);

  // —— 筹码结构(20, S) ——
  const top10g = gradeLow(c.top10Pct, 20, 35, 50);
  if (c.top10Pct != null && c.top10Pct > 50) top10g.veto = '前10持仓>50%(极端集中)';
  const devHoldg = gradeLow(c.devPct, 5, 10, 20);
  if (c.devPct != null && c.devPct > 20) devHoldg.veto = 'dev持仓>20%(单一地址过重)';
  const chips = foldDim('筹码结构', [
    { key: 'top10', weight: W.chips.top10, grade: top10g, veto: top10g.veto },
    { key: 'devHold', weight: W.chips.devHold, grade: devHoldg, veto: devHoldg.veto },
    { key: 'sniperBot', weight: W.chips.sniperBot, grade: gradeLow(c.sniperBotRatio, 0.1, 0.25, 0.5) },
    { key: 'holders', weight: W.chips.holders, grade: gradeHigh(c.holderCount, 150, 50, 20) },
  ]);

  // —— 开发者行为(10, S) ——
  let history;
  if (d.launches == null) history = { frac: 0.4, gap: true };
  else if ((d.rugged || 0) >= 2) history = { frac: 0, veto: '部署者跑路前科(≥2次归零)' };
  else if ((d.rugged || 0) === 1) history = { frac: 0.4 };
  else if (d.launches >= 3) history = { frac: 1 };      // 多次干净发射
  else history = { frac: 0.7 };                          // 新/少量发射且干净=中性偏好
  let devSold;
  if (d.devSold == null) devSold = { frac: 0.4, gap: true };
  else if (d.devSold >= 0.99) devSold = { frac: 0, veto: 'dev清仓' };
  else devSold = gradeLow(d.devSold, 0.001, 0.1, 0.3);   // 无卖出/<10%/10-30%/更多
  const dev = foldDim('开发者行为', [
    { key: 'history', weight: W.dev.history, grade: history, veto: history.veto },
    { key: 'devSold', weight: W.dev.devSold, grade: devSold, veto: devSold.veto },
  ]);

  // —— 流动性与交易质量(25, O) ——
  const liq = foldDim('流动性', [
    { key: 'depth', weight: W.liq.depth, grade: gradeHigh(l.depthUsd, 30000, 10000, 5000) },
    { key: 'lpMcap', weight: W.liq.lpMcap, grade: gradeHigh(l.lpToMcapPct, 20, 10, 5) },
    { key: 'buyers1h', weight: W.liq.buyers1h, grade: gradeHigh(l.buyers1h, 150, 50, 20) },
    { key: 'buyRatio', weight: W.liq.buyRatio, grade: gradeHigh(l.buyRatio, 0.6, 0.5, 0.4) },
    { key: 'wash', weight: W.liq.wash, grade: l.washFlag == null ? { frac: 0.4, gap: true } : (l.washFlag ? { frac: 0 } : { frac: 1 }) },
  ]);

  // —— 资金动向(20, O) ——
  const accel = (f.netIn30m != null && f.netIn1h != null)
    ? (f.netIn30m > 0 && 2 * f.netIn30m >= f.netIn1h ? { frac: 1 } : (f.netIn30m > 0 ? { frac: 0.7 } : { frac: 0 }))
    : { frac: 0.4, gap: true };
  const flow = foldDim('资金动向', [
    { key: 'netIn30m', weight: W.flow.netIn30m, grade: gradeHigh(f.netIn30m, 5000, 1000, 0.0001) },
    { key: 'accel', weight: W.flow.accel, grade: accel },
    { key: 'maxBuy', weight: W.flow.maxBuy, grade: gradeLow(f.maxBuyPct, 20, 40, 60) },
    { key: 'drawdown', weight: W.flow.drawdown, grade: gradeDrawdown(f.drawdownPct, f.ageMin) },
  ]);

  // —— 社区与叙事(5, O) ——
  const narr = cm.narrativeHits == null ? { frac: 0.4, gap: true }
    : (cm.narrativeHits >= 2 ? { frac: 1 } : (cm.narrativeHits === 1 ? { frac: 0.7 } : { frac: 0.4 }));
  const community = foldDim('社区', [
    { key: 'narrative', weight: W.community.narrative, grade: narr },
    { key: 'socials', weight: W.community.socials, grade: cm.hasSocials == null ? { frac: 0.4, gap: true } : (cm.hasSocials ? { frac: 1 } : { frac: 0.4 }) },
  ]);

  // —— 额外否决(系统真实不可逆风险) ——
  if (input.poolFeePct != null && input.poolFeePct >= 10) vetoes.push('池费率≥10%');
  if (s.state === 'WAIT' && s.source === 'unverified' && l.depthUsd != null && l.depthUsd < 5000) vetoes.push('v4未核验且深度<$5K');

  // 汇总否决 + gaps
  for (const dim of [safety, chips, dev, liq, flow, community]) vetoes.push(...dim.vetoes);
  const gaps = [...safety.gaps, ...chips.gaps, ...dev.gaps, ...liq.gaps, ...flow.gaps, ...community.gaps];
  const uniqVetoes = [...new Set(vetoes)];

  // S/O(各 0–100) + 总分
  const S = Math.round((safety.pts + chips.pts + dev.pts) / 50 * 100);
  const O = Math.round((liq.pts + flow.pts + community.pts) / 50 * 100);
  let total = Math.round(0.6 * S + 0.4 * O);
  let capped = null;
  if (safety.gaps.length >= 2) { total = Math.min(total, 70); capped = '安全缺≥2项·封顶70'; }
  if (uniqVetoes.length) { total = Math.min(total, 30); capped = '否决·封顶30'; }

  return {
    version: SCORE_VERSION, S, O, total, capped,
    dims: {
      合约安全: dimOut(safety), 筹码结构: dimOut(chips), 开发者行为: dimOut(dev),
      流动性: dimOut(liq), 资金动向: dimOut(flow), 社区: dimOut(community),
    },
    vetoes: uniqVetoes, gaps,
  };
}

function dimOut(x) { return { pts: Math.round(x.pts * 10) / 10, max: x.max, frac: Math.round(x.frac * 100) / 100 }; }

// 距ATH回撤结合代币年龄：<60min 的币回撤 50% 内不扣满分。
function gradeDrawdown(dd, ageMin) {
  if (dd == null) return { frac: 0.4, gap: true };
  if (ageMin != null && ageMin < 60) return dd < 50 ? { frac: 1 } : (dd < 70 ? { frac: 0.7 } : { frac: 0.4 });
  return gradeLow(dd, 30, 60, 85);
}

// —— metrics → 评分输入 的适配器 ——
// 从 track 每轮组好的 metrics(含序2 的 scoreInputs)映射到 scoreToken 的归一化输入。缺失字段留 null(→中+gap)。
export function buildScoreInput(metrics = {}) {
  const si = metrics.scoreInputs || {};
  const sf = metrics.softFlags || {};
  const sniperBot = ratioOf(sf, ['sniper', 'bot']);
  const lpMcap = (metrics.depthUsd != null && metrics.marketCapUsd > 0) ? (metrics.depthUsd / metrics.marketCapUsd) * 100 : null;
  return {
    chain: metrics.chain ?? null,
    poolFeePct: metrics.poolFeePct ?? null,
    safety: {
      state: metrics.tradeSafety?.state ?? null,
      source: metrics.tradeSafety?.source ?? null,
      sellTaxBps: metrics.tradeSafety?.sellTaxBps ?? null,
      lpLocked: metrics.lpLocked ?? null,
      factory: metrics.tradeSafety?.source === 'factory' || metrics.tradeSafety?.source === 'template',
      proxyKnownSafe: metrics.proxyKnownSafe ?? null,
    },
    chips: {
      top10Pct: si.top10Pct ?? null,
      devPct: si.devPct ?? null,
      sniperBotRatio: sniperBot,
      holderCount: si.holders ?? metrics.uniqueBuyers ?? null,
    },
    dev: {
      launches: si.creator?.launches ?? null,
      rugged: si.creator?.rugged ?? null,
      devSold: metrics.devSoldPct ?? null,
    },
    liq: {
      depthUsd: metrics.depthUsd ?? null,
      lpToMcapPct: lpMcap,
      buyers1h: metrics.uniqueBuyers ?? null,
      buyRatio: metrics.buyRatio ?? metrics.buyRatio30m ?? null,
      washFlag: metrics.washFlag ?? null,
    },
    flow: {
      netIn30m: metrics.netIn30m ?? null,
      netIn1h: metrics.netIn1h ?? null,
      maxBuyPct: metrics.maxBuyPct ?? null,
      drawdownPct: metrics.drawdownPct ?? null,
      ageMin: metrics.ageMin ?? null,
    },
    community: {
      narrativeHits: metrics.narrativeHits?.length ?? null,
      hasSocials: metrics.hasSocials ?? null,
    },
  };
}
function ratioOf(sf, keys) {
  const total = sf.buyerCount || 0;
  if (!total) return null;
  let n = 0; for (const k of keys) n += sf[k] || 0;
  return n / total;
}
