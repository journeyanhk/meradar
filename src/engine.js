import { watchChain, resubscribeSwaps } from './discover.js';
import { readToken, quoteUsd, resolveQuote, readTokenInfo } from './enrich.js';
import { scoreCandidate } from './score.js';
import { store } from './db.js';
import { config, chainConfig } from './config.js';
import { httpClient } from './chain.js';
import { fourMemeEvents } from './abi.js';
import { bus, Events } from './bus.js';
import { startTracker } from './track.js';
import { discoverPool } from './pool.js';
import { recordTemplate } from './template.js';
import * as momentum from './momentum.js';
import { recordSeen, recordPromoted, recordTradeWrite, setSwapPools } from './health.js';
import { child } from './logger.js';
import { formatUnits } from 'viem';

const log = child('engine');

// 代币供应量(human)，用于把成交单价换算成成交时市值
function supplyHumanOf(cand) {
  if (!cand?.total_supply) return 0;
  try { return Number(formatUnits(BigInt(cand.total_supply), cand.decimals || 18)); }
  catch { return 0; }
}

// 取某链 Four.meme Token Manager 地址（_tokenInfos 视图所在合约）。
function tokenManagerAddr(chain) {
  const cfg = chainConfig(chain);
  const lp = cfg.launchpads?.find((l) => l.type === 'fourmeme-events' && l.address && !/^0x0+$/.test(l.address));
  return lp?.address || null;
}

// 曲线期成交落库（USD 计价，仅 active 币）。
// 单位换算用「该币自己的报价币」，不再一律按 BNB —— 否则 USDT 曲线会被放大约一个 BNB 价格的倍数。
function recordCurveTrade(t, cand) {
  const q = resolveQuote(chainConfig(t.chain), cand.quote_symbol);
  if (!q) return; // 报价币未知 → 不定价、不落库（宁可晚 10 秒等 _tokenInfos 解析）
  const qp = quoteUsd(t.chain, q.sym);
  const div = 10 ** q.decimals;
  const usd = t.cost != null ? (Number(t.cost) / div) * qp : 0;
  const tokenHuman = t.amount != null ? Number(t.amount) / 1e18 : 0; // meme 代币固定 18 位
  const side = t.isBuy ? 'buy' : 'sell';
  const ts = t.ts || Date.now();
  const price = tokenHuman > 0 ? usd / tokenHuman : 0;
  const supply = supplyHumanOf(cand);
  store.addTrade({ key: cand.key, ts, side, account: t.account, quote_amount: usd, token_amount: tokenHuman, price, mcap_at_trade: price > 0 && supply > 0 ? price * supply : null });
  if (side === 'buy' && t.account) store.addBuyer(cand.key, t.account, ts);
  recordTradeWrite();
}

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
    launch_time: c.launchTime != null ? Number(c.launchTime) * 1000 : null,
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
    cost: t.cost, funds: t.funds, offers: t.offers, isBuy: t.isBuy, ts: t.ts,
  });

  const key = `${t.chain}:${t.address.toLowerCase()}`;
  let cand = store.get(key);

  // 活跃币的每笔成交(买/卖)落库，供净流入/最大单笔/买卖比与回放
  if (cand && cand.status === 'active') recordCurveTrade(t, cand);

  if (!t.isBuy) return;

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

  if (cand.status !== 'seen') {
    // 归档币再现买入 → 复活为 active。它曾通过准入（报价币/元数据/安全打分已就绪），
    // 无需重跑 promote；直接恢复轮询，避免清洗/竞态误归档后永久冻结在 0。
    if (cand.status === 'archived') {
      store.setStatus(key, 'active', null);
      recordCurveTrade(t, store.get(key));
      if (cand.pool) bus.emit(Events.POOLS_CHANGED, { chain: t.chain }); // 重建成交订阅
      bus.emit(Events.UPDATE, { ...store.get(key) });
      log.info({ chain: t.chain, symbol: cand.symbol }, '归档币再现买入，复活为 active');
    }
    return;
  }

  if (momentum.buyerCount(t.address) < (config.admission.minBuyersToActivate || 5)) return;

  // 升级：seen -> active（promote 内部保证只对 seen 生效，天然幂等）
  if (!store.promote(key)) return;
  recordPromoted();

  // 模板自学习：TokenCreate 由 Token Manager 发出即「平台部署」证据，累计该币码哈希频次供白名单自学习。
  // 先于安全打分执行，使刚跨过阈值的模板对本币的 matchesTemplate 立即生效（同时预热码哈希缓存）。
  await recordTemplate(t.chain, t.address).catch((e) => log.debug({ err: e.message }, 'recordTemplate'));

  // promote 那一刻把内存买家集合整体落库；first_ts 写 0，使这批「已存量」买家不被
  // newBuyers30m(first_ts>=since) 计入，避免升级后 30 分钟内「新买家」虚高为全部买家。
  // 此后真正的增量买入(recordCurveTrade/onSwap)用真实 ts 落库，才算新买家。
  for (const acc of momentum.buyers(t.address)) store.addBuyer(key, acc, 0);

  // 关键：解析该币的曲线报价币 + 毕业阈值。Four.meme 同一 Token Manager 上跑 BNB/USDT/USD1/任意报价币，
  // 事件里的 price/cost/funds 都是报价币单位。不读这一次，USDT 曲线会被按 BNB 放大约 700 倍。
  // 只在 promote 这一刻读一次（低频，仅通过准入的币），后续成交定价直接复用 quote_symbol。
  const tm = tokenManagerAddr(t.chain);
  if (tm) {
    const info = await readTokenInfo(t.chain, tm, t.address).catch(() => null);
    if (info) {
      store.setCurveInfo(key, {
        quote_symbol: info.quoteSym,
        max_raising: info.maxRaisingRaw != null ? info.maxRaisingRaw.toString() : null,
        launch_time: info.launchTimeMs,
      });
    }
  }

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

  // 若该币在被我们跟踪前已毕业（pool 尚未由 AMM 事件补上），主动反查一次池子
  if (!fresh.pool) await discoverPool(t.chain, fresh).catch((e) => log.debug({ err: e.message }, 'discoverPool'));

  bus.emit(Events.CANDIDATE, { ...store.get(key) });
  log.info({ chain: t.chain, symbol: fresh.symbol, buyers: momentum.buyerCount(t.address) }, '候选升级为 active');
}

