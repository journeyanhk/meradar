import { watchChain, resubscribeSwaps, resubscribeV4Swaps, registerPonsCurve, seedPonsCurves, ponsTokenOf } from './discover.js';
import { readToken, quoteUsd, resolveQuote, readTokenInfo } from './enrich.js';
import { scoreCandidate } from './score.js';
import { store } from './db.js';
import { config, chainConfig, admissionFor } from './config.js';
import { httpClient, getSecPerBlock, estimateTsFromBlock } from './chain.js';
import { fourMemeEvents, ponsFactoryEvents, ponsCurveEvents, ponsHookEvents } from './abi.js';
import { bus, Events } from './bus.js';
import { startTracker } from './track.js';
import { discoverPool } from './pool.js';
import { learnTemplate, recordPromotedTemplate } from './template.js';
import * as momentum from './momentum.js';
import { recordPoolState } from './poolstate.js';
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
  if (!q) return; // 报价币未知 → 不定价、不落库（宁可晚 10 秒等 _tokenInfos/learnQuote 解析）
  const qp = quoteUsd(t.chain, q.sym); // 动态报价币不可信/未定价时为 null
  const div = 10 ** q.decimals;
  const usd = (t.cost != null && qp != null) ? (Number(t.cost) / div) * qp : 0; // 无可信价 → usd=0，但仍计买家
  const tokenHuman = t.amount != null ? Number(t.amount) / 1e18 : 0; // meme 代币固定 18 位
  const side = t.isBuy ? 'buy' : 'sell';
  const ts = t.ts || Date.now();
  const price = tokenHuman > 0 ? usd / tokenHuman : 0;
  const supply = supplyHumanOf(cand);
  store.addTrade({ key: cand.key, ts, side, account: t.account, quote_amount: usd, token_amount: tokenHuman, price, mcap_at_trade: price > 0 && supply > 0 ? price * supply : null, fee_raw: t.fee != null ? t.fee.toString() : null, tax_raw: t.tax != null ? t.tax.toString() : null, block: t.block ?? null });
  if (side === 'buy' && t.account) store.addBuyer(cand.key, t.account, ts);
  recordTradeWrite();
}

