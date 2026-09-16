// 一次性 Arc 主网(chainId 5042)实测：核实发射台 0xb021be53…97da 的事件结构，为 arc-launchpad 适配器锁 ABI。
// 只读、不改状态。按 topic0 分组统计近 N 块日志，取多笔样本打印 indexed topics + 原始 data 结构，
// 并尝试按「地址位 = 32 字节末 20 字节」「string 动态段」拆解，供人工对照命名字段(尤其费率表 0xabe14607)。
// 用法：node scripts/verify-arc-launchpad.mjs [blocks]   （默认回看 20000 块；可 ARC_HTTP 覆盖端点）
import { createPublicClient, http, getAddress, parseAbiItem, decodeAbiParameters } from 'viem';

const URL = process.env.ARC_HTTP || 'https://rpc.mainnet.arc.io';
const LAUNCHPAD = getAddress('0xb021be536808f551b31789422fd28a6c9c6e97da');
const REGISTRY = getAddress('0x1516ce0a150258d68b76cee3db2ed232f579e044');
const LOOKBACK = BigInt(Number(process.argv[2] || 20000));

// 计划里推断的 topic0 → 语义标签（待本脚本核实字段布局）
const KNOWN = {
  '0x1d891723': 'TokenLaunched?(元数据: name/symbol/creator/…)',
  '0xa54419a4': 'TokenDeployed?(locker/registry/hook)',
  '0x55e45784': 'PoolCreated?(token↔poolId)',
  '0xabe14607': 'FeeConfig?(费率时间表)',
  '0x4d7a87ac': 'PoolRegistered?(poolId↔token, registry 合约发)',
};

const hexData = (h) => (h || '0x').slice(2);
const words = (data) => { const d = hexData(data); const out = []; for (let i = 0; i + 64 <= d.length; i += 64) out.push(d.slice(i, i + 64)); return out; };
const asAddr = (w) => '0x' + w.slice(24); // 32 字节末 20 字节
const asNum = (w) => BigInt('0x' + w);
const looksAddr = (w) => /^0{24}[0-9a-f]{40}$/.test(w) && !/^0{64}$/.test(w);

function tryStrings(data) {
  // 试着把 data 当作若干 (string) ABI 动态编码整体解出，探测元数据事件
  const out = [];
  for (const n of [6, 5, 4, 3, 2]) {
    try {
      const types = Array.from({ length: n }, () => ({ type: 'string' }));
      const vals = decodeAbiParameters(types, data);
      if (vals.every((v) => typeof v === 'string')) { out.push({ n, vals }); break; }
    } catch { /* 换 n */ }
  }
  return out;
}

async function getLogsSegmented(client, address, fromBlock, toBlock, seg = 1500n) {
  const all = [];
  let to = toBlock;
  while (to >= fromBlock) {
    const from = to - seg + 1n > fromBlock ? to - seg + 1n : fromBlock;
    try {
      const ls = await client.getLogs({ address, fromBlock: from, toBlock: to });
      all.push(...ls);
    } catch { /* 段失败跳过 */ }
    if (from === 0n) break;
    to = from - 1n;
    if (all.length > 4000) break; // 采样够了就停
  }
  return all;
}

async function dumpSamples(client, address, label, fromBlock, toBlock, max = 3) {
  const logs = await getLogsSegmented(client, address, fromBlock, toBlock);
  const byTopic = new Map();
  for (const l of logs) { const t0 = (l.topics[0] || '').slice(0, 10); if (!byTopic.has(t0)) byTopic.set(t0, []); byTopic.get(t0).push(l); }
  console.log(`\n=== ${label} ${address} — ${logs.length} 条日志, ${byTopic.size} 种 topic0 ===`);
  for (const [t0, ls] of [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[topic0 ${t0}] × ${ls.length}  ${KNOWN[t0] || '未知'}`);
    for (const l of ls.slice(0, max)) {
      const ws = words(l.data);
      console.log(`  tx=${l.transactionHash} block=${l.blockNumber}`);
      console.log(`  indexed(topics[1..]):`, l.topics.slice(1).map((t) => '0x' + t.slice(26)));
      console.log(`  data ${ws.length} words:`);
      ws.forEach((w, i) => console.log(`    [${i}] ${w}  ${looksAddr(w) ? 'addr=' + asAddr(w) : 'num=' + asNum(w)}`));
      const ss = tryStrings(l.data);
      if (ss.length) console.log('  →可能的 string 段:', JSON.stringify(ss[0].vals));
    }
  }
  return { logs, byTopic };
}

async function main() {
  const client = createPublicClient({ transport: http(URL, { timeout: 20000 }) });
  const chainId = await client.getChainId();
  const bn = await client.getBlockNumber();
  const fromBlock = bn > LOOKBACK ? bn - LOOKBACK : 0n;
  console.log(JSON.stringify({ url: URL, chainId, latest: bn.toString(), fromBlock: fromBlock.toString(), lookback: LOOKBACK.toString() }));

  const lp = await dumpSamples(client, LAUNCHPAD, '发射台', fromBlock, bn);
  const reg = await dumpSamples(client, REGISTRY, '注册合约', fromBlock, bn);

  // 交叉核对：token↔poolId 是否三源一致(PoolCreated 0x55e45784 vs PoolRegistered 0x4d7a87ac vs Initialize)
  const pc = lp.byTopic.get('0x55e45784') || [];
  const pr = reg.byTopic.get('0x4d7a87ac') || [];
  console.log(`\n=== 交叉核对 token↔poolId: PoolCreated×${pc.length} / PoolRegistered×${pr.length} ===`);
  const prMap = new Map(pr.map((l) => [(l.topics[1] || '').toLowerCase(), '0x' + (l.topics[2] || '').slice(26)])); // poolId->token
  for (const l of pc.slice(0, 5)) {
    const token = '0x' + (l.topics[1] || '').slice(26);
    const poolId = (l.topics[2] || '').toLowerCase();
    console.log(`  PoolCreated token=${token} poolId=${poolId}  registry命中token=${prMap.get(poolId) || '—'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
