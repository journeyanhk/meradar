// 买家质量分级（M2c）—— 纯函数，跨链通用，无 RPC/无 DB，便于单测冻结真值表。
//
// 设计原则（见 docs / M2c 评审）：
//  · 一个地址可命中多个标签；natural = 无任何标签。
//  · 「狙击税」只是 Robinhood 一条链上的一个字段；跨链口径靠「发射后 N 秒内买入」的时间窗，
//    与 Pons 狙击税高度重合，可交叉验证。
//  · farm/fresh 依赖调用方注入的跨币统计(farmSet)与 nonce(nonceByAccount)——本函数不查库、不发 RPC。
//  · 分级结果先展示不门控：只产出 softFlags(各标签占比) 与 naturalBuyers30m，绝不改 evaluateTier 阈值输入。

export const BUYER_DEFAULTS = {
  dustUsd: 1,               // 该币累计买入 < $1 → dust(粉尘/女巫)
  snipeWindowMs: 60_000,    // 首买距发射 ≤60s → sniper(与狙击税等价的时间窗口)
  botBlockMin: 3,           // 同一区块 ≥3 笔买入 → bot(路由拆单一般 ≤2 笔)
  bot5mCount: 10,           // 任意 5 分钟窗口内 ≥10 笔买入 → bot
  bot5mWindowMs: 5 * 60_000,
  flipperWindowMs: 10 * 60_000, // 首买后 10 分钟内
  flipperPct: 0.9,          // 卖出 ≥90% 持仓 → flipper(快进快出)
  freshNonceMax: 3,         // nonce ≤3 → fresh(新钱包)
};

// 标签集合的单一来源：分类、计数初始化、比率键、软标记均引用它，杜绝魔法字符串漂移。
export const BUYER_TAGS = ['sniper', 'bot', 'farm', 'dust', 'fresh', 'flipper'];

/**
 * 对单个地址在某币上的成交做分级。
 * @param acct {{ buys: Array<{ts,block,quoteUsd,tokens,hasTax}>, sells: Array<{ts,tokens}> }}
 * @param ctx  {{ launchMs, isFarm, nonce, now, cfg }}
 * @returns string[] 标签(可能为空=natural)
 */
export function classifyAccount(acct, { launchMs = null, isFarm = false, nonce = null, priced = true, cfg = BUYER_DEFAULTS } = {}) {
  const tags = [];
  const buys = acct.buys || [];
  if (!buys.length) return tags; // 只卖不买的地址不参与买家分级
  const firstBuyTs = buys[0].ts;
  const buyUsd = buys.reduce((s, b) => s + (b.quoteUsd || 0), 0);
  const buyTokens = buys.reduce((s, b) => s + (b.tokens || 0), 0);
  const hasTax = buys.some((b) => b.hasTax);

  // sniper：狙击税 或 首买落在发射后 snipeWindow 内(允许小幅负偏移，容忍 launch_time 抖动)。
  const withinSnipe = launchMs != null && firstBuyTs != null &&
    (firstBuyTs - launchMs) <= cfg.snipeWindowMs && (firstBuyTs - launchMs) >= -cfg.snipeWindowMs;
  if (hasTax || withinSnipe) tags.push('sniper');

  // bot：同块 ≥botBlockMin 笔，或任意 5 分钟窗口 ≥bot5mCount 笔。
  if (isBot(buys, cfg)) tags.push('bot');

  // farm：调用方跨币统计给出(24h ≥N 个不同新币)。
  if (isFarm) tags.push('farm');

  // dust：该币累计买入额过小。仅在报价币已定价(priced)时判——未定价时 quote_amount 恒 0，
  // 会把全体买家误标粉尘、自然买家归零，故此时跳过(调用方在 softFlags 标 unpriced)。
  if (priced && buyUsd < cfg.dustUsd) tags.push('dust');

  // fresh：新钱包(nonce ≤ freshNonceMax)。nonce 未查(null)则不判。
  if (nonce != null && nonce <= cfg.freshNonceMax) tags.push('fresh');

  // flipper：首买后 flipperWindow 内卖出 ≥ flipperPct 持仓。
  if (buyTokens > 0) {
    const soldInWindow = (acct.sells || [])
      .filter((s) => s.ts != null && s.ts >= firstBuyTs && s.ts <= firstBuyTs + cfg.flipperWindowMs)
      .reduce((s, x) => s + (x.tokens || 0), 0);
    if (soldInWindow / buyTokens >= cfg.flipperPct) tags.push('flipper');
  }

  return tags;
}

