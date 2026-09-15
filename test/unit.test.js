import test from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import { fourMemeEvents } from '../src/abi.js';
import { evaluateTier } from '../src/alert.js';
import { classifyTradeSafety } from '../src/score.js';
import { resolveQuote, quoteUsd } from '../src/enrich.js';
import { normalizeSwap, pickToken } from '../src/discover.js';
import { admissionFor } from '../src/config.js';
import { chainConfig } from '../src/config.js';
import { shouldRetryMeta, nextMetaState, metaBackoffMs, META_MAX_ATTEMPTS } from '../src/metaretry.js';
import * as momentum from '../src/momentum.js';
import { graduatedByCurve } from '../src/pool.js';
import { goplusCheck } from '../src/goplus.js';
import { classifyAccount, classifyTokenBuyers, taxPositive, BUYER_DEFAULTS } from '../src/buyer.js';
import { resolvePrice, sourceOf, PRICE_STALE_MS, PRICE_UNKNOWN_MS, isImplausibleUsd } from '../src/price.js';
import { isFullRangePool } from '../src/enrich.js';
import { recordPoolState, getPoolState, forgetPoolState } from '../src/poolstate.js';

// —— 1. Four.meme 事件签名的 topic0 必须与真实链上日志一致 ——
// 这些 topic0 来自实际观测（见 review 报告）。类型排错会导致 selector 变化。
test('Four.meme 事件 topic0 与观测值前缀一致', () => {
  const byName = Object.fromEntries(fourMemeEvents.map((e) => [e.name, e]));
  const expect = {
    TokenCreate: '0x396d5e90',
    TokenPurchase: '0x7db52723',
    TokenSale: '0x0a5575b3',
  };
  for (const [name, prefix] of Object.entries(expect)) {
    const sel = toEventSelector(byName[name]);
    assert.equal(sel.slice(0, 10), prefix, `${name} topic0 应以 ${prefix} 开头，实得 ${sel}`);
  }
});

// —— 2. evaluateTier：分级逻辑（单出口对象，取 .tier）——
const tierOf = (cand, m) => evaluateTier(cand, m).tier;
const base = {
  liquidityUsd: 0, priceUsd: 0, marketCapUsd: 0, volumeUsd: 0,
  holders: 0, uniqueBuyers: 0, holderGrowthPct: 0, copycats: 0,
  narrativeHits: [], isOriginal: true, graduated: false, listing: false,
};

test('毕业(listing) 直接判 T3', () => {
  assert.equal(tierOf({}, { ...base, listing: true }), 'T3');
});

test('市值+流动性双达标且净流入超过深度比例门槛判 T2', () => {
  // 深度 6万 -> 门槛 max(2000, 60000×0.5%)=2000；净流入 5000 达标
  assert.equal(tierOf({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, netIn30m: 5000 }), 'T2');
});

test('纯体量+微弱净流入停在 T1（净流入低于深度比例门槛）', () => {
  // 大市值+大深度但净流入仅 $1（<$2000 下限）、无新买家 -> 停 T1，避免换库/换 VPS 时刷屏
  assert.equal(tierOf({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, netIn30m: 1 }), 'T1');
  // 净流入=0、无新买家同样停 T1
  assert.equal(tierOf({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000 }), 'T1');
  // 深度越大门槛越高：深度 100万 -> 门槛 5000，净流入 3000 不够
  assert.equal(tierOf({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 1000000, netIn30m: 3000 }), 'T1');
  // 有足量新买家也可升 T2（动量的另一条腿）
  assert.equal(tierOf({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, newBuyers30m: 12 }), 'T2');
});

test('仿盘热度只做放大器：需叠加体量或动量才升 T2', () => {
  const m = { ...base, copycats: 5 };
  // 仅同名多、无体量无动量 -> 不再单独构成 T2（曾经的误报根因）
  assert.equal(tierOf({}, { ...m, isOriginal: true }), 'T0');
  // 叠加 T1 级市值 -> 仿盘腿放大为 T2
  assert.equal(tierOf({}, { ...m, isOriginal: true, marketCapUsd: 120000 }), 'T2');
  // 叠加实时净流入(≥ 深度门槛下限 $2000) -> 同样升 T2
  assert.equal(tierOf({}, { ...m, isOriginal: true, netIn30m: 2500 }), 'T2');
  // 非原版即便同名多也不升级
  assert.equal(tierOf({}, { ...m, isOriginal: false, marketCapUsd: 120000 }), 'T1');
});

test('买家数达标判 T1', () => {
  assert.equal(tierOf({}, { ...base, uniqueBuyers: 40 }), 'T1');
});

test('毕业腿加动量门：仅毕业无动量停 T1（Pons 高毕业率不刷屏）；毕业+动量才 T2', () => {
  // 仅 graduated、无任何动量 -> 不再单独升 T2（毕业是流水线事件不是信号）
  assert.notEqual(tierOf({}, { ...base, graduated: true }), 'T2');
  // 毕业 + 新买家达标 -> T2
  assert.equal(tierOf({}, { ...base, graduated: true, newBuyers30m: 12 }), 'T2');
  // 毕业 + 净流入达标（深度门槛下限 $2000）-> T2
  assert.equal(tierOf({}, { ...base, graduated: true, netIn30m: 2500 }), 'T2');
});

test('增速触发需满足最小买家基数', () => {
  // holderGrowth10mPct=30，growthMinBuyers=20
  assert.equal(tierOf({}, { ...base, uniqueBuyers: 7, holderGrowthPct: 40 }), 'T0');
  assert.equal(tierOf({}, { ...base, uniqueBuyers: 22, holderGrowthPct: 40 }), 'T1');
});

test('叙事乘数放宽阈值：命中叙事时更低市值即可 T1', () => {
  // T1.marketCapUsd=100000，narrativeMultiplier=0.5 -> 命中后 5万即达标
  const m = { ...base, marketCapUsd: 60000 };
  assert.equal(tierOf({}, { ...m, narrativeHits: [] }), 'T0');
  assert.equal(tierOf({}, { ...m, narrativeHits: ['trump'] }), 'T1');
});

test('无信号维持 T0', () => {
  assert.equal(tierOf({}, base), 'T0');
});

// —— 2b. evaluateTier 三条独立新鲜度门 + capTier 封顶（单出口）——
test('WAIT 的 capTier 把 T2 强提示封顶到 T1', () => {
  const m = { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, netIn30m: 5000, capTier: 'T1' };
  const r = evaluateTier({}, m);
  assert.equal(r.rawTier, 'T2', 'rawTier 仍是 T2');
  assert.equal(r.tier, 'T1', 'capTier=T1 封顶 -> T1');
});

test('成交不新鲜(>10min)把 T2 封顶到 T1', () => {
  const now = 10_000_000;
  const m = { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, netIn30m: 5000,
    now, lastTradeTs: now - 11 * 60_000 };
  const r = evaluateTier({}, m);
  assert.equal(r.rawTier, 'T2');
  assert.equal(r.tier, 'T1');
  assert.ok(r.gaps.includes('成交不新鲜'));
});

test('往返结果过期(>10min)时毕业币强提示被降级至 T1；新鲜则恢复 T2', () => {
  const now = 10_000_000;
  const g = { ...base, graduated: true, graduatedAt: now - 5 * 60_000, now, lastTradeTs: now - 60_000, newBuyers30m: 12 };
  // 往返过期 -> 封顶 T1
  const stale = evaluateTier({}, { ...g, roundTripCheckedAt: now - 11 * 60_000 });
  assert.equal(stale.rawTier, 'T2', '毕业腿(≤60min) -> rawTier T2');
  assert.equal(stale.tier, 'T1');
  assert.ok(stale.gaps.includes('往返未核验/过期'));
  // 往返新鲜 -> 恢复 T2
  const fresh = evaluateTier({}, { ...g, roundTripCheckedAt: now - 60_000 });
  assert.equal(fresh.tier, 'T2');
});

test('毕业 8 小时老币仅有成交、无动量 -> 毕业腿失效，不触发 T2', () => {
  const now = 10_000_000;
  const m = { ...base, graduated: true, graduatedAt: now - 8 * 3600_000,
    marketCapUsd: 120000, liquidityUsd: 60000, depthUsd: 60000, // 达 T1 体量但无净流入/新买家
    now, lastTradeTs: now - 60_000, roundTripCheckedAt: now - 60_000 };
  const r = evaluateTier({}, m);
  assert.notEqual(r.rawTier, 'T2', '毕业新鲜度过期 -> 毕业腿不再单独构成 T2');
  assert.notEqual(r.tier, 'T2');
});

// —— 3. resolveQuote：符号与地址两种写法必须解析为同一对象 ——
const qcfg = {
  quoteTokens: {
    WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  },
};

