import { watchChain, extractAddresses } from './discover.js';
import { readToken, readCreator } from './enrich.js';
import { scoreCandidate } from './score.js';
import { store } from './db.js';
import { config } from './config.js';
import { bus, Events } from './bus.js';
import { startTracker } from './track.js';
import { child } from './logger.js';

const log = child('engine');

// 负缓存：raw-log 里反复出现的非 ERC20 地址，避免重复校验
const notToken = new Set();
let notTokenOrder = [];
function markNotToken(addr) {
  if (notToken.has(addr)) return;
  notToken.add(addr);
  notTokenOrder.push(addr);
  if (notTokenOrder.length > 5000) notToken.delete(notTokenOrder.shift());
}

async function handleCandidate(c) {
  const key = `${c.chain}:${c.address.toLowerCase()}`;

  const existing = store.get(key);
  if (existing) {
    // 毕业事件：曲线币在 Pancake 建池 -> 补上 pool/quote 以便定价
    if (c.pool && c.quote && !existing.pool) {
      store.enrich(key, {
        name: existing.name, symbol: existing.symbol, decimals: existing.decimals,
        total_supply: existing.total_supply, creator: existing.creator,
        pool: c.pool, quote_symbol: existing.quote_symbol,
      });
      store.raw.prepare('UPDATE candidates SET pool=?, graduated=1 WHERE key=?').run(c.pool, key);
      // 存 quote 地址到内存映射（track 需要）
      store.raw.prepare('UPDATE candidates SET quote_symbol=COALESCE(quote_symbol, ?) WHERE key=?')
        .run(c.quote, key);
      log.info({ token: existing.symbol }, '候选毕业到 Pancake，已补池子');
    }
    return;
  }

  if (notToken.has(c.address.toLowerCase())) return;

  // 校验 ERC20（过滤 raw-log 噪声）
  const meta = await readToken(c.chain, c.address);
  if (!meta) { markNotToken(c.address.toLowerCase()); return; }

  const creator = await readCreator(c.chain, c.tx);

  const now = Date.now();
  const inserted = store.addCandidate({
    key, chain: c.chain, address: c.address, launchpad: c.launchpad,
    name: meta.name, symbol: meta.symbol, decimals: meta.decimals,
    creator, pool: c.pool || null, quote_symbol: c.quote || null,
    discovered_at: now, updated_at: now,
  });
  if (!inserted) return;

  // 写入 total_supply
  store.raw.prepare('UPDATE candidates SET total_supply=? WHERE key=?')
    .run(meta.totalSupply?.toString() || null, key);

  const cand = store.get(key);
  cand.quote = c.quote || null; // 供打分用（quote 地址）

  const s = await scoreCandidate(c.chain, cand);
  store.setSafety(key, s.checks);
  if (s.veto) {
    store.setStatus(key, 'rejected', s.reason);
    log.debug({ token: meta.symbol, reason: s.reason }, '候选被否决');
    bus.emit(Events.UPDATE, { ...store.get(key) });
    return;
  }

  bus.emit(Events.CANDIDATE, { ...store.get(key) });
  log.info({ chain: c.chain, symbol: meta.symbol, launchpad: c.launchpad }, '发现新候选');
}

export function startEngine() {
  // quote 地址需在 track 时可用：把 quote 存进 quote_addr 内存表
  for (const chain of config.enabledChains) {
    try {
      watchChain(chain, (c) => handleCandidate(c).catch((e) => log.debug({ err: e.message }, 'handleCandidate')), null);
      log.info({ chain }, '链监听已启动');
    } catch (e) {
      log.error({ chain, err: e.message }, '链监听启动失败（检查 RPC 配置）');
    }
  }
  startTracker();
}