// TokenCreate：只登记，不轮询。事件已带 name/symbol/creator/totalSupply，零 RPC。
// 模板自学习计数在此抽样（1/10）：见 learnTemplate 注释——放 create 才能在轮换后十几分钟学会新模板。
let createSeq = 0;
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
    // 发射时刻(狙击时间窗输入)：链上 launchTime 有效(>0)才用；Four.meme 常为 0(会被存成 1970 年，
    // 比 null 更隐蔽地让时间窗恒 false)、Pons 为 null → 回退：回填用块号估算(c.launchTs)，实时用 now。
    launch_time: c.launchTime > 0 ? Number(c.launchTime) * 1000 : (c.launchTs || Date.now()),
    status: 'seen', discovered_at: now, updated_at: now,
  });
  if (!inserted) return;
  recordSeen();
  // Pons(curve-per-token)：登记曲线合约 + 报价币/毕业阈值。quote=0x0→ETH；否则 ERC-20 计价。
  // TokenLaunched 不带 name/symbol/totalSupply，留待 promote 时 readToken 补齐（懒读，只对通过准入的币）。
  if (c.curve) {
    store.setCurve(key, c.curve);
    const q = resolveQuote(chainConfig(c.chain), c.quote);
    store.setCurveInfo(key, { quote_symbol: q?.sym ?? null, max_raising: c.graduationThreshold ?? null, launch_time: null });
  }
  // 抽样 1/10 累计码哈希频次（TokenCreate=平台部署证据，仅 Four.meme）；仅一次 getCode，httpClient 已开 batch。
  if (c.launchpad === 'fourmeme' && createSeq++ % 10 === 0) {
    await learnTemplate(c.chain, c.address).catch((e) => log.debug({ err: e.message }, 'learnTemplate'));
  }
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

  // 模板 health：记录本次 promote 的币是否命中已知模板（未知率进 /api/health 监控轮换）。
  // 计数已移到 onCreate 抽样；此处不再 bump，仅统计。matchesTemplate 读实时白名单，学习到的哈希即时生效。
  await recordPromotedTemplate(t.chain, t.address).catch((e) => log.debug({ err: e.message }, 'recordPromotedTemplate'));

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
  if (!cand) return;
  // 事件驱动定价：v4 Swap 自带 sqrtPriceX96+liquidity → 写 poolState，track 本轮直接据此算价、跳过 extsload。
  // 对 seen/active 都写(价格随时可算)。
  if (sw.poolType === 'v4' && sw.pool && sw.sqrtPriceX96 != null && sw.liquidity != null) {
    recordPoolState(sw.chain, sw.pool, { sqrtPriceX96: sw.sqrtPriceX96, liquidity: sw.liquidity, tick: sw.tick, ts: sw.ts });
  }
  const isBuy = sw.side === 'buy';
  momentum.onTrade({ token: sw.address, account: isBuy ? sw.account : null, isBuy, ts: sw.ts });

  // Arc pool-first：seen 池成交只喂动量计买家，达 admission 才升 active；升级前不写 trades
  // (避免未过安全打分的币污染 trades 表)。仅 discoverFromPools 链走此分支。
  if (cand.status === 'seen') {
    if (chainConfig(sw.chain).discoverFromPools) {
      store.touchLastTrade(key, sw.ts); // 刷新最后成交时刻 → 有量的 seen 池不被新建空池挤出 500 上限
      await promoteFromPool(sw.chain, key, cand);
    }
    return;
  }
  if (cand.status !== 'active') return;
  const qp = quoteUsd(sw.chain, sw.quoteSym); // 动态报价币不可信/未定价时为 null
  const usd = qp != null ? (sw.quoteHuman || 0) * qp : 0;
  const price = sw.tokenHuman > 0 ? usd / sw.tokenHuman : 0;
  const supply = supplyHumanOf(cand);
  store.addTrade({
    key, ts: sw.ts, side: sw.side, account: sw.account,
    quote_amount: usd, token_amount: sw.tokenHuman || 0,
    price, mcap_at_trade: price > 0 && supply > 0 ? price * supply : null, block: sw.block ?? null,
  });
  if (isBuy && sw.account) store.addBuyer(key, sw.account, sw.ts);
  if (chainConfig(sw.chain).discoverFromPools) store.touchLastTrade(key, sw.ts); // active 池同刷，有量的池排序靠前不被挤出
  recordTradeWrite();
}

// —— Arc pool-first：从「新建池」登记新币 + 升级 ——
// discoverFromPools 链上，一侧是已知报价币、另一侧未登记 → 未登记方即新 meme，登记为 seen 且「已毕业」态
// (有池即毕业)。graduated_at 用建池块时间近似(供新鲜度门)。不跑曲线/模板分支(cand.pool 已设 → track 天然跳过)。
async function registerSeenFromPool({ chain, address, launchpad, block }) {
  const key = `${chain}:${address.toLowerCase()}`;
  if (store.get(key)) return true;
  const meta = await readToken(chain, address).catch(() => null);
  if (!meta) return false; // 非 ERC20 / 读取失败 → 忽略噪声
  const now = Date.now();
  const gradTs = block ? estimateTsFromBlock(chain, block) : now;
  const inserted = store.addCandidate({
    key, chain, address, launchpad: launchpad || 'pool',
    name: (meta.name || '').slice(0, 80) || null,
    symbol: (meta.symbol || '').slice(0, 32) || null,
    decimals: meta.decimals ?? 18,
    total_supply: meta.totalSupply?.toString() ?? null, creator: null,
    pool: null, pool_type: null, quote_symbol: null,
    launch_time: gradTs, status: 'seen', discovered_at: now, updated_at: now,
  });
  if (inserted) { recordSeen(); store.markGraduated(key, gradTs); } // 有池=已毕业；graduated_at=建池块时间
  return !!store.get(key);
}

