// Arc 发射台(0xb021be53…97da) 事件解码：一处纯函数，实时订阅(discover)、启动回填(engine)、单测共用。
// 四事件均每次发射各触发一次、同一 tx；已链上核实(scripts/verify-arc-launchpad.mjs)：
//   TokenLaunched(元数据) / PoolCreated(token↔poolId) / TokenDeployed(locker+registry+hook) / FeeConfig(原始费率表)。
// 公共键：topics[1] = token(所有事件一致)；topics[2] 随事件而异(creator / poolId / …)。
// 事件名/精确签名无法确证 → 按 raw topic0(前4字节即足以在单合约内唯一区分) + decodeAbiParameters 解，不用 parseAbiItem。
import { decodeAbiParameters } from 'viem';

export const ARC_LP_TOPIC = {
  tokenLaunched: '0x1d891723', // 元数据：data=(string name, string symbol, bytes32 salt(=poolId), string uri, …)
  poolCreated: '0x55e45784',   // 池映射：topics[2]=poolId(bytes32)
  tokenDeployed: '0xa54419a4', // 部署：data[0]=locker(EIP1167) data[1]=registry data[2]=hook(EIP1167→统一实现)
  feeConfig: '0xabe14607',     // 费率表：data=uint256×8(原始，字段命名待多发射校准；实际费率仍以 Swap.fee 为准)
};

const topicAddr = (t) => (t && t.length >= 42 ? ('0x' + t.slice(26)).toLowerCase() : null);
const topic0 = (l) => (l.topics?.[0] || '').slice(0, 10).toLowerCase();
const isZero = (a) => !a || /^0x0+$/.test(a);

// 元数据 data 是动态 tuple。稳健解码：先取 name/symbol/salt(读前 3 头槽、跟随偏移、容忍尾部多余字段)；
// uri 尽力而为(第 4 段 string)。任一步失败都降级而非抛错，保证订阅不因个别异常布局中断。
function decodeMeta(data) {
  let name = null, symbol = null, salt = null, uri = null;
  try {
    const [n, s, sl] = decodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }], data);
    name = n; symbol = s; salt = sl;
  } catch {
    try { const [n, s] = decodeAbiParameters([{ type: 'string' }, { type: 'string' }], data); name = n; symbol = s; } catch { /* 放弃元数据 */ }
  }
  try {
    const [, , , u] = decodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'bytes32' }, { type: 'string' }], data);
    if (u) uri = u;
  } catch { /* 无 uri 段 */ }
  return { name: name || null, symbol: symbol || null, salt: (salt || '').toLowerCase() || null, uri: uri || null };
}

// 解码一条发射台日志 → { kind, token, … } | null(非目标事件 / 解码失败)。kind ∈ launch|pool|deployed|fee。
export function decodeArcLaunchpadLog(l) {
  const topic = topic0(l);
  const token = topicAddr(l.topics?.[1]);
  if (isZero(token)) return null;
  const block = Number(l.blockNumber || 0);
  const tx = l.transactionHash || null;

  if (topic === ARC_LP_TOPIC.tokenLaunched) {
    const creator = topicAddr(l.topics?.[2]);
    const { name, symbol, salt, uri } = decodeMeta(l.data);
    return { kind: 'launch', token, creator, name, symbol, salt, uri, block, tx };
  }
  if (topic === ARC_LP_TOPIC.poolCreated) {
    const poolId = (l.topics?.[2] || '').toLowerCase();
    if (!poolId || poolId.length < 66) return null;
    return { kind: 'pool', token, poolId, block, tx };
  }
  if (topic === ARC_LP_TOPIC.tokenDeployed) {
    try {
      const [a, b, c] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], l.data);
      // data[0]=locker(EIP1167→统一实现，LP 锁仓)；data[1]=v4hook(真实 PoolKey.hooks，每币唯一、不可哈希学习)；
      // data[2]=controller(EIP1167→统一实现 0xd9578dd8，稳定层，平台信任自学习判据)。已链上核实(Initialize.hooks==data[1])。
      return { kind: 'deployed', token, locker: (a || '').toLowerCase() || null, v4hook: (b || '').toLowerCase() || null, controller: (c || '').toLowerCase() || null, block, tx };
    } catch { return null; }
  }
  if (topic === ARC_LP_TOPIC.feeConfig) {
    try {
      const vals = decodeAbiParameters(Array.from({ length: 8 }, () => ({ type: 'uint256' })), l.data);
      return { kind: 'fee', token, schedule: vals.map((v) => v.toString()), block, tx };
    } catch { return null; }
  }
  return null;
}