test('resolveQuote：符号与地址等价、大小写无关', () => {
  const bySym = resolveQuote(qcfg, 'WBNB');
  const byAddr = resolveQuote(qcfg, '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
  assert.deepEqual(bySym, byAddr);
  assert.equal(bySym.sym, 'WBNB');
  assert.equal(bySym.decimals, 18);
  assert.equal(resolveQuote(qcfg, '0xdeadbeef'), null);
  assert.equal(resolveQuote(qcfg, null), null);
});

test('resolveQuote：零地址(Four.meme BNB 曲线) 映射到 WBNB', () => {
  const z = resolveQuote(qcfg, '0x0000000000000000000000000000000000000000');
  assert.equal(z.sym, 'WBNB');
  assert.equal(z.decimals, 18);
});

// —— curveMetrics：报价币定价（市值差 700 倍根因回归） ——
// USDT 曲线的 lastPrice/funds 单位是 USDT，绝不能乘以 BNB 现价。
test('curveMetrics USDT 曲线：市值按 USDT 计价而非 BNB', () => {
  const token = '0x00000000000000000000000000000000000000a1';
  // BINANCE HOMER 链上实测：lastPrice=3.907e13(raw,18位) => 3.907e-5 USDT/枚
  momentum.onTrade({ token, account: '0xbuyer', price: 39070000000000n, cost: 100n * 10n ** 18n, funds: 9021n * 10n ** 18n, offers: 0n, isBuy: true, ts: Date.now() });
  const supply = 1e9; // 10 亿枚
  const m = momentum.curveMetrics(token, supply, 1 /* USDT=$1 */, 18);
  assert.ok(Math.abs(m.marketCapUsd - 39070) < 50, `市值应≈$39,070，实得 ${m.marketCapUsd}`);
  assert.ok(Math.abs(m.fundsUsd - 9021) < 1, `募集应≈$9,021，实得 ${m.fundsUsd}`);
  // 若误按 BNB(~$700)计价会得到 ~$27M，这里断言远低于该量级
  assert.ok(m.marketCapUsd < 1e6, '不应被放大到百万级(BNB 误算)');
});

test('curveMetrics BNB 曲线：同 lastPrice 下乘以 BNB 现价', () => {
  const token = '0x00000000000000000000000000000000000000b2';
  momentum.onTrade({ token, account: '0xbuyer', price: 5740000000n /* 5.74e-9 BNB/枚 */, cost: 1n * 10n ** 18n, funds: 5n * 10n ** 18n, offers: 0n, isBuy: true, ts: Date.now() });
  const m = momentum.curveMetrics(token, 1e9, 700 /* BNB=$700 */, 18);
  assert.ok(Math.abs(m.marketCapUsd - 4018) < 50, `市值应≈$4,018，实得 ${m.marketCapUsd}`);
});

test('curveMetrics 未知报价币：不定价(0)但仍计买家', () => {
  const token = '0x00000000000000000000000000000000000000c3';
  momentum.onTrade({ token, account: '0xbuyer', price: 39070000000000n, cost: 100n * 10n ** 18n, funds: 9021n * 10n ** 18n, offers: 0n, isBuy: true, ts: Date.now() });
  const m = momentum.curveMetrics(token, 1e9, null /* 未知报价币 */, 18);
  assert.equal(m.marketCapUsd, 0);
  assert.equal(m.fundsUsd, 0);
  assert.equal(m.uniqueBuyers, 1);
});

// lastTradeTs：归档改为「基于活动」的根据——买/卖都刷新，取最新
test('momentum.lastTradeTs：买/卖都刷新为最新成交时间', () => {
  const token = '0x00000000000000000000000000000000000000d4';
  assert.equal(momentum.lastTradeTs(token), 0); // 无记录
  momentum.onTrade({ token, account: '0xb', isBuy: true, ts: 1000 });
  assert.equal(momentum.lastTradeTs(token), 1000);
  momentum.onTrade({ token, account: null, isBuy: false, ts: 5000 }); // 卖出也算活跃
  assert.equal(momentum.lastTradeTs(token), 5000);
  momentum.onTrade({ token, account: '0xc', isBuy: true, ts: 3000 }); // 乱序旧成交不回退
  assert.equal(momentum.lastTradeTs(token), 5000);
});

// —— 4. normalizeSwap：D3-A′ 核心买卖方向判定，V2/V3 × 买/卖 × token0/token1 排序 ——
const E = (n) => BigInt(n) * 10n ** 18n; // human -> wei(18)
function pool(poolType, quoteIsToken0) {
  return { poolType, quoteIsToken0, quoteDecimals: 18, tokenDecimals: 18, quoteSym: 'WBNB', token: '0xToken' };
}

test('normalizeSwap V2 买入(quote=token0)', () => {
  const l = { address: '0xpool', args: { amount0In: E(10), amount1In: 0n, amount0Out: 0n, amount1Out: E(100), to: '0xBuyer' } };
  const r = normalizeSwap(l, pool('v2', true), 'bsc');
  assert.equal(r.side, 'buy');
  assert.equal(r.quoteHuman, 10);
  assert.equal(r.tokenHuman, 100);
  assert.equal(r.account, '0xBuyer');
});

test('normalizeSwap V2 卖出(quote=token0)', () => {
  const l = { address: '0xpool', args: { amount0In: 0n, amount1In: E(100), amount0Out: E(9), amount1Out: 0n, to: '0xSeller' } };
  const r = normalizeSwap(l, pool('v2', true), 'bsc');
  assert.equal(r.side, 'sell');
  assert.equal(r.quoteHuman, 9);
  assert.equal(r.tokenHuman, 100);
});

test('normalizeSwap V2 买入(quote=token1，排序相反)', () => {
  const l = { address: '0xpool', args: { amount0In: 0n, amount1In: E(10), amount0Out: E(100), amount1Out: 0n, to: '0xBuyer' } };
  const r = normalizeSwap(l, pool('v2', false), 'bsc');
  assert.equal(r.side, 'buy');
  assert.equal(r.quoteHuman, 10);
  assert.equal(r.tokenHuman, 100);
});

test('normalizeSwap V3 买入(quote=token0，delta 正=池收到 quote)', () => {
  const l = { address: '0xpool', args: { amount0: E(5), amount1: -E(50), recipient: '0xBuyer' } };
  const r = normalizeSwap(l, pool('v3', true), 'bsc');
  assert.equal(r.side, 'buy');
  assert.equal(r.quoteHuman, 5);
  assert.equal(r.tokenHuman, 50);
  assert.equal(r.account, '0xBuyer');
});

test('normalizeSwap V3 卖出(quote=token0，delta 负=池付出 quote)', () => {
  const l = { address: '0xpool', args: { amount0: -E(3), amount1: E(30), recipient: '0xSeller' } };
  const r = normalizeSwap(l, pool('v3', true), 'bsc');
  assert.equal(r.side, 'sell');
  assert.equal(r.quoteHuman, 3);
  assert.equal(r.tokenHuman, 30);
});

test('normalizeSwap V3 买入(quote=token1，排序相反)', () => {
  const l = { address: '0xpool', args: { amount0: -E(50), amount1: E(5), recipient: '0xBuyer' } };
  const r = normalizeSwap(l, pool('v3', false), 'bsc');
  assert.equal(r.side, 'buy');
  assert.equal(r.quoteHuman, 5);
  assert.equal(r.tokenHuman, 50);
});

// —— 毕业检测（状态驱动）：修复「进度 100% 却无池，卡片冻结在毕业价」的 bug ——
// offers 耗尽 或 募集达标(funds≥maxRaising) → 判定已毕业，触发反查池子。
test('graduatedByCurve：offers 耗尽且有募集 → 已毕业', () => {
  // 币安镇长/捏捏 现场：offers=0、funds>0、进度 100%
  assert.equal(graduatedByCurve({ max_raising: null }, { offersPct: 0, fundsQuote: 12000, uniqueBuyers: 30 }, 18), true);
});

test('graduatedByCurve：募集达到 maxRaising → 已毕业(即使 offers 尚未归零)', () => {
  // maxRaising=12000 USDT(6→这里用 18 位 raw)，funds 达标
  const maxRaisingRaw = (12000n * 10n ** 18n).toString();
  const cand = { max_raising: maxRaisingRaw };
  assert.equal(graduatedByCurve(cand, { offersPct: 3, fundsQuote: 12000, uniqueBuyers: 40 }, 18), true);
});

test('graduatedByCurve：曲线期(offers 充足、募集未达标) → 未毕业', () => {
  const maxRaisingRaw = (12000n * 10n ** 18n).toString();
  const cand = { max_raising: maxRaisingRaw };
  assert.equal(graduatedByCurve(cand, { offersPct: 42, fundsQuote: 5000, uniqueBuyers: 12 }, 18), false);
});

test('graduatedByCurve：无成交数据(offers 默认 0、无募集无买家) → 不误判毕业', () => {
  // momentum 初始态 offers=0n → offersPct=0，但 funds/buyers 皆 0，不能当毕业
  assert.equal(graduatedByCurve({ max_raising: null }, { offersPct: 0, fundsQuote: 0, uniqueBuyers: 0 }, 18), false);
});

test('graduatedByCurve：无 curve → false', () => {
  assert.equal(graduatedByCurve({ max_raising: '1' }, null, 18), false);
});

// —— 共享 GoPlus 客户端：缓存 / 在途合并 / 微批 / N/A 字段 ——
function mockGoplus(rows) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const addrs = new URL(url).searchParams.get('contract_addresses').split(',');
    const result = {};
    for (const a of addrs) if (rows[a.toLowerCase()]) result[a.toLowerCase()] = rows[a.toLowerCase()];
    return { json: async () => ({ result }) };
  };
  return calls;
}

