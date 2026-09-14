import { readPoolMetrics, resolveQuote, quoteUsd, readCurveFunds } from './enrich.js';
import { scoreCandidate, evaluateTradeSafety } from './score.js';
import { discoverPool, graduatedByCurve } from './pool.js';
import { narrativeHit, copycatCount } from './narrative.js';
import { maybeAlert, evaluateTier } from './alert.js';
import { store } from './db.js';
import { config, chainConfig } from './config.js';
import { bus, Events } from './bus.js';
import * as momentum from './momentum.js';
import { child } from './logger.js';
import { formatUnits } from 'viem';

const log = child('track');
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };

function supplyHuman(cand) {
  if (!cand.total_supply) return 0;
  try { return Number(formatUnits(BigInt(cand.total_supply), cand.decimals || 18)); }
  catch { return 0; }
}

// 对单个候选跑一次跟踪
export async function pollCandidate(chain, cand) {
  const token = cand.address;
  const cfg = chainConfig(chain);
  // 报价币：BNB(0x0→WBNB)/USDT/USD1/… 各不相同。解析不到(未知报价币)则不定价，避免按 BNB 猜。
  const q = resolveQuote(cfg, cand.quote_symbol);
  const quotePriceUsd = q ? quoteUsd(chain, q.sym) : null;
  const quoteDec = q?.decimals || 18;

  // 曲线期指标来自内存事件流（零 RPC）；毕业后用池子真实储备
  const curve = momentum.curveMetrics(token, supplyHuman(cand), quotePriceUsd, quoteDec);

  // Pons(curve-per-token) 募集额：曲线事件不带 funds，改读 curve 合约余额（原生 ETH=getBalance，
  // ERC-20 计价=balanceOf）。实测 curve 余额 == 累计净买入，是权威且自愈的募集额，覆盖进内存指标。
  if (curve && cand.curve && !cand.pool) {
    const cf = await readCurveFunds(chain, cand.curve, q?.address, quoteDec).catch(() => null);
    if (cf) {
      curve.fundsQuote = cf.fundsQuote;
      curve.fundsUsd = quotePriceUsd != null ? cf.fundsQuote * quotePriceUsd : 0;
    }
  }

  // 毕业检测（状态驱动，每轮自愈）：Token Manager 毕业后不再发买卖事件，momentum 价格会冻结在毕业瞬间。
  // 池子若靠 PairCreated 一次性事件补——事件丢失/交易对被提前建/重启窗口——就永远接不上，卡片冻结在毕业价。
  // 这里在 offers 耗尽或募集达标时主动反查交易对；找不到不报错，靠下一轮 tick 重试（注入流动性有几秒~几十秒延迟）。
  if (!cand.pool && curve) {
    if (graduatedByCurve(cand, curve, quoteDec)) {
      const found = await discoverPool(chain, cand, { graduated: true }).catch((e) => { log.debug({ err: e.message }, 'discoverPool(track)'); return false; });
      if (found) cand = store.get(cand.key) || cand; // 用最新 pool/pool_type/quote_symbol 走本轮池子定价
    }
  }

  // 每轮跑三态贸易安全：曲线期查平台模板白名单，毕业后跑往返模拟（各自带缓存，重复调用廉价）。
  // graduating：已达毕业条件但池子尚未接上（discoverPool 有几秒~几轮延迟），此窗口不走模板 PASS，等池接上走往返。
  const graduating = !cand.pool && !!curve && graduatedByCurve(cand, curve, quoteDec);
  const ts = await scoreCandidate(chain, cand, { graduating });
  store.setSafety(cand.key, ts.checks);
  if (ts.veto) {
    store.setStatus(cand.key, 'rejected', ts.reason);
    bus.emit(Events.UPDATE, { ...store.get(cand.key) });
    return;
  }
  const tradeSafety = ts.checks.tradeSafety || null;

  // 曲线期指标已在毕业检测前算好（curve）；毕业后用池子真实储备
  let poolM = null;
  if (cand.pool && cand.quote_symbol) {
    poolM = await readPoolMetrics(chain, {
      pool: cand.pool, poolType: cand.pool_type, token, quote: cand.quote_symbol,
      decimals: cand.decimals, totalSupply: cand.total_supply ? BigInt(cand.total_supply) : null,
    });
  }

  const prev = store.get(cand.key);
  const uniqueBuyers = curve?.uniqueBuyers ?? prev?.unique_buyers ?? 0;
  const prevBuyers = prev?.unique_buyers || 0;
  const holderGrowthPct = prevBuyers > 0 ? ((uniqueBuyers - prevBuyers) / prevBuyers) * 100 : 0;

  const hits = narrativeHit(cand.name, cand.symbol);
  const copycats = cand.copy_of ? 0 : copycatCount(chain, cand.symbol); // 仅原版累计仿盘热度

  // 深度：曲线期=募集额(funds×报价币美元价，已在 curveMetrics 换算)，毕业后=池储备。
  let depthUsd, depthKind;
  if (cand.pool && poolM) { depthUsd = poolM.liquidityUsd || prev?.depth_usd || 0; depthKind = 'amm'; }
  else { depthUsd = curve?.fundsUsd || prev?.depth_usd || 0; depthKind = 'curve'; }
  const offersPct = curve?.offersPct ?? prev?.offers_pct ?? 0;
  // 曲线毕业进度 = funds / maxRaising（同为报价币单位，比值与小数位无关），比「剩余%」直观。
  const maxRaisingHuman = cand.max_raising ? Number(cand.max_raising) / (10 ** quoteDec) : 0;
  const curveProgressPct = (!cand.pool && maxRaisingHuman > 0 && curve)
    ? Math.min(100, (curve.fundsQuote / maxRaisingHuman) * 100)
    : (prev?.curve_progress_pct ?? 0);

  // 净流入/最大单笔/买卖比/新买家 —— 全部一句 SQL 取自 trades 表
  const flow = store.tradeFlow(cand.key);

  // 三条独立新鲜度门的输入（见 alert.evaluateTier）：
  //  · 成交新鲜度 = 最近一次成交距今（trades 表 → 内存动量）
  //  · 毕业新鲜度 = graduated_at；老数据(NULL)传 0 → 视为很久以前 → 毕业腿不再单独触发 T2
  //  · 往返新鲜度 = 本轮 tradeSafety 的 checkedAt（毕业币）
  const now = Date.now();
  // 成交新鲜度取「多源最大值」：trades 表只含 promote 之后的成交，回填的历史成交只在内存里；
  // 用 ?? 会被更旧的 trades 值遮住更新的内存值 —— 取 max 才不误判为不新鲜。
  const lastTradeTs = Math.max(store.lastTradeTs(cand.key) || 0, momentum.lastTradeTs(cand.address) || 0);
  const graduatedAt = cand.graduated ? (cand.graduated_at ?? 0) : null;

  const metrics = {
    liquidityUsd: depthUsd,
    depthUsd,
    depthKind,
    offersPct,
    curveProgressPct,
    priceUsd: poolM?.priceUsd || curve?.priceUsd || prev?.price_usd || 0,
    marketCapUsd: poolM?.marketCapUsd || curve?.marketCapUsd || prev?.market_cap_usd || 0,
    volumeUsd: curve?.volumeUsd || prev?.volume_usd || 0,
    holders: uniqueBuyers,
    uniqueBuyers,
    holderGrowthPct,
    netIn30m: flow.net30,
    netIn1h: flow.net1h,
    maxBuy10m: flow.maxBuy10,
    buyRatio30m: flow.buyRatio30,
    newBuyers30m: flow.newBuyers30m,
    copycats,
    narrativeHits: hits,
    isOriginal: !cand.copy_of,
    graduated: !!cand.graduated,
    listing: false, // 毕业不再直接判 T3；T3 保留给真实 CEX/Alpha 上币事件源（未来接入）
    // —— 贸易安全 + 新鲜度（供 evaluateTier 封顶 & 告警安全行）——
    now,
    lastTradeTs,
    graduatedAt,
    roundTripCheckedAt: tradeSafety?.checkedAt ?? null,
    capTier: tradeSafety?.capTier ?? null,
    tradeSafety,
  };

  store.updateMetrics(cand.key, {
    liquidity_usd: metrics.liquidityUsd,
    price_usd: metrics.priceUsd,
    market_cap_usd: metrics.marketCapUsd,
    volume_usd: metrics.volumeUsd,
    holders: metrics.holders,
    unique_buyers: metrics.uniqueBuyers,
    copycats: metrics.copycats,
    narrative_hit: hits.join(',') || null,
    graduated: cand.graduated ? 1 : 0,
    depth_usd: depthUsd,
    depth_kind: depthKind,
    offers_pct: offersPct,
    curve_progress_pct: curveProgressPct,
    net_in_30m: flow.net30,
    net_in_1h: flow.net1h,
    max_buy_10m: flow.maxBuy10,
    buy_ratio_30m: flow.buyRatio30,
    new_buyers_30m: flow.newBuyers30m,
  });
  store.addSnapshot({
    key: cand.key,
    liquidity_usd: metrics.liquidityUsd,
    price_usd: metrics.priceUsd,
    market_cap_usd: metrics.marketCapUsd,
    holders: metrics.holders,
    unique_buyers: metrics.uniqueBuyers,
  });

  const fresh = store.get(cand.key);
  // 强提示前保新鲜：若本轮 rawTier 已达 T2/T3 但毕业币往返结果过期(>10min)，重跑一次往返再定级，
  // 避免拿着旧快照发强提示。曲线期(模板)无此问题，模板哈希永久有效。
  const prelim = evaluateTier(fresh, metrics);
  if (cand.pool && RANK[prelim.rawTier] >= RANK.T2 && !prelim.rtFresh) {
    const ts2 = await evaluateTradeSafety(chain, cand, { wantFresh: true }).catch(() => null);
    if (ts2) {
      metrics.tradeSafety = ts2;
      metrics.roundTripCheckedAt = ts2.checkedAt ?? null;
      metrics.capTier = ts2.capTier ?? null;
      store.setSafety(cand.key, { ...ts.checks, tradeSafety: ts2 });
      if (ts2.state === 'REJECT') {
        store.setStatus(cand.key, 'rejected', ts2.reason);
        bus.emit(Events.UPDATE, { ...store.get(cand.key) });
        return;
      }
    }
  }
  await maybeAlert(chain, fresh, metrics);
  bus.emit(Events.UPDATE, { ...store.get(cand.key) });
}

