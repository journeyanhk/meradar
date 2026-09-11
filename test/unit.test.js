import test from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector } from 'viem';
import { fourMemeEvents } from '../src/abi.js';
import { evaluateTier } from '../src/alert.js';

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

test('市值+流动性双达标判 T2', () => {
  assert.equal(evaluateTier({}, { ...base, marketCapUsd: 600000, liquidityUsd: 60000 }), 'T2');
});

test('仿盘热度只让原版升级', () => {
  const m = { ...base, copycats: 5 };
  assert.equal(evaluateTier({}, { ...m, isOriginal: true }), 'T2');
  assert.equal(evaluateTier({}, { ...m, isOriginal: false }), 'T0');
});

test('买家数达标判 T1', () => {
  assert.equal(evaluateTier({}, { ...base, uniqueBuyers: 40 }), 'T1');
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
