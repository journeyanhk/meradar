import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(join(ROOT, 'data', 'meradar.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000'); // 等锁最多 5s，避免与在跑的服务并发写时立刻 SQLITE_BUSY

db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  key            TEXT PRIMARY KEY,
  chain          TEXT NOT NULL,
  address        TEXT NOT NULL,
  launchpad      TEXT,
  name           TEXT,
  symbol         TEXT,
  decimals       INTEGER,
  total_supply   TEXT,
  creator        TEXT,
  pool           TEXT,
  pool_type      TEXT,
  quote_symbol   TEXT,
  discovered_at  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  tier           TEXT DEFAULT 'T0',
  status         TEXT DEFAULT 'seen',    -- seen | active | archived | rejected
  graduated      INTEGER DEFAULT 0,
  reject_reason  TEXT,
  copy_of        TEXT,
  liquidity_usd  REAL DEFAULT 0,
  price_usd      REAL DEFAULT 0,
  market_cap_usd REAL DEFAULT 0,
  volume_usd     REAL DEFAULT 0,
  holders        INTEGER DEFAULT 0,
  unique_buyers  INTEGER DEFAULT 0,
  copycats       INTEGER DEFAULT 0,
  narrative_hit  TEXT,
  safety_json    TEXT,
  peak_mcap_usd  REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cand_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_cand_updated ON candidates(updated_at);
CREATE INDEX IF NOT EXISTS idx_cand_symbol ON candidates(chain, symbol);

CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  liquidity_usd REAL,
  price_usd     REAL,
  market_cap_usd REAL,
  holders       INTEGER,
  unique_buyers INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snap_key_ts ON snapshots(key, ts);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT NOT NULL,
  chain         TEXT,
  tier          TEXT,
  ts            INTEGER NOT NULL,
  reason        TEXT,
  sent_telegram INTEGER DEFAULT 0,
  sent_serverchan INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_ts ON alerts(ts);

-- 活跃币每笔成交落库：净流入/最大单笔/买卖比全变一句 SQL，且可回放校准阈值。
-- quote_amount 统一为「美元计价」，便于跨报价币(BNB/USDT)直接求和。只写 active。
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  side         TEXT NOT NULL,      -- buy | sell
  account      TEXT,
  quote_amount REAL,               -- 成交额(USD)
  token_amount REAL,               -- 代币数量(human)
  price        REAL                -- 单价(USD)
);
CREATE INDEX IF NOT EXISTS idx_trades_key_ts ON trades(key, ts);

-- 活跃币买家集合持久化：promote 时整体落库，之后增量 INSERT OR IGNORE，启动回灌。
CREATE TABLE IF NOT EXISTS buyers (
  key       TEXT NOT NULL,
  account   TEXT NOT NULL,
  first_ts  INTEGER,
  PRIMARY KEY (key, account)
);

-- 平台模板哈希自学习：TokenCreate 由 Token Manager 发出即「平台部署」证据。每个 promote 的币算一次
-- 码哈希累计频次，count≥阈值自动进白名单(写库，重启不丢)，应对 Four.meme 数天内轮换模板导致静态清单过期。
CREATE TABLE IF NOT EXISTS template_hashes (
  chain      TEXT NOT NULL,
  hash       TEXT NOT NULL,
  kind       TEXT,                 -- impl | direct
  first_seen INTEGER,
  count      INTEGER DEFAULT 0,
  PRIMARY KEY (chain, hash)
);

-- 动态报价币登记：Four.meme 现允许任意代币做曲线报价(如 SpaceX 股票代币 SPCXB)。首次遇到不认识的
-- 报价币时读链上 symbol/decimals 落库，重启后免再读；判定「已知报价币」= config.quoteTokens ∪ 本表。
CREATE TABLE IF NOT EXISTS quote_tokens (
  chain      TEXT NOT NULL,
  address    TEXT NOT NULL,
  symbol     TEXT,
  decimals   INTEGER,
  first_seen INTEGER,
  PRIMARY KEY (chain, address)
);

-- 动态报价币美元价缓存：扫 V2/V3(vs USDT/WBNB)取流动性最大的池定价，60 秒刷新，落库供重启热启。
-- priced=0 表示流动性低于下限、价格不可信 → 卡片显示「报价币 X · 无可信价格」而非全 0。
CREATE TABLE IF NOT EXISTS quote_prices (
  chain        TEXT NOT NULL,
  address      TEXT NOT NULL,
  price_usd    REAL,
  liquidity_usd REAL,
  priced       INTEGER DEFAULT 0,
  source       TEXT,
  updated_at   INTEGER,
  PRIMARY KEY (chain, address)
);

