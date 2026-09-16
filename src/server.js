import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { ROOT, config, chainConfig, entryFilterFor } from './config.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { linksFor } from './alert.js';
import { healthSnapshot } from './health.js';
import { templateHealth } from './template.js';
import { rpcCapabilities } from './rpccap.js';
import { rpcRouting } from './chain.js';
import { child } from './logger.js';
import { buyerRatios } from './buyer.js';
import { paperStats } from './paper.js';
import { PRICE_STALE_MS, PRICE_UNKNOWN_MS } from './price.js';

const log = child('server');

// JSON 列解析：坏数据不该炸接口，一律回退 null。
function safeParse(json) {
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

// farm/tokens_24h 分布：一周后按 99 分位定阈值前，先把每地址 24h 买过的不同新币数分位输出到 /api/health。
// 60s 缓存(每链一次 buyers 表分组扫)，避免 health 被频繁调用时反复全扫。
let farmDistCache = { at: 0, data: null };
function farmDistribution() {
  if (farmDistCache.data && Date.now() - farmDistCache.at < 60_000) return farmDistCache.data;
  const since = Date.now() - 24 * 3600 * 1000;
  const threshold = config.buyerGrading?.farmMinTokens24h ?? 8;
  const out = {};
  for (const chain of config.enabledChains) {
    const counts = [...store.buyerTokenCounts24h(chain, since).values()].sort((a, b) => a - b);
    const n = counts.length;
    const q = (p) => (n ? counts[Math.min(n - 1, Math.floor(p * n))] : 0);
    out[chain] = {
      accounts: n, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: n ? counts[n - 1] : 0,
      threshold, farmHits: counts.filter((c) => c >= threshold).length,
    };
  }
  farmDistCache = { at: Date.now(), data: out };
  return out;
}

// pool-first 链(Arc)首日反推发射台：把最近 24h 建池交易的 from(部署者)/to(被调用合约) Top10 输出到 /api/health，
// 用于反查 Tolly/Arcpad/RadarDEX 等发射台合约地址。仅对 discoverFromPools 链输出，其它链为空对象。
function poolCreatorsSection() {
  const out = {};
  const since = Date.now() - 24 * 3600 * 1000;
  for (const chain of config.enabledChains) {
    if (!chainConfig(chain).discoverFromPools) continue;
    out[chain] = store.poolCreators24h(chain, since);
  }
  return out;
}

// 软标记落库只存计数(buyerCount + 各标签数)；占比在此现算(共用 buyer.js/buyerRatios)，避免同一份分布存两遍。
function softFlagsFrom(json) {
  const f = safeParse(json);
  if (!f) return null;
  return { ...f, ...buyerRatios(f) };
}

// 可试仓命中统计：扫 active 候选的 entry_json，按链输出 auditVersion + A/B/合格数，供上线后调阈值参考。
// 60s 缓存(与 farmDistribution 同理)，避免 health 频繁调用时反复全扫 active。
let entryFilterCache = { at: 0, data: null };
function entryFilterSection() {
  if (entryFilterCache.data && Date.now() - entryFilterCache.at < 60_000) return entryFilterCache.data;
  const out = {};
  for (const chain of config.enabledChains) {
    out[chain] = { auditVersion: entryFilterFor(chain).auditVersion || 'v1', evaluated: 0, ok: 0, A: 0, B: 0 };
  }
  for (const c of store.activeCandidates(1000)) {
    const o = out[c.chain];
    if (!o) continue;
    const e = safeParse(c.entry_json);
    if (!e) continue;
    o.evaluated++;
    if (e.ok) { o.ok++; if (e.tier === 'A') o.A++; else if (e.tier === 'B') o.B++; }
  }
  entryFilterCache = { at: Date.now(), data: out };
  return out;
}

function decorate(c) {
  const safety = safeParse(c.safety_json);
  const peak = c.peak_mcap_usd || 0;
  const drawdownPct = peak > 0 ? Math.max(0, ((peak - (c.market_cap_usd || 0)) / peak) * 100) : 0;
  return {
    key: c.key, chain: c.chain, address: c.address, launchpad: c.launchpad,
    name: c.name, symbol: c.symbol, tier: c.tier, status: c.status,
    graduated: !!c.graduated, creator: c.creator,
    liquidityUsd: c.liquidity_usd, priceUsd: c.price_usd, marketCapUsd: c.market_cap_usd,
    priceSource: c.price_source || null,
    priceUpdatedAt: c.price_updated_at || null,
    priceState: c.price_state || null,
    priceStale: c.price_updated_at ? (Date.now() - c.price_updated_at) > PRICE_STALE_MS : false,
    priceUnknown: c.price_updated_at ? (Date.now() - c.price_updated_at) > PRICE_UNKNOWN_MS : false,
    liquidityWithdrawn: !!(c.graduated && c.pool && (c.price_usd || 0) === 0 && (c.depth_usd || 0) === 0),
    depthUsd: c.depth_usd || 0, depthKind: c.depth_kind || 'curve', offersPct: c.offers_pct || 0,
    poolFeePct: c.pool_fee_pct ?? null,
    lpLocked: !!c.locker,          // Arc 发射台：LP 锁仓合约存在 → 前端「LP 已锁」badge
    tokenUri: c.token_uri || null, // 项目图/元数据链接(Arc 发射台)
    feeSchedule: safeParse(c.fee_schedule), // FeeConfig 原始 8 值(仅展示，实际费率取 poolFeePct)
    curveProgressPct: c.curve_progress_pct || 0, quoteSymbol: c.quote_symbol || null,
    peakMcapUsd: peak, drawdownPct,
    netIn30m: c.net_in_30m || 0, netIn1h: c.net_in_1h || 0,
    maxBuy10m: c.max_buy_10m || 0, buyRatio30m: c.buy_ratio_30m || 0, newBuyers30m: c.new_buyers_30m || 0,
    naturalBuyers30m: c.natural_buyers_30m || 0,
    softFlags: softFlagsFrom(c.soft_flags),
    entry: safeParse(c.entry_json),
    holders: c.holders, uniqueBuyers: c.unique_buyers, copycats: c.copycats,
    narrativeHit: c.narrative_hit ? c.narrative_hit.split(',').filter(Boolean) : [],
    discoveredAt: c.discovered_at, updatedAt: c.updated_at,
    rejectReason: c.reject_reason, safety,
    links: linksFor(c.chain, c),
  };
}

export async function startServer() {
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/' });

  app.get('/api/health', async () => ({
    ok: true, chains: config.enabledChains,
    telegram: config.telegram.enabled, serverchan: config.serverchan.enabled,
    runtime: healthSnapshot(),
    rpcCapabilities: rpcCapabilities(),
    rpcRouting: rpcRouting(), // 各链 RPC 路由：ws 优先级列表(首项=主路)、read/logs 各走哪一路(drpc/alchemy/official…)
    template: templateHealth(), // { promoted24h, templateUnknownRate, learned } —— 未知率>5% 提示模板轮换
    buyerGrading: farmDistribution(), // 每链 tokens_bought_24h 分位(50/90/99/max) + farm 命中数，供一周后定阈值
    poolCreators24h: poolCreatorsSection(), // pool-first 链(Arc)首日反推发射台：建池者/被调合约 Top10
    entryFilter: entryFilterSection(), // 可试仓命中：各链 auditVersion + A/B/合格数(active 扫描)，供调阈值参考
    time: Date.now(),
  }));

  app.get('/api/tokens', async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 200, 500);
    const chain = req.query?.chain || null;
    return store.feed(limit, chain).map(decorate);
  });

  app.get('/api/token/:key', async (req, reply) => {
    const c = store.get(decodeURIComponent(req.params.key));
    if (!c) return reply.code(404).send({ error: 'not found' });
    return { ...decorate(c), snapshots: store.snapshots(c.key) };
  });

  app.get('/api/stats', async (req) => {
    const since = Date.now() - 24 * 3600 * 1000;
    const chain = req.query?.chain || null; // 方案0-5：分链统计(空=全量)，前端据 seen 数显示「本链 N 个候选等待准入」
    return store.stats(since, chain);
  });

  // M4 纸面引擎统计：各分组(baseline_seen/tier_t1/tier_t2/entry_pass)的开/平/延期/跳过计数
  // + 已平仓的均值/中位/胜率/平均持有时长，评估各信号档的模拟回报。
  app.get('/api/paper', async () => paperStats());

  // SSE 实时推送
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`retry: 3000\n\n`);

    const send = (type, data) => {
      try {
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(decorate(data))}\n\n`);
      } catch { /* client gone */ }
    };
    const onCand = (d) => send('candidate', d);
    const onUpd = (d) => send('update', d);
    const onAlert = (d) => {
      try { reply.raw.write(`event: alert\ndata: ${JSON.stringify(decorate(d))}\n\n`); } catch { /* noop */ }
    };
    bus.on(Events.CANDIDATE, onCand);
    bus.on(Events.UPDATE, onUpd);
    bus.on(Events.ALERT, onAlert);

    const ping = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`); } catch { /* noop */ }
    }, 25000);

    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off(Events.CANDIDATE, onCand);
      bus.off(Events.UPDATE, onUpd);
      bus.off(Events.ALERT, onAlert);
    });
  });

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, host: config.host }, `雷达服务已启动 http://${config.host}:${config.port}`);
  return app;
}
