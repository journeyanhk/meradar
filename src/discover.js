import { parseAbiItem, formatUnits } from 'viem';
import { wsClient, httpClient } from './chain.js';
import { chainConfig } from './config.js';
import { fourMemeEvents, swapEvents, ponsFactoryEvents, ponsCurveEvents, ponsHookEvents, v4SwapEvent, v4InitializeEvent } from './abi.js';
import { decodeArcLaunchpadLog } from './arc-launchpad.js';
import { recordWsLog, recordRpcError, recordTxFetch } from './health.js';
import { child } from './logger.js';

const log = child('discover');

/**
 * 带指数退避重建的 watchEvent 包装。
 * viem 只在底层 socket 断开时自动重连；当 eth_subscribe 被服务端拒绝(internal error/限流)时，
 * onError 只回调、不重试 —— 订阅就此静默失联（Arc 曾整链无数据的直接原因）。
 * 本包装：onError → 取消旧订阅 → 指数退避(2s→4s→…→60s) → 重新 watchEvent。
 * makeParams() 返回传给 client.watchEvent 的参数（不含 onError；onLogs 会被包裹以在有数据时重置退避）。
 * 返回统一退订函数。
 */
function watchWithReconnect(client, label, chain, makeParams) {
  let un = null;
  let stopped = false;
  let attempt = 0;
  let timer = null;
  const subscribe = () => {
    if (stopped) return;
    const params = makeParams();
    const origOnLogs = params.onLogs;
    un = client.watchEvent({
      ...params,
      onLogs: (logs) => { attempt = 0; origOnLogs?.(logs); }, // 有数据流入即视为健康 → 退避归零
      onError: (e) => {
        recordRpcError();
        log.warn({ chain, label, err: e.message, attempt }, '订阅出错 → 退避重建(viem 不会自行重试被拒的 eth_subscribe)');
        try { un?.(); } catch { /* noop */ }
        un = null;
        if (timer) return; // 已在退避排程中，避免叠加
        const delay = Math.min(2000 * (2 ** attempt), 60000);
        attempt++;
        timer = setTimeout(() => { timer = null; subscribe(); }, delay);
      },
    });
  };
  subscribe();
  return () => { stopped = true; if (timer) clearTimeout(timer); try { un?.(); } catch { /* noop */ } };
}

// Pons(curve-per-token)：curve 合约地址 → 代币地址 的映射。
// 曲线成交(CurveBuy/Sell)按 topic0 全量订阅，emitter=curve，靠本表反查它属于哪个代币。
// 由 TokenLaunched 实时写入 + 启动时从 DB 回灌(seedPonsCurves)，重启不丢。
const ponsCurveMap = new Map(); // `${chain}:${curveLower}` -> tokenAddress
export function registerPonsCurve(chain, curve, token) {
  if (!chain || !curve || !token) return;
  ponsCurveMap.set(`${chain}:${String(curve).toLowerCase()}`, token);
}
export function ponsTokenOf(chain, curve) {
  return ponsCurveMap.get(`${chain}:${String(curve || '').toLowerCase()}`) || null;
}
export function seedPonsCurves(rows) {
  let n = 0;
  for (const r of rows) { if (r.chain && r.curve && r.address) { registerPonsCurve(r.chain, r.curve, r.address); n++; } }
  if (n) log.info({ n }, 'Pons curve↔token 映射已回灌');
  return n;
}

