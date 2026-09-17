import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(join(ROOT, 'data', 'meradar.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000'); // 等锁最多 5s，避免与在跑的服务并发写时立刻 SQLITE_BUSY
db.exec('PRAGMA synchronous = NORMAL'); // WAL 下 NORMAL 安全且比默认 FULL 少一次 fsync/写
db.exec('PRAGMA temp_store = MEMORY');  // 临时表/排序走内存，减少磁盘抖动
db.exec('PRAGMA cache_size = -65536');  // 64MB 页缓存(负值=KB)
// 增量回收：新库在建表前设置即生效；老库为 no-op，需一次性 `VACUUM` 后才切换(见 maintenance.js 注释)。
db.exec('PRAGMA auto_vacuum = INCREMENTAL');

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
CREATE INDEX IF NOT EXISTS idx_cand_chain_status_updated ON candidates(chain, status, updated_at);

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
CREATE INDEX IF NOT EXISTS idx_v4_created ON v4_pools(created_at);

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

-- M4 纸面引擎（只读模拟）：每个候选在信号点用名义 $100 模拟买入、追踪 24h 回报。
-- 四个分组(非互斥)：baseline_seen(所有活跃候选=对照)/tier_t1/tier_t2/entry_pass，UNIQUE(key,grp) 保证每组每币至多一仓。
-- 不持有自己的 RPC：开仓价取该轮 metrics.priceUsd，后续 mark 取候选行 price_usd(归档后冻结=诚实标记)。
-- status: open(持仓中) | closed(到期平仓) | deferred(信号点门槛未过、延期重试) | deferred_expired(延期到期仍不可开) | skipped(费率≥上限不开)。
-- 往返成本(roundtrip_cost_pct)开仓时固化，每次 mark 的 pnl 都是「此刻退出」的净值(已扣往返)。
CREATE TABLE IF NOT EXISTS paper_positions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  key                TEXT NOT NULL,
  chain              TEXT NOT NULL,
  grp                TEXT NOT NULL,     -- baseline_seen | tier_t1 | tier_t2 | entry_pass
  status             TEXT NOT NULL,     -- open | closed | deferred | deferred_expired | skipped
  signal_ts          INTEGER NOT NULL,  -- 首次进入该组的时刻(信号点)
  open_ts            INTEGER,           -- 实际开仓时刻(门槛通过时)
  entry_price_usd    REAL,
  entry_mcap_usd     REAL,
  notional_usd       REAL,
  roundtrip_cost_pct REAL,
  horizon_end_ts     INTEGER,           -- open_ts + horizonHours
  defer_until_ts     INTEGER,           -- 延期截止(deferMinutes)
  close_ts           INTEGER,
  close_price_usd    REAL,
  close_mcap_usd     REAL,
  close_reason       TEXT,              -- horizon | ...
  pnl_usd            REAL,
  pnl_pct            REAL,
  peak_price_usd     REAL,
  trough_price_usd   REAL,
  last_price_usd     REAL,
  last_mcap_usd      REAL,
  last_mark_ts       INTEGER,
  skip_reason        TEXT,
  UNIQUE(key, grp)
);
CREATE INDEX IF NOT EXISTS idx_paper_pos_status ON paper_positions(status);
CREATE INDEX IF NOT EXISTS idx_paper_pos_grp ON paper_positions(grp, status);

