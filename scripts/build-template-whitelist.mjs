// 构建 Four.meme 模板字节码哈希白名单。曲线期代币的贸易安全由「平台模板保障」判定：
// 代币是 Token Manager 部署的 EIP-1167 最小代理，卖出走平台曲线合约 —— 代理指向的实现合约
// 字节码哈希在白名单里，即视为受平台模板保障(PASS·template)。
// 用法：node scripts/build-template-whitelist.mjs [RPC_URL] [scanBlocks]
// 输出：去重的 {proxyHash, implHash}，把它们写进 config.chains.bsc.templateCodeHashes。
import { createPublicClient, http, parseAbiItem, keccak256, getAddress } from 'viem';

const RPC = process.argv[2] || 'https://bsc-rpc.publicnode.com';
const SCAN = BigInt(process.argv[3] || '900');
const client = createPublicClient({ transport: http(RPC) });
const TM = getAddress('0x5c952063c7fc8610FFDB798152D69F0B9550762b');
const ev = parseAbiItem('event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)');
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/;

const latest = await client.getBlockNumber();
const logs = await client.getLogs({ address: TM, event: ev, fromBlock: latest - SCAN, toBlock: latest });
const tokens = [...new Set(logs.map((l) => l.args.token))];
console.log(`扫描 ${SCAN} 块，TokenCreate ${logs.length} 条，去重代币 ${tokens.length} 个`);

const proxyHashes = new Set();
const implHashes = new Set();
for (const t of tokens.slice(0, 20)) {
  const code = await client.getCode({ address: t }).catch(() => null);
  if (!code) continue;
  proxyHashes.add(keccak256(code));
  const m = code.match(EIP1167);
  if (m) {
    const impl = getAddress('0x' + m[1]);
    const implCode = await client.getCode({ address: impl }).catch(() => null);
    if (implCode) implHashes.add(keccak256(implCode));
  }
}
console.log('代理码哈希:', [...proxyHashes]);
console.log('实现码哈希:', [...implHashes]);
console.log('\n写进 config.chains.bsc.templateCodeHashes（代理+实现都放，任一命中即模板）:');
console.log(JSON.stringify([...proxyHashes, ...implHashes], null, 2));
