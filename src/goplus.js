import { child } from './logger.js';

const log = child('goplus');

// 共享 GoPlus 客户端：曲线期也能查(免费只读，无需池子)。四层节流，供全系统复用：
//  ① 10 分钟缓存      —— 同币短时间重复查直接命中
//  ② 在途合并         —— 同一地址并发查询共用一个 Promise，不重复打网络
//  ③ 微批(≤30 地址)   —— GoPlus 支持逗号分隔多地址；一个 tick 内多个候选合并成一次请求
//  ④ 全局令牌桶(~20/min) —— 控制整体出网速率，避免被限流
const TTL = 10 * 60_000;
const BATCH_MAX = 30;         // GoPlus 单次多地址上限
const BATCH_WINDOW_MS = 40;   // 合并窗口：40ms 内到达的单地址查询并成一批
const cache = new Map();      // `${goplusId}:${addr}` -> { ts, result }
const inflight = new Map();   // `${goplusId}:${addr}` -> Promise<result>
const queues = new Map();     // goplusId -> { addrs:Set, resolvers:Map<addr, fn[]>, timer }

// —— 令牌桶：容量 20，每 3s 回补 1 个（≈20/min）——
const BUCKET_CAP = 20;
const REFILL_MS = 3000;
let tokens = BUCKET_CAP;
let lastRefill = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function acquireToken() {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(BUCKET_CAP, tokens + (now - lastRefill) / REFILL_MS);
    lastRefill = now;
    if (tokens >= 1) { tokens -= 1; return; }
    await sleep(Math.ceil((1 - tokens) * REFILL_MS));
  }
}

function parseRow(r) {
  if (!r) return null;
  // GoPlus 对曲线期币常返回空串/缺字段 —— 记录哪些关键字段不可用(N/A)，供三态判定决定回落 WAIT 而非误判 PASS。
  const naFields = [];
  if (r.sell_tax == null || r.sell_tax === '') naFields.push('sellTax');
  if (r.buy_tax == null || r.buy_tax === '') naFields.push('buyTax');
  if (r.is_honeypot == null || r.is_honeypot === '') naFields.push('isHoneypot');
  if (r.cannot_sell_all == null || r.cannot_sell_all === '') naFields.push('cannotSellAll');
  return {
    isHoneypot: r.is_honeypot === '1',
    cannotSellAll: r.cannot_sell_all === '1',
    buyTaxBps: Math.round(parseFloat(r.buy_tax || '0') * 10000),
    sellTaxBps: Math.round(parseFloat(r.sell_tax || '0') * 10000),
    isMintable: r.is_mintable === '1',
    ownerChangeBalance: r.owner_change_balance === '1',
    naFields,
  };
}

// 拉取一批地址（≤30），返回 addr(lower) -> parsed | null 的 Map。
async function fetchBatch(goplusId, addrs) {
  await acquireToken();
  const out = new Map();
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${goplusId}?contract_addresses=${addrs.join(',')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const result = j?.result || {};
    for (const addr of addrs) {
      const row = result[addr.toLowerCase()] || result[addr];
      out.set(addr.toLowerCase(), parseRow(row));
    }
  } catch (e) {
    log.debug({ err: e.message, n: addrs.length }, 'GoPlus 批量查询失败');
    for (const addr of addrs) out.set(addr.toLowerCase(), null);
  }
  return out;
}

function flushQueue(goplusId) {
  const q = queues.get(goplusId);
  if (!q) return;
  queues.delete(goplusId);
  clearTimeout(q.timer);
  const addrs = [...q.addrs].slice(0, BATCH_MAX);
  const rest = [...q.addrs].slice(BATCH_MAX);
  fetchBatch(goplusId, addrs).then((res) => {
    for (const addr of addrs) {
      const r = res.get(addr.toLowerCase()) ?? null;
      if (r) cache.set(`${goplusId}:${addr.toLowerCase()}`, { ts: Date.now(), result: r });
      for (const fn of q.resolvers.get(addr.toLowerCase()) || []) fn(r);
      inflight.delete(`${goplusId}:${addr.toLowerCase()}`);
    }
  });
  // 超出单批上限的地址继续排队，下一窗口再发
  if (rest.length) {
    const nq = getQueue(goplusId);
    for (const addr of rest) { nq.addrs.add(addr); nq.resolvers.set(addr.toLowerCase(), q.resolvers.get(addr.toLowerCase()) || []); }
  }
}

function getQueue(goplusId) {
  let q = queues.get(goplusId);
  if (!q) {
    q = { addrs: new Set(), resolvers: new Map(), timer: null };
    q.timer = setTimeout(() => flushQueue(goplusId), BATCH_WINDOW_MS);
    queues.set(goplusId, q);
  }
  return q;
}

// 单地址查询（向后兼容 score.js）。命中缓存→直接返回；否则并入当前微批。
export async function goplusCheck(goplusId, address) {
  if (!goplusId || !address) return null;
  const key = `${goplusId}:${address.toLowerCase()}`;
  const c = cache.get(key);
  if (c && Date.now() - c.ts < TTL) return c.result;
  if (inflight.has(key)) return inflight.get(key);

  const p = new Promise((resolve) => {
    const q = getQueue(goplusId);
    q.addrs.add(address);
    const list = q.resolvers.get(address.toLowerCase()) || [];
    list.push(resolve);
    q.resolvers.set(address.toLowerCase(), list);
    if (q.addrs.size >= BATCH_MAX) flushQueue(goplusId);
  });
  inflight.set(key, p);
  return p;
}

// 批量查询（供 B 批 Top10/关联代理等一次拿多个）。自动分片 ≤30，返回 addr(lower)->parsed|null。
export async function goplusCheckMany(goplusId, addresses) {
  const results = await Promise.all((addresses || []).map((a) => goplusCheck(goplusId, a)));
  const out = new Map();
  (addresses || []).forEach((a, i) => out.set(a.toLowerCase(), results[i]));
  return out;
}
