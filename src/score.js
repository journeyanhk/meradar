import { parseUnits } from 'viem';
import { httpClient } from './chain.js';
import { routerAbi } from './abi.js';
import { chainConfig, config } from './config.js';
import { store } from './db.js';
import { child } from './logger.js';

const log = child('score');
const DAY = 24 * 3600 * 1000;

/**
 * 安全打分 = 只负责否决（veto）。动量与叙事负责发现（在 track/alert 层）。
 * 返回 { veto, reason, checks }。
 */
export async function scoreCandidate(chain, cand) {
  const checks = {};

  // 1. 创建者画像：24h 内批量发币
  if (cand.creator) {
    const n = store.countCreatorSince(chain, cand.creator, Date.now() - DAY);
    checks.creatorTokens24h = n;
    if (n > (config.score.creatorMaxTokens24h || 3)) {
      return { veto: true, reason: `批量发币地址(24h ${n}个)`, checks };
    }
  }

  // 2. 貔貅往返模拟（只读 getAmountsOut）。仅对已有 AMM 池的候选执行。
  const quote = cand.quote || cand.quote_symbol;
  if (config.score.honeypot?.enabled && cand.pool && quote) {
    const hp = await honeypotRoundTrip(chain, { ...cand, quote });
    checks.honeypot = hp;
    if (hp && hp.ok === false) {
      return { veto: true, reason: hp.reason, checks };
    }
  } else {
    checks.honeypot = { status: 'pending', note: '无 AMM 池（曲线阶段），毕业后再检测' };
  }

  return { veto: false, checks };
}

/**
 * 只读往返：quote --getAmountsOut--> token --getAmountsOut--> quote，比较回收率。
 * 说明：getAmountsOut 反映的是池子定价曲线与滑点，不含 transfer 税；
 * 深度税/貔貅检测需要 eth_call + stateOverride 真实 swap 模拟（见 honeypotViaOverride 占位）。
 */
async function honeypotRoundTrip(chain, cand) {
  const cfg = chainConfig(chain);
  const router = cfg.router;
  if (!router) return { status: 'skip', note: '未配置 router' };
  const client = httpClient(chain);
  const amountIn = parseUnits('0.05', 18); // 0.05 报价币
  try {
    const buy = await client.readContract({
      address: router, abi: routerAbi, functionName: 'getAmountsOut',
      args: [amountIn, [cand.quote, cand.address]],
    });
    const tokenOut = buy[buy.length - 1];
    if (tokenOut === 0n) return { ok: false, reason: '无法买入(0 产出)', recoveryBps: 0 };
    const sell = await client.readContract({
      address: router, abi: routerAbi, functionName: 'getAmountsOut',
      args: [tokenOut, [cand.address, cand.quote]],
    });
    const quoteBack = sell[sell.length - 1];
    const recoveryBps = Number((quoteBack * 10000n) / amountIn);
    const minRecovery = config.score.honeypot.minRecoveryBps || 9000;
    if (recoveryBps < minRecovery) {
      return { ok: false, reason: `往返回收率过低(${(recoveryBps / 100).toFixed(1)}%)`, recoveryBps };
    }
    return { ok: true, recoveryBps, method: 'getAmountsOut' };
  } catch (e) {
    log.debug({ err: e.message, token: cand.address }, 'honeypot 模拟异常');
    return { status: 'error', note: e.message };
  }
}
