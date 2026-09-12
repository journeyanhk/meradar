import { chainConfig, config } from './config.js';
import { store } from './db.js';
import { goplusCheck } from './goplus.js';
import { roundTripCheck } from './roundtrip.js';
import { matchesTemplate } from './template.js';
import { child } from './logger.js';

const log = child('score');
const DAY = 24 * 3600 * 1000;
const REJECT_SELL_TAX_BPS = 2000; // ≥20% 卖税判否决

/**
 * 安全打分 = 只否决 + 三态贸易安全。动量与叙事负责发现。
 * 返回 { state, veto, reason, checks, capTier }。
 *   state: 'PASS' | 'WAIT' | 'REJECT'（贸易安全三态，或 creator 批量发币直接 REJECT）
 *   veto:  state === 'REJECT'（向后兼容 track 的否决分支）
 *   capTier: WAIT 时的告警封顶（'T1'），PASS/REJECT 为 null
 */
export async function scoreCandidate(chain, cand) {
  const checks = {};

  // 1. 创建者批量发币 —— 显式否决
  if (cand.creator) {
    const n = store.countCreatorSince(chain, cand.creator, Date.now() - DAY);
    checks.creatorTokens24h = n;
    if (n > (config.score.creatorMaxTokens24h || 3)) {
      return { state: 'REJECT', veto: true, reason: `批量发币地址(24h ${n}个)`, checks, capTier: null };
    }
  }

  // 2. 三态贸易安全：毕业后往返优先 → 曲线期模板 → GoPlus 补位
  const ts = await evaluateTradeSafety(chain, cand);
  checks.tradeSafety = ts;
  return { state: ts.state, veto: ts.state === 'REJECT', reason: ts.reason || null, checks, capTier: ts.capTier };
}

// 编排：取往返(毕业后)/模板(曲线期)/GoPlus，交给纯函数 classifyTradeSafety 定三态。
// wantFresh 仅在「强提示前需保证往返结果新鲜」时置真（正常靠 roundTripCheck 的 10 分钟缓存即 ≤10min）。
export async function evaluateTradeSafety(chain, cand, { wantFresh = false } = {}) {
  const cfg = chainConfig(chain);
  const graduated = !!cand.pool;

  let roundTrip = null;
  let templateMatch = false;
  if (graduated) {
    if (config.score.honeypot?.enabled) {
      roundTrip = await roundTripCheck(chain, cand, { fresh: wantFresh }).catch((e) => {
        log.debug({ err: e.message, token: cand.symbol }, 'roundTripCheck 异常');
        return { status: 'error' };
      });
    }
  } else {
    templateMatch = await matchesTemplate(chain, cand.address).catch((e) => {
      log.debug({ err: e.message, token: cand.symbol }, 'matchesTemplate 异常');
      return false;
    });
  }

  let goplus = null;
  if (config.score.goplus?.enabled && cfg.goplusId) {
    goplus = await goplusCheck(cfg.goplusId, cand.address).catch(() => null);
  }

  const cls = classifyTradeSafety({ graduated, templateMatch, roundTrip, goplus, rejectSellTaxBps: REJECT_SELL_TAX_BPS });
  return {
    ...cls,
    graduated,
    roundTripStatus: roundTrip?.status ?? null,
    checkedAt: roundTrip?.checkedAt ?? null,
    goplusNaFields: goplus?.naFields ?? null,
  };
}

/**
 * 纯函数：把往返/模板/GoPlus 的原始信号折叠成三态。便于离线单测覆盖真值表。
 * 优先级：GoPlus 显式正例(两阶段通用) → 曲线期模板 → 毕业后往返 → GoPlus 补位。
 * 关键：一律看 naFields 而非「sellTaxBps===0」——空字段代表无数值，不是「无税」。
 * 入参：
 *   graduated     有池(毕业)= true，曲线期 = false
 *   templateMatch 曲线期代币字节码是否命中平台模板白名单
 *   roundTrip     { status, sellTaxBps, recoveredBps, checkedAt } | null
 *   goplus        { isHoneypot, cannotSellAll, sellTaxBps, naFields } | null
 * 返回 { state, source, capTier, sellTaxBps?, naFields?, reason?, note? }
 */
