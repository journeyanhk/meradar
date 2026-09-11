import { parseAbiItem } from 'viem';
import { wsClient } from './chain.js';
import { chainConfig } from './config.js';
import { fourMemeEvents } from './abi.js';
import { recordWsLog, recordRpcError } from './health.js';
import { child } from './logger.js';

const log = child('discover');

function pickToken(token0, token1, quoteSet) {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (quoteSet.has(t0) && !quoteSet.has(t1)) return { token: token1, quote: token0 };
  if (quoteSet.has(t1) && !quoteSet.has(t0)) return { token: token0, quote: token1 };
  return { token: token0, quote: token1 };
}

/**
 * 订阅某条链所有发射台。
 * handlers: { onCreate(c), onTrade(t), onAmm(c) }
 *  - onCreate: {chain, address, launchpad, label, creator, name, symbol, totalSupply, tx, block}
 *  - onTrade:  {chain, address, account, price, amount, cost, funds, isBuy, ts}
 *  - onAmm:    {chain, address, launchpad, label, pool, poolType, quote, graduated, tx, block}
 */
export function watchChain(chain, handlers) {
  const cfg = chainConfig(chain);
  const client = wsClient(chain);
  const quoteSet = new Set(Object.values(cfg.quoteTokens).map((q) => q.address.toLowerCase()));
  const unwatchers = [];

  for (const lp of cfg.launchpads) {
    if (!lp.address || /^0x0+$/.test(lp.address)) {
      log.warn({ chain, launchpad: lp.id }, '工厂地址未配置，跳过（待核实后填入 config.json）');
      continue;
    }

    if (lp.type === 'fourmeme-events') {
      const un = client.watchEvent({
        address: lp.address,
        events: fourMemeEvents,
        strict: false,
        onLogs: (logs) => {
          recordWsLog(chain);
          for (const l of logs) {
            try { routeFourMeme(chain, lp, l, handlers); }
            catch (e) { log.debug({ err: e.message }, 'fourmeme 事件解码失败'); }
          }
        },
        onError: (e) => { recordRpcError(); log.warn({ chain, launchpad: lp.id, err: e.message }, 'watchEvent 错误(自动重连)'); },
      });
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅 Four.meme 事件流');
      continue;
    }

    if (lp.type === 'amm-v2' || lp.type === 'amm-v3') {
      const poolType = lp.type === 'amm-v3' ? 'v3' : 'v2';
      const event = parseAbiItem(lp.event);
      const un = client.watchEvent({
        address: lp.address,
        event,
        strict: true,
        onLogs: (logs) => {
          recordWsLog(chain);
          for (const l of logs) {
            try {
              const a = l.args || {};
              if (!a.token0 || !a.token1) continue;
              const poolAddr = a.pool || a.pair;
              const { token, quote } = pickToken(a.token0, a.token1, quoteSet);
              handlers.onAmm?.({
                chain, address: token, launchpad: lp.id, label: lp.label,
                pool: poolAddr, poolType, quote, graduated: lp.id.startsWith('pancake'),
                tx: l.transactionHash, block: Number(l.blockNumber || 0),
              });
            } catch (e) { log.debug({ err: e.message }, 'amm log 解析失败'); }
          }
        },
        onError: (e) => { recordRpcError(); log.warn({ chain, launchpad: lp.id, err: e.message }, 'watchEvent 错误(自动重连)'); },
      });
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅 AMM 工厂');
    }
  }

  return () => unwatchers.forEach((u) => { try { u(); } catch { /* noop */ } });
}

function routeFourMeme(chain, lp, l, handlers) {
  const name = l.eventName;
  const a = l.args || {};
  if (name === 'TokenCreate') {
    if (!a.token) return;
    handlers.onCreate?.({
      chain, address: a.token, launchpad: lp.id, label: lp.label,
      creator: a.creator || null, name: a.name || null, symbol: a.symbol || null,
      totalSupply: a.totalSupply ?? null,
      tx: l.transactionHash, block: Number(l.blockNumber || 0),
    });
  } else if (name === 'TokenPurchase' || name === 'TokenSale') {
    if (!a.token) return;
    handlers.onTrade?.({
      chain, address: a.token, account: a.account || null,
      launchpad: lp.id, label: lp.label,
      price: a.price ?? null, amount: a.amount ?? null, cost: a.cost ?? null, funds: a.funds ?? null,
      isBuy: name === 'TokenPurchase', ts: Date.now(),
    });
  }
}
