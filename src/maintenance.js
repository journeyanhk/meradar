// 数据库维护（序 1.5 止血）：SQLite 删行不自动归还磁盘，且部分表(v4_pools/buyers/pool_creators)此前无保留策略，
// 是文件持续膨胀的根因。每日在低峰时(config.maintenance.hour，默认 04:00 本地时)执行一次：
//   ① 按保留期分批 DELETE（每批 batchSize 行，循环到 0，避免长事务阻塞轮询写入）
//   ② wal_checkpoint(TRUNCATE) 截断 WAL，防长读事务让 -wal 涨到数百 MB
//   ③ incremental_vacuum 分次归还空闲页(auto_vacuum=INCREMENTAL 下有效；老库首次需停服 VACUUM)
//   ④ ANALYZE 更新统计，稳定查询计划
// 全部只读元数据 + 删噪声行，绝不动 candidates(active/archived) 行本身与 paper_positions。
import { store } from './db.js';
import { logger } from './logger.js';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const log = logger.child({ mod: 'maintenance' });

// 分批删除到返回 0 为止，返回累计删除行数。fn(batchSize) 每次删至多 batchSize 行。
export function drain(fn, batchSize) {
  let total = 0;
  for (;;) {
    const n = fn(batchSize);
    total += n;
    if (n < batchSize) break; // 不足一批=已删完
  }
  return total;
}

// 执行一轮维护。导出供测试直接调用（不依赖定时器）。
export function runMaintenance(cfg = {}) {
  const now = Date.now();
  const batch = cfg.batchSize ?? 5000;
  const tradesMs = (cfg.tradesRetentionDays ?? 14) * DAY;
  const buyersMs = (cfg.buyersRetentionDays ?? 14) * DAY;
  const v4Ms = (cfg.v4PoolsRetentionHours ?? 48) * HOUR;
  const pcMs = (cfg.poolCreatorsRetentionDays ?? 30) * DAY;

  const removed = {
    trades: drain((n) => store.purgeTradesBatch(now - tradesMs, n), batch),
    buyers: drain((n) => store.purgeBuyers(now - buyersMs, n), batch),
    v4Pools: drain((n) => store.purgeOrphanV4Pools(now - v4Ms, n), batch),
    poolCreators: drain((n) => store.purgePoolCreators(now - pcMs, n), batch),
  };

  // 回收空间 + 更新统计（删完再做，才有空闲页可归还）。
  store.walCheckpoint();
  store.incrementalVacuum(cfg.vacuumPages ?? 4000);
  store.analyze();

  log.info({ removed }, '数据库维护完成');
  return removed;
}

// 每日调度：进程内轻量定时器，每分钟检查是否到点(命中 config.maintenance.hour 的第 0 分钟)。
// 不引外部 cron，重启即恢复；同一小时内只跑一次(记 lastRunDay)。
export function startMaintenance(cfg = {}) {
  if (cfg.enabled === false) { log.info('数据库维护未启用'); return; }
  const hour = cfg.hour ?? 4;
  let lastRunKey = null;
  const tick = () => {
    const d = new Date();
    if (d.getHours() !== hour) return;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (key === lastRunKey) return; // 今天已跑
    lastRunKey = key;
    try { runMaintenance(cfg); }
    catch (e) { log.error({ err: e.message }, '数据库维护失败'); }
  };
  setInterval(tick, 60_000);
  log.info({ hour }, '数据库维护已排程(每日)');
}