-- Pons v4 池登记：poolId↔token 映射 + 池 key 字段(定价用)。
-- 主源=Hook PoolRegistered(给 token/quote)；次源=PoolManager Initialize(补 currency0/1、fee、tickSpacing、hooks)。
-- v4 定价靠 extsload 直读 PoolManager 状态(sqrtPriceX96/liquidity)，故这里只存静态 key，不存价格。
-- 实时成交订阅按本表 pool_id 集合定向订阅 PoolManager.Swap，POOLS_CHANGED 时重建。
CREATE TABLE IF NOT EXISTS v4_pools (
  chain        TEXT NOT NULL,
  pool_id      TEXT NOT NULL,      -- bytes32 (lower)
  token        TEXT,               -- memecoin (lower)
  quote        TEXT,               -- quoteToken (lower)；0x0=原生 ETH
  currency0    TEXT,               -- v4 排序后 currency0(原生恒为 0x0)
  currency1    TEXT,
  fee          INTEGER,
  tick_spacing INTEGER,
  hooks        TEXT,
  source       TEXT,               -- registered | initialize
  block        INTEGER,
  tx           TEXT,
  created_at   INTEGER,
  PRIMARY KEY (chain, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_v4_token ON v4_pools(chain, token);

-- 买家画像（M2c）：按地址跨币沉淀，为「自建聪明钱」预留列。
-- tokens_bought_total = 该地址在库内买过的不同新币数(addBuyer 首次命中即 +1)；
-- tokens_bought_24h = 轮询时按 buyers 表 24h 窗口重算写回；tags = 最近一次分级汇总(sniper/bot/farm/fresh/flipper)。
-- early_hits/early_total/realized_pnl_usd 留给聪明钱模块，M2c 只建列不填。
CREATE TABLE IF NOT EXISTS buyer_profiles (
  chain             TEXT NOT NULL,
  account           TEXT NOT NULL,
  first_seen        INTEGER,
  last_seen         INTEGER,
  tokens_bought_24h INTEGER DEFAULT 0,
  tokens_bought_total INTEGER DEFAULT 0,
  tags              TEXT,
  nonce_at_check    INTEGER,
  nonce_checked_at  INTEGER,
  early_hits        INTEGER DEFAULT 0,
  early_total       INTEGER DEFAULT 0,
  realized_pnl_usd  REAL DEFAULT 0,
  PRIMARY KEY (chain, account)
);
-- farm 统计走 account 索引；buyers 表 first_ts 窗口过滤 + account 分组的跨币 COUNT(DISTINCT key)。
CREATE INDEX IF NOT EXISTS idx_buyers_account ON buyers(account);
CREATE INDEX IF NOT EXISTS idx_buyers_first_ts ON buyers(first_ts);

-- 建池者聚合（Arc pool-first）：每发现一个 pool-first 新币，记一次建池交易的 from(部署者)与 to(被调用合约=launcher/router)。
-- 主网首日靠 /api/health.<chain>.poolCreators24h 的 Top10 反推 Tolly/Arcpad/RadarDEX 等发射台合约地址。
CREATE TABLE IF NOT EXISTS pool_creators (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chain    TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  creator  TEXT,               -- tx.from(部署者)
  contract TEXT,               -- tx.to(被调用合约=发射台/路由)
  pool     TEXT,
  tx       TEXT
);
CREATE INDEX IF NOT EXISTS idx_poolcreators_chain_ts ON pool_creators(chain, ts);
`);

// 幂等迁移：node:sqlite 错误信息少，用 PRAGMA table_info 判断列是否存在再 ADD COLUMN，
// 不用 try/catch 吞错误。
function ensureColumns(table, cols) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [name, ddl] of cols) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumns('candidates', [
  ['depth_usd', 'depth_usd REAL DEFAULT 0'],          // 曲线期=募集额(funds×BNB)，毕业后=池储备
  ['depth_kind', "depth_kind TEXT DEFAULT 'curve'"],  // curve | amm
  ['offers_pct', 'offers_pct REAL DEFAULT 0'],        // 曲线期剩余未售供应占比
  ['launch_time', 'launch_time INTEGER'],
  ['net_in_30m', 'net_in_30m REAL DEFAULT 0'],
  ['net_in_1h', 'net_in_1h REAL DEFAULT 0'],
  ['max_buy_10m', 'max_buy_10m REAL DEFAULT 0'],
  ['buy_ratio_30m', 'buy_ratio_30m REAL DEFAULT 0'],
  ['new_buyers_30m', 'new_buyers_30m INTEGER DEFAULT 0'],
  ['max_raising', 'max_raising TEXT'],                 // 毕业阈值(报价币最小单位, raw)；曲线进度=funds/maxRaising
  ['curve_progress_pct', 'curve_progress_pct REAL DEFAULT 0'],
  ['graduated_at', 'graduated_at INTEGER'],            // 毕业(建池)时刻 ms；毕业腿强提示要求 ≤60min。老数据为 NULL
  ['curve', 'curve TEXT'],                             // Pons(curve-per-token)：该币独立曲线合约地址；募集额=curve 余额
  ['natural_buyers_30m', 'natural_buyers_30m INTEGER DEFAULT 0'], // M2c：30min 内首买且无任何标签的地址数(与 new_buyers_30m 并行，暂不入阈值)
  ['soft_flags', 'soft_flags TEXT'],                   // M2c：买家分级软标记 JSON(sniperRatio/botRatio/farmRatio/... )，只展示不门控
  // M3-1 priceOf：价格来源与最后成功更新时刻。读失败时保旧价+按 price_updated_at 判 stale，重启不丢；
  // 绝不把市值写 0(4FOUR/币安镇长两次「归零」根因)。source ∈ curve|amm-v2|amm-v3|amm-v4|external。
  ['price_source', 'price_source TEXT'],
  ['price_updated_at', 'price_updated_at INTEGER'],
  // 价格状态：ok|stale|unknown|withdrawn|implausible。implausible=合理性钳位命中(报价币单位错误)，
  // 卡片显示「数据异常·已隐藏」而非 $0，与真归零/未定价区分。
  ['price_state', 'price_state TEXT'],
  // Arc pool-first：seen 池成交订阅上限 500 的淘汰依据。按最后成交时间排序，让有量的池不被新建的空池挤出
  // (仅在 discoverFromPools 链的 onSwap 里 touch，BSC/Robinhood 不写 → 零回归)。
  ['last_trade_at', 'last_trade_at INTEGER'],
  // 可试仓 v1：每轮 evaluateEntry 的结果 JSON({ ok, tier, sizeUsd, reasons, redFlags, auditVersion })。
  // 只读展示/告警/统计，不参与分级(evaluateTier)。不写时保留上轮值；setEntry 不动 updated_at(不干扰排序/归档)。
  ['entry_json', 'entry_json TEXT'],
]);
// trades 已有 price(成交时单价 USD)=price_at_trade，无需重复列；只补 mcap_at_trade：
// 成交时市值(USD)，供聪明钱「入场市值」建模、早期队列成本、纸面 entry_mcap 直接取用，免回查快照。
ensureColumns('trades', [
  ['mcap_at_trade', 'mcap_at_trade REAL'],
  // Pons 曲线成交自带 fee/tax(报价币最小单位, raw 字符串)；Four.meme 事件无此字段 → 留空。
  // 供 M2c 买家质量分级(tax>0 视为狙击非自然买家)与 M4 纸面引擎扣税，现在先落库避免历史数据缺口。
  ['fee_raw', 'fee_raw TEXT'],
  ['tax_raw', 'tax_raw TEXT'],
  // M2c：成交所在区块。买家分级「同块 ≥3 笔=bot」需要；仅实时路径写入(回填只喂 momentum)，历史行为 NULL。
  ['block', 'block INTEGER'],
]);

const stmt = {
  upsertCandidate: db.prepare(`
    INSERT INTO candidates (key, chain, address, launchpad, name, symbol, decimals, total_supply, creator, pool, pool_type, quote_symbol, launch_time, status, discovered_at, updated_at)
    VALUES (@key, @chain, @address, @launchpad, @name, @symbol, @decimals, @total_supply, @creator, @pool, @pool_type, @quote_symbol, @launch_time, @status, @discovered_at, @updated_at)
    ON CONFLICT(key) DO NOTHING
  `),
  getCandidate: db.prepare(`SELECT * FROM candidates WHERE key = ?`),
  updateEnrich: db.prepare(`
    UPDATE candidates SET name=@name, symbol=@symbol, decimals=@decimals, total_supply=@total_supply,
      creator=@creator, updated_at=@updated_at WHERE key=@key
  `),
  setPool: db.prepare(`UPDATE candidates SET pool=@pool, pool_type=@pool_type, quote_symbol=COALESCE(quote_symbol,@quote), graduated=1, graduated_at=COALESCE(graduated_at,@updated_at), updated_at=@updated_at WHERE key=@key`),
  // 曲线期报价币信息：quote_symbol 不覆盖已有值(毕业池可能已写)，max_raising/launch_time 补空。
  setCurveInfo: db.prepare(`UPDATE candidates SET quote_symbol=COALESCE(quote_symbol,@quote_symbol), max_raising=COALESCE(@max_raising,max_raising), launch_time=COALESCE(launch_time,@launch_time), updated_at=@updated_at WHERE key=@key`),
  // Pons：登记该币曲线合约地址（募集额靠读 curve 余额）。
  setCurve: db.prepare(`UPDATE candidates SET curve=@curve, updated_at=@updated_at WHERE key=@key`),
  // Pons 毕业事件(PoolGraduated)：暂无池地址(v4 定价见 M2b)，先记毕业时刻供新鲜度/前端「已毕业」态。
  markGraduated: db.prepare(`UPDATE candidates SET graduated=1, graduated_at=COALESCE(graduated_at,@updated_at), updated_at=@updated_at WHERE key=@key`),
  // 启动回灌 curve↔token 映射（Pons 实时订阅按 emitter=curve 反查 token）。
  curveTokens: db.prepare(`SELECT key, chain, address, curve FROM candidates WHERE curve IS NOT NULL AND status != 'archived'`),
  promote: db.prepare(`UPDATE candidates SET status='active', updated_at=@updated_at WHERE key=@key AND status='seen'`),
  setCopyOf: db.prepare(`UPDATE candidates SET copy_of=@copy_of, updated_at=@updated_at WHERE key=@key`),
  updateMetrics: db.prepare(`
    UPDATE candidates SET liquidity_usd=@liquidity_usd, price_usd=@price_usd, market_cap_usd=@market_cap_usd,
      volume_usd=@volume_usd, holders=@holders, unique_buyers=@unique_buyers, copycats=@copycats,
      narrative_hit=@narrative_hit, graduated=@graduated, peak_mcap_usd=MAX(peak_mcap_usd, @market_cap_usd),
      depth_usd=@depth_usd, depth_kind=@depth_kind, offers_pct=@offers_pct,
      net_in_30m=@net_in_30m, net_in_1h=@net_in_1h, max_buy_10m=@max_buy_10m,
      buy_ratio_30m=@buy_ratio_30m, new_buyers_30m=@new_buyers_30m, curve_progress_pct=@curve_progress_pct,
      price_source=@price_source, price_updated_at=@price_updated_at, price_state=@price_state,
      updated_at=@updated_at WHERE key=@key
  `),
  updatePeak: db.prepare(`UPDATE candidates SET peak_mcap_usd=MAX(peak_mcap_usd, @mcap) WHERE key=@key`),
  setTier: db.prepare(`UPDATE candidates SET tier=@tier, updated_at=@updated_at WHERE key=@key`),
  setStatus: db.prepare(`UPDATE candidates SET status=@status, reject_reason=@reject_reason, updated_at=@updated_at WHERE key=@key`),
  setSafety: db.prepare(`UPDATE candidates SET safety_json=@safety_json, updated_at=@updated_at WHERE key=@key`),
  insertSnapshot: db.prepare(`INSERT INTO snapshots (key, ts, liquidity_usd, price_usd, market_cap_usd, holders, unique_buyers) VALUES (@key, @ts, @liquidity_usd, @price_usd, @market_cap_usd, @holders, @unique_buyers)`),
  getSnapshots: db.prepare(`SELECT ts, liquidity_usd, price_usd, market_cap_usd, holders, unique_buyers FROM snapshots WHERE key=? ORDER BY ts ASC LIMIT 500`),
  deleteOldSnapshots: db.prepare(`DELETE FROM snapshots WHERE ts < ?`),
  insertAlert: db.prepare(`INSERT INTO alerts (key, chain, tier, ts, reason, sent_telegram, sent_serverchan) VALUES (@key, @chain, @tier, @ts, @reason, @sent_telegram, @sent_serverchan)`),
  countSymbol: db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE chain=? AND symbol=? AND discovered_at >= ?`),
  countCreator: db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE chain=? AND creator=? AND discovered_at >= ?`),
  earliestSameSymbol: db.prepare(`SELECT key, discovered_at FROM candidates WHERE chain=? AND symbol=? ORDER BY discovered_at ASC LIMIT 1`),
  staleSeen: db.prepare(`SELECT key, address FROM candidates WHERE status='seen' AND discovered_at < ? LIMIT 5000`),
  deleteStaleSeen: db.prepare(`DELETE FROM candidates WHERE status='seen' AND discovered_at < ?`),
  activeCandidates: db.prepare(`SELECT * FROM candidates WHERE status='active' ORDER BY (tier='T3') DESC, (tier='T2') DESC, updated_at DESC LIMIT ?`),
  listFeed: db.prepare(`
    SELECT * FROM candidates WHERE status IN ('active','archived','rejected')
    ORDER BY (tier='T3') DESC, (tier='T2') DESC, updated_at DESC LIMIT ?
  `),
  listFeedByChain: db.prepare(`
    SELECT * FROM candidates WHERE status IN ('active','archived','rejected') AND chain = ?
    ORDER BY (tier='T3') DESC, (tier='T2') DESC, updated_at DESC LIMIT ?
  `),
  stats: db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='seen' THEN 1 ELSE 0 END) AS seen,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN tier='T1' THEN 1 ELSE 0 END) AS t1,
      SUM(CASE WHEN tier='T2' THEN 1 ELSE 0 END) AS t2,
      SUM(CASE WHEN tier='T3' THEN 1 ELSE 0 END) AS t3,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN discovered_at >= ? THEN 1 ELSE 0 END) AS last24h
    FROM candidates
  `),
  missedKills: db.prepare(`SELECT COUNT(*) AS missed FROM candidates WHERE status='rejected' AND peak_mcap_usd >= 1000000`),
  insertTrade: db.prepare(`INSERT INTO trades (key, ts, side, account, quote_amount, token_amount, price, mcap_at_trade, fee_raw, tax_raw, block) VALUES (@key, @ts, @side, @account, @quote_amount, @token_amount, @price, @mcap_at_trade, @fee_raw, @tax_raw, @block)`),
  lastTradeTs: db.prepare(`SELECT MAX(ts) AS ts FROM trades WHERE key=?`),
  deleteOldTrades: db.prepare(`DELETE FROM trades WHERE ts < ?`),
  countTrades: db.prepare(`SELECT COUNT(*) AS n FROM trades`),
  tradeFlow: db.prepare(`
    SELECT
      SUM(CASE WHEN ts>=@t30 THEN (CASE side WHEN 'buy' THEN quote_amount ELSE -quote_amount END) ELSE 0 END) AS net30,
      SUM(CASE WHEN ts>=@t1h THEN (CASE side WHEN 'buy' THEN quote_amount ELSE -quote_amount END) ELSE 0 END) AS net1h,
      MAX(CASE WHEN ts>=@t10 AND side='buy' THEN quote_amount ELSE 0 END) AS maxBuy10,
      SUM(CASE WHEN ts>=@t30 AND side='buy' THEN quote_amount ELSE 0 END) AS buy30,
      SUM(CASE WHEN ts>=@t30 AND side='sell' THEN quote_amount ELSE 0 END) AS sell30
    FROM trades WHERE key=@key AND ts>=@t1h
  `),
  newBuyers30m: db.prepare(`SELECT COUNT(*) AS n FROM buyers WHERE key=@key AND first_ts>=@since`),
  insertBuyer: db.prepare(`INSERT OR IGNORE INTO buyers (key, account, first_ts) VALUES (@key, @account, @first_ts)`),
  buyersForKey: db.prepare(`SELECT account FROM buyers WHERE key=?`),
  swapPools: db.prepare(`SELECT key, chain, address, decimals, pool, pool_type, quote_symbol FROM candidates WHERE status='active' AND pool IS NOT NULL`),
  // 某链的成交订阅池集合：默认仅 active（BSC/Robinhood）。discoverFromPools 链(Arc)额外含 seen——
  // pool-first 币登记即建池、需订阅 Swap 计买家才能升 active；按毕业时刻倒序取近 500，防订阅量失控。
  swapPoolsByChain: db.prepare(`SELECT key, chain, address, decimals, pool, pool_type, quote_symbol FROM candidates WHERE chain=? AND status='active' AND pool IS NOT NULL`),
  swapPoolsByChainInclSeen: db.prepare(`SELECT key, chain, address, decimals, pool, pool_type, quote_symbol FROM candidates WHERE chain=? AND status IN ('active','seen') AND pool IS NOT NULL ORDER BY COALESCE(last_trade_at, graduated_at, discovered_at) DESC LIMIT 500`),
  addPoolCreator: db.prepare(`INSERT INTO pool_creators (chain, ts, creator, contract, pool, tx) VALUES (@chain, @ts, @creator, @contract, @pool, @tx)`),
  touchLastTrade: db.prepare(`UPDATE candidates SET last_trade_at=? WHERE key=?`),
  poolCreatorsByCreator: db.prepare(`SELECT creator AS id, COUNT(*) AS n FROM pool_creators WHERE chain=? AND ts>=? AND creator IS NOT NULL GROUP BY creator ORDER BY n DESC LIMIT 10`),
  poolCreatorsByContract: db.prepare(`SELECT contract AS id, COUNT(*) AS n FROM pool_creators WHERE chain=? AND ts>=? AND contract IS NOT NULL GROUP BY contract ORDER BY n DESC LIMIT 10`),
  bumpTemplateHash: db.prepare(`INSERT INTO template_hashes (chain, hash, kind, first_seen, count) VALUES (@chain, @hash, @kind, @ts, 1) ON CONFLICT(chain, hash) DO UPDATE SET count = count + 1`),
  getTemplateHashCount: db.prepare(`SELECT count FROM template_hashes WHERE chain=? AND hash=?`),
  learnedTemplateHashes: db.prepare(`SELECT hash FROM template_hashes WHERE chain=? AND count>=?`),
  upsertQuoteToken: db.prepare(`INSERT INTO quote_tokens (chain, address, symbol, decimals, first_seen) VALUES (@chain, @address, @symbol, @decimals, @ts) ON CONFLICT(chain, address) DO UPDATE SET symbol=@symbol, decimals=@decimals`),
  allQuoteTokens: db.prepare(`SELECT chain, address, symbol, decimals FROM quote_tokens`),
  upsertQuotePrice: db.prepare(`INSERT INTO quote_prices (chain, address, price_usd, liquidity_usd, priced, source, updated_at) VALUES (@chain, @address, @price_usd, @liquidity_usd, @priced, @source, @updated_at) ON CONFLICT(chain, address) DO UPDATE SET price_usd=@price_usd, liquidity_usd=@liquidity_usd, priced=@priced, source=@source, updated_at=@updated_at`),
  allQuotePrices: db.prepare(`SELECT chain, address, price_usd, liquidity_usd, priced, updated_at FROM quote_prices`),
  upsertV4Pool: db.prepare(`
    INSERT INTO v4_pools (chain, pool_id, token, quote, currency0, currency1, fee, tick_spacing, hooks, source, block, tx, created_at)
    VALUES (@chain, @pool_id, @token, @quote, @currency0, @currency1, @fee, @tick_spacing, @hooks, @source, @block, @tx, @created_at)
    ON CONFLICT(chain, pool_id) DO UPDATE SET
      token=COALESCE(v4_pools.token, excluded.token),
      quote=COALESCE(v4_pools.quote, excluded.quote),
      currency0=COALESCE(excluded.currency0, v4_pools.currency0),
      currency1=COALESCE(excluded.currency1, v4_pools.currency1),
      fee=COALESCE(excluded.fee, v4_pools.fee),
      tick_spacing=COALESCE(excluded.tick_spacing, v4_pools.tick_spacing),
      hooks=COALESCE(excluded.hooks, v4_pools.hooks)
  `),
  v4PoolByToken: db.prepare(`SELECT * FROM v4_pools WHERE chain=? AND token=? ORDER BY created_at DESC LIMIT 1`),
  v4PoolById: db.prepare(`SELECT * FROM v4_pools WHERE chain=? AND pool_id=?`),
  allV4Pools: db.prepare(`SELECT * FROM v4_pools`),
  v4PoolsByChain: db.prepare(`SELECT * FROM v4_pools WHERE chain=?`),
  // M2c 买家分级
  tradesForKey: db.prepare(`SELECT ts, side, account, quote_amount, token_amount, tax_raw, block FROM trades WHERE key=@key AND account IS NOT NULL AND ts >= @since ORDER BY ts ASC`),
  // farm/tokens_24h：某链 24h 窗口内每个地址买过多少个不同新币。一次分组扫描，track 侧缓存 60s，
  // 既得 farm 集(≥N)又得每地址 tokens_bought_24h。key LIKE 'chain:%' 过滤链；first_ts>=since 限窗。
  buyerTokenCounts24h: db.prepare(`SELECT account, COUNT(DISTINCT key) AS n FROM buyers WHERE key LIKE @prefix AND first_ts >= @since GROUP BY account`),
  setBuyerFlags: db.prepare(`UPDATE candidates SET natural_buyers_30m=@natural_buyers_30m, soft_flags=@soft_flags, updated_at=@updated_at WHERE key=@key`),
  // 可试仓结果落库：不动 updated_at(避免每轮 entry 变化污染 active 排序/归档的 last-active 判定)。
  setEntry: db.prepare(`UPDATE candidates SET entry_json=@entry_json WHERE key=@key`),
  // buyer_profiles：addBuyer 首次命中某(链,地址,新币) → 累计 total + 更新 first/last_seen。
  bumpBuyerProfile: db.prepare(`
    INSERT INTO buyer_profiles (chain, account, first_seen, last_seen, tokens_bought_total)
    VALUES (@chain, @account, @ts, @ts, 1)
    ON CONFLICT(chain, account) DO UPDATE SET
      first_seen=MIN(buyer_profiles.first_seen, @ts),
      last_seen=MAX(buyer_profiles.last_seen, @ts),
      tokens_bought_total=buyer_profiles.tokens_bought_total + 1
  `),
  setBuyerTags: db.prepare(`
    INSERT INTO buyer_profiles (chain, account, first_seen, last_seen, tokens_bought_24h, tags)
    VALUES (@chain, @account, @ts, @ts, @tokens24h, @tags)
    ON CONFLICT(chain, account) DO UPDATE SET
      last_seen=MAX(buyer_profiles.last_seen, @ts),
      tokens_bought_24h=@tokens24h,
      tags=@tags
  `),
  setBuyerNonce: db.prepare(`
    INSERT INTO buyer_profiles (chain, account, first_seen, last_seen, nonce_at_check, nonce_checked_at)
    VALUES (@chain, @account, @ts, @ts, @nonce, @ts)
    ON CONFLICT(chain, account) DO UPDATE SET
      nonce_at_check=@nonce, nonce_checked_at=@ts
  `),
};

