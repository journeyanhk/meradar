import { readPoolMetrics, getBnbUsd } from './enrich.js';
import { scoreCandidate } from './score.js';
import { narrativeHit, copycatCount } from './narrative.js';
import { maybeAlert } from './alert.js';
import { store } from './db.js';
import { config } from './config.js';
import { bus, Events } from './bus.js';
import * as momentum from './momentum.js';
import { child } from './logger.js';
import { formatUnits } from 'viem';

const log = child('track');

function supplyHuman(cand) {
  if (!cand.total_supply) return 0;
  try { return Number(formatUnits(BigInt(cand.total_supply), cand.decimals || 18)); }
  catch { return 0; }
}

// 对单个候选跑一次跟踪
export async function pollCandidate(chain, cand) {
  const token = cand.address;
  const bnbUsd = getBnbUsd(chain);

  // 毕业后拿到池子才可做 getAmountsOut 往返，补一次安全打分
  if (cand.pool && !hasHoneypotCheck(cand)) {
    const s = await scoreCandidate(chain, cand);
    store.setSafety(cand.key, s.checks);
    if (s.veto) {
      store.setStatus(cand.key, 'rejected', s.reason);
      bus.emit(Events.UPDATE, { ...store.get(cand.key) });
      return;
    }
  }

  // 曲线期指标来自内存事件流（零 RPC）；毕业后用池子真实储备
  const curve = momentum.curveMetrics(token, supplyHuman(cand), bnbUsd);
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

  const metrics = {
    liquidityUsd: poolM?.liquidityUsd || prev?.liquidity_usd || 0,
    priceUsd: poolM?.priceUsd || curve?.priceUsd || prev?.price_usd || 0,
    marketCapUsd: poolM?.marketCapUsd || curve?.marketCapUsd || prev?.market_cap_usd || 0,
    volumeUsd: curve?.volumeUsd || prev?.volume_usd || 0,
    holders: uniqueBuyers,
    uniqueBuyers,
    holderGrowthPct,
    copycats,
    narrativeHits: hits,
    isOriginal: !cand.copy_of,
    graduated: !!cand.graduated,
    listing: !!cand.graduated, // 毕业到 Pancake 视为上所信号
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
  await maybeAlert(chain, fresh, metrics);
  bus.emit(Events.UPDATE, { ...store.get(cand.key) });
}

function hasHoneypotCheck(cand) {
  if (!cand.safety_json) return false;
  try { const s = JSON.parse(cand.safety_json); return !!(s.honeypot && s.honeypot.ok !== undefined); }
  catch { return false; }
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
    `SELECT key, chain, address, total_supply, decimals FROM candidates WHERE discovered_at > ? AND status != 'archived'`,
  ).all(sinceMs);
  for (const r of rows) {
    const bnbUsd = getBnbUsd(r.chain);
    const m = momentum.curveMetrics(r.address, supplyHuman(r), bnbUsd);
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
        if (cand.tier === 'T0' && Date.now() - cand.discovered_at > noMomentumMs && cand.market_cap_usd < 1) {
          store.setStatus(cand.key, 'archived', '无动量归档');
          momentum.forget(cand.address);
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
