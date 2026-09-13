// 池子反查：遍历报价币 × (V2 getPair / V3 各费率 getPool)，取第一个非零池。
// 抽成独立模块，供 engine(promote 反查) 与 track(毕业后每轮自愈) 共用，避免 engine↔track 循环依赖。
import { chainConfig } from './config.js';
import { httpClient } from './chain.js';
import { v2FactoryAbi, v3FactoryAbi, erc20Abi } from './abi.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { child } from './logger.js';
import { quoteUsd } from './enrich.js';
import { formatUnits } from 'viem';

const log = child('pool');
const V3_FEES = [100, 500, 2500, 10000];
const DUST_FLOOR_USD = 100; // 非毕业触发的反查：报价币储备低于此视为预建粉尘对，跳过

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
// opts.graduated：曲线已判定毕业（track 每轮自愈触发）→ 免粉尘下限，因为注入流动性有几秒~几十秒延迟，
//   池可能暂空但确属真池。默认 false（engine promote 反查）→ 施加 $100 报价币储备下限，
//   过滤「有人预建的粉尘交易对」（如 4FOUR 的 $0.0044 假 PancakeV2 对，会把卡片指标拉成错值）。
// 返回是否找到。找不到不报错（靠调用方下一轮重试）。
export async function discoverPool(chain, cand, opts = {}) {
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

  // 收集所有非零候选池（同一币可能在多报价币/多费率下都有对）
  const found = [];
  for (let i = 0; i < res.length; i++) {
    const addr = res[i]?.status === 'success' ? res[i].result : null;
    if (addr && !/^0x0+$/.test(addr)) {
      const q = cfg.quoteTokens[calls[i].sym];
      found.push({ pool: addr, sym: calls[i].sym, kind: calls[i].kind, qAddr: q.address, qDec: q.decimals });
    }
  }
  if (!found.length) return false;

  const commit = (p) => {
    store.setPool(cand.key, p.pool, p.kind === 'v3' ? 'v3' : 'v2', p.sym);
    log.info({ token: cand.symbol, pool: p.pool, via: p.kind, liqUsd: p.usd != null ? Math.round(p.usd) : undefined }, '反查到已毕业池');
    bus.emit(Events.POOLS_CHANGED, { chain });
    return true;
  };

  // 毕业触发：确属真毕业，接受第一个即可（免下限，抗注入延迟）。
  if (opts.graduated) return commit(found[0]);

  // 非毕业触发（promote 反查）：读各候选池持有的报价币余额→美元，取最大者，低于下限视为粉尘对跳过。
  let balRes;
  try {
    balRes = await client.multicall({ allowFailure: true, contracts: found.map((p) => ({ address: p.qAddr, abi: erc20Abi, functionName: 'balanceOf', args: [p.pool] })) });
  } catch (e) { log.debug({ err: e.message }, 'discoverPool 读报价币储备失败'); return false; }
  let best = null;
  for (let i = 0; i < found.length; i++) {
    if (balRes[i]?.status !== 'success') continue;
    const qUsd = quoteUsd(chain, found[i].sym) || 0;
    const usd = Number(formatUnits(balRes[i].result, found[i].qDec)) * qUsd;
    if (!best || usd > best.usd) best = { ...found[i], usd };
  }
  if (!best) return false;
  if (best.usd < DUST_FLOOR_USD) {
    log.debug({ token: cand.symbol, pool: best.pool, usd: best.usd }, '反查到粉尘交易对(<$100)，跳过，等真毕业');
    return false;
  }
  return commit(best);
}
