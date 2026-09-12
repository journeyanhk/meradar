// 毕业后交易安全的权威判据：往返模拟。
// getAmountsOut 是 view 函数，对税/貔貅零区分力；这里通过 eth_call 的 stateOverride 把 RoundTripChecker
// 运行时字节码注入固定地址 CHECKER 并覆写其余额提供 msg.value，在 RPC 内存里真实跑一遍买入→approve→卖出。
// 结果状态：ok / buyReverted(→WAIT，可能未开交易) / noTokens(→WAIT) / sellReverted(→REJECT，疑似貔貅)
//          / unsupported(RPC 不支持 或 V3 未实现 →回落 GoPlus/WAIT) / error。
import { encodeFunctionData, decodeFunctionResult, parseEther, getAddress } from 'viem';
import { CHECKER_RUNTIME, CHECKER_ABI, CHECKER_V3_RUNTIME, CHECKER_V3_ABI } from './roundtrip-bytecode.js';
import { httpClient } from './chain.js';
import { chainConfig } from './config.js';
import { resolveQuote } from './enrich.js';
import { v3PoolAbi } from './abi.js';
import { stateOverrideSupported } from './rpccap.js';
import { child } from './logger.js';

const log = child('roundtrip');
const CHECKER = getAddress('0x00000000000000000000000000000000cafe0002');
const CHECKER_V3 = getAddress('0x00000000000000000000000000000000cafe0003');
const DEFAULT_AMOUNT_IN = parseEther('0.02'); // 小额 0.02 BNB：够穿透曲线毕业池，又不至于严重滑点污染税率
const TTL = 10 * 60_000;
const cache = new Map(); // `${chain}:${addr}` -> { ts, result }

// 税率(bps)：理论到手 theo 与实际到手 got 之差占比。got≥theo(无税/正滑点) 记 0。
export function taxBps(theo, got) {
  if (theo == null || theo <= 0n) return null;
  if (got >= theo) return 0;
  return Number(((theo - got) * 10000n) / theo);
}

// 构造买/卖路径：WBNB 报价单跳；USDT/USD1 等报价走 WBNB→报价币→token 两跳。无法解析报价币返回 null。
export function buildPaths(cfg, quoteSym, tokenAddr) {
  const wbnb = cfg?.quoteTokens?.WBNB?.address;
  const q = resolveQuote(cfg, quoteSym);
  if (!wbnb || !q) return null;
  const token = getAddress(tokenAddr);
  const quoteAddr = getAddress(q.address);
  const wbnbAddr = getAddress(wbnb);
  const isWbnb = quoteAddr.toLowerCase() === wbnbAddr.toLowerCase();
  return {
    buyPath: isWbnb ? [wbnbAddr, token] : [wbnbAddr, quoteAddr, token],
    sellPath: isWbnb ? [token, wbnbAddr] : [token, quoteAddr, wbnbAddr],
  };
}

// 往返模拟。返回结构见文件头注释。带 10 分钟缓存；fresh=true 强制重跑(强提示前保证新鲜)。
export async function roundTripCheck(chain, cand, { amountIn = DEFAULT_AMOUNT_IN, fresh = false } = {}) {
  const key = `${chain}:${cand.address.toLowerCase()}`;
  if (!fresh) {
    const c = cache.get(key);
    if (c && Date.now() - c.ts < TTL) return c.result;
  }
  const wrap = (result) => { cache.set(key, { ts: Date.now(), result: { ...result, checkedAt: Date.now() } }); return cache.get(key).result; };
  const cfg = chainConfig(chain);

  if (!stateOverrideSupported(chain)) return wrap({ status: 'unsupported', note: 'RPC 不支持 stateOverride' });
  if ((cand.pool_type || '').toLowerCase() === 'v3') return wrap(await roundTripV3(chain, cand, cfg, amountIn));
  const router = cfg.router;
  const paths = buildPaths(cfg, cand.quote_symbol, cand.address);
  if (!router || !paths) return wrap({ status: 'unsupported', note: 'router/WBNB/报价币未解析' });
  const { buyPath, sellPath } = paths;
  const token = getAddress(cand.address);

  const client = httpClient(chain);
  const data = encodeFunctionData({ abi: CHECKER_ABI, functionName: 'checkV2', args: [getAddress(router), buyPath, sellPath, token] });

  let ret;
  try {
    const { data: out } = await client.call({
      to: CHECKER, account: CHECKER, value: amountIn, data,
      // 覆写 CHECKER 余额：实测不覆写则 OutOfFunds，往返跑不起来。多给 1 BNB 覆盖 gas/滑点。
      stateOverride: [{ address: CHECKER, code: CHECKER_RUNTIME, balance: amountIn + parseEther('1') }],
    });
    ret = decodeFunctionResult({ abi: CHECKER_ABI, functionName: 'checkV2', data: out });
  } catch (e) {
    log.debug({ err: e.shortMessage || e.message, token: cand.symbol }, 'roundTrip eth_call 失败');
    return wrap({ status: 'error', note: (e.shortMessage || e.message || '').slice(0, 160) });
  }

  const code = Number(ret[0]);
  const gotBuy = ret[1];
  const gotSell = ret[2];
  const theoBuy = ret[3];
  const theoSell = ret[4];
  if (code === 1) return wrap({ status: 'buyReverted', note: '买入 revert(可能未开交易/反机器人)' });
  if (code === 2) return wrap({ status: 'noTokens', note: '买到 0 代币' });
  if (code === 3) return wrap({ status: 'sellReverted', gotBuy: gotBuy.toString(), sellTaxBps: taxBps(theoSell, gotSell), note: '卖出 revert(疑似貔貅)' });

  // code 0：正常往返。theoBuy(买入前储备)/theoSell(买入把储备推高后的储备) 已在合约内按各自时点算好，
  // 直接用即可——避免卖税被低估约 2× 买入冲击，也省两次 RPC。
  return wrap({
    status: 'ok',
    gotBuy: gotBuy.toString(),
    gotSell: gotSell.toString(),
    buyTaxBps: taxBps(theoBuy, gotBuy),
    sellTaxBps: taxBps(theoSell, gotSell),
    recoveredBps: amountIn > 0n ? Number((gotSell * 10000n) / amountIn) : null,
  });
}