// buyerProfilesForAccounts 的 IN(...) prepared statement 按占位符个数缓存(节点 sqlite 需固定 SQL)。
const buyerProfilesInStmt = new Map();

export const store = {
  raw: db,
  addCandidate(c) { return stmt.upsertCandidate.run({ launch_time: null, ...c }).changes > 0; },
  get(key) { return stmt.getCandidate.get(key); },
  enrich(key, data) { stmt.updateEnrich.run({ key, updated_at: Date.now(), ...data }); },
  setPool(key, pool, pool_type, quote) { stmt.setPool.run({ key, pool, pool_type, quote, updated_at: Date.now() }); },
  setCurveInfo(key, { quote_symbol = null, max_raising = null, launch_time = null }) {
    stmt.setCurveInfo.run({ key, quote_symbol, max_raising, launch_time, updated_at: Date.now() });
  },
  setCurve(key, curve) { stmt.setCurve.run({ key, curve: curve ? String(curve).toLowerCase() : null, updated_at: Date.now() }); },
  markGraduated(key, at = Date.now()) { stmt.markGraduated.run({ key, updated_at: at }); },
  curveTokens() { return stmt.curveTokens.all(); },
  promote(key) { return stmt.promote.run({ key, updated_at: Date.now() }).changes > 0; },
  setCopyOf(key, copy_of) { stmt.setCopyOf.run({ key, copy_of, updated_at: Date.now() }); },
  updateMetrics(key, m) {
    stmt.updateMetrics.run({
      key, updated_at: Date.now(),
      volume_usd: 0, depth_usd: 0, depth_kind: 'curve', offers_pct: 0,
      net_in_30m: 0, net_in_1h: 0, max_buy_10m: 0, buy_ratio_30m: 0, new_buyers_30m: 0, curve_progress_pct: 0,
      price_source: null, price_updated_at: null, price_state: null,
      ...m,
    });
  },
  updatePeak(key, mcap) { stmt.updatePeak.run({ key, mcap }); },
  setTier(key, tier) { stmt.setTier.run({ key, tier, updated_at: Date.now() }); },
  setStatus(key, status, reject_reason = null) { stmt.setStatus.run({ key, status, reject_reason, updated_at: Date.now() }); },
  setSafety(key, safety) { stmt.setSafety.run({ key, safety_json: JSON.stringify(safety), updated_at: Date.now() }); },
  addSnapshot(s) { stmt.insertSnapshot.run({ ts: Date.now(), ...s }); },
  snapshots(key) { return stmt.getSnapshots.all(key); },
  purgeSnapshots(beforeMs) { return stmt.deleteOldSnapshots.run(beforeMs).changes; },
  addAlert(a) { stmt.insertAlert.run(a); },
  countSymbolSince(chain, symbol, sinceMs) { return stmt.countSymbol.get(chain, symbol, sinceMs).n; },
  countCreatorSince(chain, creator, sinceMs) { return stmt.countCreator.get(chain, creator, sinceMs).n; },
  earliestSameSymbol(chain, symbol) { return stmt.earliestSameSymbol.get(chain, symbol); },
  staleSeen(beforeMs) { return stmt.staleSeen.all(beforeMs); },
  deleteStaleSeen(beforeMs) { return stmt.deleteStaleSeen.run(beforeMs).changes; },
  activeCandidates(limit = 400) { return stmt.activeCandidates.all(limit); },
  feed(limit = 200, chain = null) {
    return chain && chain !== 'all' ? stmt.listFeedByChain.all(chain, limit) : stmt.listFeed.all(limit);
  },
  stats(since24h) { return { ...stmt.stats.get(since24h), missed: stmt.missedKills.get().missed }; },
  addTrade(t) { stmt.insertTrade.run({ account: null, quote_amount: 0, token_amount: 0, price: 0, mcap_at_trade: null, fee_raw: null, tax_raw: null, block: null, ...t }); },
  lastTradeTs(key) { return stmt.lastTradeTs.get(key)?.ts ?? null; },
  purgeTrades(beforeMs) { return stmt.deleteOldTrades.run(beforeMs).changes; },
  tradeCount() { return stmt.countTrades.get().n; },
  tradeFlow(key, now = Date.now()) {
    const r = stmt.tradeFlow.get({ key, t30: now - 30 * 60_000, t1h: now - 3600_000, t10: now - 10 * 60_000 });
    const buy30 = r.buy30 || 0, sell30 = r.sell30 || 0;
    const newBuyers = stmt.newBuyers30m.get({ key, since: now - 30 * 60_000 }).n;
    return {
      net30: r.net30 || 0, net1h: r.net1h || 0, maxBuy10: r.maxBuy10 || 0,
      buyRatio30: sell30 > 0 ? buy30 / sell30 : (buy30 > 0 ? 999 : 0),
      newBuyers30m: newBuyers,
    };
  },
  addBuyer(key, account, first_ts) {
    const acc = account.toLowerCase();
    const changes = stmt.insertBuyer.run({ key, account: acc, first_ts }).changes;
    // 首次为该地址记录「买过这个新币」→ buyer_profiles 累计 tokens_bought_total(distinct 币数)。
    // first_ts=0 的存量买家(promote 快照)也计入，但用当下时间戳更新 last_seen/first_seen 更稳妥。
    if (changes > 0) {
      const chain = key.split(':')[0];
      stmt.bumpBuyerProfile.run({ chain, account: acc, ts: first_ts || Date.now() });
    }
    return changes;
  },
  // M2c 买家分级：读该币全部有主成交、farm 地址集、写回自然买家/软标记、沉淀画像。
  tradesForKey(key, sinceMs = 0) { return stmt.tradesForKey.all({ key, since: sinceMs }); },
  buyerTokenCounts24h(chain, sinceMs) {
    const m = new Map();
    for (const r of stmt.buyerTokenCounts24h.all({ prefix: `${chain}:%`, since: sinceMs })) m.set(r.account, r.n);
    return m;
  },
  setBuyerFlags(key, naturalBuyers30m, softFlags) {
    stmt.setBuyerFlags.run({ key, natural_buyers_30m: naturalBuyers30m | 0, soft_flags: softFlags ? JSON.stringify(softFlags) : null, updated_at: Date.now() });
  },
  setEntry(key, entry) {
    stmt.setEntry.run({ key, entry_json: entry ? JSON.stringify(entry) : null });
  },
  setBuyerTags(chain, account, tags, tokens24h, ts = Date.now()) {
    stmt.setBuyerTags.run({ chain, account: account.toLowerCase(), tags: tags && tags.length ? tags.join(',') : null, tokens24h: tokens24h | 0, ts });
  },
  setBuyerNonce(chain, account, nonce, ts = Date.now()) {
    stmt.setBuyerNonce.run({ chain, account: account.toLowerCase(), nonce: nonce | 0, ts });
  },
  // 批量取一组地址的画像(tags/nonce)，一次查询替代逐地址点查(避免每轮每候选 N+1)。分片规避 SQL 变量上限；
  // 按占位符个数缓存 prepared statement，避免每轮 re-prepare。
  buyerProfilesForAccounts(chain, accounts) {
    const m = new Map();
    if (!accounts?.length) return m;
    const CH = 400;
    for (let i = 0; i < accounts.length; i += CH) {
      const chunk = accounts.slice(i, i + CH).map((a) => a.toLowerCase());
      let ps = buyerProfilesInStmt.get(chunk.length);
      if (!ps) {
        ps = db.prepare(`SELECT account, tags, nonce_at_check, nonce_checked_at FROM buyer_profiles WHERE chain=? AND account IN (${chunk.map(() => '?').join(',')})`);
        buyerProfilesInStmt.set(chunk.length, ps);
      }
      for (const r of ps.all(chain, ...chunk)) m.set(r.account, r);
    }
    return m;
  },
  buyers(key) { return stmt.buyersForKey.all(key).map((r) => r.account); },
  swapPools() { return stmt.swapPools.all(); },
  // 某链的成交订阅池：discoverFromPools 链含 seen(pool-first)，否则仅 active。
  swapPoolsFor(chain, inclSeen = false) {
    return inclSeen ? stmt.swapPoolsByChainInclSeen.all(chain) : stmt.swapPoolsByChain.all(chain);
  },
  addPoolCreator({ chain, ts = Date.now(), creator = null, contract = null, pool = null, tx = null }) {
    stmt.addPoolCreator.run({ chain, ts, creator, contract, pool, tx });
  },
  // pool-first seen 池成交时刷新最后成交时刻，供 swapPoolsByChainInclSeen 淘汰排序(有量的池不被空池挤出)。
  touchLastTrade(key, ts) { stmt.touchLastTrade.run(ts, key); },
  poolCreators24h(chain, since) {
    return { byCreator: stmt.poolCreatorsByCreator.all(chain, since), byContract: stmt.poolCreatorsByContract.all(chain, since) };
  },
  // 模板哈希自学习：累计频次并返回最新 count；查已达阈值的哈希（供 template.js 白名单合并）。
  bumpTemplateHash(chain, hash, kind) {
    const h = String(hash).toLowerCase();
    stmt.bumpTemplateHash.run({ chain, hash: h, kind, ts: Date.now() });
    return stmt.getTemplateHashCount.get(chain, h)?.count ?? 0;
  },
  learnedTemplateHashes(chain, minCount) { return stmt.learnedTemplateHashes.all(chain, minCount).map((r) => r.hash); },
  // 动态报价币登记 + 美元价缓存（quotePrice.js 用）。
  registerQuoteToken(chain, address, symbol, decimals) {
    stmt.upsertQuoteToken.run({ chain, address: String(address).toLowerCase(), symbol, decimals, ts: Date.now() });
  },
  quoteTokens() { return stmt.allQuoteTokens.all(); },
  setQuotePrice(p) { stmt.upsertQuotePrice.run({ source: null, updated_at: Date.now(), ...p, address: String(p.address).toLowerCase() }); },
  quotePrices() { return stmt.allQuotePrices.all(); },
  // Pons v4 池：登记/查映射(poolId↔token) + 池 key(定价/订阅用)。地址统一小写。
  upsertV4Pool(p) {
    const lc = (v) => (v ? String(v).toLowerCase() : null);
    stmt.upsertV4Pool.run({
      chain: p.chain,
      pool_id: lc(p.pool_id),
      token: lc(p.token),
      quote: lc(p.quote),
      currency0: lc(p.currency0),
      currency1: lc(p.currency1),
      fee: p.fee ?? null,
      tick_spacing: p.tick_spacing ?? null,
      hooks: lc(p.hooks),
      source: p.source ?? null,
      block: p.block ?? null,
      tx: lc(p.tx),
      created_at: p.created_at ?? Date.now(),
    });
  },
  v4PoolByToken(chain, token) { return stmt.v4PoolByToken.get(chain, String(token).toLowerCase()); },
  v4PoolById(chain, poolId) { return stmt.v4PoolById.get(chain, String(poolId).toLowerCase()); },
  v4Pools(chain) { return chain ? stmt.v4PoolsByChain.all(chain) : stmt.allV4Pools.all(); },
};