export function pickToken(token0, token1, quoteSet) {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (quoteSet.has(t0) && !quoteSet.has(t1)) return { token: token1, quote: token0, matched: true };
  if (quoteSet.has(t1) && !quoteSet.has(t0)) return { token: token0, quote: token1, matched: true };
  return { token: token0, quote: token1, matched: false };
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
    // Pons(curve-per-token)：用 factory/hook 而非单一 address，且需三条订阅，先于下方 address 守卫处理。
    if (lp.type === 'curve-per-token') {
      subscribePonsCurve(chain, lp, client, handlers, unwatchers);
      continue;
    }

    if (!lp.address || /^0x0+$/.test(lp.address)) {
      log.warn({ chain, launchpad: lp.id }, '工厂地址未配置，跳过（待核实后填入 config.json）');
      continue;
    }

    if (lp.type === 'arc-launchpad') {
      // Arc 发射台：单合约、每次发射四事件同 tx。签名不确证 → 订阅地址全量日志、按 topic0 解码(src/arc-launchpad.js)。
      const un = watchWithReconnect(client, `arc-launchpad:${lp.id}`, chain, () => ({
        address: lp.address,
        strict: false,
        onLogs: (logs) => {
          recordWsLog(chain);
          for (const l of logs) {
            try { routeArcLaunchpad(chain, lp, l, handlers); }
            catch (e) { log.debug({ err: e.message }, 'arc-launchpad 事件解码失败'); }
          }
        },
      }));
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅 Arc 发射台事件流');
      continue;
    }

    if (lp.type === 'fourmeme-events') {
      const un = watchWithReconnect(client, `fourmeme:${lp.id}`, chain, () => ({
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
      }));
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅 Four.meme 事件流');
      continue;
    }

    if (lp.type === 'amm-v2' || lp.type === 'amm-v3') {
      const poolType = lp.type === 'amm-v3' ? 'v3' : 'v2';
      const event = parseAbiItem(lp.event);
      const un = watchWithReconnect(client, `amm:${lp.id}`, chain, () => ({
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
              const { token, quote, matched } = pickToken(a.token0, a.token1, quoteSet);
              handlers.onAmm?.({
                chain, address: token, launchpad: lp.id, label: lp.label,
                pool: poolAddr, poolType, quote, quoteMatched: matched, graduated: lp.id.startsWith('pancake'),
                tx: l.transactionHash, block: Number(l.blockNumber || 0),
              });
            } catch (e) { log.debug({ err: e.message }, 'amm log 解析失败'); }
          }
        },
      }));
      unwatchers.push(un);
      log.info({ chain, launchpad: lp.id, address: lp.address }, '订阅 AMM 工厂');
    }
  }

  // Pons v4 二级来源：PoolManager.Initialize（bytes32 id + currency0/1）。
  // PoolRegistered(hook) 为主来源，但 hook 事件可能缺失/延迟——Initialize 是 v4 池创建的规范信号，
  // 也是 Arc 主网 v4 的入口。engine.onV4Initialize 里按 currency0/1 反查已跟踪代币，未登记才落库(source='initialize')。
  if (cfg.poolManagerV4 && !/^0x0+$/.test(cfg.poolManagerV4)) {
    const un = watchWithReconnect(client, 'v4-initialize', chain, () => ({
      address: cfg.poolManagerV4,
      event: v4InitializeEvent,
      strict: false,
      onLogs: (logs) => {
        recordWsLog(chain);
        for (const l of logs) {
          try {
            const a = l.args || {};
            if (!a.id) continue;
            handlers.onV4Initialize?.({
              chain, poolId: a.id,
              currency0: a.currency0, currency1: a.currency1,
              fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks,
              sqrtPriceX96: a.sqrtPriceX96, tick: a.tick,
              tx: l.transactionHash, block: Number(l.blockNumber || 0),
            });
          } catch (e) { log.debug({ err: e.message }, 'v4 Initialize 解码失败'); }
        }
      },
    }));
    unwatchers.push(un);
    log.info({ chain, poolManager: cfg.poolManagerV4 }, '订阅 Pons v4 PoolManager.Initialize(二级来源)');
  }

  return () => unwatchers.forEach((u) => { try { u(); } catch { /* noop */ } });
}

// Arc 发射台四事件 → 对应 handler。token=topics[1](公共键)。见 src/arc-launchpad.js decodeArcLaunchpadLog。
function routeArcLaunchpad(chain, lp, l, handlers) {
  const d = decodeArcLaunchpadLog(l);
  if (!d) return;
  const base = { chain, address: d.token, launchpad: lp.id, label: lp.label, block: d.block, tx: d.tx };
  if (d.kind === 'launch') {
    handlers.onArcLaunch?.({ ...base, creator: d.creator, name: d.name, symbol: d.symbol, uri: d.uri, salt: d.salt, ts: Date.now() });
  } else if (d.kind === 'pool') {
    handlers.onArcPool?.({ ...base, poolId: d.poolId });
  } else if (d.kind === 'deployed') {
    handlers.onArcDeployed?.({ ...base, locker: d.locker, v4hook: d.v4hook, controller: d.controller });
  } else if (d.kind === 'fee') {
    handlers.onArcFee?.({ ...base, schedule: d.schedule });
  }
}

