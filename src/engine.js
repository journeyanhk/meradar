import { watchChain } from './discover.js';
import { readToken } from './enrich.js';
import { scoreCandidate } from './score.js';
import { store } from './db.js';
import { config, chainConfig } from './config.js';
import { httpClient } from './chain.js';
import { fourMemeEvents } from './abi.js';
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
  let cand = store.get(key);

  // 懒注册：服务启动前创建的老币，首次出现买入时补登记为 seen。
  // （$牛来 式慢热币常在发行数小时后才启动，否则会被下一行直接丢弃而永远进不了跟踪。）
  if (!cand) {
    const meta = await readToken(t.chain, t.address).catch(() => null);
    if (!meta) return; // 非 ERC20 / 读取失败，忽略噪声
    const now = Date.now();
    const inserted = store.addCandidate({
      key, chain: t.chain, address: t.address, launchpad: t.launchpad || 'fourmeme',
      name: (meta.name || '').slice(0, 80) || null,
      symbol: (meta.symbol || '').slice(0, 32) || null,
      decimals: meta.decimals ?? 18,
      total_supply: meta.totalSupply?.toString() ?? null, creator: null,
      pool: null, pool_type: null, quote_symbol: null,
      status: 'seen', discovered_at: now, updated_at: now,
    });
    if (inserted) recordSeen();
    cand = store.get(key);
    if (!cand) return;
  }

  if (cand.status !== 'seen') return;

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

// 启动回填：拉取最近 ~hours 小时的 TokenCreate 登记为 seen，
// 让服务启动前创建、之后才启动的慢热币也能进入跟踪。（publicnode 支持带地址的 getLogs）
export async function backfillRecentCreates(chain, hours = 2) {
  const cfg = chainConfig(chain);
  const lp = cfg.launchpads?.find(
    (l) => l.type === 'fourmeme-events' && l.address && !/^0x0+$/.test(l.address),
  );
  if (!lp) return 0;
  const client = httpClient(chain);
  let latest;
  try { latest = await client.getBlockNumber(); } catch (e) { log.warn({ chain, err: e.message }, '回填取块高失败'); return 0; }
  const blocksPerHour = Math.round(3600 / 0.45); // BSC ~0.45s/块
  const span = BigInt(blocksPerHour * hours);
  const chunk = 4000n; // 分段，规避公共 RPC 单次日志范围上限
  let from = latest > span ? latest - span : 0n;
  let count = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (from <= latest) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    let logs = null;
    for (let attempt = 0; attempt < 3 && logs === null; attempt++) {
      try {
        logs = await client.getLogs({ address: lp.address, events: fourMemeEvents, fromBlock: from, toBlock: to });
      } catch (e) {
        if (attempt === 2) log.debug({ chain, from: from.toString(), err: e.message }, '回填分段失败(跳过，靠懒注册兜底；公共 RPC 常只服务近 ~1h 日志，付费 RPC 可覆盖全窗口)');
        else await sleep(600 * (attempt + 1)); // 退避重试，缓解公共 RPC 限流 403
      }
    }
    for (const l of logs || []) {
      if (l.eventName !== 'TokenCreate') continue;
      const a = l.args || {};
      if (!a.token) continue;
      await onCreate({
        chain, address: a.token, launchpad: lp.id, label: lp.label,
        creator: a.creator || null, name: a.name || null, symbol: a.symbol || null,
        totalSupply: a.totalSupply ?? null, tx: l.transactionHash, block: Number(l.blockNumber || 0),
      }).catch(() => {});
      count++;
    }
    from = to + 1n;
    await sleep(250); // 分段间隔，降低被限流概率
  }
  log.info({ chain, count, hours }, '启动回填 TokenCreate 完成');
  return count;
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
