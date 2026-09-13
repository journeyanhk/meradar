// 构建 Four.meme 模板字节码哈希白名单（补种静态清单 + 核对轮换）。
// 曲线期代币的贸易安全由「平台模板保障」判定：Token Manager 部署的代币（EIP-1167 代理指向平台实现，
// 或直接部署），码哈希命中白名单即 PASS(template)。Four.meme 数天内会轮换多套模板，静态清单需定期核对。
//
// 用法：node scripts/build-template-whitelist.mjs [RPC_URL] [days] [blocksPerDay] [sampleTokensPerDay]
// 默认扫最近 7 天，每天抽样最近 2000 块内的 TokenCreate，每天最多取 80 个代币算哈希。
// 输出：按频次排序的 impl/direct 码哈希 + 建议写入 config.chains.bsc.templateCodeHashes 的清单。
import { createPublicClient, http, parseAbiItem, keccak256, getAddress } from 'viem';

const RPC = process.argv[2] || 'https://bsc-rpc.publicnode.com';
const DAYS = Number(process.argv[3] || 7);
const BLOCKS_PER_DAY = BigInt(process.argv[4] || 2000);      // 每天抽样的块数（最近 2000 块 ≈ 15 分钟）
const SAMPLE_PER_DAY = Number(process.argv[5] || 80);       // 每天最多算多少个代币的哈希，限住 RPC 量
const BSC_DAY_BLOCKS = 28800n;                               // BSC ~3s/块 → 一天 ~28800 块
const client = createPublicClient({ transport: http(RPC) });
const TM = getAddress('0x5c952063c7fc8610FFDB798152D69F0B9550762b');
const ev = parseAbiItem('event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)');
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const latest = await client.getBlockNumber();
// hash -> { kind, count, sample }
const stats = new Map();
const seenTokens = new Set();
let scannedTokens = 0;

function bump(hash, kind, token) {
  const h = hash.toLowerCase();
  const cur = stats.get(h) || { kind, count: 0, sample: token };
  cur.count += 1;
  stats.set(h, cur);
}

for (let d = 0; d < DAYS; d++) {
  const toBlock = latest - BigInt(d) * BSC_DAY_BLOCKS;
  const fromBlock = toBlock > BLOCKS_PER_DAY ? toBlock - BLOCKS_PER_DAY : 0n;
  let logs = [];
  try {
    logs = await client.getLogs({ address: TM, event: ev, fromBlock, toBlock });
  } catch (e) {
    console.error(`第 ${d} 天 [${fromBlock}-${toBlock}] getLogs 失败: ${e.shortMessage || e.message}`);
    continue;
  }
  const tokens = [...new Set(logs.map((l) => l.args.token))].filter((t) => !seenTokens.has(t)).slice(0, SAMPLE_PER_DAY);
  console.error(`第 ${d} 天 [${fromBlock}-${toBlock}]：TokenCreate ${logs.length} 条，取样 ${tokens.length} 个代币`);
  for (const t of tokens) {
    seenTokens.add(t);
    const code = await client.getCode({ address: t }).catch(() => null);
    if (!code || code === '0x') continue;
    scannedTokens++;
    const m = code.match(EIP1167);
    if (m) {
      const impl = getAddress('0x' + m[1]);
      const implCode = await client.getCode({ address: impl }).catch(() => null);
      if (implCode && implCode !== '0x') bump(keccak256(implCode), 'impl', t);
      else bump(keccak256(code), 'proxy', t); // impl 取码失败，退回代理码哈希
    } else {
      bump(keccak256(code), 'direct', t); // 非 1167：直接部署合约
    }
    await sleep(40);
  }
  await sleep(200);
}

const rows = [...stats.entries()].sort((a, b) => b[1].count - a[1].count);
console.error(`\n共取样 ${scannedTokens} 个代币，去重码哈希 ${rows.length} 个：`);
for (const [h, v] of rows) console.error(`  ${h}  ${v.kind.padEnd(6)}  count=${v.count}  e.g. ${v.sample}`);

console.error('\n建议写入 config.chains.bsc.templateCodeHashes（去重）:');
console.log(JSON.stringify(rows.map(([h]) => h), null, 2));