test('goplus 微批：同窗口多地址合并为一次请求，税率换算正确', async () => {
  const calls = mockGoplus({
    '0xa1': { is_honeypot: '0', sell_tax: '0.02', buy_tax: '0.01', cannot_sell_all: '0' },
    '0xa2': { is_honeypot: '1', sell_tax: '0.5', buy_tax: '0' },
  });
  const [a, b] = await Promise.all([goplusCheck('56', '0xA1'), goplusCheck('56', '0xA2')]);
  assert.equal(calls.length, 1, '两个地址应合并为一次请求');
  assert.equal(a.sellTaxBps, 200);
  assert.equal(b.isHoneypot, true);
});

test('goplus 缓存 + 在途合并：重复查同地址不再打网络', async () => {
  mockGoplus({ '0xb1': { is_honeypot: '0', sell_tax: '0.03' } });
  await goplusCheck('56', '0xB1'); // 填充缓存
  const calls = mockGoplus({ '0xb1': { is_honeypot: '0', sell_tax: '0.03' } });
  const [c, d] = await Promise.all([goplusCheck('56', '0xB1'), goplusCheck('56', '0xB1')]);
  assert.equal(calls.length, 0, '命中缓存应 0 次请求');
  assert.equal(c.sellTaxBps, 300);
  assert.equal(c, d);
});

test('goplus N/A 字段：曲线期空字段记入 naFields，供三态回落 WAIT', async () => {
  mockGoplus({ '0xc1': { is_honeypot: '', sell_tax: '', buy_tax: '' } });
  const r = await goplusCheck('56', '0xC1');
  // cannot_sell_all 缺省(undefined)也计入 N/A
  assert.deepEqual(r.naFields.sort(), ['buyTax', 'cannotSellAll', 'isHoneypot', 'sellTax']);
});

// —— classifyTradeSafety 真值表：三态折叠的 8 条分支 ——
// 优先级：GoPlus 显式正例 → 曲线期模板 → 毕业后往返 → GoPlus 补位。buyReverted/noTokens 一律 WAIT。
const cleanGp = { isHoneypot: false, cannotSellAll: false, sellTaxBps: 300, naFields: [] };

test('真值表①：GoPlus 貔貅但毕业往返 ok -> WAIT(数据冲突)，往返是真实执行不被快照误杀', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'ok', sellTaxBps: 0 },
    goplus: { isHoneypot: true, cannotSellAll: false, sellTaxBps: 0, naFields: [] },
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.source, 'conflict');
  assert.equal(r.capTier, 'T1');
  assert.ok(r.softFlags?.includes('数据冲突'));
});

test('真值表①b：GoPlus 貔貅且无往返可对质(曲线期) -> REJECT(采信 GoPlus)', () => {
  const r = classifyTradeSafety({
    graduated: false, templateMatch: true, roundTrip: null,
    goplus: { isHoneypot: true, cannotSellAll: false, sellTaxBps: 0, naFields: [] },
  });
  assert.equal(r.state, 'REJECT');
  assert.equal(r.source, 'goplus');
});

test('真值表②：GoPlus 无法全部卖出 -> REJECT', () => {
  const r = classifyTradeSafety({
    graduated: false, templateMatch: true,
    goplus: { isHoneypot: false, cannotSellAll: true, sellTaxBps: 0, naFields: [] },
  });
  assert.equal(r.state, 'REJECT');
});

test('真值表③：GoPlus 卖税≥20% 且无往返可对质 -> REJECT', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'unsupported' },
    goplus: { isHoneypot: false, cannotSellAll: false, sellTaxBps: 2500, naFields: [] },
  });
  assert.equal(r.state, 'REJECT');
  assert.equal(r.source, 'goplus');
});

test('真值表④：曲线期命中平台模板 -> PASS(template)', () => {
  const r = classifyTradeSafety({ graduated: false, templateMatch: true, roundTrip: null, goplus: null });
  assert.equal(r.state, 'PASS');
  assert.equal(r.source, 'template');
  assert.equal(r.capTier, null);
});

test('真值表⑤：曲线期未命中模板 -> WAIT 封顶 T1', () => {
  const r = classifyTradeSafety({ graduated: false, templateMatch: false, roundTrip: null, goplus: null });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.capTier, 'T1');
});

test('真值表⑥：毕业往返 ok 且卖税 <20% -> PASS(roundtrip)', () => {
  const r = classifyTradeSafety({ graduated: true, roundTrip: { status: 'ok', sellTaxBps: 300 }, goplus: null });
  assert.equal(r.state, 'PASS');
  assert.equal(r.source, 'roundtrip');
  assert.equal(r.sellTaxBps, 300);
});

test('真值表⑦：毕业往返卖出 revert -> REJECT(疑似貔貅)', () => {
  const r = classifyTradeSafety({ graduated: true, roundTrip: { status: 'sellReverted' }, goplus: null });
  assert.equal(r.state, 'REJECT');
  assert.equal(r.source, 'roundtrip');
});

test('真值表⑧：毕业往返买入 revert -> WAIT（交易未开/反机器人，退避复查）', () => {
  const r = classifyTradeSafety({ graduated: true, roundTrip: { status: 'buyReverted' }, goplus: null });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.capTier, 'T1');
});

test('真值表⑨：往返不可用 + GoPlus 干净 -> PASS(goplus 补位)', () => {
  const r = classifyTradeSafety({ graduated: true, roundTrip: { status: 'unsupported' }, goplus: cleanGp });
  assert.equal(r.state, 'PASS');
  assert.equal(r.source, 'goplus');
});

test('真值表⑩：往返不可用 + GoPlus 关键字段 N/A -> WAIT', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'error' },
    goplus: { isHoneypot: false, cannotSellAll: false, sellTaxBps: 0, naFields: ['sellTax', 'isHoneypot', 'cannotSellAll'] },
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.capTier, 'T1');
});

test('真值表⑪：毕业中(池未接上) -> WAIT，即便字节码像模板也不 PASS 强提示', () => {
  const r = classifyTradeSafety({ graduated: false, graduating: true, templateMatch: true, roundTrip: null, goplus: null });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.source, 'graduating');
  assert.equal(r.capTier, 'T1');
});

// —— M3-1b 部署前修复：Pons 工厂判据 + v4 未核验豁免 ——
test('工厂判据：曲线期 platformDeployed（工厂逐币部署）-> PASS(factory)，不看字节码哈希', () => {
  const r = classifyTradeSafety({
    graduated: false, platformDeployed: true, templateMatch: false, roundTrip: null, goplus: null,
  });
  assert.equal(r.state, 'PASS');
  assert.equal(r.source, 'factory');
  assert.equal(r.capTier, null);
  assert.ok(r.naFields?.includes('sellTax'));
});

test('工厂判据：毕业中优先于 platformDeployed -> WAIT(graduating)，不因工厂部署放行', () => {
  const r = classifyTradeSafety({
    graduated: false, graduating: true, platformDeployed: true, templateMatch: false, roundTrip: null, goplus: null,
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.source, 'graduating');
  assert.equal(r.capTier, 'T1');
});

test('v4 未核验豁免：毕业后 v4 unsupported + 允许未核验强信号 -> WAIT 但不封顶(source=unverified)', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'unsupported' }, goplus: null, allowUnverifiedStrong: true,
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.source, 'unverified');
  assert.equal(r.capTier, null);
  assert.ok(r.softFlags?.includes('未核验路径'));
});

test('v4 未核验豁免：同场景但未开启豁免 -> WAIT 封顶 T1', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'unsupported' }, goplus: null, allowUnverifiedStrong: false,
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.capTier, 'T1');
  assert.notEqual(r.source, 'unverified');
});

