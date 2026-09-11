import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = new Database(join(ROOT, 'data', 'meradar.sqlite'));
db.pragma('journal_mode = WAL');

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
`);

const stmt = {
  upsertCandidate: db.prepare(`
    INSERT INTO candidates (key, chain, address, launchpad, name, symbol, decimals, total_supply, creator, pool, pool_type, quote_symbol, status, discovered_at, updated_at)
    VALUES (@key, @chain, @address, @launchpad, @name, @symbol, @decimals, @total_supply, @creator, @pool, @pool_type, @quote_symbol, @status, @discovered_at, @updated_at)
    ON CONFLICT(key) DO NOTHING
  `),
  getCandidate: db.prepare(`SELECT * FROM candidates WHERE key = ?`),
  updateEnrich: db.prepare(`
    UPDATE candidates SET name=@name, symbol=@symbol, decimals=@decimals, total_supply=@total_supply,
      creator=@creator, updated_at=@updated_at WHERE key=@key
  `),
  setPool: db.prepare(`UPDATE candidates SET pool=@pool, pool_type=@pool_type, quote_symbol=COALESCE(quote_symbol,@quote), graduated=1, updated_at=@updated_at WHERE key=@key`),
  promote: db.prepare(`UPDATE candidates SET status='active', updated_at=@updated_at WHERE key=@key AND status='seen'`),
  setCopyOf: db.prepare(`UPDATE candidates SET copy_of=@copy_of, updated_at=@updated_at WHERE key=@key`),
  updateMetrics: db.prepare(`
    UPDATE candidates SET liquidity_usd=@liquidity_usd, price_usd=@price_usd, market_cap_usd=@market_cap_usd,
      volume_usd=@volume_usd, holders=@holders, unique_buyers=@unique_buyers, copycats=@copycats,
      narrative_hit=@narrative_hit, graduated=@graduated, peak_mcap_usd=MAX(peak_mcap_usd, @market_cap_usd),
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
};

export const store = {
  raw: db,
  addCandidate(c) { return stmt.upsertCandidate.run(c).changes > 0; },
  get(key) { return stmt.getCandidate.get(key); },
  enrich(key, data) { stmt.updateEnrich.run({ key, updated_at: Date.now(), ...data }); },
  setPool(key, pool, pool_type, quote) { stmt.setPool.run({ key, pool, pool_type, quote, updated_at: Date.now() }); },
  promote(key) { return stmt.promote.run({ key, updated_at: Date.now() }).changes > 0; },
  setCopyOf(key, copy_of) { stmt.setCopyOf.run({ key, copy_of, updated_at: Date.now() }); },
  updateMetrics(key, m) { stmt.updateMetrics.run({ key, updated_at: Date.now(), volume_usd: 0, ...m }); },
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
  activeCandidates(limit = 400) { return stmt.activeCandidates.all(limit); },
  feed(limit = 200) { return stmt.listFeed.all(limit); },
  stats(since24h) { return { ...stmt.stats.get(since24h), missed: stmt.missedKills.get().missed }; },
};