-- 纸面标记序列：每次 mark(60s 循环 + 事件即时)落一行，供回报曲线/回撤复盘。position_id→paper_positions.id。
-- price_state 记标记时的价格状态(ok/stale/unknown/withdrawn)，分析时可剔除非 ok 标记。
CREATE TABLE IF NOT EXISTS paper_marks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  price_usd   REAL,
  mcap_usd    REAL,
  pnl_usd     REAL,
  pnl_pct     REAL,
  price_state TEXT
);
CREATE INDEX IF NOT EXISTS idx_paper_marks_pos ON paper_marks(position_id, ts);
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
  ['pool_fee_pct', 'pool_fee_pct REAL'],               // v4 池动态费率(%)：90.1% 等反狙击高费率池 → 可试仓硬拒 + 卡片显示
  // Arc 发射台(arc-launchpad)元数据：token_uri=项目图/元数据链接；locker=LP 锁仓合约(存在=「LP 已锁」)；
  // hook=该币 v4 hook(EIP1167 代理，自学习信任层)；fee_schedule=FeeConfig 原始 8 值 JSON(仅展示，实际费率仍取 Swap.fee)。
  ['token_uri', 'token_uri TEXT'],
  ['locker', 'locker TEXT'],
  ['hook', 'hook TEXT'],
  ['fee_schedule', 'fee_schedule TEXT'],
]);
// v4_pools 补列：max_liquidity_seen=历次读到的最大 activeLiquidity(bigint 存 TEXT)。
// 撤池判定改为「曾有流动性(从有到无)」而非「tickSpacing≥200 且当前 tick 为 0」——后者在 Arc 单边发射池上必然误判
// (代币全挂在当前价之上、USDC 侧为 0，第一笔买入前当前 tick 无流动性是设计如此，不是 rug)。重启不丢「曾有」证据。
ensureColumns('v4_pools', [
  ['max_liquidity_seen', 'max_liquidity_seen TEXT'],
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
  // 成交幂等键(方案0-1)：chain + 事件坐标(txHash:logIndex)。双订阅/回填重叠/重启重放导致同一 Swap 二次入库时，
  // 靠 uq_trades_evt 去重(INSERT OR IGNORE)，防放量/净流入/买卖比虚高。历史行三列为 NULL(SQLite 视 NULL 互不相等，不阻塞)。
  ['chain', 'chain TEXT'],
  ['tx_hash', 'tx_hash TEXT'],
  ['log_index', 'log_index INTEGER'],
]);
// 成交事件唯一索引：同一(链, txHash, logIndex)只允许一行。NULL 互不相等 → 历史 NULL 行不冲突，迁移不失败。
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_trades_evt ON trades(chain, tx_hash, log_index)');
// M4 纸面标记：老库补 price_state 列(标记时价格状态，分析剔除非 ok 标记)。
ensureColumns('paper_marks', [
  ['price_state', 'price_state TEXT'],
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
  // Arc 发射台：补创建者(不覆盖已有)；补元数据(token_uri/locker/hook/fee_schedule，均只填空、不覆盖)。
  setCreatorIfEmpty: db.prepare(`UPDATE candidates SET creator=COALESCE(creator,@creator), updated_at=@updated_at WHERE key=@key`),
  setArcMeta: db.prepare(`UPDATE candidates SET token_uri=COALESCE(token_uri,@token_uri), locker=COALESCE(locker,@locker), hook=COALESCE(hook,@hook), fee_schedule=COALESCE(fee_schedule,@fee_schedule), updated_at=@updated_at WHERE key=@key`),
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
      pool_fee_pct=@pool_fee_pct,
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
  staleSeenChain: db.prepare(`SELECT key, address FROM candidates WHERE chain=? AND status='seen' AND discovered_at < ? LIMIT 5000`),
  deleteStaleSeenChain: db.prepare(`DELETE FROM candidates WHERE chain=? AND status='seen' AND discovered_at < ?`),
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
  // 分链统计(方案0-5)：同口径但按链过滤，供 /api/stats?chain= 与前端「本链 N 个候选等待准入」。
  statsByChain: db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='seen' THEN 1 ELSE 0 END) AS seen,
      SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN tier='T1' THEN 1 ELSE 0 END) AS t1,
      SUM(CASE WHEN tier='T2' THEN 1 ELSE 0 END) AS t2,
      SUM(CASE WHEN tier='T3' THEN 1 ELSE 0 END) AS t3,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN discovered_at >= @since THEN 1 ELSE 0 END) AS last24h
    FROM candidates WHERE chain = @chain
  `),
  missedKills: db.prepare(`SELECT COUNT(*) AS missed FROM candidates WHERE status='rejected' AND peak_mcap_usd >= 1000000`),
  missedKillsByChain: db.prepare(`SELECT COUNT(*) AS missed FROM candidates WHERE chain=? AND status='rejected' AND peak_mcap_usd >= 1000000`),
  insertTrade: db.prepare(`INSERT OR IGNORE INTO trades (key, chain, ts, side, account, quote_amount, token_amount, price, mcap_at_trade, fee_raw, tax_raw, block, tx_hash, log_index) VALUES (@key, @chain, @ts, @side, @account, @quote_amount, @token_amount, @price, @mcap_at_trade, @fee_raw, @tax_raw, @block, @tx_hash, @log_index)`),
  lastTradeTs: db.prepare(`SELECT MAX(ts) AS ts FROM trades WHERE key=?`),
  deleteOldTrades: db.prepare(`DELETE FROM trades WHERE ts < ?`),
  deleteOldTradesBatch: db.prepare(`DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE ts < ? LIMIT ?)`),
  // 维护清理(maintenance.js 每日调用)：
  // buyers 不能按 first_ts 删——promote 快照买家 first_ts=0(见 engine.js)，时间截断会误删活跃币买家。
  // 改按候选生命周期：孤儿(候选已删)或 归档/拒绝且 updated_at 超期 的 key 才删；active 候选的买家永不删。
  deleteOldBuyers: db.prepare(`
    DELETE FROM buyers WHERE rowid IN (
      SELECT b.rowid FROM buyers b
      LEFT JOIN candidates c ON c.key = b.key
      WHERE c.key IS NULL
         OR (c.status IN ('archived','rejected') AND c.updated_at < ?)
      LIMIT ?
    )`),
  deleteOrphanV4Pools: db.prepare(`
    DELETE FROM v4_pools WHERE rowid IN (
      SELECT v.rowid FROM v4_pools v
      WHERE v.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM candidates c
          WHERE c.chain = v.chain AND LOWER(c.address) = v.token AND c.status IN ('active','archived')
        )
      LIMIT ?
    )`),
  deleteOldPoolCreators: db.prepare(`DELETE FROM pool_creators WHERE rowid IN (SELECT rowid FROM pool_creators WHERE ts < ? LIMIT ?)`),
  // 建币者历史(供评分维度6)：从 candidates 按 creator 聚合——总发币数、疑似 rug 数(rejected 或 撤池)、近 N 天数。
  creatorStats: db.prepare(`
    SELECT COUNT(*) AS launches,
      SUM(CASE WHEN status='rejected' OR price_state='withdrawn' THEN 1 ELSE 0 END) AS rugged,
      SUM(CASE WHEN discovered_at >= @since THEN 1 ELSE 0 END) AS recent
    FROM candidates WHERE chain=@chain AND creator=@creator`),
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
  // 全量订阅模式(Arc)：单一 PoolManager 监听，meta 仅是 poolId→币 映射，不再是订阅分片，
  // 故无需 LIMIT——但按 seenCleanupHours 时间窗剔除陈旧池，避免 Map 无界增长。仅取 v4。
  swapPoolsByChainAll: db.prepare(`SELECT key, chain, address, decimals, pool, pool_type, quote_symbol FROM candidates WHERE chain=? AND status IN ('active','seen') AND pool IS NOT NULL AND pool_type='v4' AND COALESCE(last_trade_at, graduated_at, discovered_at) >= ?`),
  addPoolCreator: db.prepare(`INSERT INTO pool_creators (chain, ts, creator, contract, pool, tx) VALUES (@chain, @ts, @creator, @contract, @pool, @tx)`),
  touchLastTrade: db.prepare(`UPDATE candidates SET last_trade_at=? WHERE key=?`),
  poolCreatorsByCreator: db.prepare(`SELECT creator AS id, COUNT(*) AS n FROM pool_creators WHERE chain=? AND ts>=? AND creator IS NOT NULL GROUP BY creator ORDER BY n DESC LIMIT 10`),
  poolCreatorsByContract: db.prepare(`SELECT contract AS id, COUNT(*) AS n FROM pool_creators WHERE chain=? AND ts>=? AND contract IS NOT NULL GROUP BY contract ORDER BY n DESC LIMIT 10`),
  bumpTemplateHash: db.prepare(`INSERT INTO template_hashes (chain, hash, kind, first_seen, count) VALUES (@chain, @hash, @kind, @ts, 1) ON CONFLICT(chain, hash) DO UPDATE SET count = count + 1`),
  getTemplateHashCount: db.prepare(`SELECT count FROM template_hashes WHERE chain=? AND hash=?`),
  learnedTemplateHashes: db.prepare(`SELECT hash FROM template_hashes WHERE chain=? AND count>=?`),
  learnedTemplateHashesByKind: db.prepare(`SELECT hash FROM template_hashes WHERE chain=? AND kind=? AND count>=?`),
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
  setV4MaxLiquidity: db.prepare(`UPDATE v4_pools SET max_liquidity_seen=? WHERE chain=? AND pool_id=?`),
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
  // M4 纸面引擎
  paperPositionByKeyGrp: db.prepare(`SELECT * FROM paper_positions WHERE key=? AND grp=?`),
  paperPositionsByKey: db.prepare(`SELECT * FROM paper_positions WHERE key=?`),
  paperActivePositions: db.prepare(`SELECT * FROM paper_positions WHERE status IN ('open','deferred')`),
  paperInsertPosition: db.prepare(`
    INSERT OR IGNORE INTO paper_positions
      (key, chain, grp, status, signal_ts, open_ts, entry_price_usd, entry_mcap_usd, notional_usd, roundtrip_cost_pct, horizon_end_ts, defer_until_ts, peak_price_usd, trough_price_usd, last_price_usd, last_mcap_usd, last_mark_ts, skip_reason)
    VALUES (@key, @chain, @grp, @status, @signal_ts, @open_ts, @entry_price_usd, @entry_mcap_usd, @notional_usd, @roundtrip_cost_pct, @horizon_end_ts, @defer_until_ts, @peak_price_usd, @trough_price_usd, @last_price_usd, @last_mcap_usd, @last_mark_ts, @skip_reason)
  `),
  paperOpenDeferred: db.prepare(`
    UPDATE paper_positions SET status='open', open_ts=@open_ts, entry_price_usd=@entry_price_usd, entry_mcap_usd=@entry_mcap_usd,
      roundtrip_cost_pct=@roundtrip_cost_pct, horizon_end_ts=@horizon_end_ts,
      peak_price_usd=@peak_price_usd, trough_price_usd=@trough_price_usd,
      last_price_usd=@last_price_usd, last_mcap_usd=@last_mcap_usd, last_mark_ts=@last_mark_ts
    WHERE id=@id AND status='deferred'
  `),
  paperMarkSkipped: db.prepare(`UPDATE paper_positions SET status='skipped', skip_reason=@skip_reason WHERE id=@id AND status='deferred'`),
  paperExpireDeferred: db.prepare(`UPDATE paper_positions SET status='deferred_expired', close_ts=@now WHERE id=@id AND status='deferred'`),
  paperUpdateMark: db.prepare(`
    UPDATE paper_positions SET last_price_usd=@last_price_usd, last_mcap_usd=@last_mcap_usd, last_mark_ts=@last_mark_ts,
      peak_price_usd=@peak_price_usd, trough_price_usd=@trough_price_usd WHERE id=@id
  `),
  // 只更新峰谷/last(不动 last_mark_ts)：标记去重时用——记录价格轨迹但不落 marks 行。
  paperUpdatePeak: db.prepare(`
    UPDATE paper_positions SET last_price_usd=@last_price_usd, last_mcap_usd=@last_mcap_usd,
      peak_price_usd=@peak_price_usd, trough_price_usd=@trough_price_usd WHERE id=@id
  `),
  paperClosePosition: db.prepare(`
    UPDATE paper_positions SET status='closed', close_ts=@close_ts, close_price_usd=@close_price_usd, close_mcap_usd=@close_mcap_usd,
      close_reason=@close_reason, pnl_usd=@pnl_usd, pnl_pct=@pnl_pct,
      peak_price_usd=@peak_price_usd, trough_price_usd=@trough_price_usd WHERE id=@id AND status='open'
  `),
  paperInsertMark: db.prepare(`INSERT INTO paper_marks (position_id, ts, price_usd, mcap_usd, pnl_usd, pnl_pct, price_state) VALUES (@position_id, @ts, @price_usd, @mcap_usd, @pnl_usd, @pnl_pct, @price_state)`),
  paperStatusCounts: db.prepare(`SELECT grp, status, COUNT(*) AS n FROM paper_positions GROUP BY grp, status`),
  paperStatusCountsByChain: db.prepare(`SELECT grp, status, COUNT(*) AS n FROM paper_positions WHERE chain=? GROUP BY grp, status`),
  // 已平仓明细(含峰谷/入场/平仓原因)：供 pnl 分位 + MFE/MAE/2× 命中 + rug 率统计。
  paperClosedPnls: db.prepare(`SELECT pnl_pct, (close_ts - open_ts) AS hold_ms, entry_price_usd, peak_price_usd, trough_price_usd, close_reason FROM paper_positions WHERE grp=? AND status='closed'`),
  paperClosedPnlsByChain: db.prepare(`SELECT pnl_pct, (close_ts - open_ts) AS hold_ms, entry_price_usd, peak_price_usd, trough_price_usd, close_reason FROM paper_positions WHERE grp=? AND chain=? AND status='closed'`),
  // 已平仓>N 天的仓位其 marks 清理(仓位行永久保留，只删明细行控 DB 体积)。open/deferred 的 marks 绝不删。
  paperDeleteClosedMarks: db.prepare(`DELETE FROM paper_marks WHERE position_id IN (SELECT id FROM paper_positions WHERE status='closed' AND close_ts < ?)`),
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
  setCreatorIfEmpty(key, creator) { stmt.setCreatorIfEmpty.run({ key, creator: creator ? String(creator).toLowerCase() : null, updated_at: Date.now() }); },
  setArcMeta(key, { token_uri = null, locker = null, hook = null, fee_schedule = null } = {}) {
    stmt.setArcMeta.run({
      key,
      token_uri: token_uri || null,
      locker: locker ? String(locker).toLowerCase() : null,
      hook: hook ? String(hook).toLowerCase() : null,
      fee_schedule: fee_schedule ? (typeof fee_schedule === 'string' ? fee_schedule : JSON.stringify(fee_schedule)) : null,
      updated_at: Date.now(),
    });
  },
  markGraduated(key, at = Date.now()) { stmt.markGraduated.run({ key, updated_at: at }); },
  curveTokens() { return stmt.curveTokens.all(); },
  promote(key) { return stmt.promote.run({ key, updated_at: Date.now() }).changes > 0; },
  setCopyOf(key, copy_of) { stmt.setCopyOf.run({ key, copy_of, updated_at: Date.now() }); },
  updateMetrics(key, m) {
    stmt.updateMetrics.run({
      key, updated_at: Date.now(),
      volume_usd: 0, depth_usd: 0, depth_kind: 'curve', offers_pct: 0,
      net_in_30m: 0, net_in_1h: 0, max_buy_10m: 0, buy_ratio_30m: 0, new_buyers_30m: 0, curve_progress_pct: 0,
      pool_fee_pct: null,
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
  staleSeenChain(chain, beforeMs) { return stmt.staleSeenChain.all(chain, beforeMs); },
  deleteStaleSeenChain(chain, beforeMs) { return stmt.deleteStaleSeenChain.run(chain, beforeMs).changes; },
  activeCandidates(limit = 400) { return stmt.activeCandidates.all(limit); },
  feed(limit = 200, chain = null) {
    return chain && chain !== 'all' ? stmt.listFeedByChain.all(chain, limit) : stmt.listFeed.all(limit);
  },
  stats(since24h, chain = null) {
    if (chain && chain !== 'all') {
      return { ...stmt.statsByChain.get({ since: since24h, chain }), missed: stmt.missedKillsByChain.get(chain).missed };
    }
    return { ...stmt.stats.get(since24h), missed: stmt.missedKills.get().missed };
  },
  // 返回 true=真正新增(changes>0)，false=被幂等键拦截(重复事件)。调用方据此决定是否更新内存聚合。
  addTrade(t) { return stmt.insertTrade.run({ account: null, quote_amount: 0, token_amount: 0, price: 0, mcap_at_trade: null, fee_raw: null, tax_raw: null, block: null, chain: null, tx_hash: null, log_index: null, ...t }).changes > 0; },
  lastTradeTs(key) { return stmt.lastTradeTs.get(key)?.ts ?? null; },
  purgeTrades(beforeMs) { return stmt.deleteOldTrades.run(beforeMs).changes; },
  purgeTradesBatch(beforeMs, limit = 5000) { return stmt.deleteOldTradesBatch.run(beforeMs, limit).changes; },
  // 维护清理：分批删除，返回本批删除行数(调用方循环到 0 为止)。
  purgeBuyers(beforeMs, limit = 5000) { return stmt.deleteOldBuyers.run(beforeMs, limit).changes; },
  purgeOrphanV4Pools(beforeMs, limit = 5000) { return stmt.deleteOrphanV4Pools.run(beforeMs, limit).changes; },
  purgePoolCreators(beforeMs, limit = 5000) { return stmt.deleteOldPoolCreators.run(beforeMs, limit).changes; },
  creatorStats(chain, creator, sinceMs) {
    if (!creator) return { launches: 0, rugged: 0, recent: 0 };
    const r = stmt.creatorStats.get({ chain, creator, since: sinceMs });
    return { launches: r.launches || 0, rugged: r.rugged || 0, recent: r.recent || 0 };
  },
  // 维护 PRAGMA：checkpoint 截断 WAL、增量回收空闲页、更新查询统计。db 私有于本模块，故经 store 暴露。
  walCheckpoint() { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); },
  incrementalVacuum(pages = 4000) { db.exec(`PRAGMA incremental_vacuum(${pages})`); },
  analyze() { db.exec('ANALYZE'); },
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
  // 全量订阅模式：取时间窗内所有 v4 池(无 LIMIT)，sinceTs = now - seenCleanupHours。
  swapPoolsForFull(chain, sinceTs) { return stmt.swapPoolsByChainAll.all(chain, sinceTs); },
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
  learnedTemplateHashesByKind(chain, kind, minCount) { return stmt.learnedTemplateHashesByKind.all(chain, kind, minCount).map((r) => r.hash); },
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
  // 记录该池历史最大 activeLiquidity(单调递增)。撤池判定的「曾有流动性」证据来源，重启不丢。
  // liq 为 bigint；仅在更大时写库(避免每轮无谓 UPDATE)。
  bumpV4MaxLiquidity(chain, poolId, liq) {
    if (liq == null || liq <= 0n) return;
    const id = String(poolId).toLowerCase();
    const row = stmt.v4PoolById.get(chain, id);
    if (!row) return;
    const cur = row.max_liquidity_seen ? BigInt(row.max_liquidity_seen) : 0n;
    if (liq > cur) stmt.setV4MaxLiquidity.run(liq.toString(), chain, id);
  },
  v4Pools(chain) { return chain ? stmt.v4PoolsByChain.all(chain) : stmt.allV4Pools.all(); },
  // —— M4 纸面引擎 ——
  paperPosition(key, grp) { return stmt.paperPositionByKeyGrp.get(key, grp); },
  paperPositionsForKey(key) { return stmt.paperPositionsByKey.all(key); },
  paperActivePositions() { return stmt.paperActivePositions.all(); },
  // 开/延期/跳过一仓：INSERT OR IGNORE + UNIQUE(key,grp) 保证幂等(并发/重放不会重复开仓)。返回 true=真正新增。
  paperInsertPosition(p) {
    return stmt.paperInsertPosition.run({
      open_ts: null, entry_price_usd: null, entry_mcap_usd: null, roundtrip_cost_pct: null,
      horizon_end_ts: null, defer_until_ts: null, peak_price_usd: null, trough_price_usd: null,
      last_price_usd: null, last_mcap_usd: null, last_mark_ts: null, skip_reason: null,
      ...p,
    }).changes > 0;
  },
  paperOpenDeferred(id, f) { return stmt.paperOpenDeferred.run({ id, ...f }).changes > 0; },
  paperMarkSkipped(id, skip_reason) { stmt.paperMarkSkipped.run({ id, skip_reason }); },
  paperExpireDeferred(id, now) { stmt.paperExpireDeferred.run({ id, now }); },
  paperUpdateMark(id, f) { stmt.paperUpdateMark.run({ id, ...f }); },
  paperUpdatePeak(id, f) { stmt.paperUpdatePeak.run({ id, ...f }); },
  paperClose(id, f) { return stmt.paperClosePosition.run({ id, ...f }).changes > 0; },
  paperAddMark(m) { stmt.paperInsertMark.run({ price_state: null, ...m }); },
  paperStatusCounts(chain = null) { return chain ? stmt.paperStatusCountsByChain.all(chain) : stmt.paperStatusCounts.all(); },
  paperClosedPnls(grp, chain = null) { return chain ? stmt.paperClosedPnlsByChain.all(grp, chain) : stmt.paperClosedPnls.all(grp); },
  // 已平仓>beforeMs 的仓位其 marks 清理(仓位行永久保留)。
  purgePaperMarks(beforeMs) { return stmt.paperDeleteClosedMarks.run(beforeMs).changes; },
};