test('v4 未核验豁免：仅限 unsupported，error 状态不豁免（仍封顶 T1）', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'error' }, goplus: null, allowUnverifiedStrong: true,
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.capTier, 'T1');
  assert.notEqual(r.source, 'unverified');
});

// —— M3-1b 部署前修复：tiersFor / allowUnverifiedStrongFor / narrativeHit 逐链 ——
import { tiersFor, allowUnverifiedStrongFor } from '../src/config.js';
import { narrativeHit } from '../src/narrative.js';

test('tiersFor：未知链返回全局 tiers，不抛错', () => {
  const g = tiersFor(undefined);
  assert.ok(g && typeof g === 'object');
  assert.deepEqual(tiersFor('__no_such_chain__'), g);
});

test('tiersFor：robinhood 覆盖 T1/T2 且浅合并保留全局其它字段', () => {
  const g = tiersFor(undefined);
  const rh = tiersFor('robinhood');
  assert.equal(rh.T1.marketCapUsd, 30000);
  assert.equal(rh.T2.marketCapUsd, 150000);
  assert.equal(rh.T2.minLiquidityUsd, 20000);
  // 全局 T1 其它键仍在（浅合并，未被整体替换）
  for (const k of Object.keys(g.T1 || {})) {
    if (k !== 'marketCapUsd') assert.equal(rh.T1[k], g.T1[k]);
  }
});

test('allowUnverifiedStrongFor：robinhood 在有效期内为 true，未知链为 false', () => {
  assert.equal(allowUnverifiedStrongFor('__no_such_chain__'), false);
  assert.equal(allowUnverifiedStrongFor(undefined), false);
  // robinhood 配置 until=2026-09-30，当前(测试运行)应在期内
  const rh = allowUnverifiedStrongFor('robinhood');
  assert.equal(typeof rh, 'boolean');
});

test('narrativeHit：robinhood 叠加逐链关键词（TSLA 命中），未知链仅全局', () => {
  const hits = narrativeHit('robinhood', 'TSLA moon', 'TSLA');
  assert.ok(hits.some((h) => h.toLowerCase() === 'tsla'));
  // 未知链不应命中 robinhood 专属词
  const none = narrativeHit('__no_such_chain__', 'TSLA moon', 'TSLA');
  assert.ok(!none.some((h) => h.toLowerCase() === 'tsla'));
});

test('narrativeHit：ASCII 关键词整词匹配——AI 不误命中 chain/train，Inu 不误命中 minute', () => {
  // 子串误命中的三个反例：都不应命中
  assert.deepEqual(narrativeHit('robinhood', 'onchain train', 'CHAIN'), []);
  assert.deepEqual(narrativeHit('robinhood', 'every minute', 'MIN'), []);
  assert.deepEqual(narrativeHit('robinhood', 'stocking filler', 'SOCK'), []);
  // 整词命中：AI 作为独立词、$AI symbol
  assert.ok(narrativeHit('robinhood', 'AI agent', '').some((h) => h === 'ai'));
  assert.ok(narrativeHit('robinhood', 'super AI', 'AI').some((h) => h === 'ai'));
  // Inu 作为整词命中
  assert.ok(narrativeHit('robinhood', 'Shiba Inu', 'INU').some((h) => h === 'inu'));
});

// —— 往返模拟纯函数：taxBps 税率换算 ——
import { taxBps, buildPaths } from '../src/roundtrip.js';
import { getAddress } from 'viem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('taxBps：无税/正滑点记 0，正税按 bps，理论量缺失返回 null', () => {
  assert.equal(taxBps(null, 5n), null, '理论量缺失 → null');
  assert.equal(taxBps(0n, 5n), null, '理论量<=0 → null');
  assert.equal(taxBps(100n, 100n), 0, 'got=theo → 0');
  assert.equal(taxBps(100n, 120n), 0, 'got>theo(正滑点) → 0');
  assert.equal(taxBps(100n, 98n), 200, '到手少 2% → 200bps');
  assert.equal(taxBps(10000n, 9500n), 500, '到手少 5% → 500bps');
});

// —— 往返模拟纯函数：buildPaths 买/卖路径 ——
const _pathCfg = {
  quoteTokens: {
    WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  },
};
const _tok = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

test('buildPaths：WBNB 报价单跳，USDT 报价经 WBNB 两跳', () => {
  const w = getAddress(_pathCfg.quoteTokens.WBNB.address);
  const u = getAddress(_pathCfg.quoteTokens.USDT.address);
  const t = getAddress(_tok);

  const wbnb = buildPaths(_pathCfg, 'WBNB', _tok);
  assert.deepEqual(wbnb.buyPath, [w, t], 'WBNB 买单跳');
  assert.deepEqual(wbnb.sellPath, [t, w], 'WBNB 卖单跳');

  const usdt = buildPaths(_pathCfg, 'USDT', _tok);
  assert.deepEqual(usdt.buyPath, [w, u, t], 'USDT 买两跳 WBNB→USDT→token');
  assert.deepEqual(usdt.sellPath, [t, u, w], 'USDT 卖两跳 token→USDT→WBNB');
});

test('buildPaths：报价币无法解析返回 null', () => {
  assert.equal(buildPaths(_pathCfg, 'NOPE', _tok), null);
  assert.equal(buildPaths({ quoteTokens: {} }, 'WBNB', _tok), null, '无 WBNB → null');
});

// —— 固化 fixture：毕业币真实往返锚点 + 曲线期 GoPlus 空字段 ——
const _fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/roundtrip.fixture.json', import.meta.url)), 'utf8'),
);

test('fixture：毕业币 CAKE 往返正常(status 0)，回收率≈99.5%，无税', () => {
  const g = _fixture.graduated;
  assert.equal(g.statusCode, 0, '正常往返 status=0');
  assert.equal(g.buyTaxBps, 0, 'CAKE 无买税');
  assert.equal(g.sellTaxBps, 0, 'CAKE 无卖税');
  assert.ok(g.recoveredBps > 9000 && g.recoveredBps <= 10000, `回收率应≈9950，实得 ${g.recoveredBps}`);
});

test('fixture：RPC 探测返回常量 42(0x..2a)，说明支持 stateOverride', () => {
  assert.ok(/2a$/.test(_fixture.stateOverrideProbe), '探测应返回 0x..002a');
});

test('fixture：曲线期 GoPlus 关键字段为空(→三态回落 WAIT)', () => {
  const r = _fixture.curvePhaseGoplusRaw;
  assert.equal(r.is_honeypot, '', '曲线期貔貅字段空');
  assert.equal(r.sell_tax, '', '曲线期卖税字段空');
  assert.equal(r.buy_tax, '', '曲线期买税字段空');
});

test('fixture：V3 毕业币 CAKE 往返正常(status 0)，回收率≈99.4%(Uniswap SwapRouter02)', () => {
  const g = _fixture.graduatedV3;
  assert.equal(g.statusCode, 0, 'V3 正常往返 status=0');
  assert.ok(g.recoveredBps > 9000 && g.recoveredBps <= 10000, `V3 回收率应≈9940，实得 ${g.recoveredBps}`);
});

test('taxBps 有税代币桩：合约按买后储备返回 theoSell，10%卖税→1000bps 不被冲击低估', () => {
  // 模拟合约返回：买后储备下理论卖出 theoSell=1_000_000，实际到手 gotSell=900_000（扣 10% 卖税）。
  // 旧实现用买前储备算 theoSell 会偏小、把税钳成 0；现在 theo 与卖出同一时点，税率如实为 1000bps。
  assert.equal(taxBps(1_000_000n, 900_000n), 1000, '10% 卖税 → 1000bps');
  assert.equal(taxBps(1_000_000n, 800_000n), 2000, '20% 卖税 → 命中 REJECT 阈值');
  // 无税代币正滑点：买后储备更深，gotSell 可能 ≥ theoSell → 钳 0，不误报
  assert.equal(taxBps(1_000_000n, 1_005_000n), 0, '正滑点 → 0');
});

// —— Robinhood / Pons(curve-per-token)：事件签名 + 解码 + 定价口径（M0 冻结 fixture 驱动）——
import { ponsFactoryEvents, ponsCurveEvents, ponsHookEvents } from '../src/abi.js';
import { decodeEventLog } from 'viem';

const _rh = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/robinhood.json', import.meta.url)), 'utf8'),
);

test('Pons 事件签名 topic0 与链上冻结值精确一致（错一位类型即 selector 变，viem events 会静默丢弃）', () => {
  const all = [...ponsFactoryEvents, ...ponsCurveEvents, ...ponsHookEvents];
  const byName = Object.fromEntries(all.map((e) => [e.name, e]));
  for (const name of ['TokenLaunched', 'PoolGraduated', 'LaunchSwept', 'CurveBuy', 'CurveSell', 'PoolRegistered']) {
    assert.ok(byName[name], `缺少事件 ${name}`);
    assert.equal(toEventSelector(byName[name]), _rh.topics[name], `${name} topic0 与 fixture 不一致`);
  }
});

