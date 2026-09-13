// 动态报价币定价：Four.meme 现允许任意代币做曲线报价（如 SpaceX 股票代币 SPCXB），
// 静态 quoteTokens 配置覆盖不到 → resolveQuote 返回 null → 市值/募集/净流入全为 0（4FOUR 归零根因）。
// 本模块把「报价币定价」从静态配置改成动态解析 + 缓存：
//   1) 首次遇到未知报价币：读链上 symbol/decimals 落库(quote_tokens)，永久登记；
//   2) 美元价：扫 Pancake V2/V3(vs USDT / WBNB)取流动性最大的池定价，60 秒缓存 + 落库(quote_prices)；
//   3) 流动性 < $5000 的报价币价格不可信 → priced=false，卡片显示「报价币 X · 无可信价格」而非全 0。
// enrich.js 的 resolveQuote/quoteUsd 在 config 未命中时回落到这里（按 chainId 查内存注册表，同步）。
import { getAddress, formatUnits } from 'viem';
import { httpClient } from './chain.js';
import { chainConfig, config } from './config.js';
import { store } from './db.js';
import { getBnbUsd } from './enrich.js';
import { erc20Abi, pairAbi, v3PoolAbi, v2FactoryAbi, v3FactoryAbi } from './abi.js';
import { child } from './logger.js';

const log = child('quotePrice');
const MIN_LIQ_USD = 5000;      // 低于此流动性的报价币价格不可信
const PRICE_TTL = 60_000;      // 美元价缓存 60 秒
const V3_FEES = [100, 500, 2500, 10000];

const reg = new Map();        // `${chainId}:${addrLower}` -> { sym, address, decimals, chain }
const regBySym = new Map();   // `${chainId}:${symLower}` -> addrLower
const priceCache = new Map(); // `${chainId}:${addrLower}` -> { priceUsd, liquidityUsd, priced, ts }
let loaded = false;

function chainIdOf(chain) { return chainConfig(chain)?.chainId; }

// 惰性从库加载登记表与价格缓存（重启热启，免重复读链）。
function load() {
  if (loaded) return;
  loaded = true;
  for (const r of store.quoteTokens()) {
    const cid = chainIdOf(r.chain);
    if (cid == null) continue;
    reg.set(`${cid}:${r.address.toLowerCase()}`, { sym: r.symbol, address: getAddress(r.address), decimals: r.decimals, chain: r.chain });
    if (r.symbol) regBySym.set(`${cid}:${String(r.symbol).toLowerCase()}`, r.address.toLowerCase());
  }
  for (const p of store.quotePrices()) {
    const cid = chainIdOf(p.chain);
    if (cid == null) continue;
    priceCache.set(`${cid}:${p.address.toLowerCase()}`, { priceUsd: p.price_usd, liquidityUsd: p.liquidity_usd, priced: !!p.priced, ts: p.updated_at });
  }
}

// 同步查动态报价币元数据（config 未命中时 enrich.resolveQuote 回落到这里）。返回 null 表示尚未登记。
export function lookupDynamicQuote(chainId, symOrAddr) {
  load();
  const s = String(symOrAddr).toLowerCase();
  const addr = s.startsWith('0x') ? (reg.has(`${chainId}:${s}`) ? s : null) : regBySym.get(`${chainId}:${s}`);
  if (!addr) return null;
  const m = reg.get(`${chainId}:${addr}`);
  if (!m) return null;
  const pc = priceCache.get(`${chainId}:${addr}`);
  return { sym: m.sym, address: m.address, decimals: m.decimals, dynamic: true, priced: !!(pc && pc.priced) };
}

// 同步查动态报价币美元价。不可信(priced=false)或未定价 → 返回 null（调用方按「无可信价格」处理）。
export function dynamicQuoteUsd(chainId, symOrAddr) {
  load();
  const s = String(symOrAddr).toLowerCase();
  const addr = s.startsWith('0x') ? s : regBySym.get(`${chainId}:${s}`);
  if (!addr) return null;
  const pc = priceCache.get(`${chainId}:${addr}`);
  return pc && pc.priced ? pc.priceUsd : null;
}

