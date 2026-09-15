import { config } from './config.js';
import { store } from './db.js';

// 关键词编译成匹配器：ASCII 词按词边界整词匹配（避免 AI 命中 chain/train、Inu 命中 minute、
// stock 命中 stocking）；含非 ASCII 的中文词无词边界概念，保留子串匹配。
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function compileKeyword(k) {
  const key = k.toLowerCase();
  const isAscii = /^[a-z0-9$#]+$/i.test(k);
  if (isAscii) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(key)}([^a-z0-9]|$)`, 'i');
    return { key, test: (hay) => re.test(hay) };
  }
  return { key, test: (hay) => hay.includes(key) };
}
const globalKeywords = (config.narrative?.keywords || []).map(compileKeyword);
// 每链叙事不同：BSC 是中文 Meme 词，Robinhood 是股票代码/AI（$AI×NVDA、BONER×HIMS 等）。
// 链级关键词并入全局，按链缓存一份编译后的匹配器数组。
const chainKeywordCache = new Map();
function keywordsFor(chain) {
  if (!chain) return globalKeywords;
  let kw = chainKeywordCache.get(chain);
  if (!kw) {
    const extraRaw = config.chains?.[chain]?.narrativeKeywords || [];
    if (!extraRaw.length) {
      kw = globalKeywords;
    } else {
      const seen = new Set(globalKeywords.map((m) => m.key));
      const extra = extraRaw.map(compileKeyword).filter((m) => !seen.has(m.key));
      kw = [...globalKeywords, ...extra];
    }
    chainKeywordCache.set(chain, kw);
  }
  return kw;
}
const DAY = 24 * 3600 * 1000;

// 叙事关键词命中（name/symbol 直接匹配，最便宜有效的信号）。按链取关键词集(全局+链级)。
export function narrativeHit(chain, name = '', symbol = '') {
  const hay = `${name} ${symbol}`.toLowerCase();
  return keywordsFor(chain).filter((m) => m.key && m.test(hay)).map((m) => m.key);
}

// 仿盘计数：同名越多，原版越热（热度代理）。24h 内同 chain+symbol 数量。
export function copycatCount(chain, symbol) {
  if (!symbol) return 0;
  const n = store.countSymbolSince(chain, symbol, Date.now() - DAY);
  return Math.max(0, n - 1); // 减去自己
}