function isBot(buys, cfg) {
  // 同块聚合
  const perBlock = new Map();
  for (const b of buys) {
    if (b.block == null || b.block === 0) continue;
    perBlock.set(b.block, (perBlock.get(b.block) || 0) + 1);
  }
  for (const n of perBlock.values()) if (n >= cfg.botBlockMin) return true;
  // 5 分钟滑窗(买入时间已按 ts 升序)
  const ts = buys.map((b) => b.ts).filter((t) => t != null).sort((a, b) => a - b);
  let i = 0;
  for (let j = 0; j < ts.length; j++) {
    while (ts[j] - ts[i] > cfg.bot5mWindowMs) i++;
    if (j - i + 1 >= cfg.bot5mCount) return true;
  }
  return false;
}

/**
 * 对某币的全部成交做买家分级。纯函数：不查库、不发 RPC。
 * @param trades Array<{ ts, side:'buy'|'sell', account, quote_amount(USD), token_amount, tax_raw, block }>
 * @param opts   {{ launchMs, farmSet:Set<string>, nonceByAccount:Map<string,number>, now, cfg }}
 * @returns {{ tagsByAccount: Map<string,string[]>, ratios, naturalBuyers, naturalBuyers30m, buyerCount }}
 */
export function classifyTokenBuyers(trades, { launchMs = null, farmSet = new Set(), nonceByAccount = new Map(), priced = true, now = Date.now(), cfg = BUYER_DEFAULTS } = {}) {
  const byAcct = new Map(); // account -> { buys, sells }
  for (const t of trades || []) {
    const acc = (t.account || '').toLowerCase();
    if (!acc) continue;
    let e = byAcct.get(acc);
    if (!e) { e = { buys: [], sells: [] }; byAcct.set(acc, e); }
    if (t.side === 'buy') {
      e.buys.push({ ts: t.ts, block: t.block ?? null, quoteUsd: t.quote_amount || 0, tokens: t.token_amount || 0, hasTax: taxPositive(t.tax_raw) });
    } else if (t.side === 'sell') {
      e.sells.push({ ts: t.ts, tokens: t.token_amount || 0 });
    }
  }

  const tagsByAccount = new Map();
  const counts = Object.fromEntries(BUYER_TAGS.map((t) => [t, 0]));
  let buyerCount = 0, naturalBuyers = 0, naturalBuyers30m = 0;
  const since30m = now - 30 * 60_000;

  for (const [acc, e] of byAcct) {
    if (!e.buys.length) continue; // 只卖不买 → 不是买家
    e.buys.sort((a, b) => a.ts - b.ts);
    buyerCount++;
    const tags = classifyAccount(e, { launchMs, isFarm: farmSet.has(acc), nonce: nonceByAccount.has(acc) ? nonceByAccount.get(acc) : null, priced, cfg });
    if (tags.length) tagsByAccount.set(acc, tags);
    for (const t of tags) counts[t] = (counts[t] || 0) + 1;
    const isNatural = tags.length === 0;
    if (isNatural) {
      naturalBuyers++;
      if (e.buys[0].ts >= since30m) naturalBuyers30m++;
    }
  }

  const ratios = {};
  for (const k of Object.keys(counts)) ratios[`${k}Ratio`] = buyerCount ? counts[k] / buyerCount : 0;

  return { tagsByAccount, ratios, counts, naturalBuyers, naturalBuyers30m, buyerCount };
}

// tax_raw 落库为字符串(报价币最小单位)。>0 即被曲线收了狙击税。
export function taxPositive(taxRaw) {
  if (taxRaw == null) return false;
  try { return BigInt(taxRaw) > 0n; } catch { return Number(taxRaw) > 0; }
}
