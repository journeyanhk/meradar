import { config, chainConfig } from './config.js';
import { startServer } from './server.js';
import { startEngine, backfillRecentCreates } from './engine.js';
import { logsClient, measureSecPerBlock } from './chain.js';
import { refreshBnbUsd, getBnbUsd, refreshNativeUsd, getNativeUsd, hasLiveNativeUsd } from './enrich.js';
import { refreshDynamicQuotes } from './quotePrice.js';
import { probeStateOverride } from './rpccap.js';
import { store } from './db.js';
import * as momentum from './momentum.js';
import { setNativeUsd } from './health.js';
import { logger } from './logger.js';

// 启动自检：用当前 HTTP RPC 查最近 30 个区块、某发射台地址的日志，验证 eth_getLogs 未被封。
// （带 address 的窄查询才是真实用法；空 topics 全量查询很多 RPC 会直接 403，不代表不可用。）
async function selfCheckLogs(chain) {
  try {
    const client = logsClient(chain); // 日志自检走官方端点(与回填同源)
    const cfg = chainConfig(chain);
    // 发射台地址：Four.meme 用 address，Pons 用 factory（工厂逐币部署）。任取一个有效地址做窄查询。
    const addrOf = (l) => l.address || l.factory;
    const addr = cfg.launchpads?.map(addrOf).find((a) => a && !/^0x0+$/.test(a));
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
    // 出块间隔实测：回填窗口跨度与历史成交 ts 估算都靠它（Robinhood ~0.1s，写死 2s 会让新鲜度误判）。
    const spb = await measureSecPerBlock(chain);
    logger.info({ chain, secPerBlock: Number(spb.toFixed(3)) }, '出块间隔已实测');
    await probeStateOverride(chain).catch(() => {}); // 往返模拟能力探测，结果进 /api/health
    if (chainConfig(chain).bnbUsdPool) {
      await refreshBnbUsd(chain);
      logger.info({ chain, bnbUsd: getBnbUsd(chain) }, 'BNB 现价已就绪');
      setInterval(() => refreshBnbUsd(chain).catch(() => {}), 60_000);
    }
    // 原生资产(Robinhood ETH)美元价：启动拉一次 + 每 60s 刷新（复用 BSC ETH/USDT 池，M2b v4 定价依赖它）。
    if (chainConfig(chain).nativeUsdPool) {
      await refreshNativeUsd(chain);
      setNativeUsd(chain, getNativeUsd(chain), hasLiveNativeUsd(chain));
      logger.info({ chain, nativeUsd: getNativeUsd(chain), live: hasLiveNativeUsd(chain) }, '原生资产美元价已就绪');
      if (!hasLiveNativeUsd(chain)) logger.warn({ chain }, '原生资产美元价退回 fallback 常量(BSC 池不可用)，/api/health nativeUsd.live=false');
      setInterval(() => refreshNativeUsd(chain).then(() => setNativeUsd(chain, getNativeUsd(chain), hasLiveNativeUsd(chain))).catch(() => {}), 60_000);
    }
    // 动态报价币美元价：先刷一遍已登记的（重启热启），之后每 60s 复价过期项（$5000 流动性下限）
    await refreshDynamicQuotes(chain).catch(() => {});
    setInterval(() => refreshDynamicQuotes(chain).catch(() => {}), 60_000);
  }

  // 快照清理：按 snapshotRetentionDays 保留，每小时清一次
  const retainDays = config.tracking.snapshotRetentionDays || 7;
  setInterval(() => {
    const removed = store.purgeSnapshots(Date.now() - retainDays * 24 * 3600 * 1000);
    if (removed) logger.debug({ removed }, '清理过期快照');
  }, 3600_000);

  // 成交记录清理：保留 30 天（供阈值回放校准），每小时清一次
  setInterval(() => {
    const removed = store.purgeTrades(Date.now() - 30 * 24 * 3600 * 1000);
    if (removed) logger.debug({ removed }, '清理过期成交记录');
  }, 3600_000);

  // seen 清理：登记超 24h 仍无动量升级的候选直接删除（本就是噪声），并释放内存动量状态。
  // 关键：必须删除而非归档——归档后行仍存在，懒注册会因「行已存在」跳过它，
  // 导致「发行超 24h 才启动」的慢热币被永久忽略；删除后其首次买入会重新懒注册。
  function cleanupStaleSeen() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const stale = store.staleSeen(cutoff);
    for (const s of stale) momentum.forget(s.address);
    const removed = store.deleteStaleSeen(cutoff);
    if (removed) logger.debug({ removed }, '删除陈旧 seen 候选(允许日后懒注册重登记)');
  }
  setInterval(cleanupStaleSeen, 3600_000);

  // 启动回填最近 TokenCreate（默认 ~2h，链可用 backfillHours 覆盖：Robinhood ~0.1s/块，2h=7.2万块过重→取 1h）
  for (const chain of config.enabledChains) {
    if (!config.rpc[chain]?.http) continue;
    const hours = chainConfig(chain).backfillHours ?? 2;
    await backfillRecentCreates(chain, hours).catch((e) => logger.warn({ chain, err: e.message }, '回填失败(忽略)'));
  }

  // 回灌 active 币的买家集合（buyers 表 -> 内存动量），保持去重与计数在重启后连续
  let restored = 0;
  for (const cand of store.activeCandidates(config.tracking.maxActiveCandidates || 400)) {
    const accts = store.buyers(cand.key);
    if (accts.length) { momentum.restore(cand.address, accts); restored += accts.length; }
  }
  if (restored) logger.info({ restored }, '已回灌 active 买家集合');

  startEngine();
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, '启动失败');
  process.exit(1);
});

process.on('unhandledRejection', (e) => logger.error({ err: e?.message }, 'unhandledRejection'));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
