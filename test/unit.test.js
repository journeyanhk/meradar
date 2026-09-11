import test from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import { fourMemeEvents } from '../src/abi.js';
import { evaluateTier } from '../src/alert.js';
import { resolveQuote } from '../src/enrich.js';
import { normalizeSwap } from '../src/discover.js';
import * as momentum from '../src/momentum.js';

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

// —— 2. evaluateTier：分级逻辑 ——
const base = {
  liquidityUsd: 0, priceUsd: 0, marketCapUsd: 0, volumeUsd: 0,
  holders: 0, uniqueBuyers: 0, holderGrowthPct: 0, copycats: 0,
  narrativeHits: [], isOriginal: true, graduated: false, listing: false,
};

test('毕业(listing) 直接判 T3', () => {
  assert.equal(evaluateTier({}, { ...base, listing: true }), 'T3');
});

test('市值+流动性双达标且净流入超过深度比例门槛判 T2', () => {
  // 深度 6万 -> 门槛 max(2000, 60000×0.5%)=2000；净流入 5000 达标
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, netIn30m: 5000 }), 'T2');
});

test('纯体量+微弱净流入停在 T1（净流入低于深度比例门槛）', () => {
  // 大市值+大深度但净流入仅 $1（<$2000 下限）、无新买家 -> 停 T1，避免换库/换 VPS 时刷屏
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, netIn30m: 1 }), 'T1');
  // 净流入=0、无新买家同样停 T1
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000 }), 'T1');
  // 深度越大门槛越高：深度 100万 -> 门槛 5000，净流入 3000 不够
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 1000000, netIn30m: 3000 }), 'T1');
  // 有足量新买家也可升 T2（动量的另一条腿）
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, depthUsd: 60000, newBuyers30m: 12 }), 'T2');
});

test('仿盘热度只让原版升级', () => {
  const m = { ...base, copycats: 5 };
  assert.equal(evaluateTier({}, { ...m, isOriginal: true }), 'T2');
  assert.equal(evaluateTier({}, { ...m, isOriginal: false }), 'T0');
});

test('买家数达标判 T1', () => {
  assert.equal(evaluateTier({}, { ...base, uniqueBuyers: 40 }), 'T1');
});

test('毕业(graduated)归入 T2 而非 T3', () => {
  assert.equal(evaluateTier({}, { ...base, graduated: true }), 'T2');
});

test('增速触发需满足最小买家基数', () => {
  // holderGrowth10mPct=30，growthMinBuyers=20
  assert.equal(evaluateTier({}, { ...base, uniqueBuyers: 7, holderGrowthPct: 40 }), 'T0');
  assert.equal(evaluateTier({}, { ...base, uniqueBuyers: 22, holderGrowthPct: 40 }), 'T1');
});

test('叙事乘数放宽阈值：命中叙事时更低市值即可 T1', () => {
  // T1.marketCapUsd=100000，narrativeMultiplier=0.5 -> 命中后 5万即达标
  const m = { ...base, marketCapUsd: 60000 };
  assert.equal(evaluateTier({}, { ...m, narrativeHits: [] }), 'T0');
  assert.equal(evaluateTier({}, { ...m, narrativeHits: ['trump'] }), 'T1');
});

test('无信号维持 T0', () => {
  assert.equal(evaluateTier({}, base), 'T0');
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