// 记录建池者(Arc pool-first)：拉一次建池交易的 from(部署者)/to(被调用合约=发射台)，供 poolCreators24h 反推发射台合约。
// 每币一次(发现时)，非每笔成交，成本可忽略；失败静默。
async function recordPoolCreator(chain, { tx, pool }) {
  if (!tx) return;
  try {
    const t = await httpClient(chain).getTransaction({ hash: tx });
    store.addPoolCreator({
      chain, ts: Date.now(),
      creator: (t?.from || '').toLowerCase() || null,
      contract: (t?.to || '').toLowerCase() || null,
      pool: pool || null, tx,
    });
  } catch { /* 拿不到交易 → 跳过 */ }
}

// pool-first 币升级：seen 池成交经 momentum 计买家，达 admission 升 active。
// 无 Token Manager/曲线：不读 tokenInfo、不读曲线；走仿盘归属 + 安全打分(毕业后往返/收紧豁免)。
async function promoteFromPool(chain, key, cand) {
  if (momentum.buyerCount(cand.address) < admissionFor(chain)) return;
  if (!store.promote(key)) return;
  recordPromoted();
  for (const acc of momentum.buyers(cand.address)) store.addBuyer(key, acc, 0);
  const fresh = store.get(key);
  if (fresh.symbol) {
    const earliest = store.earliestSameSymbol(chain, fresh.symbol);
    if (earliest && earliest.key !== key) store.setCopyOf(key, earliest.key);
  }
  const s = await scoreCandidate(chain, fresh).catch((e) => { log.debug({ err: e.message }, 'scoreCandidate(pool-first)'); return { veto: false, checks: {} }; });
  store.setSafety(key, s.checks);
  if (s.veto) {
    store.setStatus(key, 'rejected', s.reason);
    bus.emit(Events.UPDATE, { ...store.get(key) });
    return;
  }
  bus.emit(Events.CANDIDATE, { ...store.get(key) });
  log.info({ chain, symbol: fresh.symbol, buyers: momentum.buyerCount(cand.address) }, 'pool-first 候选升级为 active');
}

// promote 时反查池子（逻辑已抽到 src/pool.js，engine 与 track 共用）

// Pons 毕业(PoolGraduated)：记毕业时刻(供新鲜度 + 前端「已毕业」态)，并触发 v4 定向订阅重建，
// 后续 Swap/PoolRegistered 接上 v4 定价（见 engine onSwap / poolstate）。
async function onGraduate(g) {
  const key = `${g.chain}:${g.address.toLowerCase()}`;
  if (!store.get(key)) return;
  store.markGraduated(key, g.ts || Date.now());
  bus.emit(Events.POOLS_CHANGED, { chain: g.chain }); // 据此重建 v4 定向订阅
  bus.emit(Events.UPDATE, { ...store.get(key) });
  log.info({ chain: g.chain, token: g.address }, 'Pons 毕业(PoolGraduated)：已记毕业时刻，v4 池登记后接定价');
}

// Pons 清算中(LaunchSwept)：毕业前的过渡态；M1 仅记录，前端「毕业中」态与 v4 建池由 M2b 补。
async function onSweep(s) {
  const key = `${s.chain}:${s.address.toLowerCase()}`;
  if (!store.get(key)) return;
  log.debug({ chain: s.chain, token: s.address }, 'Pons LaunchSwept(清算中)');
}