function routeFourMeme(chain, lp, l, handlers) {
  const name = l.eventName;
  const a = l.args || {};
  if (name === 'TokenCreate') {
    if (!a.token) return;
    handlers.onCreate?.({
      chain, address: a.token, launchpad: lp.id, label: lp.label,
      creator: a.creator || null, name: a.name || null, symbol: a.symbol || null,
      totalSupply: a.totalSupply ?? null, launchTime: a.launchTime ?? null,
      tx: l.transactionHash, block: Number(l.blockNumber || 0),
    });
  } else if (name === 'TokenPurchase' || name === 'TokenSale') {
    if (!a.token) return;
    handlers.onTrade?.({
      chain, address: a.token, account: a.account || null,
      launchpad: lp.id, label: lp.label,
      price: a.price ?? null, amount: a.amount ?? null, cost: a.cost ?? null,
      offers: a.offers ?? null, funds: a.funds ?? null,
      block: Number(l.blockNumber || 0), // M2c：同块多买=bot 判定
      isBuy: name === 'TokenPurchase', ts: Date.now(),
    });
  }
}

/**
 * Pons(curve-per-token) 三条订阅：
 *  ① 工厂 → TokenLaunched(登记 curve↔token + onCreate) / PoolGraduated(onGraduate) / LaunchSwept(onSweep)
 *  ② hook  → PoolRegistered(poolId↔token，M2b v4 定价用；M1 仅转发/登记)
 *  ③ 曲线成交 → CurveBuy/CurveSell 按 topic0 全量订阅(无地址过滤)，emitter=curve 反查 token → onTrade
 * 全量订阅是刻意选择：curve 每币一个地址、数量随发行增长，用地址数组过滤反而更重；
 * topic0 过滤由节点侧完成，未知 curve 的成交在本地被 map 命中失败即丢弃。
 */
function subscribePonsCurve(chain, lp, client, handlers, unwatchers) {
  // ① 工厂事件
  if (lp.factory && !/^0x0+$/.test(lp.factory)) {
    const un = watchWithReconnect(client, `pons-factory:${lp.id}`, chain, () => ({
      address: lp.factory, events: ponsFactoryEvents, strict: false,
      onLogs: (logs) => {
        recordWsLog(chain);
        for (const l of logs) { try { routePonsFactory(chain, lp, l, handlers); } catch (e) { log.debug({ err: e.message }, 'pons 工厂事件解码失败'); } }
      },
    }));
    unwatchers.push(un);
    log.info({ chain, launchpad: lp.id, factory: lp.factory }, '订阅 Pons 工厂事件(TokenLaunched/PoolGraduated/LaunchSwept)');
  }
  // ② hook PoolRegistered（poolId↔token）
  if (lp.hook && !/^0x0+$/.test(lp.hook)) {
    const un = watchWithReconnect(client, `pons-hook:${lp.id}`, chain, () => ({
      address: lp.hook, events: ponsHookEvents, strict: false,
      onLogs: (logs) => {
        recordWsLog(chain);
        for (const l of logs) {
          try {
            const a = l.args || {};
            if (l.eventName !== 'PoolRegistered' || !a.poolId) continue;
            handlers.onPoolRegistered?.({ chain, poolId: a.poolId, token: a.memecoin, quote: a.quoteToken, creator: a.creator, tx: l.transactionHash, block: Number(l.blockNumber || 0) });
          } catch (e) { log.debug({ err: e.message }, 'pons hook 事件解码失败'); }
        }
      },
    }));
    unwatchers.push(un);
    log.info({ chain, launchpad: lp.id, hook: lp.hook }, '订阅 Pons hook 事件(PoolRegistered)');
  }
  // ③ 曲线成交（topic0 全量订阅）
  const un = watchWithReconnect(client, `pons-curve:${lp.id}`, chain, () => ({
    events: ponsCurveEvents, strict: false,
    onLogs: (logs) => {
      recordWsLog(chain);
      for (const l of logs) { try { routePonsCurve(chain, lp, l, handlers); } catch (e) { log.debug({ err: e.message }, 'pons 曲线成交解码失败'); } }
    },
  }));
  unwatchers.push(un);
  log.info({ chain, launchpad: lp.id }, '订阅 Pons 曲线成交(CurveBuy/CurveSell, topic0 全量)');
}

