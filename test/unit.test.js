import test from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import { fourMemeEvents } from '../src/abi.js';
import { evaluateTier } from '../src/alert.js';
import { classifyTradeSafety } from '../src/score.js';
import { resolveQuote } from '../src/enrich.js';
import { normalizeSwap } from '../src/discover.js';
import * as momentum from '../src/momentum.js';
import { graduatedByCurve } from '../src/pool.js';
import { goplusCheck } from '../src/goplus.js';

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

test('毕业(graduated)归入 T2 而非 T3', () => {
  assert.equal(tierOf({}, { ...base, graduated: true }), 'T2');
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
  const g = { ...base, graduated: true, graduatedAt: now - 5 * 60_000, now, lastTradeTs: now - 60_000 };
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