test('Pons TokenLaunched fixture 解码：pairToken=0x0 表示原生 ETH 计价，阈值 4.2 ETH', () => {
  const la = _rh.launchTx.events.find((e) => e.event === 'TokenLaunched').args;
  assert.match(la.pairToken, /^0x0+$/, 'pairToken 为零地址 → 原生 ETH 计价');
  assert.equal(la.graduationThreshold, '4200000000000000000', '标准 meme 毕业阈值 4.2 ETH');
  assert.notEqual(la.curve.toLowerCase(), la.token.toLowerCase(), 'curve 与 token 不同');
});

test('Pons CurveBuy fixture：买家是 recipient(非 wallet=Router)，单价=quoteIn·1e18/tokensOut', () => {
  const b = _rh.launchTx.events.find((e) => e.event === 'CurveBuy').args;
  // wallet 是 Pons Router；真实买家/接收人是 recipient
  assert.equal(b.wallet.toLowerCase(), '0xe33e9e479df8802cb0866d5d05258bec4cf62948', 'wallet=Router');
  assert.notEqual(b.recipient.toLowerCase(), b.wallet.toLowerCase(), 'recipient≠wallet');
  const quoteIn = BigInt(b.quoteIn), tokensOut = BigInt(b.tokensOut);
  const price = (quoteIn * (10n ** 18n)) / tokensOut; // discover.routePonsCurve 同一口径
  // priceUsd = price/1e18 * ethUsd；用假定 ethUsd=4500 断言量级合理（fresh launch 早期市值几千美元级）
  const priceUsd = (Number(price) / 1e18) * 4500;
  const mcapUsd = priceUsd * 1e9; // Pons 固定 10 亿供应
  assert.ok(mcapUsd > 1000 && mcapUsd < 1_000_000, `首笔买入市值应在千~百万美元级，实得 ${Math.round(mcapUsd)}`);
});

test('Pons PoolRegistered fixture：hook 发出，quoteToken=0x0(原生 ETH)，poolId 为 bytes32', () => {
  const p = _rh.graduationTx.events.find((e) => e.event === 'PoolRegistered').args;
  assert.match(p.quoteToken, /^0x0+$/, '原生 ETH 计价池');
  assert.equal(p.poolId.length, 66, 'poolId 是 32 字节(0x+64hex)');
  assert.ok(p.memecoin && /^0x[0-9a-fA-F]{40}$/.test(p.memecoin), 'memecoin 是地址');
});

test('Pons 事件按冻结原始 topics/data 可被 viem 解码（防 ABI 漂移）', () => {
  // 用 fixture 的 poolId 重建 PoolRegistered 的 topics/data，确保 indexed 划分正确。
  const src = _rh.graduationTx.events.find((e) => e.event === 'PoolRegistered');
  const ev = ponsHookEvents.find((e) => e.name === 'PoolRegistered');
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
  const data = '0x' + [src.args.memecoin, src.args.quoteToken, src.args.creator].map((a) => pad(a).slice(2)).join('');
  const dec = decodeEventLog({ abi: [ev], topics: [_rh.topics.PoolRegistered, src.args.poolId], data });
  assert.equal(dec.args.memecoin.toLowerCase(), src.args.memecoin.toLowerCase());
  assert.equal(dec.args.creator.toLowerCase(), src.args.creator.toLowerCase());
});

// —— M2b：Uniswap v4 定价 / 方向 / topic0（Robinhood/Pons）——
import { computeV4Metrics } from '../src/enrich.js';
import { classifyV4Swap } from '../src/discover.js';
import { v4InitializeEvent, v4SwapEvent } from '../src/abi.js';

test('v4 事件 topic0 与冻结值一致（防 ABI 漂移）', () => {
  assert.equal(toEventSelector(v4InitializeEvent), _rh.topics.v4Initialize, 'Initialize topic0');
  assert.equal(toEventSelector(v4SwapEvent), _rh.topics.v4Swap, 'Swap topic0');
});

test('classifyV4Swap：meme=currency1 买入（用户收到 meme>0）', () => {
  // 真实用户买单 fixture：amount1(meme)>0=BUY、amount0(ETH quote)<0=用户付出 → quoteRaw 取反为正
  const s = _rh.v4.realSwapTx.events.find((e) => e.event === 'Swap').args;
  const r = classifyV4Swap({ amount0: BigInt(s.amount0), amount1: BigInt(s.amount1), memeIsCurrency0: false });
  assert.equal(r.side, 'buy');
  assert.equal(r.tokenRaw, BigInt(s.amount1));
  assert.equal(r.quoteRaw, -BigInt(s.amount0));
  assert.ok(r.quoteRaw > 0n, 'quoteRaw 应为正');
});

test('classifyV4Swap：meme=currency1 卖出（用户付出 meme<0）', () => {
  const r = classifyV4Swap({ amount0: 5n, amount1: -50n, memeIsCurrency0: false });
  assert.equal(r.side, 'sell');
  assert.equal(r.tokenRaw, 50n);
  assert.equal(r.quoteRaw, 5n);
});

test('classifyV4Swap：meme=currency0 时按 amount0 判向（符号约定与 V3 池视角相反）', () => {
  // 用户收到 meme(amount0>0)=买、付出 quote(amount1<0)
  const buy = classifyV4Swap({ amount0: 100n, amount1: -8n, memeIsCurrency0: true });
  assert.equal(buy.side, 'buy'); assert.equal(buy.quoteRaw, 8n); assert.equal(buy.tokenRaw, 100n);
  const sell = classifyV4Swap({ amount0: -100n, amount1: 8n, memeIsCurrency0: true });
  assert.equal(sell.side, 'sell'); assert.equal(sell.quoteRaw, 8n); assert.equal(sell.tokenRaw, 100n);
});

test('classifyV4Swap：零 meme delta → null', () => {
  assert.equal(classifyV4Swap({ amount0: 0n, amount1: 0n, memeIsCurrency0: true }), null);
});

// GATE：$AI(USDG 计价 v4 池)链上 extsload 定价 vs DexScreener，偏差 ≤20%。
// sqrtPriceX96/liquidity 为冻结的链上直读值，计算全走 computeV4Metrics 纯函数。
test('computeV4Metrics 定价门：$AI 链上价 vs DexScreener ≤20%', () => {
  const g = _rh.v4.pricingGate;
  const supplyHuman = Number(BigInt(g.totalSupply) / 10n ** BigInt(g.memeDec));
  const m = computeV4Metrics({
    sqrtPriceX96: BigInt(g.sqrtPriceX96), liquidity: BigInt(g.liquidity),
    memeIsCurrency0: g.memeIsCurrency0, memeDec: g.memeDec, quoteDec: g.quoteDec,
    quoteUsd: g.quoteUsd, supplyHuman,
  });
  const dev = Math.abs(m.priceUsd - g.dexScreenerUsd) / g.dexScreenerUsd * 100;
  assert.ok(dev <= g.tolerancePct, `偏差 ${dev.toFixed(2)}% 应 ≤${g.tolerancePct}%（链上 ${m.priceUsd}, DexScreener ${g.dexScreenerUsd}）`);
  assert.ok(m.priceUsd > 0 && m.marketCapUsd > 0, '价格/市值应为正');
});

test('computeV4Metrics：quoteUsd=null(报价币无可信价) → 价格/流动性归零', () => {
  const m = computeV4Metrics({ sqrtPriceX96: 40082679562063991241565n, liquidity: 2903661403571976782n, memeIsCurrency0: true, memeDec: 18, quoteDec: 6, quoteUsd: null, supplyHuman: 1e9 });
  assert.equal(m.priceUsd, 0);
  assert.equal(m.liquidityUsd, 0);
});

test('Initialize fixture：currency0=原生 ETH(0x0)、currency1=memecoin、tickSpacing=200', () => {
  const init = _rh.v4.graduationTx.events.find((e) => e.event === 'Initialize').args;
  assert.match(init.currency0, /^0x0+$/, 'currency0 为原生 ETH');
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(init.currency1), 'currency1 为 memecoin 地址');
  assert.equal(init.tickSpacing, 200);
});

test('HookFeeCollected.payer=memecoin(非买家)：买家须取 tx.from', () => {
  // 已链上核验：payer 是 memecoin 合约地址，与 Initialize.currency1 相同；真实买家在 tx.from。
  const init = _rh.v4.graduationTx.events.find((e) => e.event === 'Initialize').args;
  const fee = _rh.v4.realSwapTx.events.find((e) => e.event === 'HookFeeCollected').args;
  assert.equal(fee.payer.toLowerCase(), init.currency1.toLowerCase(), 'payer 等于 memecoin，故不能当买家');
  assert.ok(/^0x[0-9a-fA-F]{40}$/.test(_rh.v4.realSwapTx.txFrom), 'tx.from 为真实买家');
});

