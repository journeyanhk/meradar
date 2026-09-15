import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

const raw = readFileSync(join(ROOT, 'config.json'), 'utf8');
const file = JSON.parse(raw);

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  port: Number(env('PORT', '8787')),
  host: env('HOST', '127.0.0.1'),
  logLevel: env('LOG_LEVEL', 'info'),
  enabledChains: env('CHAINS', 'bsc')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rpc: {
    // ws 支持逗号分隔的多路（主路,第二路…）：wsClient 解析成 viem fallback，断线自动切换。
    // logsHttp 为 getLogs/回填/自检 专用端点（留空回落 http）：官方公共端点密集查询会 429，
    // 可指向 Alchemy 等第二路只承接回填，用量小、免费额度足。
    bsc: { http: env('BSC_HTTP'), ws: env('BSC_WS'), logsHttp: env('BSC_LOGS_HTTP') },
    arc: { http: env('ARC_HTTP'), ws: env('ARC_WS'), logsHttp: env('ARC_LOGS_HTTP') },
    // Robinhood Chain：官方 HTTP 做兜底；logsHttp(Alchemy)做 getLogs 回填(官方对密集查询 429)，
    // dRPC HTTP 做只读调用(name/symbol/multicall/往返 state override，比官方公共端点稳、不易 429)，
    // ws 主路 dRPC + 第二路 Alchemy(逗号分隔)。均有默认公共端点，未配 .env 也能跑（付费端点更稳，可在 .env 覆盖）。
    robinhood: {
      http: env('ROBINHOOD_HTTP', 'https://rpc.mainnet.chain.robinhood.com'),
      readHttp: env('ROBINHOOD_READ_HTTP', 'https://robinhood.drpc.org'),
      logsHttp: env('ROBINHOOD_LOGS_HTTP'),
      ws: env('ROBINHOOD_WS', 'wss://robinhood.drpc.org'),
    },
  },
  telegram: {
    token: env('TELEGRAM_BOT_TOKEN'),
    chatId: env('TELEGRAM_CHAT_ID'),
    enabled: Boolean(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID')),
  },
  serverchan: {
    sendkey: env('SERVERCHAN_SENDKEY'),
    enabled: Boolean(env('SERVERCHAN_SENDKEY')),
  },
  ...file,
};

export function chainConfig(chain) {
  const c = config.chains[chain];
  if (!c) throw new Error(`未知链: ${chain}`);
  return c;
}

// 分级阈值：全局 config.tiers 为底，chains.<chain>.tiers 覆盖(T1/T2 逐键浅合并)。
// Pons 毕业市值仅 $3–6 万，全局 T1($10万) 市值腿几乎不可能触发 → Robinhood 用更低的链级阈值。
export function tiersFor(chain) {
  const base = config.tiers || {};
  const ov = chain ? config.chains?.[chain]?.tiers : null;
  if (!ov) return base;
  return {
    ...base, ...ov,
    T1: { ...(base.T1 || {}), ...(ov.T1 || {}) },
    T2: { ...(base.T2 || {}), ...(ov.T2 || {}) },
  };
}

// 该链是否对「毕业后无往返路径(unsupported)」放行强提示(收紧版豁免)。
// 配置形如 { until: '2026-09-30' }：到期后自动失效回落 WAIT/T1(安全默认)。true 视为永久(不建议)。
export function allowUnverifiedStrongFor(chain) {
  const a = chain ? config.chains?.[chain]?.allowUnverifiedStrong : null;
  if (!a) return false;
  if (a === true) return true;
  if (a.until) return Date.now() < Date.parse(a.until);
  return true;
}

// 升级为 active 所需独立买家数：链级 chains.<chain>.admission 覆盖全局 admission.minBuyersToActivate。
// Arc pool-first 币毕业即建池、成交经 Swap 计数，门槛可略低(3)以尽早纳入跟踪；BSC/Robinhood 维持全局默认。
export function admissionFor(chain) {
  const c = chain ? config.chains?.[chain]?.admission : null;
  return c ?? config.admission?.minBuyersToActivate ?? 5;
}

// 可试仓过滤阈值：全局 config.entryFilter 为底，chains.<chain>.entryFilter 覆盖(hard/structure/momentum/sizing 逐组浅合并)。
// Robinhood 毕业市值/池偏小 → 门槛略降；Arc 首日更严、仓位更小。缺省返回全局(未配则 {})。
export function entryFilterFor(chain) {
  const base = config.entryFilter || {};
  const ov = chain ? config.chains?.[chain]?.entryFilter : null;
  if (!ov) return base;
  return {
    ...base, ...ov,
    hard: { ...(base.hard || {}), ...(ov.hard || {}) },
    structure: { ...(base.structure || {}), ...(ov.structure || {}) },
    momentum: { ...(base.momentum || {}), ...(ov.momentum || {}) },
    sizing: { ...(base.sizing || {}), ...(ov.sizing || {}) },
  };
}
