// 曲线期贸易安全的判据：代币字节码是否命中 Four.meme 平台模板白名单。
// Four.meme 代币是 Token Manager 部署的 EIP-1167 最小代理，卖出走平台曲线合约；
// 代理码哈希或其指向的实现合约码哈希命中白名单，即视为受平台模板保障(PASS·template)。
// 字节码部署后不可变，结果按地址永久缓存。
import { keccak256, getAddress } from 'viem';
import { httpClient } from './chain.js';
import { chainConfig } from './config.js';
import { child } from './logger.js';

const log = child('template');
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const cache = new Map(); // `${chain}:${addr}` -> boolean

// 命中平台模板返回 true。无白名单配置 / 取码失败 / 空码 → false（交由调用方按 WAIT 处理）。
export async function matchesTemplate(chain, address) {
  const key = `${chain}:${String(address).toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const cfg = chainConfig(chain);
  const whitelist = new Set((cfg.templateCodeHashes || []).map((h) => h.toLowerCase()));
  if (!whitelist.size) { cache.set(key, false); return false; }

  const client = httpClient(chain);
  let code;
  try { code = await client.getCode({ address: getAddress(address) }); }
  catch (e) { log.debug({ err: e.message, address }, 'getCode 失败'); return false; } // 不缓存失败，下轮重试
  if (!code || code === '0x') { cache.set(key, false); return false; }

  // 快路径：代理码哈希直接命中（同版本代理码完全一致）
  if (whitelist.has(keccak256(code).toLowerCase())) { cache.set(key, true); return true; }

  // 稳健路径：EIP-1167 代理 → 取实现合约码哈希比对（抗代理层细节差异/实现升级）
  const m = code.match(EIP1167);
  if (m) {
    try {
      const implCode = await client.getCode({ address: getAddress('0x' + m[1]) });
      if (implCode && whitelist.has(keccak256(implCode).toLowerCase())) { cache.set(key, true); return true; }
    } catch (e) { log.debug({ err: e.message, address }, 'impl getCode 失败'); return false; }
  }
  cache.set(key, false);
  return false;
}

// 供单测/诊断：仅计算哈希不比对
export function _cacheSize() { return cache.size; }
