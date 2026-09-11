import test from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import { fourMemeEvents } from '../src/abi.js';
import { evaluateTier } from '../src/alert.js';
import { resolveQuote } from '../src/enrich.js';
import { normalizeSwap } from '../src/discover.js';

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

test('市值+流动性双达标且有动量判 T2', () => {
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, netIn30m: 1 }), 'T2');
});

test('纯体量无动量停在 T1（不因回填的老大币误判 T2）', () => {
  // 大市值+大深度但净流入=0、无新买家 -> 停 T1，避免换库/换 VPS 时刷屏
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000 }), 'T1');
  // 有足量新买家也可升 T2
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000, newBuyers30m: 12 }), 'T2');
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