export function classifyTradeSafety({ graduated, templateMatch, roundTrip, goplus, rejectSellTaxBps = REJECT_SELL_TAX_BPS }) {
  const na = new Set(goplus?.naFields || []);
  const gpHoneypot = !!goplus && goplus.isHoneypot === true && !na.has('isHoneypot');
  const gpCannotSell = !!goplus && goplus.cannotSellAll === true && !na.has('cannotSellAll');
  const gpTaxKnown = !!goplus && goplus.sellTaxBps != null && !na.has('sellTax');
  const gpTaxHigh = gpTaxKnown && goplus.sellTaxBps >= rejectSellTaxBps;

  // 0) GoPlus 显式正例：两阶段通用、最高优先级（即便往返 ok 也否决，纵深防御）
  if (gpHoneypot) return { state: 'REJECT', source: 'goplus', reason: 'GoPlus:貔貅', capTier: null };
  if (gpCannotSell) return { state: 'REJECT', source: 'goplus', reason: 'GoPlus:无法全部卖出', capTier: null };
  if (gpTaxHigh) return { state: 'REJECT', source: 'goplus', reason: `GoPlus:卖税${(goplus.sellTaxBps / 100).toFixed(0)}%`, capTier: null };

  // 1) 曲线期：模板命中=平台保障 PASS；否则无验证路径 → WAIT 封顶 T1
  if (!graduated) {
    if (templateMatch) {
      return { state: 'PASS', source: 'template', capTier: null, naFields: ['sellTax', 'cannotSellAll'], note: '曲线期·平台模板' };
    }
    return { state: 'WAIT', source: 'none', capTier: 'T1', note: '非模板代币未核验' };
  }

  // 2) 毕业后：往返优先
  if (roundTrip) {
    const st = roundTrip.status;
    if (st === 'ok') {
      // 只对 V2 有 sellTaxBps；≥20% 否决。V3 sellTaxBps=null → 只看 status。
      if (roundTrip.sellTaxBps != null && roundTrip.sellTaxBps >= rejectSellTaxBps) {
        return { state: 'REJECT', source: 'roundtrip', reason: `往返卖税${(roundTrip.sellTaxBps / 100).toFixed(0)}%`, capTier: null };
      }
      return { state: 'PASS', source: 'roundtrip', capTier: null, sellTaxBps: roundTrip.sellTaxBps ?? null, note: '往返' };
    }
    if (st === 'sellReverted') return { state: 'REJECT', source: 'roundtrip', reason: '往返卖出 revert(疑似貔貅)', capTier: null };
    // buyReverted / noTokens 一律 WAIT：交易可能未开/反机器人，GoPlus 快照不能替代
    if (st === 'buyReverted' || st === 'noTokens') {
      return { state: 'WAIT', source: 'roundtrip', capTier: 'T1', note: '交易未开/反机器人，退避复查' };
    }
    // unsupported / error → 落到 GoPlus 补位
  }

  // 3) 往返不可用(unsupported/error/无往返)：GoPlus 补位——关键字段有值且干净才 PASS
  const gpHoneypotKnown = !!goplus && !na.has('isHoneypot');
  const gpCannotSellKnown = !!goplus && !na.has('cannotSellAll');
  const gpClean =
    gpHoneypotKnown && goplus.isHoneypot === false &&
    gpCannotSellKnown && goplus.cannotSellAll === false &&
    gpTaxKnown && goplus.sellTaxBps < rejectSellTaxBps;
  if (gpClean) return { state: 'PASS', source: 'goplus', capTier: null, sellTaxBps: goplus.sellTaxBps, note: 'GoPlus' };

  return { state: 'WAIT', source: 'none', capTier: 'T1', note: '无验证路径' };
}