// 毕业后成交（AMM Swap）：喂动量买家 + 落库，与曲线期同源同表。
async function onSwap(sw) {
  const key = `${sw.chain}:${sw.address.toLowerCase()}`;
  const cand = store.get(key);
  if (!cand || cand.status !== 'active') return;
  const isBuy = sw.side === 'buy';
  momentum.onTrade({ token: sw.address, account: isBuy ? sw.account : null, isBuy, ts: sw.ts });
  const usd = (sw.quoteHuman || 0) * quoteUsd(sw.chain, sw.quoteSym);
  const price = sw.tokenHuman > 0 ? usd / sw.tokenHuman : 0;
  const supply = supplyHumanOf(cand);
  store.addTrade({
    key, ts: sw.ts, side: sw.side, account: sw.account,
    quote_amount: usd, token_amount: sw.tokenHuman || 0,
    price, mcap_at_trade: price > 0 && supply > 0 ? price * supply : null,
  });
  if (isBuy && sw.account) store.addBuyer(key, sw.account, sw.ts);
  recordTradeWrite();
}

// promote 时反查池子（逻辑已抽到 src/pool.js，engine 与 track 共用）

// AMM 建池 / 毕业：补池子地址与类型，供 track 定价，并重建成交订阅。
async function onAmm(c) {
  const key = `${c.chain}:${c.address.toLowerCase()}`;
  const existing = store.get(key);
  if (!existing) return; // 未登记的 AMM 新对不追（噪声太多，只关心已发现的曲线币毕业）
  if (existing.pool) return;
  // quote_symbol 统一存符号：PairCreated 给的是地址，先解析成符号再落库
  const q = resolveQuote(chainConfig(c.chain), c.quote);
  store.setPool(key, c.pool, c.poolType, q?.sym ?? null);
  log.info({ token: existing.symbol, pool: c.pool }, '候选建池/毕业，已补池子');
  bus.emit(Events.POOLS_CHANGED, { chain: c.chain });
  bus.emit(Events.UPDATE, { ...store.get(key) });
}

