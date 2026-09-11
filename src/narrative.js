import { config } from './config.js';
import { store } from './db.js';

const keywords = (config.narrative?.keywords || []).map((k) => k.toLowerCase());
const DAY = 24 * 3600 * 1000;

// 叙事关键词命中（name/symbol 直接匹配，最便宜有效的信号）
export function narrativeHit(name = '', symbol = '') {
  const hay = `${name} ${symbol}`.toLowerCase();
  const hits = keywords.filter((k) => k && hay.includes(k));
  return hits;
}

// 仿盘计数：同名越多，原版越热（热度代理）。24h 内同 chain+symbol 数量。
export function copycatCount(chain, symbol) {
  if (!symbol) return 0;
  const n = store.countSymbolSince(chain, symbol, Date.now() - DAY);
  return Math.max(0, n - 1); // 减去自己
}
