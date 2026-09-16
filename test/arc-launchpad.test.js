// Arc 发射台(arc-launchpad) 适配器单测：
//   ① decodeArcLaunchpadLog 对真实 tx 的四事件(launch/pool/deployed/fee)逐一解码，字段与链上核实值一致；
//   ② classifyTradeSafety 的 hookTrust 三态门控(known→PASS·factory / unknown→WAIT·T1 / none→落既有豁免)。
// fixture(test/fixtures/arc-launchpad.json) 取自主网 tx 0x23c1c76a…(代币 IMPERFECT 0x64f33d…)，四事件同 tx。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeArcLaunchpadLog, ARC_LP_TOPIC } from '../src/arc-launchpad.js';
import { classifyTradeSafety } from '../src/score.js';

const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/arc-launchpad.json', import.meta.url))));
const decoded = fx.logs.map(decodeArcLaunchpadLog).filter(Boolean);
const byKind = Object.fromEntries(decoded.map((d) => [d.kind, d]));
const TOKEN = fx.token.toLowerCase();

test('arc-launchpad: 四事件全部解出，token(topics[1]) 一致', () => {
  assert.equal(decoded.length, 4, '应解出四事件');
  for (const d of decoded) assert.equal(d.token, TOKEN, `${d.kind} 的 token 应=发射代币`);
  assert.deepEqual(new Set(decoded.map((d) => d.kind)), new Set(['launch', 'pool', 'deployed', 'fee']));
});

test('arc-launchpad: TokenLaunched 解出 name/symbol/creator/uri，salt==poolId', () => {
  const l = byKind.launch;
  assert.equal(l.name, 'IMPERFECT');
  assert.equal(l.symbol, 'IMPER');
  assert.equal(l.creator, '0xac42c13329d64db9318de5b318918d0026af9648');
  assert.ok(l.uri && l.uri.startsWith('ipfs://'), 'uri 应为 ipfs 链接');
  assert.equal(l.salt, byKind.pool.poolId, 'salt 应等于 PoolCreated 的 poolId(交叉核对)');
});

test('arc-launchpad: PoolCreated 给出 32 字节 poolId', () => {
  const p = byKind.pool;
  assert.match(p.poolId, /^0x[0-9a-f]{64}$/, 'poolId 应为 bytes32');
});

test('arc-launchpad: TokenDeployed 解出 locker/v4hook/controller 三地址', () => {
  const d = byKind.deployed;
  for (const a of [d.locker, d.v4hook, d.controller]) assert.match(a, /^0x[0-9a-f]{40}$/);
  // v4hook(data[1])=真实 PoolKey.hooks(链上 Initialize.hooks 核实)；controller(data[2])=稳定信任锚。
  assert.equal(d.v4hook, '0xa085ddd8e47b431d01ad91b949d03ada11286044');
  assert.notEqual(d.locker, d.controller);
});

test('arc-launchpad: FeeConfig 解出 8 个原始费率值(字符串)', () => {
  const f = byKind.fee;
  assert.equal(f.schedule.length, 8);
  assert.ok(f.schedule.every((v) => typeof v === 'string'));
  assert.equal(f.schedule[4], '10000'); // 观测：末位 basis 常量
});

test('arc-launchpad: topic0 前缀与 fixture 实际日志一致', () => {
  const prefixes = new Set(fx.logs.map((l) => (l.topics[0] || '').slice(0, 10)));
  for (const t of Object.values(ARC_LP_TOPIC)) assert.ok(prefixes.has(t), `${t} 应命中 fixture`);
});

test('arc-launchpad: 非目标事件 / 零 token 返回 null', () => {
  assert.equal(decodeArcLaunchpadLog({ topics: ['0xdeadbeef'], data: '0x' }), null);
  assert.equal(decodeArcLaunchpadLog({ topics: [ARC_LP_TOPIC.tokenLaunched, '0x'.padEnd(66, '0')], data: '0x' }), null);
});

// ── hookTrust 门控真值表(纯函数，毕业后 v4 往返 unsupported) ──
const gradV4 = { graduated: true, roundTrip: { status: 'unsupported' }, goplus: null };

test('hookTrust=known → 毕业后 v4 PASS·factory(视同平台工厂部署)', () => {
  const c = classifyTradeSafety({ ...gradV4, hookTrust: 'known', allowUnverifiedStrong: true });
  assert.equal(c.state, 'PASS');
  assert.equal(c.source, 'factory');
  assert.equal(c.capTier, null);
});

test('hookTrust=unknown → WAIT 封顶 T1(可能自定义 hook)', () => {
  const c = classifyTradeSafety({ ...gradV4, hookTrust: 'unknown', allowUnverifiedStrong: true });
  assert.equal(c.state, 'WAIT');
  assert.equal(c.source, 'hook');
  assert.equal(c.capTier, 'T1');
});

test('hookTrust=none/null → 落既有 allowUnverifiedStrong 豁免路径(零回归)', () => {
  const none = classifyTradeSafety({ ...gradV4, hookTrust: 'none', allowUnverifiedStrong: true });
  assert.equal(none.state, 'WAIT');
  assert.equal(none.source, 'unverified');
  assert.equal(none.capTier, null);
  // 非 Arc v4(hookTrust 未传)与 none 行为一致
  const nil = classifyTradeSafety({ ...gradV4, allowUnverifiedStrong: true });
  assert.equal(nil.source, 'unverified');
});

test('hookTrust=unknown 但 GoPlus 显式貔貅 → 仍 REJECT(GoPlus 正例优先)', () => {
  const c = classifyTradeSafety({ ...gradV4, hookTrust: 'unknown', goplus: { isHoneypot: true, naFields: [] } });
  assert.equal(c.state, 'REJECT');
  assert.equal(c.source, 'goplus');
});