// V3 往返：Uniswap V3 / SwapRouter02 形态（Arc 主力，BSC 直发 V3 少量）。
// 用原生币 msg.value 经 SwapRouter 包装成 wrappedNative 买 token，再全额换回，按 wrappedNative 余额差计回收。
// 仅在池子一侧为「包装原生币」时适用；Arc 的 USDC(6位) 计价买入需覆写 ERC20 余额槽，属后续(9/16 主网)工作。
// V3 无 fee-on-transfer 变体，貔貅/高税会让某腿 revert：买入 revert→WAIT，卖出 revert→REJECT。
async function roundTripV3(chain, cand, cfg, amountIn) {
  const swapRouter = cfg.swapRouterV3;
  const wrapped = cfg.wrappedNative || cfg.quoteTokens?.WBNB?.address;
  if (!swapRouter || /^0x0+$/.test(swapRouter)) return { status: 'unsupported', note: 'V3 SwapRouter 未配置(Arc 主网 9/16 填)' };
  if (!wrapped || /^0x0+$/.test(wrapped)) return { status: 'unsupported', note: '包装原生币未配置' };
  if (!cand.pool) return { status: 'unsupported', note: 'V3 池未知' };

  const client = httpClient(chain);
  let fee, token0, token1;
  try {
    [fee, token0, token1] = await Promise.all([
      client.readContract({ address: getAddress(cand.pool), abi: v3PoolAbi, functionName: 'fee' }),
      client.readContract({ address: getAddress(cand.pool), abi: v3PoolAbi, functionName: 'token0' }),
      client.readContract({ address: getAddress(cand.pool), abi: v3PoolAbi, functionName: 'token1' }),
    ]);
  } catch (e) {
    log.debug({ err: e.message }, 'V3 池 fee/token 读取失败');
    return { status: 'error', note: 'V3 池 fee/token 读取失败' };
  }

  const wl = getAddress(wrapped).toLowerCase();
  if (token0.toLowerCase() !== wl && token1.toLowerCase() !== wl) {
    return { status: 'unsupported', note: 'V3 池非包装原生币计价，原生买入不适用(Arc USDC 计价待 ERC20 余额覆写)' };
  }

  const token = getAddress(cand.address);
  const data = encodeFunctionData({ abi: CHECKER_V3_ABI, functionName: 'checkV3', args: [getAddress(swapRouter), getAddress(wrapped), token, Number(fee)] });
  let ret;
  try {
    const { data: out } = await client.call({
      to: CHECKER_V3, account: CHECKER_V3, value: amountIn, data,
      stateOverride: [{ address: CHECKER_V3, code: CHECKER_V3_RUNTIME, balance: amountIn + parseEther('1') }],
    });
    ret = decodeFunctionResult({ abi: CHECKER_V3_ABI, functionName: 'checkV3', data: out });
  } catch (e) {
    log.debug({ err: e.shortMessage || e.message, token: cand.symbol }, 'roundTripV3 eth_call 失败');
    return { status: 'error', note: (e.shortMessage || e.message || '').slice(0, 160) };
  }

  const code = Number(ret[0]);
  const gotBuy = ret[1];
  const gotSell = ret[2];
  if (code === 1) return { status: 'buyReverted', note: '买入 revert(可能未开池/反机器人)' };
  if (code === 2) return { status: 'noTokens', note: '买到 0 代币' };
  if (code === 3) return { status: 'sellReverted', gotBuy: gotBuy.toString(), note: '卖出 revert(疑似貔貅)' };
  return {
    status: 'ok',
    gotBuy: gotBuy.toString(),
    gotSell: gotSell.toString(),
    buyTaxBps: null, // V3 理论税需 QuoterV2；最小适配只给回收率，税率留待后续
    sellTaxBps: null,
    recoveredBps: amountIn > 0n ? Number((gotSell * 10000n) / amountIn) : null,
    feeTier: Number(fee),
  };
}
