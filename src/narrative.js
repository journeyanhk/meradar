import { config } from './config.js';
import { store } from './db.js';

const globalKeywords = (config.narrative?.keywords || []).map((k) => k.toLowerCase());
// 每链叙事不同：BSC 是中文 Meme 词，Robinhood 是股票代码/AI（$AI×NVDA、BONER×HIMS 等）。
// 链级关键词并入全局，按链缓存一份小写数组。
const chainKeywordCache = new Map();
function keywordsFor(chain) {
  if (!chain) return globalKeywords;
  let kw = chainKeywordCache.get(chain);
  if (!kw) {
    const extra = (config.chains?.[chain]?.narrativeKeywords || []).map((k) => k.toLowerCase());
    kw = extra.length ? [...new Set([...globalKeywords, ...extra])] : globalKeywords;
    chainKeywordCache.set(chain, kw);
  }
  return kw;
}
const DAY = 24 * 3600 * 1000;

// 叙事关键词命中（name/symbol 直接匹配，最便宜有效的信号）。按链取关键词集(全局+链级)。
export function narrativeHit(chain, name = '', symbol = '') {
  const hay = `${name} ${symbol}`.toLowerCase();
  return keywordsFor(chain).filter((k) => k && hay.includes(k));
}

// 仿盘计数：同名越多，原版越热（热度代理）。24h 内同 chain+symbol 数量。
export function copycatCount(chain, symbol) {
  if (!symbol) return 0;
  const n = store.countSymbolSince(chain, symbol, Date.now() - DAY);
  return Math.max(0, n - 1); // 减去自己
}