// —— M2c 买家分级（跨链纯函数）——
// 冻结真值表：sniper(税/时间窗)、bot(同块/5min)、farm、dust、fresh、flipper、natural。
const LAUNCH = 1_000_000_000_000; // 任意基准 ms

test('M2c sniper：狙击税 > 0 → sniper（全链）', () => {
  const tags = classifyAccount({ buys: [{ ts: LAUNCH + 10 * 60_000, quoteUsd: 100, tokens: 1000, hasTax: true }] }, { launchMs: LAUNCH });
  assert.ok(tags.includes('sniper'), '有狙击税即 sniper，与买入时间无关');
});

test('M2c sniper：首买距发射 ≤60s → sniper（跨链时间窗）', () => {
  const tags = classifyAccount({ buys: [{ ts: LAUNCH + 30_000, quoteUsd: 100, tokens: 1000, hasTax: false }] }, { launchMs: LAUNCH });
  assert.ok(tags.includes('sniper'), '30s 内买入 = sniper');
  const late = classifyAccount({ buys: [{ ts: LAUNCH + 120_000, quoteUsd: 100, tokens: 1000, hasTax: false }] }, { launchMs: LAUNCH });
  assert.ok(!late.includes('sniper'), '120s 后买入不是 sniper');
});

test('M2c sniper：无 launch_time 时时间窗不误判', () => {
  const tags = classifyAccount({ buys: [{ ts: LAUNCH + 30_000, quoteUsd: 100, tokens: 1000, hasTax: false }] }, { launchMs: null });
  assert.ok(!tags.includes('sniper'), 'launch_time 缺失 → 不按时间窗判 sniper');
});

test('M2c bot：同一区块 ≥3 笔买入 → bot', () => {
  const buys = [
    { ts: LAUNCH + 5 * 60_000, block: 100, quoteUsd: 50, tokens: 100 },
    { ts: LAUNCH + 5 * 60_000, block: 100, quoteUsd: 50, tokens: 100 },
    { ts: LAUNCH + 5 * 60_000, block: 100, quoteUsd: 50, tokens: 100 },
  ];
  assert.ok(classifyAccount({ buys }, { launchMs: LAUNCH }).includes('bot'), '同块 3 笔 = bot');
  // 同块 2 笔(路由拆单)不算
  assert.ok(!classifyAccount({ buys: buys.slice(0, 2) }, { launchMs: LAUNCH }).includes('bot'), '同块 2 笔不算 bot');
});

test('M2c bot：5 分钟内 ≥10 笔买入 → bot', () => {
  const buys = [];
  for (let i = 0; i < 10; i++) buys.push({ ts: LAUNCH + 10 * 60_000 + i * 20_000, block: 200 + i, quoteUsd: 20, tokens: 50 });
  assert.ok(classifyAccount({ buys }, { launchMs: LAUNCH }).includes('bot'), '5min 内 10 笔 = bot');
});

test('M2c dust：累计买入 < $1 → dust', () => {
  const tags = classifyAccount({ buys: [{ ts: LAUNCH + 20 * 60_000, block: 5, quoteUsd: 0.4, tokens: 1 }] }, { launchMs: LAUNCH });
  assert.ok(tags.includes('dust'), '<$1 = dust');
});

test('M3-0 dust priced 守卫：报价币无价(priced=false)时不判 dust', () => {
  const buy = { buys: [{ ts: LAUNCH + 20 * 60_000, block: 5, quoteUsd: 0, tokens: 1000 }] };
  assert.ok(classifyAccount(buy, { launchMs: LAUNCH, priced: true }).includes('dust'), '默认(priced)时 $0 = dust');
  assert.ok(!classifyAccount(buy, { launchMs: LAUNCH, priced: false }).includes('dust'), 'priced=false 时跳过 dust');
});

test('M3-0 dust priced 守卫：classifyTokenBuyers(priced=false) 不把全体标粉尘', () => {
  const trades = [
    { ts: LAUNCH + 1000, side: 'buy', account: '0xa', quote_amount: 0, token_amount: 100 },
    { ts: LAUNCH + 2000, side: 'buy', account: '0xb', quote_amount: 0, token_amount: 200 },
  ];
  const res = classifyTokenBuyers(trades, { launchMs: null, priced: false, now: LAUNCH + 3000 });
  assert.equal(res.counts.dust, 0, 'priced=false 时 dust 计数为 0');
  assert.equal(res.naturalBuyers, 2, '未定价买家仍算自然买家(不被误标)');
});

test('M2c fresh：nonce ≤3 → fresh；nonce 未知不判', () => {
  const buy = { buys: [{ ts: LAUNCH + 20 * 60_000, block: 5, quoteUsd: 100, tokens: 100 }] };
  assert.ok(classifyAccount(buy, { launchMs: LAUNCH, nonce: 1 }).includes('fresh'), 'nonce 1 = fresh');
  assert.ok(!classifyAccount(buy, { launchMs: LAUNCH, nonce: 50 }).includes('fresh'), 'nonce 50 不是 fresh');
  assert.ok(!classifyAccount(buy, { launchMs: LAUNCH, nonce: null }).includes('fresh'), 'nonce 未知不判 fresh');
});

test('M2c flipper：首买后 10 分钟内卖出 ≥90% → flipper', () => {
  const acct = {
    buys: [{ ts: LAUNCH + 20 * 60_000, block: 5, quoteUsd: 100, tokens: 1000 }],
    sells: [{ ts: LAUNCH + 20 * 60_000 + 5 * 60_000, tokens: 950 }],
  };
  assert.ok(classifyAccount(acct, { launchMs: LAUNCH }).includes('flipper'), '5min 内卖 95% = flipper');
  // 11 分钟后才卖 → 不算
  const slow = { buys: acct.buys, sells: [{ ts: LAUNCH + 20 * 60_000 + 11 * 60_000, tokens: 950 }] };
  assert.ok(!classifyAccount(slow, { launchMs: LAUNCH }).includes('flipper'), '窗口外卖出不算 flipper');
});

test('M2c natural：无任何标签', () => {
  const tags = classifyAccount({ buys: [{ ts: LAUNCH + 20 * 60_000, block: 5, quoteUsd: 100, tokens: 100 }] }, { launchMs: LAUNCH, nonce: 50 });
  assert.deepEqual(tags, [], '普通买家无标签');
});

test('M2c classifyTokenBuyers：聚合 ratios + naturalBuyers30m', () => {
  const now = LAUNCH + 40 * 60_000;
  const trades = [
    // 自然买家 A（30min 内首买）
    { ts: now - 10 * 60_000, side: 'buy', account: '0xAAA', quote_amount: 100, token_amount: 100, block: 1 },
    // sniper B（狙击税）
    { ts: now - 5 * 60_000, side: 'buy', account: '0xBBB', quote_amount: 100, token_amount: 100, tax_raw: '5', block: 2 },
    // farm C（由 farmSet 注入）
    { ts: now - 5 * 60_000, side: 'buy', account: '0xCCC', quote_amount: 100, token_amount: 100, block: 3 },
    // 只卖不买 D → 不计入买家
    { ts: now - 5 * 60_000, side: 'sell', account: '0xDDD', token_amount: 50 },
  ];
  const res = classifyTokenBuyers(trades, { launchMs: null, farmSet: new Set(['0xccc']), now });
  assert.equal(res.buyerCount, 3, '3 个买家(D 只卖不算)');
  assert.equal(res.counts.sniper, 1);
  assert.equal(res.counts.farm, 1);
  assert.equal(res.naturalBuyers, 1, '仅 A 是自然买家');
  assert.equal(res.naturalBuyers30m, 1, 'A 在 30min 内首买');
  assert.ok(Math.abs(res.ratios.sniperRatio - 1 / 3) < 1e-9);
});

test('M2c taxPositive：字符串 raw 判正', () => {
  assert.equal(taxPositive('0'), false);
  assert.equal(taxPositive('1'), true);
  assert.equal(taxPositive(null), false);
  assert.equal(taxPositive('123456789012345678'), true);
});

// —— M3-1 priceOf 抽象：冻结「三护栏」真值表（保旧价 / 真归零 / 陈旧上限） ——

test('M3-1 sourceOf：池型 → 来源名', () => {
  assert.equal(sourceOf('v4'), 'amm-v4');
  assert.equal(sourceOf('v3'), 'amm-v3');
  assert.equal(sourceOf('v2'), 'amm-v2');
  assert.equal(sourceOf(null), 'amm-v2');
});

