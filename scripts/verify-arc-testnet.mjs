// 一次性 Arc 测试网实测：验证报告结论 + 我的实现前提。不改状态，只读/eth_call。
import { createPublicClient, http, getAddress, encodeFunctionData, keccak256 } from 'viem';
import { CHECKER_V3E_RUNTIME } from '../src/roundtrip-bytecode.js';

const RPCS = ['https://rpc.testnet.arc.network', 'https://rpc.testnet.arc.io'];
const USDC = getAddress('0x3600000000000000000000000000000000000000');
const FACTORY = getAddress('0xAb6A8AAb7d490007634ef59d424b5d89688a1971');
const ROUTER = getAddress('0x509cF58CdA08C7aee83a2BdBb4A1Eac907343D01');
const QUOTER = getAddress('0x121aeB6DEf00F6F67665008CaC1C19805886ed1a');
const CHECKER_V3E = getAddress('0x00000000000000000000000000000000cafe0004');

const erc20 = [
  { name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' },
  { name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
];
const factoryAbi = [{ name: 'feeAmountTickSpacing', inputs: [{ type: 'uint24' }], outputs: [{ type: 'int24' }], stateMutability: 'view', type: 'function' }];

async function tryRpc(url) {
  const client = createPublicClient({ transport: http(url, { timeout: 15000 }) });
  const out = { url };
  out.chainId = await client.getChainId();

  // 1) stateOverride 探针：注入返回常量 42 的最小字节码
  const PROBE = getAddress('0x00000000000000000000000000000000c0de0001');
  const PROBE_CODE = '0x7f000000000000000000000000000000000000000000000000000000000000002a60005260206000f3';
  const { data: probe } = await client.call({ to: PROBE, data: '0x', stateOverride: [{ address: PROBE, code: PROBE_CODE }] });
  out.stateOverride = BigInt(probe) === 42n;

  // 2) USDC symbol/decimals
  out.usdcSymbol = await client.readContract({ address: USDC, abi: erc20, functionName: 'symbol' }).catch((e) => 'ERR:' + e.shortMessage);
  out.usdcDecimals = await client.readContract({ address: USDC, abi: erc20, functionName: 'decimals' }).catch((e) => 'ERR');

  // 3) 关键前提：覆写 CHECKER 原生余额 5e18 → USDC.balanceOf(CHECKER) 是否 = 5_000_000 ?
  const balCalldata = encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [CHECKER_V3E] });
  const { data: balRaw } = await client.call({
    to: USDC, data: balCalldata,
    stateOverride: [{ address: CHECKER_V3E, code: CHECKER_V3E_RUNTIME, balance: 5n * 10n ** 18n }],
  });
  out.usdcBalUnderNativeOverride = BigInt(balRaw).toString();
  out.nativeViewConfirmed = BigInt(balRaw) === 5_000_000n;

  // 4) 工厂 feeAmountTickSpacing(3000)
  out.factoryHasCode = ((await client.getCode({ address: FACTORY })) || '0x').length > 2;
  out.tickSpacing3000 = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'feeAmountTickSpacing', args: [3000] }).catch((e) => 'ERR:' + e.shortMessage);

  // 5) 路由/Quoter 有代码 + 路由含 v1 选择器 0x414bf389
  const routerCode = (await client.getCode({ address: ROUTER })) || '0x';
  out.routerHasCode = routerCode.length > 2;
  out.routerHasV1Selector = routerCode.toLowerCase().includes('414bf389');
  out.quoterHasCode = ((await client.getCode({ address: QUOTER })) || '0x').length > 2;

  return out;
}

for (const url of RPCS) {
  try { console.log(JSON.stringify(await tryRpc(url), (k, v) => typeof v === 'bigint' ? v.toString() : v, 2)); break; }
  catch (e) { console.error(`RPC ${url} 失败:`, e.shortMessage || e.message); }
}
