import { parseAbiItem, getAddress } from 'viem';
import { wsClient } from './chain.js';
import { chainConfig } from './config.js';
import { child } from './logger.js';

const log = child('discover');

// 从任意日志里提取 20 字节地址（用于 Four.meme 曲线型 raw-log 发现，无需硬编码 ABI）
export function extractAddresses(logEntry) {
  const words = [];
  for (const t of (logEntry.topics || []).slice(1)) words.push(t);
  const data = (logEntry.data || '0x').replace(/^0x/, '');
  for (let i = 0; i + 64 <= data.length; i += 64) words.push(data.slice(i, i + 64));
  const out = new Set();
  for (let w of words) {
    w = w.replace(/^0x/, '').padStart(64, '0');
    if (/^0{24}[0-9a-fA-F]{40}$/.test(w)) {
      const addr = '0x' + w.slice(24);
      if (addr !== '0x0000000000000000000000000000000000000000') {
        try { out.add(getAddress(addr)); } catch { /* skip */ }
      }
    }
  }
  return [...out];
}

// 判断 AMM 事件里哪个是「新币」（非报价币）
function pickToken(token0, token1, quoteSet) {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (quoteSet.has(t0) && !quoteSet.has(t1)) return { token: token1, quote: token0 };
  if (quoteSet.has(t1) && !quoteSet.has(t0)) return { token: token0, quote: token1 };
  return { token: token0, quote: token1 }; // 都不是报价币时取 token0
}

/**
 * 订阅某条链的所有发射台。
 * @param {(c) => void} onCandidate  {chain, address, launchpad, pool, quote, graduated, tx, block}
 * @param {(a) => void} onActivity   {chain, address, isBuy}  跟踪层用（曲线买卖活动）
 */
export function watchChain(chain, onCandidate, onActivity) {
  const cfg = chainConfig(chain);
  const client = wsClient(chain);
  const quoteSet = new Set(Object.values(cfg.quoteTokens).map((a) => a.toLowerCase()));
  const unwatchers = [];

  for (const lp of cfg.launchpads) {
    if (!lp.address || /^0x0+$/.test(lp.address)) {
      log.warn({ chain, launchpad: lp.id }, '工厂地址未配置，跳过（待核实后填入 config.json）');
      continue;
    }

    if (lp.type === 'amm-v2' || lp.type === 'amm-v3') {
      const event = parseAbiItem(lp.event);
      const un = client.watchEvent({
        address: lp.address,
        event,
        strict: true,
        onLogs: (logs) => {
          for (const l of logs) {
            try {
              const a = l.args || {};
              if (!a.token0 || !a.token1) continue;
              const { token0, token1, pair, pool } = a;
              const poolAddr = pool || pair;
              const { token, quote } = pickToken(token0, token1, quoteSet);
              onCandidate({
                chain, address: token, launchpad: lp.id, label: lp.label,
                pool: poolAddr, quote, graduated: lp.id.startsWith('pancake'),
                tx: l.transactionHash, block: Number(l.blockNumber || 0),
              });
            } catch (e) { log.debug({ err: e.message }, 'amm log 解析失败'); }
          }
        },
        onError: (e) => log.warn({ chain, launchpad: lp.id, err: e.message }, 'watchEvent 错误(将自动重连)'),
      });
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅 AMM 工厂');
    }

    if (lp.type === 'curve-rawlog') {
      const un = client.watchEvent({
        address: lp.address, // 不带 event => 订阅该地址全部日志
        onLogs: (logs) => {
          for (const l of logs) {
            const isBuy = lp.buyTopic0 && l.topics?.[0]?.toLowerCase() === lp.buyTopic0.toLowerCase();
            const addrs = extractAddresses(l);
            for (const addr of addrs) {
              if (quoteSet.has(addr.toLowerCase())) continue;
              if (addr.toLowerCase() === lp.address.toLowerCase()) continue;
              onCandidate({
                chain, address: addr, launchpad: lp.id, label: lp.label,
                pool: null, quote: null, graduated: false,
                tx: l.transactionHash, block: Number(l.blockNumber || 0),
              });
              if (onActivity) onActivity({ chain, address: addr, isBuy });
            }
          }
        },
        onError: (e) => log.warn({ chain, launchpad: lp.id, err: e.message }, 'watchEvent 错误(将自动重连)'),
      });
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅曲线发射台(raw-log)');
    }
  }

  return () => unwatchers.forEach((u) => { try { u(); } catch { /* noop */ } });
}
