// 序2：评分输入采集(只读)。汇总 scorecard.js(序3) 需要的三个新维度，纯读、不落库、不动 updated_at：
//   1) top10Pct   —— 前10买家净持仓集中度(%)，越高越集中(散户少/易砸盘)，null=无成交样本(unknown)
//   2) creator    —— 建币者历史 { launches, rugged, recent }，rugged/launches 反映跑路率
//   3) devPct     —— dev(建币者)当前持仓占总供应比(%)，越高越有砸盘风险，null=读不到(unknown)
// 成本控制：调用方仅对 tier≥T2(或 T1+可试仓 PASS)的少量币调用；dev 余额 readBalance 自带 10min 缓存。
import { store } from './db.js';
import { readBalance, devHoldingPct } from './enrich.js';

const DAY = 24 * 3600 * 1000;

export async function collectScoreInputs(chain, cand, opts = {}) {
  const sinceDays = opts.sinceDays ?? 7;
  const devTtlMs = opts.devTtlMs ?? 600000;

  // 1) 前10买家净持仓集中度：排除池子与建币者两个非散户地址。
  const conc = store.topHolderConcentration(cand.key, cand.pool, cand.creator);

  // 2) 建币者历史：近 sinceDays 天窗口(recent 计数用)。
  const creator = store.creatorStats(chain, cand.creator, Date.now() - sinceDays * DAY);

  // 3) dev 余额占比：链上 balanceOf(token, creator) / total_supply(raw)。缺 creator/供应量则 null。
  let devPct = null;
  if (cand.creator && cand.total_supply) {
    const raw = await readBalance(chain, cand.address, cand.creator, { ttlMs: devTtlMs });
    devPct = devHoldingPct(raw, cand.total_supply);
  }

  return {
    top10Pct: conc.top10Pct,
    holders: conc.holders,
    devPct,
    creator,
    scoreVersion: 'v0',
  };
}