// promote 时 await：登记动态报价币(读 symbol/decimals) + 立即定价一次。config 内置报价币直接跳过。
// 返回 { sym, address, decimals } | null。
export async function learnQuote(chain, quoteAddr) {
  if (!quoteAddr || /^0x0+$/.test(String(quoteAddr))) return null; // 零地址=原生曲线，由 config WBNB 处理
  load();
  const cfg = chainConfig(chain);
  const cid = cfg?.chainId;
  if (cid == null) return null;
  // config 里已有 → 非动态，交给 resolveQuote 原路径
  for (const [, q] of Object.entries(cfg.quoteTokens || {})) {
    if (q.address?.toLowerCase() === String(quoteAddr).toLowerCase()) return null;
  }
  const addr = getAddress(quoteAddr);
  const key = `${cid}:${addr.toLowerCase()}`;
  if (!reg.has(key)) {
    const client = httpClient(chain);
    let sym, dec;
    try {
      [sym, dec] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: addr, abi: erc20Abi, functionName: 'symbol' },
          { address: addr, abi: erc20Abi, functionName: 'decimals' },
        ],
      });
    } catch (e) { log.debug({ err: e.message, addr }, '动态报价币 symbol/decimals 读取失败'); return null; }
    sym = String(sym).slice(0, 32);
    dec = Number(dec);
    reg.set(key, { sym, address: addr, decimals: dec, chain });
    regBySym.set(`${cid}:${sym.toLowerCase()}`, addr.toLowerCase());
    store.registerQuoteToken(chain, addr, sym, dec);
    log.info({ chain, sym, addr }, '登记新动态报价币');
  }
  await refreshOne(chain, reg.get(key)).catch((e) => log.debug({ err: e.message }, 'refreshOne'));
  return reg.get(key);
}

// 定期刷新本链所有动态报价币的美元价（index.js 每 60s 调，与 refreshBnbUsd 同侧）。
export async function refreshDynamicQuotes(chain) {
  load();
  const cid = chainIdOf(chain);
  if (cid == null) return;
  const now = Date.now();
  for (const [k, m] of reg) {
    if (!k.startsWith(`${cid}:`)) continue;
    const pc = priceCache.get(k);
    if (pc && now - pc.ts < PRICE_TTL) continue; // 未过期跳过
    await refreshOne(chain, m).catch((e) => log.debug({ err: e.message, sym: m.sym }, 'refreshDynamicQuotes'));
  }
}

// 给某动态报价币定价：扫 V2/V3(vs USDT/WBNB) 所有池，取流动性最大者。落缓存 + 库。
async function refreshOne(chain, meta) {
  const cfg = chainConfig(chain);
  const cid = cfg.chainId;
  const best = await priceTokenUsd(chain, meta.address, meta.decimals);
  const priced = !!best && best.liquidityUsd >= MIN_LIQ_USD;
  const rec = { priceUsd: best?.priceUsd ?? 0, liquidityUsd: best?.liquidityUsd ?? 0, priced, ts: Date.now() };
  priceCache.set(`${cid}:${meta.address.toLowerCase()}`, rec);
  store.setQuotePrice({ chain, address: meta.address, price_usd: rec.priceUsd, liquidity_usd: rec.liquidityUsd, priced: priced ? 1 : 0, source: best?.source ?? null });
  return rec;
}