// Pons PoolRegistered(hook 发出，毕业时与 Initialize/Swap 同回执)：poolId↔token 映射主源。
// 落 v4_pools(含派生 currency0/1，供定价与定向订阅)；若该币已在跟踪 → 接 v4 定价(pool=poolId, pool_type='v4', graduated)。
// v4 池按 poolId 在 PoolManager 内部标识、无独立池地址，故 candidates.pool 存 poolId、readPoolMetrics 走 v4 分支(extsload 直读)。
async function onPoolRegistered(p) {
  const meme = (p.token || '').toLowerCase();
  const quote = (p.quote || '').toLowerCase();
  if (!p.poolId || !meme || /^0x0+$/.test(meme)) return;
  // v4 currency 按地址升序排序，原生 ETH(0x0) 恒为 currency0。
  const isNative = /^0x0+$/.test(quote);
  let currency0, currency1;
  if (isNative || quote < meme) { currency0 = quote; currency1 = meme; }
  else { currency0 = meme; currency1 = quote; }
  store.upsertV4Pool({
    chain: p.chain, pool_id: p.poolId, token: meme, quote,
    currency0, currency1, source: 'registered', block: p.block, tx: p.tx,
  });
  const key = `${p.chain}:${meme}`;
  const cand = store.get(key);
  if (!cand) { log.debug({ chain: p.chain, token: meme, poolId: p.poolId }, 'v4 池登记(token 未跟踪，仅存映射)'); return; }
  const q = resolveQuote(chainConfig(p.chain), p.quote);
  store.setPool(key, p.poolId, 'v4', q?.sym ?? null); // 内部含 graduated=1 + graduated_at
  bus.emit(Events.POOLS_CHANGED, { chain: p.chain });
  bus.emit(Events.UPDATE, { ...store.get(key) });
  log.info({ chain: p.chain, token: meme, poolId: p.poolId }, 'Pons v4 池登记，已接 v4 定价(graduated)');
}

// PoolManager.Initialize(二级来源)：v4 池创建的规范信号。PoolRegistered(hook) 为主源、优先，
// 但 hook 事件可能缺失/延迟；Initialize 按 currency0/1 反查已跟踪代币兜底登记(source='initialize')。
// 同回执里 PoolRegistered 与 Initialize 并存时，v4PoolByToken 命中即早退，不重复落库/emit。
async function onV4Initialize(i) {
  if (!i.poolId) return;
  const c0 = (i.currency0 || '').toLowerCase();
  const c1 = (i.currency1 || '').toLowerCase();
  const cfg = chainConfig(i.chain);
  const quoteSet = new Set(Object.values(cfg.quoteTokens).map((q) => q.address.toLowerCase()));
  quoteSet.add('0x0000000000000000000000000000000000000000'); // 原生 ETH
  // 两腿里非报价币的那条是 meme；两条都是/都不是报价币 → 无法判定，跳过。
  let meme, quote;
  const c0q = quoteSet.has(c0), c1q = quoteSet.has(c1);
  if (c0q && !c1q) { meme = c1; quote = c0; }
  else if (c1q && !c0q) { meme = c0; quote = c1; }
  else return;
  if (!meme || /^0x0+$/.test(meme)) return;
  const key = `${i.chain}:${meme}`;
  let cand = store.get(key);
  if (!cand) {
    // pool-first 链(Arc)：v4 新池的非报价币一侧即新 meme，登记为 seen·已毕业；否则(BSC/Robinhood)不为全网 v4 池落库。
    if (!cfg.discoverFromPools) return;
    if (!(await registerSeenFromPool({ chain: i.chain, address: meme, launchpad: 'arc-uniV4', block: i.block }))) return;
    recordPoolCreator(i.chain, { tx: i.tx, pool: i.poolId }).catch(() => {});
    cand = store.get(key);
    if (!cand) return;
  }
  if (store.v4PoolByToken(i.chain, meme)) return; // PoolRegistered 已登记为主源 → 让主源优先，早退
  store.upsertV4Pool({
    chain: i.chain, pool_id: i.poolId, token: meme, quote,
    currency0: c0, currency1: c1, fee: i.fee != null ? Number(i.fee) : null,
    tick_spacing: i.tickSpacing != null ? Number(i.tickSpacing) : null,
    hooks: i.hooks, source: 'initialize', block: i.block, tx: i.tx,
  });
  const q = resolveQuote(cfg, quote);
  store.setPool(key, i.poolId, 'v4', q?.sym ?? null);
  bus.emit(Events.POOLS_CHANGED, { chain: i.chain });
  bus.emit(Events.UPDATE, { ...store.get(key) });
  log.info({ chain: i.chain, token: meme, poolId: i.poolId, tickSpacing: i.tickSpacing }, 'Pons v4 池 Initialize(二级来源)，已接 v4 定价');
}

