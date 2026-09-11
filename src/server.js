import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { ROOT, config } from './config.js';
import { store } from './db.js';
import { bus, Events } from './bus.js';
import { linksFor } from './alert.js';
import { child } from './logger.js';

const log = child('server');

function decorate(c) {
  let safety = null;
  try { safety = c.safety_json ? JSON.parse(c.safety_json) : null; } catch { /* noop */ }
  return {
    key: c.key, chain: c.chain, address: c.address, launchpad: c.launchpad,
    name: c.name, symbol: c.symbol, tier: c.tier, status: c.status,
    graduated: !!c.graduated, creator: c.creator,
    liquidityUsd: c.liquidity_usd, priceUsd: c.price_usd, marketCapUsd: c.market_cap_usd,
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
