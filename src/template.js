// 曲线期贸易安全的判据：代币字节码哈希是否命中 Four.meme 平台模板（静态白名单 ∪ 运行时自学习）。
// Four.meme 代币由 Token Manager 部署（EIP-1167 最小代理指向平台实现合约，或直接部署），卖出走平台曲线合约；
// 码哈希命中即视为受平台模板保障(PASS·template)。
//
// 为何要自学习：Four.meme 数天内会轮换多套模板/实现，任何静态清单都会在下一次轮换时让全部新币 WAIT。
// TokenCreate 事件由 Token Manager 发出，本身就是「平台部署」的证据 —— 每个 promote 的币算一次码哈希累计频次，
// count≥阈值自动进白名单(写库，重启不丢)。判定 = 哈希 ∈ (静态 ∪ 已学习)。
//
// 字节码部署后不可变 → 码哈希按地址永久缓存；但「是否命中白名单」不缓存 false（哈希后续可能被学习进白名单）。
import { keccak256, getAddress } from 'viem';
import { httpClient } from './chain.js';
import { chainConfig } from './config.js';
import { store } from './db.js';
import { child } from './logger.js';

const log = child('template');
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const LEARN_THRESHOLD = 20; // 同一码哈希被 ≥20 个平台部署币复用 → 自动进白名单

const codeCache = new Map();      // `${chain}:${addr}` -> { proxyHash, implHash } | null(空码)。字节码不可变，永久缓存
const learnedByChain = new Map(); // chain -> Set<hash>（count≥阈值的已学习哈希，惰性从库加载 + 学习时增量）
const recentPromotes = [];        // { ts, known } 近 24h，用于 health.templateUnknownRate

function staticSet(chain) {
  return new Set((chainConfig(chain).templateCodeHashes || []).map((h) => h.toLowerCase()));
}
function learnedSet(chain) {
  let s = learnedByChain.get(chain);
  if (!s) { s = new Set(store.learnedTemplateHashes(chain, LEARN_THRESHOLD).map((h) => h.toLowerCase())); learnedByChain.set(chain, s); }
  return s;
}
function whitelisted(chain, hashes) {
  const stat = staticSet(chain);
  const learn = learnedSet(chain);
  return hashes.some((h) => h && (stat.has(h) || learn.has(h)));
}

// 取代币码哈希（代理码 + EIP-1167 指向的实现码）。字节码不可变 → 永久缓存。空码返回 null；取码失败返回 undefined(不缓存)。
async function codeHashes(chain, address) {
  const key = `${chain}:${String(address).toLowerCase()}`;
  if (codeCache.has(key)) return codeCache.get(key);
  const client = httpClient(chain);
  let code;
  try { code = await client.getCode({ address: getAddress(address) }); }
  catch (e) { log.debug({ err: e.message, address }, 'getCode 失败'); return undefined; } // 不缓存失败，下轮重试
  if (!code || code === '0x') { codeCache.set(key, null); return null; }

  const proxyHash = keccak256(code).toLowerCase();
  let implHash = null;
  const m = code.match(EIP1167);
  if (m) {
    try {
      const implCode = await client.getCode({ address: getAddress('0x' + m[1]) });
      if (implCode && implCode !== '0x') implHash = keccak256(implCode).toLowerCase();
    } catch (e) { log.debug({ err: e.message, address }, 'impl getCode 失败'); return undefined; }
  }
  const out = { proxyHash, implHash };
  codeCache.set(key, out);
  return out;
}

// 命中平台模板返回 true。取码失败/空码 → false（交由调用方按 WAIT 处理）。
// 只依赖码哈希不可变缓存；白名单命中每次实时判定，使新学习的哈希立刻对已见币生效。
export async function matchesTemplate(chain, address) {
  const h = await codeHashes(chain, address);
  if (!h) return false;
  return whitelisted(chain, [h.proxyHash, h.implHash]);
}

// TokenCreate(抽样)时调用：累计该币码哈希频次，count≥阈值自动进白名单。
// 计数放在 create 而非 promote —— Four.meme 每小时约创建 1000 币、过准入仅几十，轮换后放 promote
// 需攒 20 个「过准入的币」(数小时~1天)期间新模板全 WAIT；放 create 抽样 1/10 约 100 次/时，十几分钟即达阈值。
// TokenCreate 由 Token Manager 发出，每个都是平台部署，计数语义与 promote 相同。
export async function learnTemplate(chain, address) {
  let h;
  try { h = await codeHashes(chain, address); } catch { h = undefined; }
  if (!h) return;
  // 记实现码哈希优先（平台逻辑稳定层，抗代理地址差异）；无实现则记代理/直接部署码哈希。
  const primary = h.implHash || h.proxyHash;
  const kind = h.implHash ? 'impl' : 'direct';
  const count = store.bumpTemplateHash(chain, primary, kind);
  const learn = learnedSet(chain);
  if (count >= LEARN_THRESHOLD && !learn.has(primary)) {
    learn.add(primary);
    log.info({ chain, hash: primary, kind, count }, '新模板已学习');
  }
}

// promote 时调用：只记近 24h「哈希未知」比例供 health（不再计数，计数已移到 TokenCreate 抽样）。
// 返回 promote 时是否「已知模板」。
export async function recordPromotedTemplate(chain, address) {
  let h;
  try { h = await codeHashes(chain, address); } catch { h = undefined; }
  const known = !!h && whitelisted(chain, [h.proxyHash, h.implHash]);
  recentPromotes.push({ ts: Date.now(), known });
  return known;
}

// 供 /api/health：近 24h promote 的币中「哈希未知」比例，>5% 即模板可能又轮换了。
export function templateHealth() {
  const cutoff = Date.now() - 24 * 3600_000;
  while (recentPromotes.length && recentPromotes[0].ts < cutoff) recentPromotes.shift();
  const n = recentPromotes.length;
  const unknown = recentPromotes.reduce((a, r) => a + (r.known ? 0 : 1), 0);
  const learned = {};
  for (const [c, s] of learnedByChain) learned[c] = s.size;
  return { promoted24h: n, templateUnknownRate: n ? Number((unknown / n).toFixed(3)) : 0, learned };
}

// 供单测/诊断
export function _cacheSize() { return codeCache.size; }
