import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new DatabaseSync(join(ROOT, 'data', 'meradar.sqlite'));
db.exec('PRAGMA journal_mode = WAL');

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
]);
// trades 已有 price(成交时单价 USD)=price_at_trade，无需重复列；只补 mcap_at_trade：
// 成交时市值(USD)，供聪明钱「入场市值」建模、早期队列成本、纸面 entry_mcap 直接取用，免回查快照。
ensureColumns('trades', [
  ['mcap_at_trade', 'mcap_at_trade REAL'],
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
  promote: db.prepare(`UPDATE candidates SET status='active', updated_at=@updated_at WHERE key=@key AND status='seen'`),
  setCopyOf: db.prepare(`UPDATE candidates SET copy_of=@copy_of, updated_at=@updated_at WHERE key=@key`),
  updateMetrics: db.prepare(`
    UPDATE candidates SET liquidity_usd=@liquidity_usd, price_usd=@price_usd, market_cap_usd=@market_cap_usd,
      volume_usd=@volume_usd, holders=@holders, unique_buyers=@unique_buyers, copycats=@copycats,
      narrative_hit=@narrative_hit, graduated=@graduated, peak_mcap_usd=MAX(peak_mcap_usd, @market_cap_usd),
      depth_usd=@depth_usd, depth_kind=@depth_kind, offers_pct=@offers_pct,
      net_in_30m=@net_in_30m, net_in_1h=@net_in_1h, max_buy_10m=@max_buy_10m,
      buy_ratio_30m=@buy_ratio_30m, new_buyers_30m=@new_buyers_30m, curve_progress_pct=@curve_progress_pct,
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
  insertTrade: db.prepare(`INSERT INTO trades (key, ts, side, account, quote_amount, token_amount, price, mcap_at_trade) VALUES (@key, @ts, @side, @account, @quote_amount, @token_amount, @price, @mcap_at_trade)`),
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
  bumpTemplateHash: db.prepare(`INSERT INTO template_hashes (chain, hash, kind, first_seen, count) VALUES (@chain, @hash, @kind, @ts, 1) ON CONFLICT(chain, hash) DO UPDATE SET count = count + 1`),
  getTemplateHashCount: db.prepare(`SELECT count FROM template_hashes WHERE chain=? AND hash=?`),
  learnedTemplateHashes: db.prepare(`SELECT hash FROM template_hashes WHERE chain=? AND count>=?`),
  upsertQuoteToken: db.prepare(`INSERT INTO quote_tokens (chain, address, symbol, decimals, first_seen) VALUES (@chain, @address, @symbol, @decimals, @ts) ON CONFLICT(chain, address) DO UPDATE SET symbol=@symbol, decimals=@decimals`),
  allQuoteTokens: db.prepare(`SELECT chain, address, symbol, decimals FROM quote_tokens`),
  upsertQuotePrice: db.prepare(`INSERT INTO quote_prices (chain, address, price_usd, liquidity_usd, priced, source, updated_at) VALUES (@chain, @address, @price_usd, @liquidity_usd, @priced, @source, @updated_at) ON CONFLICT(chain, address) DO UPDATE SET price_usd=@price_usd, liquidity_usd=@liquidity_usd, priced=@priced, source=@source, updated_at=@updated_at`),
  allQuotePrices: db.prepare(`SELECT chain, address, price_usd, liquidity_usd, priced, updated_at FROM quote_prices`),
};

export const store = {
  raw: db,
  addCandidate(c) { return stmt.upsertCandidate.run({ launch_time: null, ...c }).changes > 0; },
  get(key) { return stmt.getCandidate.get(key); },
  enrich(key, data) { stmt.updateEnrich.run({ key, updated_at: Date.now(), ...data }); },
  setPool(key, pool, pool_type, quote) { stmt.setPool.run({ key, pool, pool_type, quote, updated_at: Date.now() }); },
  setCurveInfo(key, { quote_symbol = null, max_raising = null, launch_time = null }) {
    stmt.setCurveInfo.run({ key, quote_symbol, max_raising, launch_time, updated_at: Date.now() });
  },
  promote(key) { return stmt.promote.run({ key, updated_at: Date.now() }).changes > 0; },
  setCopyOf(key, copy_of) { stmt.setCopyOf.run({ key, copy_of, updated_at: Date.now() }); },
  updateMetrics(key, m) {
    stmt.updateMetrics.run({
      key, updated_at: Date.now(),
      volume_usd: 0, depth_usd: 0, depth_kind: 'curve', offers_pct: 0,
      net_in_30m: 0, net_in_1h: 0, max_buy_10m: 0, buy_ratio_30m: 0, new_buyers_30m: 0, curve_progress_pct: 0,
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
  feed(limit = 200) { return stmt.listFeed.all(limit); },
  stats(since24h) { return { ...stmt.stats.get(since24h), missed: stmt.missedKills.get().missed }; },
  addTrade(t) { stmt.insertTrade.run({ account: null, quote_amount: 0, token_amount: 0, price: 0, mcap_at_trade: null, ...t }); },
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
  addBuyer(key, account, first_ts) { stmt.insertBuyer.run({ key, account: account.toLowerCase(), first_ts }); },
  buyers(key) { return stmt.buyersForKey.all(key).map((r) => r.account); },
  swapPools() { return stmt.swapPools.all(); },
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
};
