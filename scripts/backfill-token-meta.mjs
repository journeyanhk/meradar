// 一次性数据修复：补读元数据留空的候选（名字「?」、市值 $0 的根因）。
//
// 背景：Pons 的 TokenLaunched 不带 name/symbol/totalSupply，代码在 promote 那一刻读一次链上元数据；
// 若那一刻 readToken 撞官方公共端点的 429/超时 → 返回 null → name/symbol/total_supply 永久留空 →
// 卡片名字「?」、市值 = 供应量×价格 = null×价格 = 0。track.js 现已加「每轮退避重试补读」会自愈，
// 本脚本对现有空字段行做一次性批量补读，让它们立即恢复（比等退避周期快）。
//
// 读取走 httpClient(chain)（Robinhood 已改 dRPC 优先，稳定不易 429）；每批 30 个，批间隔 500ms。
//
// 用法(项目根)：node --no-warnings=ExperimentalWarning scripts/backfill-token-meta.mjs [--dry] [--chain=robinhood]
// 建议先 --dry 查看数量。执行前建议备份 data 目录。

import { store } from '../src/db.js';
import { readToken } from '../src/enrich.js';

const DRY = process.argv.includes('--dry');
const chainArg = (process.argv.find((a) => a.startsWith('--chain=')) || '').split('=')[1] || null;
const db = store.raw;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(DRY ? '== DRY RUN(不写库) ==' : '== 正式执行 ==', chainArg ? `chain=${chainArg}` : '(全链)');

  const rows = db.prepare(
    `SELECT key, chain, address, symbol, total_supply, creator
       FROM candidates
      WHERE (symbol IS NULL OR total_supply IS NULL) AND status != 'archived'
        ${chainArg ? 'AND chain=@chain' : ''}`,
  ).all(chainArg ? { chain: chainArg } : {});

  console.log(`缺 symbol/total_supply 的候选: ${rows.length}`);
  if (!rows.length || DRY) {
    for (const r of rows.slice(0, 20)) console.log(`  ${r.chain}:${r.address} symbol=${r.symbol} supply=${r.total_supply}`);
    return;
  }

  let fixed = 0, failed = 0;
  const BATCH = 30;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const metas = await Promise.all(batch.map((r) => readToken(r.chain, r.address).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j], meta = metas[j];
      if (meta && meta.symbol) {
        store.enrich(r.key, {
          name: meta.name, symbol: meta.symbol, decimals: meta.decimals,
          total_supply: meta.totalSupply?.toString() || r.total_supply, creator: r.creator,
        });
        fixed++;
      } else {
        failed++;
      }
    }
    console.log(`  进度 ${Math.min(i + BATCH, rows.length)}/${rows.length}  已补 ${fixed}  失败 ${failed}`);
    await sleep(500);
  }
  console.log(`完成：补齐 ${fixed}，仍失败 ${failed}（失败项将由 track.js 退避重试继续兜底）`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