function routePonsFactory(chain, lp, l, handlers) {
  const name = l.eventName;
  const a = l.args || {};
  if (name === 'TokenLaunched') {
    if (!a.token || !a.curve) return;
    registerPonsCurve(chain, a.curve, a.token);
    handlers.onCreate?.({
      chain, address: a.token, launchpad: lp.id, label: lp.label,
      creator: a.deployer || null, name: null, symbol: null, totalSupply: null, launchTime: null,
      curve: a.curve,
      quote: a.pairToken, // 0x0=原生 ETH 计价；否则 ERC-20 计价
      graduationThreshold: a.graduationThreshold != null ? a.graduationThreshold.toString() : null,
      tx: l.transactionHash, block: Number(l.blockNumber || 0),
    });
  } else if (name === 'PoolGraduated') {
    if (!a.token) return;
    handlers.onGraduate?.({ chain, address: a.token, tx: l.transactionHash, block: Number(l.blockNumber || 0), ts: Date.now() });
  } else if (name === 'LaunchSwept') {
    if (!a.token) return;
    handlers.onSweep?.({ chain, address: a.token, tx: l.transactionHash, block: Number(l.blockNumber || 0) });
  }
}

function routePonsCurve(chain, lp, l, handlers) {
  const a = l.args || {};
  const emitter = (l.address || '').toLowerCase();
  const token = ponsCurveMap.get(`${chain}:${emitter}`);
  if (!token) return; // 未跟踪的 curve（其 TokenLaunched 未见/未回灌）→ 丢弃
  const isBuy = l.eventName === 'CurveBuy';
  // 买家取 recipient（wallet 是 Router，非真实买家，见 docs）。卖单也用 recipient(收到报价币的人)。
  const account = a.recipient || null;
  const quoteRaw = isBuy ? a.quoteIn : a.quoteOut;
  const tokenRaw = isBuy ? a.tokensOut : a.tokensIn; // meme 固定 18 位
  if (quoteRaw == null || tokenRaw == null || tokenRaw === 0n) return;
  // 单价(报价币最小单位 / 每个人类可读 meme)：= quoteRaw * 10^18 / tokenRaw，与 momentum.lastPriceWei 口径一致。
  const price = (quoteRaw * (10n ** 18n)) / tokenRaw;
  handlers.onTrade?.({
    chain, address: token, account, launchpad: lp.id, label: lp.label,
    price, amount: tokenRaw, cost: quoteRaw, offers: null, funds: null,
    fee: a.fee ?? null, tax: a.tax ?? null, // 曲线自带手续费/税(报价币最小单位)，落库供 M2c/M4
    block: Number(l.blockNumber || 0), // M2c：同块多买=bot 判定
    isBuy, ts: Date.now(),
  });
}

/**
 * 毕业后成交：一条动态订阅覆盖所有 active 且已建池的池子。
 * pools: [{ address, token, quote, quoteSym, quoteDecimals, poolType, quoteIsToken0 }]
 * onSwap 收到归一化的成交：{ chain, address, account, side, quoteHuman, quoteSym, tokenHuman, ts }
 * 触发重建的时机只有两个：setPool（新毕业）与归档，频率极低。
 */
export function resubscribeSwaps(chain, pools, onSwap) {
  const client = wsClient(chain);
  if (!pools.length) return () => {};
  const meta = new Map(pools.map((p) => [p.address.toLowerCase(), p]));
  const un = watchWithReconnect(client, 'swaps', chain, () => ({
    address: pools.map((p) => p.address),
    events: swapEvents,
    strict: false,
    onLogs: (logs) => {
      recordWsLog(chain);
      for (const l of logs) {
        try {
          const p = meta.get((l.address || '').toLowerCase());
          if (!p) continue;
          const norm = normalizeSwap(l, p, chain);
          if (norm) onSwap(norm);
        } catch (e) { log.debug({ err: e.message }, 'swap 解码失败'); }
      }
    },
  }));
  log.info({ chain, pools: pools.length }, '重建毕业池成交订阅(单订阅)');
  return un;
}

