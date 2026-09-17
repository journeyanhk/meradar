#!/usr/bin/env node
// 手动触发一次数据库维护(等同 maintenance.js 每日任务)。用于上线后立刻清存量、
// 让 freelist_count 涨起来，再决定停服 VACUUM 回收。
//
// 用法：
//   node scripts/db-maintain.mjs            # 用 config.maintenance 的保留期跑一次
//   node scripts/db-maintain.mjs --stats    # 只打印各表行数与 freelist，不删除
//
// 注意：只删噪声/过期行，绝不动 active/archived 候选行本身与 paper_positions。
import { store } from '../src/db.js';
import { runMaintenance } from '../src/maintenance.js';
import { config } from '../src/config.js';

const statsOnly = process.argv.includes('--stats');

function printStats(label) {
  const rows = store.rawCounts?.() ?? null;
  console.log(`\n[${label}]`);
  if (rows) console.table(rows);
  const fl = store.freelistInfo?.();
  if (fl) console.log(`freelist: ${fl.free_pages} 页 × ${fl.page_size}B = ${fl.reclaimable_mb} MB 可回收`);
}

printStats('维护前');
if (statsOnly) process.exit(0);

const removed = runMaintenance(config.maintenance ?? {});
console.log('\n本次删除：', JSON.stringify(removed));
printStats('维护后');
console.log('\n若 freelist 可回收 MB 较大，可低峰停服执行：');
console.log('  sqlite3 data/meradar.sqlite "PRAGMA auto_vacuum=INCREMENTAL; VACUUM;"');
process.exit(0);