test('M3-1 resolvePrice：曲线期有价 → curve 主源 ok', () => {
  const now = 1_000_000;
  const px = resolvePrice({
    now, hasPool: false, poolType: null,
    poolM: null, curve: { priceUsd: 0.002, fundsUsd: 5000, marketCapUsd: 200000 }, prev: null,
  });
  assert.equal(px.priceUsd, 0.002);
  assert.equal(px.depthUsd, 5000);
  assert.equal(px.marketCapUsd, 200000);
  assert.equal(px.source, 'curve');
  assert.equal(px.state, 'ok');
  assert.equal(px.updatedAt, now);
});

test('M3-1 resolvePrice：毕业池有价 → amm-v* 主源 ok（零回归：与旧 poolM 一致）', () => {
  const now = 2_000_000;
  const poolM = { priceUsd: 0.05, liquidityUsd: 12000, marketCapUsd: 500000, priced: true, drained: false };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v3', poolM, curve: null, prev: null });
  assert.equal(px.priceUsd, 0.05);
  assert.equal(px.depthUsd, 12000);
  assert.equal(px.marketCapUsd, 500000);
  assert.equal(px.source, 'amm-v3');
  assert.equal(px.state, 'ok');
});

test('M3-1 resolvePrice：读失败(poolM=null) → 保旧价、绝不写 0', () => {
  const now = 3_000_000;
  const prev = { price_usd: 0.05, market_cap_usd: 500000, depth_usd: 12000, price_source: 'amm-v3', price_updated_at: now - 60_000 };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v3', poolM: null, curve: null, prev });
  assert.equal(px.priceUsd, 0.05, '保上一次成功价');
  assert.equal(px.marketCapUsd, 500000);
  assert.equal(px.depthUsd, 12000);
  assert.equal(px.source, 'amm-v3');
  assert.equal(px.state, 'ok', '距上次 1min < 10min → 仍 ok');
});

test('M3-1 resolvePrice：读失败 + 距上次 >10min → stale（保旧价）', () => {
  const now = 4_000_000;
  const prev = { price_usd: 0.05, market_cap_usd: 500000, depth_usd: 12000, price_source: 'amm-v3', price_updated_at: now - (PRICE_STALE_MS + 1) };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v3', poolM: null, curve: null, prev });
  assert.equal(px.priceUsd, 0.05);
  assert.equal(px.state, 'stale');
  assert.equal(px.stale, true);
});

test('M3-1 resolvePrice：读失败 + 距上次 >24h → unknown（仍保旧数值不写 0）', () => {
  const now = 5_000_000_000;
  const prev = { price_usd: 0.05, market_cap_usd: 500000, depth_usd: 12000, price_source: 'amm-v3', price_updated_at: now - (PRICE_UNKNOWN_MS + 1) };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v3', poolM: null, curve: null, prev });
  assert.equal(px.priceUsd, 0.05, 'unknown 也不清零，保护 peak MAX 与下游数学');
  assert.equal(px.marketCapUsd, 500000);
  assert.equal(px.state, 'unknown');
});

test('M3-1 resolvePrice：报价腿枯竭(drained) → 真归零 withdrawn', () => {
  const now = 6_000_000;
  const prev = { price_usd: 0.05, market_cap_usd: 500000, depth_usd: 12000, price_source: 'amm-v2', price_updated_at: now - 30_000 };
  const poolM = { priceUsd: 0, liquidityUsd: 0, marketCapUsd: 0, priced: false, drained: true };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v2', poolM, curve: null, prev });
  assert.equal(px.priceUsd, 0, 'rug 真归零');
  assert.equal(px.depthUsd, 0);
  assert.equal(px.marketCapUsd, 0);
  assert.equal(px.state, 'withdrawn');
  assert.equal(px.source, 'amm-v2');
  assert.equal(px.updatedAt, now);
});

test('M3-1 resolvePrice：首见无池无曲线无旧价 → 全 0 + unknown（age=Infinity）', () => {
  const px = resolvePrice({ now: 7_000_000, hasPool: false, poolType: null, poolM: null, curve: null, prev: null });
  assert.equal(px.priceUsd, 0);
  assert.equal(px.marketCapUsd, 0);
  assert.equal(px.depthUsd, 0);
  assert.equal(px.state, 'unknown');
  assert.equal(px.source, null);
});

test('M3-1 resolvePrice：数值字段恒为 number（不返回 null，保护下游）', () => {
  const px = resolvePrice({ now: 8_000_000, hasPool: true, poolType: 'v4', poolM: null, curve: null, prev: {} });
  assert.equal(typeof px.priceUsd, 'number');
  assert.equal(typeof px.depthUsd, 'number');
  assert.equal(typeof px.marketCapUsd, 'number');
});

// —— M3-1b：曲线新鲜度按最后成交时刻、v4 集中池 noActiveLiquidity、事件驱动池状态 ——

test('M3-1b resolvePrice：曲线价但最后成交 >10min → stale（死币灰标）', () => {
  const now = 9_000_000;
  const curve = { priceUsd: 0.001, fundsUsd: 3000, marketCapUsd: 100000, updatedAt: now - (PRICE_STALE_MS + 1) };
  const px = resolvePrice({ now, hasPool: false, poolType: null, poolM: null, curve, prev: null });
  assert.equal(px.priceUsd, 0.001, '价仍在（无新成交不会变）');
  assert.equal(px.source, 'curve');
  assert.equal(px.state, 'stale');
  assert.equal(px.updatedAt, curve.updatedAt, 'updatedAt=最后成交时刻，非 now');
});

test('M3-1b resolvePrice：曲线价但最后成交 >24h → unknown', () => {
  const now = 9_000_000_000;
  const curve = { priceUsd: 0.001, fundsUsd: 3000, marketCapUsd: 100000, updatedAt: now - (PRICE_UNKNOWN_MS + 1) };
  const px = resolvePrice({ now, hasPool: false, poolType: null, poolM: null, curve, prev: null });
  assert.equal(px.state, 'unknown');
});

test('M3-1b resolvePrice：v4 集中池当前 tick 无流动性(noActiveLiquidity) → 保旧价，不 withdrawn', () => {
  const now = 10_000_000;
  const prev = { price_usd: 0.02, market_cap_usd: 300000, depth_usd: 8000, price_source: 'amm-v4', price_updated_at: now - 30_000 };
  const poolM = { priceUsd: 0.02, liquidityUsd: 0, marketCapUsd: 300000, priced: true, drained: false, noActiveLiquidity: true };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v4', poolM, curve: null, prev });
  assert.equal(px.priceUsd, 0.02, '保旧价');
  assert.equal(px.depthUsd, 8000);
  assert.notEqual(px.state, 'withdrawn', '不误判为撤池');
  assert.equal(px.state, 'ok');
});

// —— $MUMO 教训：合理性钳位（报价币无美元价却被填单位错误常量/残留值）——
test('钳位 isImplausibleUsd：价格>$1e6 / 市值>$10 亿 / 深度>市值×100 判离谱；正常值放行', () => {
  assert.equal(isImplausibleUsd({ priceUsd: 2e6 }), true, '价格>$1e6');
  assert.equal(isImplausibleUsd({ marketCapUsd: 1.7e20 }), true, '市值>$10 亿($MUMO)');
  assert.equal(isImplausibleUsd({ marketCapUsd: 1000, depthUsd: 2e5 }), true, '深度>市值×100(单腿单位错)');
  assert.equal(isImplausibleUsd({ priceUsd: 0.002, marketCapUsd: 200000, depthUsd: 5000 }), false, '正常曲线币放行');
  assert.equal(isImplausibleUsd({ marketCapUsd: 0, depthUsd: 0 }), false, '未定价全 0 放行(不误判)');
});

test('钳位 resolvePrice：毕业池算出离谱市值($MUMO) → 归零 + state=implausible，不入 prev/peak', () => {
  const now = 11_000_000;
  const poolM = { priceUsd: 3.6e12, liquidityUsd: 1.8e18, marketCapUsd: 1.7e20, priced: true, drained: false };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v4', poolM, curve: null, prev: null });
  assert.equal(px.state, 'implausible');
  assert.equal(px.priceUsd, 0);
  assert.equal(px.marketCapUsd, 0);
  assert.equal(px.depthUsd, 0);
  assert.equal(px.source, 'amm-v4', '来源仍标注，便于诊断');
});

test('钳位 resolvePrice：上一轮污染的巨值经 keepOld 也被钳位（读失败仍归零，防残留传染）', () => {
  const now = 12_000_000;
  const prev = { price_usd: 3.6e12, market_cap_usd: 1.7e20, depth_usd: 1.8e18, price_source: 'amm-v4', price_updated_at: now - 30_000 };
  const px = resolvePrice({ now, hasPool: true, poolType: 'v4', poolM: null, curve: null, prev });
  assert.equal(px.state, 'implausible', 'keepOld 保出的巨值同样被钳位');
  assert.equal(px.marketCapUsd, 0);
});