export function normalizeSwap(l, p, chain) {
  const a = l.args || {};
  const qDec = p.quoteDecimals || 18;
  const q0 = p.quoteIsToken0;
  let side, quoteRaw, tokenRaw, account;
  if (p.poolType === 'v3') {
    // int256 delta：>0 表示池子收到该币（用户卖出该币给池子）
    const qDelta = q0 ? a.amount0 : a.amount1;
    const tDelta = q0 ? a.amount1 : a.amount0;
    if (qDelta == null || tDelta == null) return null;
    account = a.recipient || null;
    if (qDelta > 0n) { side = 'buy'; quoteRaw = qDelta; tokenRaw = -tDelta; }
    else { side = 'sell'; quoteRaw = -qDelta; tokenRaw = tDelta; }
  } else {
    // V2：以 amountIn/Out 判断方向
    const qIn = q0 ? a.amount0In : a.amount1In;
    const qOut = q0 ? a.amount0Out : a.amount1Out;
    const tIn = q0 ? a.amount1In : a.amount0In;
    const tOut = q0 ? a.amount1Out : a.amount0Out;
    if (qIn == null || qOut == null) return null;
    account = a.to || null;
    if (qIn > 0n) { side = 'buy'; quoteRaw = qIn; tokenRaw = tOut; }
    else { side = 'sell'; quoteRaw = qOut; tokenRaw = tIn; }
  }
  if (quoteRaw <= 0n) return null;
  const quoteHuman = Number(formatUnits(quoteRaw, qDec));
  const tokenHuman = Number(formatUnits(tokenRaw > 0n ? tokenRaw : 0n, p.tokenDecimals || 18));
  // ts 使用 Date.now()：本函数只服务实时订阅路径（swap 到达即处理），偏差可忽略。
  // ⚠️ 若将来新增「历史 Swap 回填」，勿复用此处的 Date.now()——需按块高估算
  //    ts = now − (latest − blockNumber) × 区块间隔，与 backfill 中曲线成交的口径一致。
  return { chain, address: p.token, account, side, quoteHuman, quoteSym: p.quoteSym, tokenHuman, block: Number(l.blockNumber || 0), ts: Date.now() };
}

/**
 * Pons v4 毕业池成交：按 poolId 集合定向订阅 PoolManager.Swap（indexed id → 节点侧 topic 过滤）。
 * pools: [{ poolId, token, quoteSym, quoteDecimals, tokenDecimals, memeIsCurrency0 }]
 * 与 resubscribeSwaps 同产出归一化成交对象，交由 engine.onSwap 落库。POOLS_CHANGED 时整体重建。
 */
export function resubscribeV4Swaps(chain, poolManager, pools, onSwap) {
  const client = wsClient(chain);
  if (!pools.length || !poolManager || /^0x0+$/.test(poolManager)) return () => {};
  const meta = new Map(pools.map((p) => [String(p.poolId).toLowerCase(), p]));
  // 分片：indexed id 数组过滤走节点侧 topic 过滤，部分节点对数组长度设限，按 100 个 poolId 一片订阅。
  // 陈旧/归档池不在 pools 内(rebuildV4Swaps 仅取 active 候选)，天然退订。
  const SHARD = 100;
  const uns = [];
  const mkOnLogs = () => (logs) => {
    recordWsLog(chain);
    for (const l of logs) dispatchV4Swap(l, meta, chain, onSwap);
  };
  for (let i = 0; i < pools.length; i += SHARD) {
    const group = pools.slice(i, i + SHARD);
    const un = watchWithReconnect(client, `v4-swaps-shard:${i / SHARD}`, chain, () => ({
      address: poolManager,
      event: v4SwapEvent,
      args: { id: group.map((p) => p.poolId) }, // indexed bytes32 id → 节点侧按 poolId 过滤
      strict: false,
      onLogs: mkOnLogs(),
    }));
    uns.push(un);
  }
  log.info({ chain, pools: pools.length, shards: uns.length }, '重建 Pons v4 成交订阅(PoolManager, 按 poolId 定向, 分片)');
  return () => uns.forEach((u) => { try { u(); } catch { /* noop */ } });
}

// 单条 v4 Swap log → 本地 poolId→meta 命中才归一化落库；未命中(非我们跟踪的池)直接丢。resubscribe/full 共用。
function dispatchV4Swap(l, meta, chain, onSwap) {
  const p = meta.get(String(l.args?.id || '').toLowerCase());
  if (!p) return;
  try {
    const norm = normalizeSwapV4(l, p, chain);
    if (norm) onSwap(norm);
  } catch (e) { log.debug({ err: e.message }, 'v4 swap 解码失败'); }
}

/**
 * v4 全量成交订阅（Arc 首周）：对 PoolManager.Swap 单条订阅所有池，本地按 poolId→meta 过滤。
 * 每小时两千个带独立 hook 的 v4 池，「按 seen 池分片重建」会不停抖动；改为订阅常驻、只刷新 meta 表。
 * getMeta(): 返回当前 Map<poolIdLower, meta>（engine 在 POOLS_CHANGED 时原地替换，订阅不重建）。
 */
