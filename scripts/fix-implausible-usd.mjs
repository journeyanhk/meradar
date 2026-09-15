// 一次性数据清洗：修复「报价币无美元价却被填了单位错误常量/残留值」导致的离谱数字（$MUMO 教训）。
//
// 背景：Robinhood 上以代币化股票(MU/TSLA…)计价的曲线/毕业币，目前无美元价来源；某条历史路径曾把
// quoteUsd 填成 10^17 量级值，写出市值 $1.7e20、深度 $1.8e18，并经 keepOld/peak_mcap 被长期保留。
// resolvePrice 现已加合理性钳位(state='implausible' → 归零)，会在下一轮跟踪自愈 price/mcap/depth，
// 但历史 peak_mcap_usd 与已污染快照/成交额需一次性清洗。
//
// 本脚本：对存储值命中合理性钳位(isImplausibleUsd)的候选，清零美元字段 + peak，
// 删除其 trades/snapshots，tier 复位；实时跟踪层将按正确口径(无价→不定价)重建。
//
// 用法(项目根)：node --no-warnings=ExperimentalWarning scripts/fix-implausible-usd.mjs [--dry] [--chain=robinhood]
// 建议先 --dry 查看数量，再正式执行；执行前备份 data 目录。

import { store } from '../src/db.js';
import { isImplausibleUsd } from '../src/price.js';

const DRY = process.argv.includes('--dry');
const chainArg = (process.argv.find((a) => a.startsWith('--chain=')) || '').split('=')[1] || null;
const db = store.raw;

function run() {
  console.log(DRY ? '== DRY RUN(不写库) ==' : '== 正式执行 ==', chainArg ? `chain=${chainArg}` : '(全链)');

  const rows = db.prepare(
    `SELECT key, chain, symbol, price_usd, market_cap_usd, depth_usd, peak_mcap_usd
       FROM candidates ${chainArg ? 'WHERE chain=@chain' : ''}`,
  ).all(chainArg ? { chain: chainArg } : {});

  // 命中钳位的：当前值离谱，或 peak 离谱(peak 单独判，钳位只护当前值不护历史 peak)。
  const bad = rows.filter((r) =>
    isImplausibleUsd({ priceUsd: r.price_usd || 0, marketCapUsd: r.market_cap_usd || 0, depthUsd: r.depth_usd || 0 })
    || (r.peak_mcap_usd || 0) > 1e9);
  console.log(`命中合理性钳位(需清洗)的候选: ${bad.length} / ${rows.length}`);
  for (const r of bad.slice(0, 20)) {
    console.log(`  ${r.chain}:${r.symbol} mcap=${r.market_cap_usd} depth=${r.depth_usd} peak=${r.peak_mcap_usd}`);
  }

  const reset = db.prepare(
    `UPDATE candidates SET market_cap_usd=0, depth_usd=0, liquidity_usd=0, price_usd=0, peak_mcap_usd=0,
       net_in_30m=0, net_in_1h=0, max_buy_10m=0, buy_ratio_30m=0, curve_progress_pct=0,
       price_state='implausible', tier='T0', updated_at=@updated_at WHERE key=@key`,
  );
  const delTrades = db.prepare(`DELETE FROM trades WHERE key=?`);
  const delSnaps = db.prepare(`DELETE FROM snapshots WHERE key=?`);
  let cleaned = 0;
  for (const r of bad) {
    cleaned++;
    if (!DRY) { reset.run({ key: r.key, updated_at: Date.now() }); delTrades.run(r.key); delSnaps.run(r.key); }
  }
  console.log(`清洗完成: ${cleaned} 个候选美元字段已归零、trades/snapshots 已清空(实时层按正确口径重建)`);
  console.log(DRY ? '(DRY RUN 未写库)' : '完成。建议重启服务。');
}

run();
process.exit(0);
