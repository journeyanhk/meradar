import { watchChain } from './discover.js';
import { readToken } from './enrich.js';
import { scoreCandidate } from './score.js';
import { store } from './db.js';
import { config } from './config.js';
import { bus, Events } from './bus.js';
import { startTracker } from './track.js';
import * as momentum from './momentum.js';
import { recordSeen, recordPromoted } from './health.js';
import { child } from './logger.js';

const log = child('engine');

// TokenCreate：只登记，不轮询。事件已带 name/symbol/creator/totalSupply，零 RPC。
async function onCreate(c) {
  const key = `${c.chain}:${c.address.toLowerCase()}`;
  if (store.get(key)) return;
  const now = Date.now();
  const inserted = store.addCandidate({
    key, chain: c.chain, address: c.address, launchpad: c.launchpad,
    name: (c.name || '').slice(0, 80) || null,
    symbol: (c.symbol || '').slice(0, 32) || null,
    decimals: 18, // Four.meme 曲线代币固定 18 位
    total_supply: c.totalSupply != null ? c.totalSupply.toString() : null,
    creator: c.creator || null, pool: null, pool_type: null, quote_symbol: null,
    status: 'seen', discovered_at: now, updated_at: now,
  });
  if (!inserted) return;
  recordSeen();
  log.debug({ chain: c.chain, symbol: c.symbol }, '登记新币(seen)');
}

// TokenPurchase/TokenSale：喂动量状态机；买家达阈值才升级为 active。
async function onTrade(t) {
  momentum.onTrade({
    token: t.address, account: t.account, price: t.price,
    cost: t.cost, funds: t.funds, isBuy: t.isBuy, ts: t.ts,
  });
  if (!t.isBuy) return;

  const key = `${t.chain}:${t.address.toLowerCase()}`;
  const cand = store.get(key);
  if (!cand || cand.status !== 'seen') return;

  if (momentum.buyerCount(t.address) < (config.admission.minBuyersToActivate || 5)) return;

  // 升级：seen -> active（promote 内部保证只对 seen 生效，天然幂等）
  if (!store.promote(key)) return;
  recordPromoted();

  // 元数据兜底：若创建事件缺 symbol，补一次链上读取（仅此刻，一次性）
  let fresh = store.get(key);
  if (!fresh.symbol || !fresh.name) {
    const meta = await readToken(t.chain, t.address).catch(() => null);
    if (meta) {
      store.enrich(key, {
        name: meta.name, symbol: meta.symbol, decimals: meta.decimals,
        total_supply: meta.totalSupply?.toString() || fresh.total_supply, creator: fresh.creator,
      });
      fresh = store.get(key);
    }
  }

  // 仿盘归属：同名最早的那个是「原版」，其余标记 copy_of
  if (fresh.symbol) {
    const earliest = store.earliestSameSymbol(t.chain, fresh.symbol);
    if (earliest && earliest.key !== key) store.setCopyOf(key, earliest.key);
  }

  // 安全打分（只否决）
  const s = await scoreCandidate(t.chain, fresh).catch((e) => {
    log.debug({ err: e.message }, 'scoreCandidate 异常'); return { veto: false, checks: {} };
  });
  store.setSafety(key, s.checks);
  if (s.veto) {
    store.setStatus(key, 'rejected', s.reason);
    log.debug({ token: fresh.symbol, reason: s.reason }, '候选被否决');
    bus.emit(Events.UPDATE, { ...store.get(key) });
    return;
  }

  bus.emit(Events.CANDIDATE, { ...store.get(key) });
  log.info({ chain: t.chain, symbol: fresh.symbol, buyers: momentum.buyerCount(t.address) }, '候选升级为 active');
}

// AMM 建池 / 毕业：补池子地址与类型，供 track 定价。
async function onAmm(c) {
  const key = `${c.chain}:${c.address.toLowerCase()}`;
  const existing = store.get(key);
  if (!existing) return; // 未登记的 AMM 新对不追（噪声太多，只关心已发现的曲线币毕业）
  if (existing.pool) return;
  store.setPool(key, c.pool, c.poolType, c.quote);
  log.info({ token: existing.symbol, pool: c.pool }, '候选建池/毕业，已补池子');
  bus.emit(Events.UPDATE, { ...store.get(key) });
}

export function startEngine() {
  for (const chain of config.enabledChains) {
    try {
      watchChain(chain, {
        onCreate: (c) => onCreate(c).catch((e) => log.debug({ err: e.message }, 'onCreate')),
        onTrade: (t) => onTrade(t).catch((e) => log.debug({ err: e.message }, 'onTrade')),
        onAmm: (c) => onAmm(c).catch((e) => log.debug({ err: e.message }, 'onAmm')),
      });
      log.info({ chain }, '链监听已启动');
    } catch (e) {
      log.error({ chain, err: e.message }, '链监听启动失败（检查 RPC 配置）');
    }
  }
  startTracker();
}
