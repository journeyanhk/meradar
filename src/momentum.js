// 内存动量状态机：Four.meme 每次创建/买/卖都经过 Token Manager 一个地址，
// 我们已订阅其全部日志，动量所需的一切都在事件流里 —— 零 RPC 查询。
const state = new Map(); // token(lower) -> { buyers:Set, buyTs:number[], lastPriceWei:bigint, volBnb:number, funds:bigint, peakMcapUsd:number }
const WINDOW_MS = 30 * 60_000;

function get(token) {
  const k = token.toLowerCase();
  let s = state.get(k);
  if (!s) { s = { buyers: new Set(), buyTs: [], lastPriceWei: 0n, volBnb: 0, funds: 0n, peakMcapUsd: 0 }; state.set(k, s); }
  return s;
}

export function onTrade({ token, account, price, cost, funds, isBuy, ts = Date.now() }) {
  const s = get(token);
  if (isBuy && account) { s.buyers.add(account.toLowerCase()); s.buyTs.push(ts); }
  if (price != null) s.lastPriceWei = price;
  if (funds != null) s.funds = funds;
  if (cost != null) s.volBnb += Number(cost) / 1e18;
  const cutoff = ts - WINDOW_MS;
  if (s.buyTs.length > 256 || s.buyTs[0] < cutoff) s.buyTs = s.buyTs.filter((t) => t >= cutoff);
  return s;
}

// 曲线期指标：price(wei/代币) × totalSupply × bnbUsd = 市值
export function curveMetrics(token, supplyHuman, bnbUsd) {
  const s = state.get(token.toLowerCase());
  if (!s) return null;
  const priceUsd = (Number(s.lastPriceWei) / 1e18) * bnbUsd;
  const marketCapUsd = priceUsd * (supplyHuman || 0);
  if (marketCapUsd > s.peakMcapUsd) s.peakMcapUsd = marketCapUsd;
  const now = Date.now();
  const buys30m = s.buyTs.filter((t) => now - t < WINDOW_MS).length;
  return {
    uniqueBuyers: s.buyers.size,
    buys30m,
    priceUsd,
    marketCapUsd,
    volumeUsd: s.volBnb * bnbUsd,
    fundsBnb: Number(s.funds) / 1e18,
  };
}

export function buyerCount(token) {
  const s = state.get(token.toLowerCase());
  return s ? s.buyers.size : 0;
}

// 供漏杀率统计：即便被 reject，仍用免费事件流更新峰值
export function allStates() {
  return state;
}

// 归档时可清理，控制内存
export function forget(token) {
  state.delete(token.toLowerCase());
}
export function size() { return state.size; }
