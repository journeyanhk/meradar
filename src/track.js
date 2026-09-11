import { httpClient } from './chain.js';
import { TRANSFER_TOPIC } from './abi.js';
import { readPoolMetrics } from './enrich.js';
import { scoreCandidate } from './score.js';
import { narrativeHit, copycatCount } from './narrative.js';
import { maybeAlert } from './alert.js';
import { store } from './db.js';
import { config } from './config.js';
import { bus, Events } from './bus.js';
import { child } from './logger.js';

const log = child('track');
const LOOKBACK_BLOCKS = 1500n; // ~1h @ 3s/块，bounded 避免 RPC 超限

// 统计近窗口内 Transfer 的独立接收地址（买家代理指标）
async function countRecentBuyers(chain, token) {
  const client = httpClient(chain);
  try {
    const latest = await client.getBlockNumber();
    const from = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
    const logs = await client.getLogs({
      address: token,
      topics: [TRANSFER_TOPIC],
      fromBlock: from,
      toBlock: latest,
    });
    const receivers = new Set();
    for (const l of logs) {
      const to = l.topics?.[2];
      if (to) receivers.add('0x' + to.slice(26));
    }
    return receivers.size;
  } catch (e) {
    log.debug({ err: e.message, token }, 'countRecentBuyers 失败(可能 RPC 限制日志范围)');
    return 0;
  }
}

// 对单个候选跑一次跟踪
export async function pollCandidate(chain, cand) {
  const token = cand.address;

  // 若还没做过安全打分（曲线新币在毕业拿到 pool 后才可查），补一次
  if (!cand.safety_json && (cand.pool || cand.creator)) {
    const s = await scoreCandidate(chain, cand);
    store.setSafety(cand.key, s.checks);
    if (s.veto) {
      store.setStatus(cand.key, 'rejected', s.reason);
      bus.emit(Events.UPDATE, { ...store.get(cand.key) });
      return;
    }
  }

  const uniqueBuyers = await countRecentBuyers(chain, token);
  let poolM = null;
  if (cand.pool && cand.quote_symbol) {
    poolM = await readPoolMetrics(chain, {
      pool: cand.pool, token, quote: cand.quote_symbol,
      decimals: cand.decimals, totalSupply: safeSupply(cand),
    });
  }

  const prev = store.get(cand.key);
  const prevBuyers = prev?.unique_buyers || 0;
  const holderGrowthPct = prevBuyers > 0 ? ((uniqueBuyers - prevBuyers) / prevBuyers) * 100 : 0;

  const hits = narrativeHit(cand.name, cand.symbol);
  const copycats = copycatCount(chain, cand.symbol);

  const metrics = {
    liquidityUsd: poolM?.liquidityUsd || prev?.liquidity_usd || 0,
    priceUsd: poolM?.priceUsd || prev?.price_usd || 0,
    marketCapUsd: poolM?.marketCapUsd || prev?.market_cap_usd || 0,
    holders: uniqueBuyers,
    uniqueBuyers,
    holderGrowthPct,
    copycats,
    narrativeHits: hits,
    graduated: !!cand.graduated,
  };

  store.updateMetrics(cand.key, {
    liquidity_usd: metrics.liquidityUsd,
    price_usd: metrics.priceUsd,
    market_cap_usd: metrics.marketCapUsd,
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

function safeSupply(cand) {
  return cand.total_supply ? BigInt(cand.total_supply) : null;
}

let running = false;
export function startTracker() {
  const intervalMs = (config.tracking.pollIntervalSec || 45) * 1000;
  const noMomentumMs = (config.tracking.archiveIfNoMomentumMin || 180) * 60 * 1000;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const actives = store.activeCandidates(config.tracking.maxActiveCandidates || 300);
      for (const cand of actives) {
        // 归档：长期无动量的 T0
        if (cand.tier === 'T0' && Date.now() - cand.discovered_at > noMomentumMs && cand.market_cap_usd < 1) {
          store.setStatus(cand.key, 'archived', '无动量归档');
          continue;
        }
        try {
          await pollCandidate(cand.chain, cand);
        } catch (e) {
          log.debug({ err: e.message, token: cand.symbol }, 'pollCandidate 异常');
        }
      }
    } finally {
      running = false;
    }
  }

  setInterval(tick, intervalMs);
  log.info({ intervalSec: config.tracking.pollIntervalSec }, '跟踪层已启动');
}