test('M3-1b isFullRangePool：Pons hook 命中 或 tickSpacing≥200 才算全区间', () => {
  const cfg = { launchpads: [{ hook: '0xE5E702641EA86f4AE6CC3cDAeD2b886F976bE044' }] };
  assert.equal(isFullRangePool(cfg, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044', null), true, 'Pons hook 命中(大小写无关)');
  assert.equal(isFullRangePool(cfg, null, 200), true, 'tickSpacing≥200');
  assert.equal(isFullRangePool(cfg, null, 60), false, '窄 tickSpacing → 集中池');
  assert.equal(isFullRangePool(cfg, '0x0000000000000000000000000000000000000000', 10), false, '无 hook + 窄间距');
});

test('M3-1b poolState：新鲜(<60s)可取，陈旧返回 null', () => {
  const now = Date.now();
  forgetPoolState('robinhood', '0xpoolid');
  recordPoolState('robinhood', '0xPoolId', { sqrtPriceX96: 123n, liquidity: 456n, tick: 7, ts: now });
  const fresh = getPoolState('robinhood', '0xpoolid');
  assert.ok(fresh, '刚写入 → 新鲜');
  assert.equal(fresh.sqrtPriceX96, 123n);
  assert.equal(fresh.liquidity, 456n);
  assert.equal(getPoolState('robinhood', '0xpoolid', 1000), fresh, '默认阈内可取');
  // 手动写一条 2 分钟前的 → 陈旧
  recordPoolState('robinhood', '0xpoolid', { sqrtPriceX96: 1n, liquidity: 1n, ts: now - 120_000 });
  assert.equal(getPoolState('robinhood', '0xpoolid'), null, '陈旧 → null(回退 RPC)');
  forgetPoolState('robinhood', '0xpoolid');
  assert.equal(getPoolState('robinhood', '0xpoolid', 1e9), null, 'forget 后取不到');
});

test('M3-1b poolState：缺 sqrtPriceX96/liquidity 不写入（不覆盖旧值）', () => {
  forgetPoolState('c', '0xp');
  recordPoolState('c', '0xp', { sqrtPriceX96: null, liquidity: 5n });
  assert.equal(getPoolState('c', '0xp', 1e9), null);
});

// —— Arc pool-first ——

test('admissionFor：Arc 链级覆盖为 3，其它链回落全局默认', () => {
  assert.equal(admissionFor('arc'), 3, 'arc 用链级 admission=3');
  assert.equal(admissionFor('bsc'), 5, 'bsc 无链级覆盖 → 全局默认 5');
  assert.equal(admissionFor(null), 5, '无链名 → 全局默认 5');
});

test('pickToken：恰一侧是报价币 → matched，未登记方即 meme', () => {
  const quote = '0x3600000000000000000000000000000000000000'; // arc USDC
  const meme = '0xabcdef0000000000000000000000000000000001';
  // quote 为 token0
  let r = pickToken(quote, meme, new Set([quote]));
  assert.equal(r.matched, true);
  assert.equal(r.token.toLowerCase(), meme);
  assert.equal(r.quote.toLowerCase(), quote);
  // quote 为 token1（排序相反）
  r = pickToken(meme, quote, new Set([quote]));
  assert.equal(r.matched, true);
  assert.equal(r.token.toLowerCase(), meme);
  assert.equal(r.quote.toLowerCase(), quote);
});

test('pickToken：两侧都非报价币 / 都是报价币 → 不 matched(无法判定)', () => {
  const a = '0xaaaa000000000000000000000000000000000001';
  const b = '0xbbbb000000000000000000000000000000000002';
  const q1 = '0x3600000000000000000000000000000000000000';
  const q2 = '0x3600000000000000000000000000000000000001';
  assert.equal(pickToken(a, b, new Set([q1])).matched, false, '都非报价币');
  assert.equal(pickToken(q1, q2, new Set([q1, q2])).matched, false, '都是报价币');
});

test('Arc 毕业池 v4/Aerodrome 无往返(unsupported) + 收紧豁免 → 放行强提示标未核验(不封 T1)', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'unsupported' },
    goplus: null, allowUnverifiedStrong: true,
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.source, 'unverified');
  assert.equal(r.capTier, null, '未核验路径不封顶到 T1');
  assert.deepEqual(r.softFlags, ['未核验路径']);
});

test('未开豁免的链：毕业后无往返 → 回落 WAIT/T1(安全默认)', () => {
  const r = classifyTradeSafety({
    graduated: true, roundTrip: { status: 'unsupported' },
    goplus: null, allowUnverifiedStrong: false,
  });
  assert.equal(r.state, 'WAIT');
  assert.equal(r.capTier, 'T1', '无豁免 → 封顶 T1');
});

test('Arc 原生 USDC：0x0(v4 currency0) 解析为 USDC_NATIVE(18位, $1)，0x3600(ERC-20 视图) 仍为 USDC(6位)', () => {
  const arc = chainConfig('arc');
  // v4 原生腿 0x0 → 优先命中地址为 0x0 的 native 条目 USDC_NATIVE，18 位
  const nat = resolveQuote(arc, '0x0000000000000000000000000000000000000000');
  assert.equal(nat.sym, 'USDC_NATIVE');
  assert.equal(nat.decimals, 18, 'v4 原生资产按 wei 记账=18 位');
  assert.equal(quoteUsd('arc', 'USDC_NATIVE'), 1, '稳定币美元价固定 1');
  // V3/V2 的 ERC-20 视图 0x3600 → USDC，6 位（不能与 18 位原生腿混用）
  const erc = resolveQuote(arc, '0x3600000000000000000000000000000000000000');
  assert.equal(erc.sym, 'USDC');
  assert.equal(erc.decimals, 6);
  assert.equal(quoteUsd('arc', 'USDC'), 1);
});

// —— 元数据补读退避（Pons 名字「?」/市值 $0 修复）——

test('shouldRetryMeta：字段齐全不补；缺字段且未在退避窗内则补；达上限放弃', () => {
  const now = 1_000_000;
  // 齐全 → 不补
  assert.equal(shouldRetryMeta({ symbol: 'PEPE', totalSupply: '1000' }, undefined, now), false);
  // 缺 symbol、从未尝试 → 立即补
  assert.equal(shouldRetryMeta({ symbol: null, totalSupply: '1000' }, undefined, now), true);
  // 缺 total_supply、从未尝试 → 补
  assert.equal(shouldRetryMeta({ symbol: 'PEPE', totalSupply: null }, undefined, now), true);
  // 退避窗口内 → 不补
  assert.equal(shouldRetryMeta({ symbol: null, totalSupply: null }, { attempts: 1, nextAt: now + 5000 }, now), false);
  // 退避窗口已过 → 补
  assert.equal(shouldRetryMeta({ symbol: null, totalSupply: null }, { attempts: 1, nextAt: now - 1 }, now), true);
  // 达上限 → 放弃
  assert.equal(shouldRetryMeta({ symbol: null, totalSupply: null }, { attempts: META_MAX_ATTEMPTS, nextAt: 0 }, now), false);
});

test('元数据补读：首轮失败进退避、窗口过后再试、成功后不再补(最终一致)', () => {
  const now = 1_000_000;
  const cand = { symbol: null, totalSupply: null };
  // 首轮：应补 → 失败 → 推进退避
  assert.equal(shouldRetryMeta(cand, undefined, now), true);
  const s1 = nextMetaState(undefined, now);
  assert.equal(s1.attempts, 1);
  assert.equal(s1.nextAt, now + metaBackoffMs(1)); // 1m
  // 退避窗口内不再试
  assert.equal(shouldRetryMeta(cand, s1, now + 30_000), false);
  // 窗口过后再试
  assert.equal(shouldRetryMeta(cand, s1, s1.nextAt), true);
  // 第二轮成功补齐 → 字段齐全 → 不再补
  const filled = { symbol: 'HARVEST', totalSupply: '100000000000000000000000' };
  assert.equal(shouldRetryMeta(filled, s1, s1.nextAt + 1), false);
});

test('metaBackoffMs：1m,1m,5m,5m,15m…索引超界取末位 15m', () => {
  assert.equal(metaBackoffMs(1), 60_000);
  assert.equal(metaBackoffMs(2), 60_000);
  assert.equal(metaBackoffMs(3), 300_000);
  assert.equal(metaBackoffMs(5), 900_000);
  assert.equal(metaBackoffMs(99), 900_000); // 超界 → 末位
});
