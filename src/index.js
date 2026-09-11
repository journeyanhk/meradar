import { config, chainConfig } from './config.js';
import { startServer } from './server.js';
import { startEngine, backfillRecentCreates } from './engine.js';
import { httpClient } from './chain.js';
import { refreshBnbUsd, getBnbUsd } from './enrich.js';
import { store } from './db.js';
import * as momentum from './momentum.js';
import { logger } from './logger.js';

// 启动自检：用当前 HTTP RPC 查最近 30 个区块、某发射台地址的日志，验证 eth_getLogs 未被封。
// （带 address 的窄查询才是真实用法；空 topics 全量查询很多 RPC 会直接 403，不代表不可用。）
async function selfCheckLogs(chain) {
  try {
    const client = httpClient(chain);
    const cfg = chainConfig(chain);
    const addr = cfg.launchpads?.find((l) => l.address && !/^0x0+$/.test(l.address))?.address;
    const latest = await client.getBlockNumber();
    const from = latest > 30n ? latest - 30n : 0n;
    await client.getLogs(addr ? { address: addr, fromBlock: from, toBlock: latest } : { fromBlock: from, toBlock: latest });
    logger.info({ chain }, 'eth_getLogs 自检通过');
  } catch (e) {
    logger.warn({ chain, err: e.message }, 'eth_getLogs 自检失败：该 RPC 可能封禁日志查询，毕业池定价会受影响，建议换 publicnode/付费 RPC');
  }
}

async function main() {
  logger.info({ chains: config.enabledChains }, 'Meme 雷达启动中…');

  if (!config.telegram.enabled) logger.warn('Telegram 未配置（.env: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）');
  if (!config.serverchan.enabled) logger.warn('Server酱 未配置（.env: SERVERCHAN_SENDKEY）');

  await startServer();

  const hasRpc = config.enabledChains.some((c) => config.rpc[c]?.http || config.rpc[c]?.ws);
  if (!hasRpc) {
    logger.warn('未配置任何链 RPC，仅启动 Web（不监听链上事件）');
    return;
  }

  // BNB 现价：启动先拉一次，之后每 60s 刷新（只读 Pancake WBNB/USDT 池）
  for (const chain of config.enabledChains) {
    if (!config.rpc[chain]?.http) continue;
    await selfCheckLogs(chain);
    if (chainConfig(chain).bnbUsdPool) {
      await refreshBnbUsd(chain);
      logger.info({ chain, bnbUsd: getBnbUsd(chain) }, 'BNB 现价已就绪');
      setInterval(() => refreshBnbUsd(chain).catch(() => {}), 60_000);
    }
  }

  // 快照清理：按 snapshotRetentionDays 保留，每小时清一次
  const retainDays = config.tracking.snapshotRetentionDays || 7;
  setInterval(() => {
    const removed = store.purgeSnapshots(Date.now() - retainDays * 24 * 3600 * 1000);
    if (removed) logger.debug({ removed }, '清理过期快照');
  }, 3600_000);

  // seen 清理：登记超 24h 仍无动量升级的候选归档，并释放内存动量状态，防止只增不减
  function cleanupStaleSeen() {
    const stale = store.staleSeen(Date.now() - 24 * 3600 * 1000);
    for (const s of stale) {
      store.setStatus(s.key, 'archived', 'seen 超 24h 无动量');
      momentum.forget(s.address);
    }
    if (stale.length) logger.debug({ archived: stale.length }, '归档陈旧 seen 候选');
  }
  setInterval(cleanupStaleSeen, 3600_000);

  // 启动回填最近 ~2h 的 TokenCreate，让慢热型老币也能进入跟踪
  for (const chain of config.enabledChains) {
    if (!config.rpc[chain]?.http) continue;
    await backfillRecentCreates(chain, 2).catch((e) => logger.warn({ chain, err: e.message }, '回填失败(忽略)'));
  }

  startEngine();
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, '启动失败');
  process.exit(1);
});

process.on('unhandledRejection', (e) => logger.error({ err: e?.message }, 'unhandledRejection'));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
