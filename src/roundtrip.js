// 毕业后交易安全的权威判据：往返模拟。
// getAmountsOut 是 view 函数，对税/貔貅零区分力；这里通过 eth_call 的 stateOverride 把 RoundTripChecker
// 运行时字节码注入固定地址 CHECKER 并覆写其余额提供 msg.value，在 RPC 内存里真实跑一遍买入→approve→卖出。
// 结果状态：ok / buyReverted(→WAIT，可能未开交易) / noTokens(→WAIT) / sellReverted(→REJECT，疑似貔貅)
//          / unsupported(RPC 不支持 或 V3 未实现 →回落 GoPlus/WAIT) / error。
import { encodeFunctionData, decodeFunctionResult, parseEther, getAddress, keccak256, encodeAbiParameters, pad } from 'viem';
import { CHECKER_RUNTIME, CHECKER_ABI, CHECKER_V3_RUNTIME, CHECKER_V3_ABI, CHECKER_V3E_RUNTIME, CHECKER_V3E_ABI } from './roundtrip-bytecode.js';
import { httpClient } from './chain.js';
import { chainConfig } from './config.js';
import { resolveQuote } from './enrich.js';
import { v3PoolAbi } from './abi.js';
import { stateOverrideSupported } from './rpccap.js';
import { child } from './logger.js';

const log = child('roundtrip');
const CHECKER = getAddress('0x00000000000000000000000000000000cafe0002');
const CHECKER_V3 = getAddress('0x00000000000000000000000000000000cafe0003');
const CHECKER_V3E = getAddress('0x00000000000000000000000000000000cafe0004');
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

// V3 往返调度：读池 fee/token0/token1，判定报价币在哪一侧，按报价币形态选路径。
//   报价币=包装原生币           → 原生 msg.value 路径(checkV3, SwapRouter02 形态)     —— BSC V3
//   报价币=原生余额 ERC-20 视图  → ERC-20 路径 + 覆写 CHECKER 原生余额(无需槽探测)      —— Arc USDC
//   报价币=普通 ERC-20 且配 balanceSlot → ERC-20 路径 + 覆写余额槽                     —— BSC USDT 计价 V3(日后)
//   其余                        → unsupported(回落 GoPlus/WAIT)
async function roundTripV3(chain, cand, cfg, amountIn) {
  const swapRouter = cfg.swapRouterV3;
  if (!swapRouter || /^0x0+$/.test(swapRouter)) return { status: 'unsupported', note: 'V3 SwapRouter 未配置(Arc 主网 9/16 填)' };
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

  const token = getAddress(cand.address);
  const tk = token.toLowerCase();
  // 报价币 = 池中「非目标 token」的那一侧
  const quoteAddr = token0.toLowerCase() === tk ? token1 : (token1.toLowerCase() === tk ? token0 : null);
  if (!quoteAddr) return { status: 'unsupported', note: 'V3 池两侧均非目标 token' };

  const wrapped = cfg.wrappedNative || cfg.quoteTokens?.WBNB?.address;
  const wrappedOk = wrapped && !/^0x0+$/.test(wrapped);

  // A) 包装原生币计价 → 原生 msg.value 路径
  if (wrappedOk && quoteAddr.toLowerCase() === wrapped.toLowerCase()) {
    return roundTripV3Native(client, getAddress(swapRouter), getAddress(wrapped), token, Number(fee), amountIn);
  }

  // B/C) ERC-20 报价币
  return roundTripV3Erc20(cfg, client, getAddress(swapRouter), quoteAddr, token, Number(fee));
}

// A) 原生 msg.value 路径（SwapRouter02 形态，无 deadline）：BSC WBNB 计价 V3 池。
async function roundTripV3Native(client, swapRouter, wrapped, token, fee, amountIn) {
  const data = encodeFunctionData({ abi: CHECKER_V3_ABI, functionName: 'checkV3', args: [swapRouter, wrapped, token, fee] });
  let ret;
  try {
    const { data: out } = await client.call({
      to: CHECKER_V3, account: CHECKER_V3, value: amountIn, data,
      stateOverride: [{ address: CHECKER_V3, code: CHECKER_V3_RUNTIME, balance: amountIn + parseEther('1') }],
    });
    ret = decodeFunctionResult({ abi: CHECKER_V3_ABI, functionName: 'checkV3', data: out });
  } catch (e) {
    log.debug({ err: e.shortMessage || e.message }, 'roundTripV3(native) eth_call 失败');
    return { status: 'error', note: (e.shortMessage || e.message || '').slice(0, 160) };
  }
  const code = Number(ret[0]);
  const gotBuy = ret[1];
  const gotSell = ret[2];
  if (code === 1) return { status: 'buyReverted', note: '买入 revert(可能未开池/反机器人)' };
  if (code === 2) return { status: 'noTokens', note: '买到 0 代币' };
  if (code === 3) return { status: 'sellReverted', gotBuy: gotBuy.toString(), note: '卖出 revert(疑似貔貅)' };
  return {
    status: 'ok', gotBuy: gotBuy.toString(), gotSell: gotSell.toString(),
    buyTaxBps: null, sellTaxBps: null, // V3 理论税需 Quoter；最小适配只给回收率
    recoveredBps: amountIn > 0n ? Number((gotSell * 10000n) / amountIn) : null,
    feeTier: fee,
  };
}

