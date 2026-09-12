// 池子反查：遍历报价币 × (V2 getPair / V3 各费率 getPool)，取第一个非零池。
// 抽成独立模块，供 engine(promote 反查) 与 track(毕业后每轮自愈) 共用，避免 engine↔track 循环依赖。
import { chainConfig } from './config.js';
import { httpClient } from './chain.js';
import { v2FactoryAbi, v3FactoryAbi } from './abi.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { child } from './logger.js';

const log = child('pool');
const V3_FEES = [100, 500, 2500, 10000];

// 曲线状态是否已毕业：offers 耗尽（严格 0 且非 null，排除重启回灌后 offers 未知的币），
// 或募集达标（funds ≥ maxRaising），或持久化的曲线进度已达 99%（重启后内存清空、Token Manager
// 毕业后停发事件，仅靠内存无法再判定，用 DB 落库的 curve_progress_pct 兜底）。
// 纯函数，供 track 每轮判断是否该反查池子；抽出便于单测。cand.max_raising 是报价币最小单位(raw)。
export function graduatedByCurve(cand, curve, quoteDec = 18) {
  if (!curve) return false;
  const maxRaisingHuman = cand?.max_raising ? Number(cand.max_raising) / (10 ** quoteDec) : 0;
  const persistedProgress = Number(cand?.curve_progress_pct) || 0;
  return (
    (curve.offersPct === 0 && ((curve.fundsQuote || 0) > 0 || (curve.uniqueBuyers || 0) > 0)) ||
    (maxRaisingHuman > 0 && (curve.fundsQuote || 0) >= maxRaisingHuman * 0.999) ||
    persistedProgress >= 99
  );
}

// 反查某币是否已有 AMM 交易对；找到则 setPool + 触发 Swap 订阅重建。
// 返回是否找到。找不到不报错（毕业后注入流动性有几秒~几十秒延迟，靠调用方下一轮重试）。
export async function discoverPool(chain, cand) {
  const cfg = chainConfig(chain);
  const token = cand.address;
  const quotes = Object.entries(cfg.quoteTokens || {}); // [sym, {address, decimals}]
  const v2 = cfg.launchpads?.find((l) => l.type === 'amm-v2' && l.address && !/^0x0+$/.test(l.address));
  const v3 = cfg.launchpads?.find((l) => l.type === 'amm-v3' && l.address && !/^0x0+$/.test(l.address));
  const calls = [];
  if (v2) for (const [sym, q] of quotes) calls.push({ kind: 'v2', sym, c: { address: v2.address, abi: v2FactoryAbi, functionName: 'getPair', args: [token, q.address] } });
  if (v3) for (const [sym, q] of quotes) for (const fee of V3_FEES) calls.push({ kind: 'v3', sym, c: { address: v3.address, abi: v3FactoryAbi, functionName: 'getPool', args: [token, q.address, fee] } });
  if (!calls.length) return false;
  const client = httpClient(chain);
  let res;
  try { res = await client.multicall({ allowFailure: true, contracts: calls.map((x) => x.c) }); }
  catch (e) { log.debug({ err: e.message }, 'discoverPool multicall 失败'); return false; }
  for (let i = 0; i < res.length; i++) {
    const r = res[i];
    const addr = r?.status === 'success' ? r.result : null;
    if (addr && !/^0x0+$/.test(addr)) {
      store.setPool(cand.key, addr, calls[i].kind === 'v3' ? 'v3' : 'v2', calls[i].sym);
      log.info({ token: cand.symbol, pool: addr, via: calls[i].kind }, '反查到已毕业池');
      bus.emit(Events.POOLS_CHANGED, { chain });
      return true;
    }
  }
  return false;
}