export function subscribeV4SwapsFull(chain, poolManager, getMeta, onSwap) {
  const client = wsClient(chain);
  if (!poolManager || /^0x0+$/.test(poolManager)) return () => {};
  const un = watchWithReconnect(client, 'v4-swaps-full', chain, () => ({
    address: poolManager,
    event: v4SwapEvent,
    strict: false,
    onLogs: (logs) => {
      recordWsLog(chain);
      const meta = getMeta();
      if (!meta || meta.size === 0) return;
      for (const l of logs) dispatchV4Swap(l, meta, chain, onSwap);
    },
  }));
  log.info({ chain }, '建立 v4 全量成交订阅(PoolManager 单订阅, 本地 poolId 过滤)');
  return () => { try { un(); } catch { /* noop */ } };
}

/**
 * v4 Swap 方向判定纯函数(无 RPC，供单测冻结断言)。amount0/amount1 为「用户视角」int128 bigint：
 * 负=用户付出、正=用户收到(与 V3 池视角相反)。meme 收到(>0)=买、付出(<0)=卖；报价腿取反号。
 * 返回 { side, tokenRaw, quoteRaw }(均正)，无成交返回 null。买家(tx.from)由调用方补。
 */
export function classifyV4Swap({ amount0, amount1, memeIsCurrency0 }) {
  const memeDelta = memeIsCurrency0 ? amount0 : amount1;
  const quoteDelta = memeIsCurrency0 ? amount1 : amount0;
  if (memeDelta == null || quoteDelta == null) return null;
  if (memeDelta > 0n) return { side: 'buy', tokenRaw: memeDelta, quoteRaw: -quoteDelta };
  if (memeDelta < 0n) return { side: 'sell', tokenRaw: -memeDelta, quoteRaw: quoteDelta };
  return null;
}

/**
 * v4 Swap 归一化(纯解码，零 RPC)。买家/卖家=tx.from —— Swap.sender 是 Router、
 * HookFeeCollected.payer 是 memecoin 合约，均非真实交易者(已链上核验)；故 account 不在此解析，
 * 仅带回 txHash，由 engine 两段式准入按需经 resolveV4TxFrom 解析(热池才付 getTransaction 成本)。
 */
export function normalizeSwapV4(l, p, chain) {
  const a = l.args || {};
  const c = classifyV4Swap({ amount0: a.amount0, amount1: a.amount1, memeIsCurrency0: p.memeIsCurrency0 });
  if (!c || c.quoteRaw <= 0n) return null;
  const quoteHuman = Number(formatUnits(c.quoteRaw, p.quoteDecimals || 18));
  const tokenHuman = Number(formatUnits(c.tokenRaw, p.tokenDecimals || 18));
  // sqrtPriceX96/liquidity 随 Swap 事件到达 → 供 onSwap 写 poolState，实现事件驱动定价(零 RPC)。
  return {
    chain, address: p.token, account: null, txHash: l.transactionHash || null,
    side: c.side, quoteHuman, quoteSym: p.quoteSym,
    tokenHuman, block: Number(l.blockNumber || 0), ts: Date.now(),
    pool: p.poolId, poolType: 'v4', sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: a.tick,
    fee: a.fee != null ? Number(a.fee) : null, // v4 动态费率(百万分之)：供费率硬拒(90.1% 反狙击池)
  };
}

/**
 * tx.from 解析(LRU 缓存)。同一 txHash 常含多条 Swap(路由多跳/同池连买)、多池共用一笔交易 →
 * 缓存 txHash→from 省重复 getTransaction。返回小写地址或 null(零地址/取不到)。
 * engine 两段式准入：seen 池先按不同 txHash 数预筛，够 admission 才调此解析，绝大多数冷池零 RPC。
 */
const TX_FROM_CACHE = new Map(); // txHashLower -> from(lower)（LRU：超上限删最旧）
const TX_FROM_CACHE_MAX = 20000;
export async function resolveV4TxFrom(chain, txHash) {
  if (!txHash) return null;
  const hash = txHash.toLowerCase();
  if (TX_FROM_CACHE.has(hash)) return TX_FROM_CACHE.get(hash); // 命中(可能是 null，代表已确认无有效 from)
  try {
    recordTxFetch();
    const tx = await httpClient(chain).getTransaction({ hash: txHash });
    const from = (tx?.from || '').toLowerCase();
    const account = (from && !/^0x0+$/.test(from)) ? from : null;
    TX_FROM_CACHE.set(hash, account);
    if (TX_FROM_CACHE.size > TX_FROM_CACHE_MAX) TX_FROM_CACHE.delete(TX_FROM_CACHE.keys().next().value);
    return account;
  } catch { return null; } // 拿不到 → 不缓存(留待下次重试)
}