// B/C) ERC-20 报价币路径（SwapRouter v1 形态，带 deadline）：Arc UnitFlow USDC 计价池。
// 余额注入两种：native(Arc USDC=原生余额视图)覆写原生 balance；否则按配置 balanceSlot 覆写存储槽。
async function roundTripV3Erc20(cfg, client, swapRouter, quoteAddr, token, fee) {
  const routerKind = cfg.routerKind || 'swaprouter02';
  if (routerKind !== 'v3-router-v1') {
    // 目前 ERC-20 往返只实现 v1 路由形态(Arc UnitFlow)。SwapRouter02 ERC-20 待主网 DEX 确定后补分支。
    return { status: 'unsupported', note: `ERC-20 报价往返暂仅支持 routerKind=v3-router-v1(实得 ${routerKind})` };
  }
  const q = quoteEntryByAddress(cfg, quoteAddr);
  if (!q) return { status: 'unsupported', note: 'V3 池报价币未在 quoteTokens 配置' };

  const probeIn = 5n * 10n ** BigInt(q.decimals); // 5 个报价币单位的探针额度
  let stateOverride;
  if (q.native) {
    // Arc：USDC 是原生余额的 ERC-20 视图 → 覆写 CHECKER 原生余额即等于给它 USDC（原生 18 位 = 视图 decimals 位 × 1e(18-dec)）。
    const nativeBal = probeIn * 10n ** BigInt(18 - q.decimals) + parseEther('1');
    stateOverride = [{ address: CHECKER_V3E, code: CHECKER_V3E_RUNTIME, balance: nativeBal }];
  } else if (q.balanceSlot != null) {
    // 普通 ERC-20：覆写 balanceOf 映射槽 keccak256(abi.encode(holder, slot))=probeIn；原生 balance 给点 gas 兜底。
    const slotKey = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [CHECKER_V3E, BigInt(q.balanceSlot)]));
    stateOverride = [
      { address: CHECKER_V3E, code: CHECKER_V3E_RUNTIME, balance: parseEther('1') },
      { address: getAddress(quoteAddr), stateDiff: [{ slot: slotKey, value: pad(`0x${probeIn.toString(16)}`) }] },
    ];
  } else {
    return { status: 'unsupported', note: 'ERC-20 报价币未标注 native/balanceSlot，无法注入余额' };
  }

  const data = encodeFunctionData({
    abi: CHECKER_V3E_ABI, functionName: 'checkV3Erc20',
    args: [swapRouter, getAddress(quoteAddr), token, fee, probeIn],
  });
  let ret;
  try {
    const { data: out } = await client.call({ to: CHECKER_V3E, account: CHECKER_V3E, data, stateOverride });
    ret = decodeFunctionResult({ abi: CHECKER_V3E_ABI, functionName: 'checkV3Erc20', data: out });
  } catch (e) {
    log.debug({ err: e.shortMessage || e.message }, 'roundTripV3(erc20) eth_call 失败');
    return { status: 'error', note: (e.shortMessage || e.message || '').slice(0, 160) };
  }
  const code = Number(ret[0]);
  const gotBuy = ret[1];
  const gotSell = ret[2];
  if (code === 1) return { status: 'buyReverted', note: '买入 revert(可能未开池/反机器人)' };
  if (code === 2) return { status: 'noTokens', note: '买到 0 代币' };
  if (code === 3) return { status: 'sellReverted', gotBuy: gotBuy.toString(), note: '卖出 revert(疑似貔貅)' };
  return {
    status: 'ok', gotBuy: gotBuy.toString(), gotSell: gotSell.toString(),
    buyTaxBps: null, sellTaxBps: null, // 理论税需 v1 Quoter；最小适配只给回收率
    recoveredBps: probeIn > 0n ? Number((gotSell * 10000n) / probeIn) : null,
    feeTier: fee, quoteSym: q.sym,
  };
}

// 取 quoteTokens 里匹配某地址的配置项（含 native/balanceSlot，resolveQuote 会丢弃这两字段故单独取）。
function quoteEntryByAddress(cfg, addr) {
  const s = String(addr).toLowerCase();
  for (const [sym, q] of Object.entries(cfg.quoteTokens || {})) {
    if (q.address?.toLowerCase() === s) return { sym, address: q.address, decimals: q.decimals, native: !!q.native, balanceSlot: q.balanceSlot };
  }
  return null;
}