// 单条动态订阅：覆盖某链所有 active 且已建池的池子；集合变化时整体重建。
const swapUnwatch = new Map(); // chain -> unwatch
function rebuildSwaps(chain) {
  const cfg = chainConfig(chain);
  const pools = store.swapPools()
    .filter((r) => r.chain === chain && r.pool)
    .map((r) => {
      // resolveQuote 同时吃符号和历史遗留的地址值，两种存法都能解析
      const q = resolveQuote(cfg, r.quote_symbol) || {};
      const quoteAddr = (q.address || '').toLowerCase();
      const tokenAddr = r.address.toLowerCase();
      return {
        address: r.pool, token: r.address, quote: quoteAddr, quoteSym: q.sym || r.quote_symbol,
        quoteDecimals: q.decimals || 18, tokenDecimals: r.decimals || 18,
        poolType: r.pool_type === 'v3' ? 'v3' : 'v2',
        quoteIsToken0: quoteAddr ? quoteAddr < tokenAddr : false,
      };
    })
    .filter((p) => p.quote && p.address);
  swapUnwatch.get(chain)?.();
  swapUnwatch.set(chain, pools.length ? resubscribeSwaps(chain, pools, (sw) => onSwap(sw).catch((e) => log.debug({ err: e.message }, 'onSwap'))) : null);
  setSwapPools(store.swapPools().filter((r) => r.pool).length);
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
  const nowMs = Date.now();
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
      const a = l.args || {};
      if (l.eventName === 'TokenCreate') {
        if (!a.token) continue;
        await onCreate({
          chain, address: a.token, launchpad: lp.id, label: lp.label,
          creator: a.creator || null, name: a.name || null, symbol: a.symbol || null,
          totalSupply: a.totalSupply ?? null, launchTime: a.launchTime ?? null,
          tx: l.transactionHash, block: Number(l.blockNumber || 0),
        }).catch(() => {});
        count++;
      } else if (l.eventName === 'TokenPurchase' || l.eventName === 'TokenSale') {
        // 回填期把历史买卖也喂进动量：累积买家数，使启动后首笔实时买入即可触发升级。
        // ts 用块高估算(BSC ~450ms/块)，避免历史成交在重启后 30 分钟内虚增 buys30m。
        if (!a.token) continue;
        const bn = l.blockNumber != null ? BigInt(l.blockNumber) : latest;
        const ts = nowMs - Number(latest - bn) * 450;
        momentum.onTrade({
          token: a.token, account: a.account || null, price: a.price ?? null,
          cost: a.cost ?? null, funds: a.funds ?? null, offers: a.offers ?? null,
          isBuy: l.eventName === 'TokenPurchase', ts,
        });
      }
    }
    from = to + 1n;
    await sleep(250); // 分段间隔，降低被限流概率
  }
  log.info({ chain, count, hours }, '启动回填 TokenCreate 完成');
  return count;
}

export function startEngine() {
  // 毕业池集合变化（新毕业 / 归档）时重建单条 Swap 订阅
  bus.on(Events.POOLS_CHANGED, ({ chain }) => {
    try { rebuildSwaps(chain); } catch (e) { log.debug({ err: e.message }, 'rebuildSwaps'); }
  });

  for (const chain of config.enabledChains) {
    try {
      watchChain(chain, {
        onCreate: (c) => onCreate(c).catch((e) => log.debug({ err: e.message }, 'onCreate')),
        onTrade: (t) => onTrade(t).catch((e) => log.debug({ err: e.message }, 'onTrade')),
        onAmm: (c) => onAmm(c).catch((e) => log.debug({ err: e.message }, 'onAmm')),
      });
      // 启动时按库中已有的毕业池建一次订阅（覆盖重启前已毕业的活跃币）
      try { rebuildSwaps(chain); } catch (e) { log.debug({ err: e.message }, 'rebuildSwaps(启动)'); }
      log.info({ chain }, '链监听已启动');
    } catch (e) {
      log.error({ chain, err: e.message }, '链监听启动失败（检查 RPC 配置）');
    }
  }
  startTracker();
}
