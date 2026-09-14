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
    bsc: { http: env('BSC_HTTP'), ws: env('BSC_WS') },
    arc: { http: env('ARC_HTTP'), ws: env('ARC_WS') },
    // Robinhood Chain：官方 HTTP 做 getLogs 回填(≤1400 块/段)，dRPC 公共 WS 做实时订阅。
    // 两者都有默认公共端点，未配 .env 也能跑（付费端点更稳，可在 .env 覆盖）。
    robinhood: {
      http: env('ROBINHOOD_HTTP', 'https://rpc.mainnet.chain.robinhood.com'),
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
