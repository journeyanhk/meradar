import { child } from './logger.js';

const log = child('goplus');
const cache = new Map(); // addr -> {ts, result}
const TTL = 10 * 60_000;

// GoPlus Token Security：免费只读，返回 is_honeypot / buy_tax / sell_tax / is_mintable ...
export async function goplusCheck(goplusId, address) {
  if (!goplusId) return null;
  const key = `${goplusId}:${address.toLowerCase()}`;
  const c = cache.get(key);
  if (c && Date.now() - c.ts < TTL) return c.result;
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${goplusId}?contract_addresses=${address}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    const r = j?.result?.[address.toLowerCase()];
    if (!r) return null;
    const out = {
      isHoneypot: r.is_honeypot === '1',
      cannotSellAll: r.cannot_sell_all === '1',
      buyTaxBps: Math.round(parseFloat(r.buy_tax || '0') * 10000),
      sellTaxBps: Math.round(parseFloat(r.sell_tax || '0') * 10000),
      isMintable: r.is_mintable === '1',
      ownerChangeBalance: r.owner_change_balance === '1',
    };
    cache.set(key, { ts: Date.now(), result: out });
    return out;
  } catch (e) {
    log.debug({ err: e.message, address }, 'GoPlus 查询失败');
    return null;
  }
}