// AMM 建池 / 毕业：补池子地址与类型，供 track 定价，并重建成交订阅。
// discoverFromPools 链(Arc)：未登记的新对且恰有一侧是已知报价币 → pool-first 登记为新币(seen·已毕业)。
async function onAmm(c) {
  const key = `${c.chain}:${c.address.toLowerCase()}`;
  const cfg = chainConfig(c.chain);
  const existing = store.get(key);
  if (!existing) {
    // 非 pool-first 链：未登记的 AMM 新对不追（噪声太多，只关心已发现的曲线币毕业）。
    // pool-first 链：仅当恰有一侧是已知报价币时登记（两侧都非报价币=忽略）。
    if (!cfg.discoverFromPools || !c.quoteMatched) return;
    if (!(await registerSeenFromPool({ chain: c.chain, address: c.address, launchpad: c.launchpad, block: c.block }))) return;
    const q = resolveQuote(cfg, c.quote);
    store.setPool(key, c.pool, c.poolType, q?.sym ?? null);
    recordPoolCreator(c.chain, { tx: c.tx, pool: c.pool }).catch(() => {});
    bus.emit(Events.POOLS_CHANGED, { chain: c.chain });
    bus.emit(Events.UPDATE, { ...store.get(key) });
    log.info({ chain: c.chain, symbol: store.get(key)?.symbol, pool: c.pool, poolType: c.poolType }, 'pool-first 登记新币(seen·已毕业)');
    return;
  }
  if (existing.pool) return;
  // quote_symbol 统一存符号：PairCreated 给的是地址，先解析成符号再落库
  const q = resolveQuote(cfg, c.quote);
  store.setPool(key, c.pool, c.poolType, q?.sym ?? null);
  log.info({ token: existing.symbol, pool: c.pool }, '候选建池/毕业，已补池子');
  bus.emit(Events.POOLS_CHANGED, { chain: c.chain });
  bus.emit(Events.UPDATE, { ...store.get(key) });
}

