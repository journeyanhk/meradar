// RPC 能力探测：往返模拟(RoundTripChecker)靠 eth_call 的 stateOverride 注入字节码 + 覆写余额，
// 不是所有 RPC 都支持。启动时探测一次，结果写进 /api/health 的 rpcCapabilities，
// 不支持则：日志 warn、往返模拟标不可用、贸易安全判定自动回落 GoPlus→WAIT（不静默放过貔貅）。
import { httpClient } from './chain.js';
import { child } from './logger.js';

const log = child('rpccap');

// 最小运行时字节码：PUSH32 0x2a → MSTORE(0) → RETURN 32 字节。返回常量 42(0x2a)。
// 若 RPC 忽略 stateOverride，则该(不存在的)地址无代码，eth_call 返回 0x 或报错 → 判不支持。
const PROBE_ADDR = '0x00000000000000000000000000000000C0DE0001';
const PROBE_CODE =
  '0x7f000000000000000000000000000000000000000000000000000000000000002a60005260206000f3';
const EXPECTED = '0x000000000000000000000000000000000000000000000000000000000000002a';

const caps = new Map(); // chain -> { stateOverride: boolean, checkedAt: number }

export async function probeStateOverride(chain) {
  try {
    const client = httpClient(chain);
    const { data } = await client.call({
      to: PROBE_ADDR,
      data: '0x',
      stateOverride: [{ address: PROBE_ADDR, code: PROBE_CODE }],
    });
    const ok = (data || '').toLowerCase() === EXPECTED;
    caps.set(chain, { stateOverride: ok, checkedAt: Date.now() });
    if (ok) log.info({ chain }, 'RPC 支持 stateOverride，往返模拟可用');
    else log.warn({ chain, got: data }, 'RPC 未按预期返回，stateOverride 不可用，往返模拟停用→贸易判定回落 GoPlus/WAIT');
    return ok;
  } catch (e) {
    caps.set(chain, { stateOverride: false, checkedAt: Date.now() });
    log.warn({ chain, err: e.message }, 'stateOverride 探测报错，判为不支持，往返模拟停用→贸易判定回落 GoPlus/WAIT');
    return false;
  }
}

// 供贸易安全层查询：探测未跑过时返回 false（保守：无往返能力则不敢判 PASS）
export function stateOverrideSupported(chain) {
  return caps.get(chain)?.stateOverride === true;
}

// 供 /api/health 暴露
export function rpcCapabilities() {
  const out = {};
  for (const [chain, v] of caps) out[chain] = { stateOverride: v.stateOverride, checkedAt: v.checkedAt };
  return out;
}
