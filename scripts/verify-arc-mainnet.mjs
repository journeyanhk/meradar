// 一次性 Arc 主网(chainId 5042)实测：核对接入前提，不改状态、只读。
// 覆盖：chainId、出块、stateOverride、USDC/PoolManager getCode、最近一条 v4 Initialize 的 currency0/fee。
// 用法：node scripts/verify-arc-mainnet.mjs   （可 ARC_HTTP 覆盖端点）
import { createPublicClient, http, getAddress, parseAbiItem } from 'viem';

const URL = process.env.ARC_HTTP || 'https://rpc.mainnet.arc.io';
const USDC = getAddress('0x3600000000000000000000000000000000000000');
const POOL_MANAGER = getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const EXPECT_CHAIN_ID = 5042;

const v4Initialize = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);

async function main() {
  const client = createPublicClient({ transport: http(URL, { timeout: 15000 }) });
  const out = { url: URL };

  out.chainId = await client.getChainId();
  out.chainIdOk = out.chainId === EXPECT_CHAIN_ID;

  // 出块：相邻两块时间戳差
  const bn = await client.getBlockNumber();
  const [b0, b1] = await Promise.all([client.getBlock({ blockNumber: bn - 10n }), client.getBlock({ blockNumber: bn })]);
  out.block = Number(bn);
  out.secPerBlock = Number(b1.timestamp - b0.timestamp) / 10;

  // stateOverride 探针：注入返回常量 42 的最小字节码
  const PROBE = getAddress('0x00000000000000000000000000000000c0de0001');
  const PROBE_CODE = '0x7f000000000000000000000000000000000000000000000000000000000000002a60005260206000f3';
  try {
    const { data } = await client.call({ to: PROBE, data: '0x', stateOverride: [{ address: PROBE, code: PROBE_CODE }] });
    out.stateOverride = BigInt(data) === 42n;
  } catch (e) { out.stateOverride = 'ERR:' + (e.shortMessage || e.message); }

  // getCode：USDC(6位视图) + PoolManager(v4 主 DEX)
  const usdcCode = (await client.getCode({ address: USDC })) || '0x';
  out.usdcBytes = (usdcCode.length - 2) / 2;
  const pmCode = (await client.getCode({ address: POOL_MANAGER })) || '0x';
  out.poolManagerBytes = (pmCode.length - 2) / 2;
  out.poolManagerHasCode = out.poolManagerBytes > 0;

  // 最近 ~1500 块的一条 v4 Initialize：确认事件可解 + currency0/fee 形态
  try {
    const logs = await client.getLogs({ address: POOL_MANAGER, event: v4Initialize, fromBlock: bn - 1500n, toBlock: bn });
    out.recentInitializes = logs.length;
    const sample = logs[logs.length - 1];
    if (sample) {
      out.sampleInitialize = {
        currency0: sample.args.currency0,
        currency1: sample.args.currency1,
        fee: Number(sample.args.fee),
        feePct: Number(sample.args.fee) / 1e6 * 100,
        tickSpacing: Number(sample.args.tickSpacing),
        hooks: sample.args.hooks,
      };
    }
  } catch (e) { out.recentInitializes = 'ERR:' + (e.shortMessage || e.message); }

  console.log(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

main().catch((e) => { console.error('verify 失败:', e.shortMessage || e.message); process.exit(1); });
