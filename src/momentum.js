// 内存动量状态机：Four.meme 每次创建/买/卖都经过 Token Manager 一个地址，
// 我们已订阅其全部日志，动量所需的一切都在事件流里 —— 零 RPC 查询。
const state = new Map(); // token(lower) -> { buyers:Set, buyTs:number[], lastPriceWei:bigint, volRaw:bigint, funds:bigint, offers:bigint, peakMcapUsd:number, lastTradeTs:number }
const WINDOW_MS = 30 * 60_000;

function get(token) {
  const k = token.toLowerCase();
  let s = state.get(k);
  if (!s) { s = { buyers: new Set(), buyTs: [], lastPriceWei: 0n, volRaw: 0n, funds: 0n, offers: null, peakMcapUsd: 0, lastTradeTs: 0 }; state.set(k, s); }
  return s;
}

export function onTrade({ token, account, price, cost, funds, offers, isBuy, ts = Date.now() }) {
  const s = get(token);
  if (ts > s.lastTradeTs) s.lastTradeTs = ts; // 买/卖都算「活跃」，供归档判断（基于活动而非市值）
  if (isBuy && account) { s.buyers.add(account.toLowerCase()); s.buyTs.push(ts); }
  if (price != null) s.lastPriceWei = BigInt(price);
  if (funds != null) s.funds = BigInt(funds);
  if (offers != null) s.offers = BigInt(offers);
  if (cost != null) s.volRaw += BigInt(cost);
  const cutoff = ts - WINDOW_MS;
  if (s.buyTs.length > 256 || s.buyTs[0] < cutoff) s.buyTs = s.buyTs.filter((t) => t >= cutoff);
  return s;
}

// 启动回灌 active 币的买家集合（buyers 表 -> 内存 Set），保持去重与计数准确。
export function restore(token, accounts) {
  const s = get(token);
  for (const a of accounts) if (a) s.buyers.add(a.toLowerCase());
}

// 曲线期指标：报价币单位换算成美元。price/funds/cost 的单位是「该币自己的报价币」，
// 由调用方传入报价币的美元单价与小数位；未知报价币时传 quotePriceUsd=null → 不定价(价格/市值/额=0)。
// lastPrice、funds、volRaw 都是「报价币最小单位(raw)」，除以 10^quoteDecimals 得到人类可读报价币数量。
export function curveMetrics(token, supplyHuman, quotePriceUsd, quoteDecimals = 18) {
  const s = state.get(token.toLowerCase());
  if (!s) return null;
  const priced = quotePriceUsd != null;
  const div = 10 ** quoteDecimals;
  const priceUsd = priced ? (Number(s.lastPriceWei) / div) * quotePriceUsd : 0;
  const marketCapUsd = priceUsd * (supplyHuman || 0);
  if (marketCapUsd > s.peakMcapUsd) s.peakMcapUsd = marketCapUsd;
  const now = Date.now();
  const buys30m = s.buyTs.filter((t) => now - t < WINDOW_MS).length;
  // offers 未收到过事件时为 null：曲线进度未知，offersPct 返回 null，避免重启回灌后被误判「已毕业」(offersPct===0)。
  const offersHuman = s.offers == null ? null : Number(s.offers) / 1e18; // meme 代币固定 18 位
  const offersPct = s.offers == null ? null : (supplyHuman > 0 ? Math.min(100, (offersHuman / supplyHuman) * 100) : 0);
  const fundsQuote = Number(s.funds) / div; // 募集额(报价币人类单位)
  return {
    uniqueBuyers: s.buyers.size,
    buys30m,
    priceUsd,
    marketCapUsd,
    volumeUsd: priced ? (Number(s.volRaw) / div) * quotePriceUsd : 0,
    fundsQuote,
    fundsUsd: priced ? fundsQuote * quotePriceUsd : 0,
    offersPct,
  };
}

// 导出 active 币的当前买家集合（promote 时落库用）
export function buyers(token) {
  const s = state.get(token.toLowerCase());
  return s ? [...s.buyers] : [];
}

export function buyerCount(token) {
  const s = state.get(token.toLowerCase());
  return s ? s.buyers.size : 0;
}

// 最后一次成交(买/卖)时间戳，供归档判断（基于活动而非市值），无记录返回 0
export function lastTradeTs(token) {
  const s = state.get(token.toLowerCase());
  return s ? s.lastTradeTs : 0;
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
