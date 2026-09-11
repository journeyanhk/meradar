import { parseUnits } from 'viem';
import { httpClient } from './chain.js';
import { routerAbi } from './abi.js';
import { chainConfig, config } from './config.js';
import { store } from './db.js';
import { goplusCheck } from './goplus.js';
import { child } from './logger.js';

const log = child('score');
const DAY = 24 * 3600 * 1000;

/**
 * 安全打分 = 只否决。动量与叙事负责发现。
 * 返回 { veto, reason, checks }。
 */
export async function scoreCandidate(chain, cand) {
  const cfg = chainConfig(chain);
  const checks = {};

  // 1. 创建者批量发币
  if (cand.creator) {
    const n = store.countCreatorSince(chain, cand.creator, Date.now() - DAY);
    checks.creatorTokens24h = n;
    if (n > (config.score.creatorMaxTokens24h || 3)) {
      return { veto: true, reason: `批量发币地址(24h ${n}个)`, checks };
    }
  }

  // 2. GoPlus token security（免费只读，曲线期也能查，无需池子）
  if (config.score.goplus?.enabled && cfg.goplusId) {
    const gp = await goplusCheck(cfg.goplusId, cand.address);
    if (gp) {
      checks.goplus = gp;
      if (gp.isHoneypot) return { veto: true, reason: 'GoPlus:貔貅', checks };
      if (gp.cannotSellAll) return { veto: true, reason: 'GoPlus:无法全部卖出', checks };
      if (gp.sellTaxBps >= 2000) return { veto: true, reason: `GoPlus:卖出税${(gp.sellTaxBps / 100).toFixed(0)}%`, checks };
    }
  }

  // 3. getAmountsOut 往返初筛（仅有 AMM 池时）
  const quote = cand.quote || cand.quote_symbol;
  if (config.score.honeypot?.enabled && cand.pool && quote) {
    const hp = await honeypotRoundTrip(chain, { ...cand, quote });
    checks.honeypot = hp;
    if (hp && hp.ok === false) return { veto: true, reason: hp.reason, checks };
  } else if (!checks.goplus) {
    checks.honeypot = { status: 'pending', note: '曲线期无池且 GoPlus 未覆盖，毕业后再检测' };
  }

  return { veto: false, checks };
}

async function honeypotRoundTrip(chain, cand) {
  const cfg = chainConfig(chain);
  const router = cfg.router;
  if (!router) return { status: 'skip', note: '未配置 router' };
  const client = httpClient(chain);
  const amountIn = parseUnits('0.05', 18);
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