// 单条动态订阅：覆盖某链所有 active 且已建池的 V2/V3 池子；集合变化时整体重建。
// v4 毕业池(pool_type='v4')走 rebuildV4Swaps 定向订阅 PoolManager，不在此处。
const swapUnwatch = new Map(); // chain -> unwatch
function rebuildSwaps(chain) {
  const cfg = chainConfig(chain);
  const pools = store.swapPoolsFor(chain, !!cfg.discoverFromPools)
    .filter((r) => r.pool && r.pool_type !== 'v4')
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

// Pons v4 毕业池定向订阅：按 active 且 pool_type='v4' 的候选取 v4_pools 元信息，按 poolId 集合订阅 PoolManager.Swap。
const v4SwapUnwatch = new Map(); // chain -> unwatch
function rebuildV4Swaps(chain) {
  const cfg = chainConfig(chain);
  const pm = cfg.poolManagerV4;
  if (!pm || /^0x0+$/.test(pm)) return;
  const pools = [];
  for (const r of store.swapPoolsFor(chain, !!cfg.discoverFromPools).filter((r) => r.pool && r.pool_type === 'v4')) {
    const vp = store.v4PoolById(chain, r.pool) || store.v4PoolByToken(chain, r.address);
    if (!vp) continue;
    const q = resolveQuote(cfg, r.quote_symbol) || {};
    pools.push({
      poolId: r.pool, token: r.address, quoteSym: q.sym || r.quote_symbol,
      quoteDecimals: q.decimals || 18, tokenDecimals: r.decimals || 18,
      memeIsCurrency0: (vp.currency0 || '') === r.address.toLowerCase(),
    });
  }
  v4SwapUnwatch.get(chain)?.();
  v4SwapUnwatch.set(chain, pools.length ? resubscribeV4Swaps(chain, pm, pools, (sw) => onSwap(sw).catch((e) => log.debug({ err: e.message }, 'onSwap(v4)'))) : null);
}

// 启动回填：按链上启用的发射台类型分派（Four.meme 事件流 / Pons 曲线）。
export async function backfillRecentCreates(chain, hours = 2) {
  const cfg = chainConfig(chain);
  let count = 0;
  if (cfg.launchpads?.some((l) => l.type === 'curve-per-token' && l.factory && !/^0x0+$/.test(l.factory))) {
    count += await backfillPonsLaunches(chain, hours).catch((e) => { log.warn({ chain, err: e.message }, 'Pons 回填失败(忽略)'); return 0; });
  }
  if (cfg.launchpads?.some((l) => l.type === 'fourmeme-events' && l.address && !/^0x0+$/.test(l.address))) {
    count += await backfillFourMeme(chain, hours).catch((e) => { log.warn({ chain, err: e.message }, 'Four.meme 回填失败(忽略)'); return 0; });
  }
  return count;
}

// 启动回填：拉取最近 ~hours 小时的 TokenCreate 登记为 seen，
// 让服务启动前创建、之后才启动的慢热币也能进入跟踪。（publicnode 支持带地址的 getLogs）
async function backfillFourMeme(chain, hours = 2) {
  const cfg = chainConfig(chain);
  const lp = cfg.launchpads?.find(
    (l) => l.type === 'fourmeme-events' && l.address && !/^0x0+$/.test(l.address),
  );
  if (!lp) return 0;
  const client = httpClient(chain);
  let latest;
  try { latest = await client.getBlockNumber(); } catch (e) { log.warn({ chain, err: e.message }, '回填取块高失败'); return 0; }
  const blocksPerHour = Math.round(3600 / getSecPerBlock(chain)); // 实测出块间隔（BSC ~0.45s/块）
  const msPerBlock = getSecPerBlock(chain) * 1000;
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
          launchTs: estimateTsFromBlock(chain, Number(l.blockNumber || 0)),
        }).catch(() => {});
        count++;
      } else if (l.eventName === 'TokenPurchase' || l.eventName === 'TokenSale') {
        // 回填期把历史买卖也喂进动量：累积买家数，使启动后首笔实时买入即可触发升级。
        // ts 用块高估算(BSC ~450ms/块)，避免历史成交在重启后 30 分钟内虚增 buys30m。
        if (!a.token) continue;
        const bn = l.blockNumber != null ? BigInt(l.blockNumber) : latest;
        const ts = nowMs - Number(latest - bn) * msPerBlock;
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

// Pons(curve-per-token) 启动回填：两遍扫描最近 ~hours 小时。
//  ① TokenLaunched(工厂,单事件) → 登记 curve↔token 映射 + onCreate(seen)，使实时曲线成交能反查归属。
//  ② CurveBuy/CurveSell(topic0 全量,无地址) → 喂动量买家(块高估算 ts)，让启动前已热的币首笔实时买入即可升级。
// getLogs 一律用 event/events 参数(viem 自动算 topic0)，绝不用原始 topics(会被静默忽略,返回全量,见 docs)。
async function backfillPonsLaunches(chain, hours = 2) {
  const cfg = chainConfig(chain);
  const lp = cfg.launchpads?.find((l) => l.type === 'curve-per-token' && l.factory && !/^0x0+$/.test(l.factory));
  if (!lp) return 0;
  const client = httpClient(chain);
  let latest;
  try { latest = await client.getBlockNumber(); } catch (e) { log.warn({ chain, err: e.message }, 'Pons 回填取块高失败'); return 0; }
  const secPerBlock = getSecPerBlock(chain); // 实测出块间隔（Robinhood ~0.1s/块），用于窗口跨度与 ts 估算
  const span = BigInt(Math.round((3600 * hours) / secPerBlock));
  const chunk = 1400n; // 官方 HTTP 段上限 + 429 规避
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tokenLaunched = ponsFactoryEvents.find((e) => e.name === 'TokenLaunched');
  const poolGraduated = ponsFactoryEvents.find((e) => e.name === 'PoolGraduated');
  const poolRegistered = ponsHookEvents.find((e) => e.name === 'PoolRegistered');
  const nowMs = Date.now();
  let from = latest > span ? latest - span : 0n;
  let launches = 0;
  while (from <= latest) {
    const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
    // ① TokenLaunched
    let llogs = null;
    for (let a = 0; a < 3 && llogs === null; a++) {
      try { llogs = await client.getLogs({ address: lp.factory, event: tokenLaunched, fromBlock: from, toBlock: to }); }
      catch (e) { if (a === 2) log.debug({ chain, err: e.message }, 'Pons 回填 TokenLaunched 分段失败'); else await sleep(600 * (a + 1)); }
    }
    for (const l of llogs || []) {
      const ar = l.args || {};
      if (!ar.token || !ar.curve) continue;
      registerPonsCurve(chain, ar.curve, ar.token);
      await onCreate({
        chain, address: ar.token, launchpad: lp.id, label: lp.label,
        creator: ar.deployer || null, name: null, symbol: null, totalSupply: null, launchTime: null,
        curve: ar.curve, quote: ar.pairToken,
        graduationThreshold: ar.graduationThreshold != null ? ar.graduationThreshold.toString() : null,
        tx: l.transactionHash, block: Number(l.blockNumber || 0),
        launchTs: estimateTsFromBlock(chain, Number(l.blockNumber || 0)),
      }).catch(() => {});
      launches++;
    }
    await sleep(400);
    // ② CurveBuy/CurveSell（topic0 全量）
    let tlogs = null;
    for (let a = 0; a < 3 && tlogs === null; a++) {
      try { tlogs = await client.getLogs({ events: ponsCurveEvents, fromBlock: from, toBlock: to }); }
      catch (e) { if (a === 2) log.debug({ chain, err: e.message }, 'Pons 回填曲线成交分段失败'); else await sleep(600 * (a + 1)); }
    }
    for (const l of tlogs || []) {
      const token = ponsTokenOf(chain, l.address);
      if (!token) continue; // 未登记的 curve（其 launch 在窗口外）→ 跳过
      const ar = l.args || {};
      const isBuy = l.eventName === 'CurveBuy';
      const quoteRaw = isBuy ? ar.quoteIn : ar.quoteOut;
      const tokenRaw = isBuy ? ar.tokensOut : ar.tokensIn;
      if (quoteRaw == null || tokenRaw == null || tokenRaw === 0n) continue;
      const bn = l.blockNumber != null ? BigInt(l.blockNumber) : latest;
      const ts = nowMs - Number(latest - bn) * secPerBlock * 1000;
      momentum.onTrade({
        token, account: isBuy ? (ar.recipient || null) : null,
        price: (quoteRaw * (10n ** 18n)) / tokenRaw, cost: quoteRaw, funds: null, offers: null,
        isBuy, ts,
      });
    }
    await sleep(400);
    // ③ PoolGraduated（停机期间的毕业回填）：命中已登记币 → markGraduated，避免毕业币卡在「曲线期、募集 $0、价格冻结」。
    // 注：launch 在窗口外的毕业币此时 store 无行，onGraduate 会自行早退；运行中币的余额归零自愈留待 M2b v4 池查找。
    let glogs = null;
    for (let a = 0; a < 3 && glogs === null; a++) {
      try { glogs = await client.getLogs({ address: lp.factory, event: poolGraduated, fromBlock: from, toBlock: to }); }
      catch (e) { if (a === 2) log.debug({ chain, err: e.message }, 'Pons 回填 PoolGraduated 分段失败'); else await sleep(600 * (a + 1)); }
    }
    for (const l of glogs || []) {
      const ar = l.args || {};
      if (!ar.token) continue;
      const bn = l.blockNumber != null ? BigInt(l.blockNumber) : latest;
      const ts = nowMs - Number(latest - bn) * secPerBlock * 1000;
      await onGraduate({ chain, address: ar.token, tx: l.transactionHash, block: Number(l.blockNumber || 0), ts }).catch(() => {});
    }
    await sleep(400);
    // ④ PoolRegistered(hook)：v4 池 poolId↔token 主源。回填停机期间的毕业池，接上 v4 定价/成交订阅。
    // 命中已登记币 → 落 v4_pools + setPool(poolId, 'v4', graduated)；未跟踪币仅存映射(onPoolRegistered 自处理)。
    if (lp.hook && !/^0x0+$/.test(lp.hook) && poolRegistered) {
      let plogs = null;
      for (let a = 0; a < 3 && plogs === null; a++) {
        try { plogs = await client.getLogs({ address: lp.hook, event: poolRegistered, fromBlock: from, toBlock: to }); }
        catch (e) { if (a === 2) log.debug({ chain, err: e.message }, 'Pons 回填 PoolRegistered 分段失败'); else await sleep(600 * (a + 1)); }
      }
      for (const l of plogs || []) {
        const ar = l.args || {};
        if (!ar.poolId || !ar.memecoin) continue;
        await onPoolRegistered({ chain, poolId: ar.poolId, token: ar.memecoin, quote: ar.quoteToken, creator: ar.creator, tx: l.transactionHash, block: Number(l.blockNumber || 0) }).catch(() => {});
      }
      await sleep(400);
    }
    from = to + 1n;
    await sleep(400);
  }
  log.info({ chain, launches, hours }, 'Pons 启动回填完成');
  return launches;
}

export function startEngine() {
  // 毕业池集合变化（新毕业 / 归档）时重建 Swap 订阅（V2/V3 + v4 各一条）。
  // 去抖 3s：Arc pool-first 首日一小时可能几百个新池，每池一次 POOLS_CHANGED；不去抖=几百次全量退订/重订。
  // 合并成每链每 3s 最多一次重建。启动时的 rebuild 走下方直接调用，不受此去抖影响。
  const rebuildTimers = new Map(); // chain -> timer
  bus.on(Events.POOLS_CHANGED, ({ chain }) => {
    clearTimeout(rebuildTimers.get(chain));
    rebuildTimers.set(chain, setTimeout(() => {
      rebuildTimers.delete(chain);
      try { rebuildSwaps(chain); } catch (e) { log.debug({ err: e.message }, 'rebuildSwaps'); }
      try { rebuildV4Swaps(chain); } catch (e) { log.debug({ err: e.message }, 'rebuildV4Swaps'); }
    }, 3000));
  });

  // Pons：从 DB 回灌 curve↔token 映射（重启后实时曲线成交才能按 emitter 反查归属）。
  try { seedPonsCurves(store.curveTokens()); } catch (e) { log.debug({ err: e.message }, 'seedPonsCurves'); }

  for (const chain of config.enabledChains) {
    try {
      watchChain(chain, {
        onCreate: (c) => onCreate(c).catch((e) => log.debug({ err: e.message }, 'onCreate')),
        onTrade: (t) => onTrade(t).catch((e) => log.debug({ err: e.message }, 'onTrade')),
        onAmm: (c) => onAmm(c).catch((e) => log.debug({ err: e.message }, 'onAmm')),
        onGraduate: (g) => onGraduate(g).catch((e) => log.debug({ err: e.message }, 'onGraduate')),
        onSweep: (s) => onSweep(s).catch((e) => log.debug({ err: e.message }, 'onSweep')),
        onPoolRegistered: (p) => onPoolRegistered(p).catch((e) => log.debug({ err: e.message }, 'onPoolRegistered')),
        onV4Initialize: (i) => onV4Initialize(i).catch((e) => log.debug({ err: e.message }, 'onV4Initialize')),
      });
      // 启动时按库中已有的毕业池建一次订阅（覆盖重启前已毕业的活跃币）
      try { rebuildSwaps(chain); } catch (e) { log.debug({ err: e.message }, 'rebuildSwaps(启动)'); }
      try { rebuildV4Swaps(chain); } catch (e) { log.debug({ err: e.message }, 'rebuildV4Swaps(启动)'); }
      log.info({ chain }, '链监听已启动');
    } catch (e) {
      log.error({ chain, err: e.message }, '链监听启动失败（检查 RPC 配置）');
    }
  }
  startTracker();
}
