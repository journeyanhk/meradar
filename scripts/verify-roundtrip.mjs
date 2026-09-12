// 固化往返模拟 fixture：对一个已知毕业币跑真实往返，把结果冻结进 test/fixtures/roundtrip.fixture.json，
// 作为单测的回归锚点(离线断言，不在单测里打网络)。同时抓一个报价样本证明 stateOverride 可用。
// 用法：node scripts/verify-roundtrip.mjs [RPC_URL]
// 重跑条件：升级 solc/改合约后、或换默认 RPC 后，确认锚点仍成立再更新 fixture。
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseEther, getAddress } from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHECKER_RUNTIME, CHECKER_ABI, CHECKER_V3_RUNTIME, CHECKER_V3_ABI } from '../src/roundtrip-bytecode.js';
import { routerAbi } from '../src/abi.js';
import { taxBps } from '../src/roundtrip.js';

const RPC = process.argv[2] || 'https://bsc-rpc.publicnode.com';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = createPublicClient({ transport: http(RPC) });

const CHECKER = getAddress('0x00000000000000000000000000000000cafe0002');
const CHECKER_V3 = getAddress('0x00000000000000000000000000000000cafe0003');
const ROUTER = getAddress('0x10ED43C718714eb63d5aA57B78B54704E256024E'); // PancakeSwap V2
// Uniswap V3 SwapRouter02 on BSC —— 与 Arc 的 Uniswap V3 同为 SwapRouter02 形态(exactInputSingle 无 deadline)。
const V3_ROUTER = getAddress('0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2');
const V3_FEE = 3000;
const WBNB = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
// 锚点样本：CAKE，PancakeSwap V2 有 WBNB 深池、无转账税，往返应回收 ~99.5%(2×0.25% 手续费)。
const CAKE = getAddress('0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82');
const amountIn = parseEther('0.02');

async function main() {
  // 1) state override 探测
  const probe = await client.call({
    to: CHECKER, data: '0x',
    stateOverride: [{ address: CHECKER, code: '0x7f000000000000000000000000000000000000000000000000000000000000002a60005260206000f3' }],
  }).then((r) => r.data).catch((e) => 'ERR:' + (e.shortMessage || e.message));

  // 2) 毕业币往返
  const data = encodeFunctionData({ abi: CHECKER_ABI, functionName: 'checkV2', args: [ROUTER, [WBNB, CAKE], [CAKE, WBNB], CAKE] });
  const { data: out } = await client.call({
    to: CHECKER, account: CHECKER, value: amountIn, data,
    stateOverride: [{ address: CHECKER, code: CHECKER_RUNTIME, balance: amountIn + parseEther('1') }],
  });
  const [code, gotBuy, gotSell] = decodeFunctionResult({ abi: CHECKER_ABI, functionName: 'checkV2', data: out });
  const ob = await client.readContract({ address: ROUTER, abi: routerAbi, functionName: 'getAmountsOut', args: [amountIn, [WBNB, CAKE]] });
  const os = await client.readContract({ address: ROUTER, abi: routerAbi, functionName: 'getAmountsOut', args: [gotBuy, [CAKE, WBNB]] });

  // 3) V3 毕业币往返(Uniswap V3 SwapRouter02，CAKE fee 3000)：验证 V3 分支字节码，Arc 主力形态。
  const dataV3 = encodeFunctionData({ abi: CHECKER_V3_ABI, functionName: 'checkV3', args: [V3_ROUTER, WBNB, CAKE, V3_FEE] });
  const { data: outV3 } = await client.call({
    to: CHECKER_V3, account: CHECKER_V3, value: amountIn, data: dataV3,
    stateOverride: [{ address: CHECKER_V3, code: CHECKER_V3_RUNTIME, balance: amountIn + parseEther('1') }],
  });
  const [codeV3, gotBuyV3, gotSellV3] = decodeFunctionResult({ abi: CHECKER_V3_ABI, functionName: 'checkV3', data: outV3 });

  const fixture = {
    _note: '由 scripts/verify-roundtrip.mjs 生成；毕业币真实往返锚点，供单测离线断言。',
    generatedAt: new Date().toISOString(),
    rpc: RPC,
    stateOverrideProbe: probe,
    graduated: {
      token: CAKE, symbol: 'CAKE', router: ROUTER, amountInWei: amountIn.toString(),
      statusCode: Number(code),
      buyTaxBps: taxBps(ob[ob.length - 1], gotBuy),
      sellTaxBps: taxBps(os[os.length - 1], gotSell),
      recoveredBps: Number((gotSell * 10000n) / amountIn),
    },
    graduatedV3: {
      token: CAKE, symbol: 'CAKE', router: V3_ROUTER, dex: 'UniswapV3 SwapRouter02', fee: V3_FEE,
      amountInWei: amountIn.toString(),
      statusCode: Number(codeV3),
      recoveredBps: Number((gotSellV3 * 10000n) / amountIn),
    },
    // 曲线期 GoPlus 空字段代表样本：GoPlus 对曲线期币常返回空 sell_tax/is_honeypot →
    // parseRow 归入 naFields → 三态判定回落 WAIT 而非误判 PASS。
    curvePhaseGoplusRaw: { is_honeypot: '', sell_tax: '', buy_tax: '', cannot_sell_all: '' },
  };
  writeFileSync(join(root, 'test/fixtures/roundtrip.fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify(fixture, null, 2));
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