// 并发受限执行
async function runPool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); }
      catch (e) { log.debug({ err: e.message }, 'worker 异常'); }
    }
  });
  await Promise.all(runners);
}

// 用免费事件流刷新所有动量币的峰值市值（含 rejected），供漏杀率统计
function refreshPeaks(sinceMs) {
  const rows = store.raw.prepare(
    `SELECT key, chain, address, total_supply, decimals, quote_symbol FROM candidates WHERE discovered_at > ? AND status != 'archived'`,
  ).all(sinceMs);
  for (const r of rows) {
    const q = resolveQuote(chainConfig(r.chain), r.quote_symbol);
    if (!q) continue; // 未知/未解析报价币 → 不定价，避免污染峰值
    const m = momentum.curveMetrics(r.address, supplyHuman(r), quoteUsd(r.chain, q.sym), q.decimals);
    if (m && m.marketCapUsd > 0) store.updatePeak(r.key, m.marketCapUsd);
  }
}

let running = false;
export function startTracker() {
  const intervalMs = (config.tracking.pollIntervalSec || 45) * 1000;
  const noMomentumMs = (config.tracking.archiveIfNoMomentumMin || 180) * 60 * 1000;
  const concurrency = config.tracking.concurrency || 6;

  async function tick() {
    if (running) return;
    running = true;
    try {
      refreshPeaks(Date.now() - 24 * 3600 * 1000);
      const actives = store.activeCandidates(config.tracking.maxActiveCandidates || 400);
      const toPoll = [];
      for (const cand of actives) {
        // 归档判据用「活动」而非「市值<1」：市值为 0 可能只是价格还没重建(清洗/重启后竞态)，
        // 会把链上仍在成交的币误踢出跟踪集。改用最后一次成交距今，多源取最大以抗竞态：
        // trades 表(实时落库) / 内存动量(含回填) / updated_at(清洗刚触过则视为活跃)。
        const lastTradeTs = Math.max(
          store.lastTradeTs(cand.key) || 0,
          momentum.lastTradeTs(cand.address) || 0,
          cand.updated_at || 0,
        );
        if (cand.tier === 'T0' && Date.now() - lastTradeTs > noMomentumMs) {
          store.setStatus(cand.key, 'archived', '无动量归档');
          momentum.forget(cand.address);
          if (cand.pool) bus.emit(Events.POOLS_CHANGED, { chain: cand.chain }); // 归档已毕业币需重建成交订阅
          continue;
        }
        toPoll.push(cand);
      }
      await runPool(toPoll, concurrency, (cand) => pollCandidate(cand.chain, cand));
    } finally {
      running = false;
    }
  }

  setInterval(tick, intervalMs);
  log.info({ intervalSec: config.tracking.pollIntervalSec, concurrency }, '跟踪层已启动');
}
