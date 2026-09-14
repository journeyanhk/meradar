import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { linksFor } from './alert.js';
import { healthSnapshot } from './health.js';
import { templateHealth } from './template.js';
import { rpcCapabilities } from './rpccap.js';
import { child } from './logger.js';
import { BUYER_TAGS } from './buyer.js';

const log = child('server');

// 软标记落库只存计数(buyerCount + 各标签数)；占比在此现算，避免同一份分布存两遍。
function softFlagsFrom(json) {
  let f = null;
  try { f = json ? JSON.parse(json) : null; } catch { return null; }
  if (!f) return null;
  const n = f.buyerCount || 0;
  const ratios = {};
  for (const t of BUYER_TAGS) ratios[`${t}Ratio`] = n > 0 ? (f[t] || 0) / n : 0;
  return { ...f, ...ratios };
}

function decorate(c) {
  let safety = null;
  try { safety = c.safety_json ? JSON.parse(c.safety_json) : null; } catch { /* noop */ }
  const peak = c.peak_mcap_usd || 0;
  const drawdownPct = peak > 0 ? Math.max(0, ((peak - (c.market_cap_usd || 0)) / peak) * 100) : 0;
  return {
    key: c.key, chain: c.chain, address: c.address, launchpad: c.launchpad,
    name: c.name, symbol: c.symbol, tier: c.tier, status: c.status,
    graduated: !!c.graduated, creator: c.creator,
    liquidityUsd: c.liquidity_usd, priceUsd: c.price_usd, marketCapUsd: c.market_cap_usd,
    depthUsd: c.depth_usd || 0, depthKind: c.depth_kind || 'curve', offersPct: c.offers_pct || 0,
    curveProgressPct: c.curve_progress_pct || 0, quoteSymbol: c.quote_symbol || null,
    peakMcapUsd: peak, drawdownPct,
    netIn30m: c.net_in_30m || 0, netIn1h: c.net_in_1h || 0,
    maxBuy10m: c.max_buy_10m || 0, buyRatio30m: c.buy_ratio_30m || 0, newBuyers30m: c.new_buyers_30m || 0,
    naturalBuyers30m: c.natural_buyers_30m || 0,
    softFlags: softFlagsFrom(c.soft_flags),
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
    template: templateHealth(), // { promoted24h, templateUnknownRate, learned } —— 未知率>5% 提示模板轮换
    time: Date.now(),
  }));

  app.get('/api/tokens', async (req) => {
    const limit = Math.min(Number(req.query?.limit) || 200, 500);
    return store.feed(limit).map(decorate);
  });

  app.get('/api/token/:key', async (req, reply) => {
    const c = store.get(decodeURIComponent(req.params.key));
    if (!c) return reply.code(404).send({ error: 'not found' });
    return { ...decorate(c), snapshots: store.snapshots(c.key) };
  });

  app.get('/api/stats', async () => {
    const since = Date.now() - 24 * 3600 * 1000;
    return store.stats(since);
  });

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