// 扫某代币对 USDT / WBNB 的 V2+V3 池，返回流动性最大的池的 { priceUsd, liquidityUsd, source } 或 null。
async function priceTokenUsd(chain, token, tokenDec) {
  const cfg = chainConfig(chain);
  const client = httpClient(chain);
  const bnb = getBnbUsd(chain);
  const refs = [];
  if (cfg.quoteTokens?.USDT) refs.push({ addr: getAddress(cfg.quoteTokens.USDT.address), dec: cfg.quoteTokens.USDT.decimals, usd: 1 });
  if (cfg.quoteTokens?.WBNB) refs.push({ addr: getAddress(cfg.quoteTokens.WBNB.address), dec: cfg.quoteTokens.WBNB.decimals, usd: bnb });
  const v2 = cfg.launchpads?.find((l) => l.type === 'amm-v2' && l.address && !/^0x0+$/.test(l.address));
  const v3 = cfg.launchpads?.find((l) => l.type === 'amm-v3' && l.address && !/^0x0+$/.test(l.address));
  const tok = getAddress(token);

  // Round 1：发现池地址
  const disc = [];
  if (v2) for (const r of refs) disc.push({ kind: 'v2', r, c: { address: v2.address, abi: v2FactoryAbi, functionName: 'getPair', args: [tok, r.addr] } });
  if (v3) for (const r of refs) for (const fee of V3_FEES) disc.push({ kind: 'v3', r, c: { address: v3.address, abi: v3FactoryAbi, functionName: 'getPool', args: [tok, r.addr, fee] } });
  if (!disc.length) return null;
  let dres;
  try { dres = await client.multicall({ allowFailure: true, contracts: disc.map((x) => x.c) }); }
  catch (e) { log.debug({ err: e.message }, 'priceTokenUsd 发现池失败'); return null; }
  const pools = [];
  for (let i = 0; i < dres.length; i++) {
    const addr = dres[i]?.status === 'success' ? dres[i].result : null;
    if (addr && !/^0x0+$/.test(addr)) pools.push({ ...disc[i], pool: getAddress(addr) });
  }
  if (!pools.length) return null;

  // Round 2：读每个池的储备/价格
  let best = null;
  for (const p of pools) {
    try {
      if (p.kind === 'v2') {
        const [reserves, token0] = await client.multicall({
          allowFailure: false,
          contracts: [
            { address: p.pool, abi: pairAbi, functionName: 'getReserves' },
            { address: p.pool, abi: pairAbi, functionName: 'token0' },
          ],
        });
        const tokIsT0 = token0.toLowerCase() === tok.toLowerCase();
        const tokReserve = Number(formatUnits(tokIsT0 ? reserves[0] : reserves[1], tokenDec));
        const refReserve = Number(formatUnits(tokIsT0 ? reserves[1] : reserves[0], p.r.dec));
        if (tokReserve <= 0) continue;
        const priceUsd = (refReserve / tokReserve) * p.r.usd;
        const liquidityUsd = refReserve * p.r.usd * 2;
        if (!best || liquidityUsd > best.liquidityUsd) best = { priceUsd, liquidityUsd, source: `v2:${p.r.usd === 1 ? 'USDT' : 'WBNB'}` };
      } else {
        const [slot0, token0, refBal] = await client.multicall({
          allowFailure: false,
          contracts: [
            { address: p.pool, abi: v3PoolAbi, functionName: 'slot0' },
            { address: p.pool, abi: v3PoolAbi, functionName: 'token0' },
            { address: p.r.addr, abi: erc20Abi, functionName: 'balanceOf', args: [p.pool] },
          ],
        });
        const tokIsT0 = token0.toLowerCase() === tok.toLowerCase();
        const dec0 = tokIsT0 ? tokenDec : p.r.dec;
        const dec1 = tokIsT0 ? p.r.dec : tokenDec;
        const ratio = Number(slot0[0]) / 2 ** 96;
        const human1per0 = ratio * ratio * 10 ** (dec0 - dec1); // token1 per token0 (human)
        if (!(human1per0 > 0)) continue;
        // token 的价格(以 ref 计)：token=token0 → ref/token = human1per0；token=token1 → 1/human1per0
        const priceInRef = tokIsT0 ? human1per0 : 1 / human1per0;
        const priceUsd = priceInRef * p.r.usd;
        const liquidityUsd = Number(formatUnits(refBal, p.r.dec)) * p.r.usd * 2;
        if (!best || liquidityUsd > best.liquidityUsd) best = { priceUsd, liquidityUsd, source: `v3:${p.r.usd === 1 ? 'USDT' : 'WBNB'}` };
      }
    } catch (e) { log.debug({ err: e.message, pool: p.pool }, 'priceTokenUsd 读池失败'); }
  }
  return best;
}

// 供 /api/health 或诊断：已登记动态报价币数与可定价数。
export function quoteHealth() {
  load();
  let total = 0, priced = 0;
  for (const [k] of reg) { total++; if (priceCache.get(k)?.priced) priced++; }
  return { dynamicQuotes: total, dynamicPriced: priced };
}
