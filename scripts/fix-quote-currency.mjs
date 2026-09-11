// 一次性数据清洗：修复「Four.meme 曲线被一律按 BNB 计价」导致的历史污染。
//
// 背景：Four.meme 同一 Token Manager 上跑 BNB(报价=0x0)/USDT/USD1/任意 ERC20 报价的曲线，
// 旧代码把所有曲线事件都按 BNB×现价换算，于是 USDT 等非 BNB 报价的曲线币的
// market_cap / depth / net_in / peak_mcap / trades.quote_amount 被放大约一个 BNB 价格的倍数。
//
// 本脚本：
//   1) 对曲线期(pool 为空)且缺 quote_symbol 的候选，批量读 _tokenInfos 回填 quote_symbol/max_raising/launch_time；
//   2) 对报价币非 WBNB 的曲线币，清零被污染的美元字段并删除其 trades/snapshots，
//      让实时跟踪层用正确口径重新累计（peak_mcap 归零后由 refreshPeaks 重建）。
//
// 用法(在项目根)：node --no-warnings=ExperimentalWarning scripts/fix-quote-currency.mjs [--dry]
// 建议先跑 --dry 查看将要改动的数量，再正式执行；执行前先备份 data 目录。

import { store } from '../src/db.js';
import { config, chainConfig } from '../src/config.js';
import { readTokenInfos } from '../src/enrich.js';

const DRY = process.argv.includes('--dry');
const db = store.raw;

function tokenManagerAddr(chain) {
  const cfg = chainConfig(chain);
  const lp = cfg.launchpads?.find((l) => l.type === 'fourmeme-events' && l.address && !/^0x0+$/.test(l.address));
  return lp?.address || null;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function run() {
  console.log(DRY ? '== DRY RUN(不写库) ==' : '== 正式执行 ==');

  // 1) 回填缺失的 quote_symbol
  const needInfo = db.prepare(
    `SELECT key, chain, address FROM candidates WHERE pool IS NULL AND (quote_symbol IS NULL OR quote_symbol='') AND status IN ('active','rejected','seen')`,
  ).all();
  console.log(`待回填报价币的曲线候选: ${needInfo.length}`);

  const setInfo = db.prepare(
    `UPDATE candidates SET quote_symbol=@quote_symbol, max_raising=COALESCE(@max_raising,max_raising), launch_time=COALESCE(launch_time,@launch_time), updated_at=@updated_at WHERE key=@key`,
  );
  const byChain = {};
  for (const r of needInfo) (byChain[r.chain] ||= []).push(r);

  let filled = 0;
  for (const [chain, rows] of Object.entries(byChain)) {
    const tm = tokenManagerAddr(chain);
    if (!tm) { console.log(`  ${chain}: 未配置 Token Manager，跳过`); continue; }
    for (const group of chunk(rows, 80)) {
      const infos = await readTokenInfos(chain, tm, group.map((r) => r.address));
      for (const r of group) {
        const info = infos.get(r.address.toLowerCase());
        if (!info) continue;
        filled++;
        if (!DRY) setInfo.run({
          key: r.key, quote_symbol: info.quoteSym,
          max_raising: info.maxRaisingRaw != null ? info.maxRaisingRaw.toString() : null,
          launch_time: info.launchTimeMs, updated_at: Date.now(),
        });
      }
      await new Promise((s) => setTimeout(s, 200));
    }
    console.log(`  ${chain}: 回填 ${filled} 个`);
  }

  // 2) 清洗被 700× 污染的非 BNB 曲线币
  const polluted = db.prepare(
    `SELECT key FROM candidates WHERE pool IS NULL AND quote_symbol IS NOT NULL AND quote_symbol NOT IN ('WBNB','UNKNOWN')`,
  ).all();
  console.log(`报价币非 BNB 的曲线币(需清洗美元字段): ${polluted.length}`);

  const resetMetrics = db.prepare(
    `UPDATE candidates SET market_cap_usd=0, depth_usd=0, liquidity_usd=0, peak_mcap_usd=0,
       net_in_30m=0, net_in_1h=0, max_buy_10m=0, buy_ratio_30m=0, curve_progress_pct=0,
       tier='T0', updated_at=@updated_at WHERE key=@key`,
  );
  const delTrades = db.prepare(`DELETE FROM trades WHERE key=?`);
  const delSnaps = db.prepare(`DELETE FROM snapshots WHERE key=?`);
  let cleaned = 0;
  for (const r of polluted) {
    cleaned++;
    if (!DRY) {
      resetMetrics.run({ key: r.key, updated_at: Date.now() });
      delTrades.run(r.key);
      delSnaps.run(r.key);
    }
  }
  console.log(`清洗完成: ${cleaned} 个候选的美元字段已归零、trades/snapshots 已清空(实时层将按正确口径重建)`);
  console.log(DRY ? '(DRY RUN 未写库)' : '完成。建议重启服务。');
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
