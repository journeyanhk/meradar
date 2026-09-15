import { createPublicClient, http, webSocket, fallback } from 'viem';
import { config, chainConfig } from './config.js';
import { child } from './logger.js';

const log = child('chain');
const clients = new Map();

// WS 端点列表：ROBINHOOD_WS 等支持逗号分隔（主路,第二路…），解析成数组供 wsClient 组 fallback。
function wsUrls(chain) {
  return (config.rpc[chain]?.ws || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 由 URL 主机名归一成短标签（并隐藏 Alchemy 等 URL 里的 API key），供 /api/health 展示走的是哪一路。
function endpointLabel(url) {
  if (!url) return null;
  try {
    const h = new URL(url).host;
    if (h.includes('drpc')) return 'drpc';
    if (h.includes('alchemy')) return 'alchemy';
    if (h.includes('publicnode')) return 'publicnode';
    if (h.includes('quiknode') || h.includes('quicknode')) return 'quicknode';
    if (h.includes('getblock')) return 'getblock';
    if (h.includes('robinhood.com')) return 'official';
    return h;
  } catch {
    return 'invalid';
  }
}

// 供 /api/health 暴露各链 RPC 路由：ws 为优先级列表(首项=主路)，read/logs 各走哪一路。
export function rpcRouting() {
  const out = {};
  for (const chain of config.enabledChains) {
    const rc = config.rpc[chain] || {};
    out[chain] = {
      ws: wsUrls(chain).map(endpointLabel),
      read: endpointLabel(rc.readHttp || rc.http),
      logs: endpointLabel(rc.logsHttp || rc.http),
    };
  }
  return out;
}

function buildChain(chain) {
  const c = chainConfig(chain);
  return {
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [config.rpc[chain]?.http].filter(Boolean) } },
    ...(c.multicall3
      ? { contracts: { multicall3: { address: c.multicall3 } } }
      : {}),
  };
}

// HTTP 客户端：用于只读调用 (enrich / track / honeypot / 往返)。
// readHttp 存在且异于官方 http 时(Robinhood dRPC)：优先 readHttp，失败退官方——只读调用(name/symbol/
// multicall/extsload/往返 state override)在 dRPC 上稳定且不易 429；官方公共端点在回填后一批 promote
// 集中读时会 429/超时(名字「?」、市值 $0 的根因)。BSC/Arc 无 readHttp → 单 transport，行为不变。
export function httpClient(chain) {
  const key = `http:${chain}`;
  if (clients.has(key)) return clients.get(key);
  const rc = config.rpc[chain] || {};
  const official = rc.http;
  const read = rc.readHttp || official;
  if (!read) throw new Error(`${chain} 缺少 HTTP RPC (检查 .env)`);
  const opts = { batch: true, timeout: 15000, retryCount: 3 };
  const transport = (rc.readHttp && rc.readHttp !== official)
    ? fallback([http(rc.readHttp, opts), http(official, opts)])
    : http(read, opts);
  const client = createPublicClient({ chain: buildChain(chain), transport });
  clients.set(key, client);
  return client;
}

// getLogs / 回填 / 日志自检 专用客户端：优先 logsHttp(可指向 Alchemy 第二路，官方端点密集查询 429)，
// 无则回落官方 http。dRPC 的 eth_getLogs 对 Pons 逐币工厂地址会失败(实测)，故绝不走 readHttp。
// BSC/Arc 未配 logsHttp 时官方 http 即唯一端点，与 httpClient 同源，行为不变。
export function logsClient(chain) {
  const key = `logs:${chain}`;
  if (clients.has(key)) return clients.get(key);
  const rc = config.rpc[chain] || {};
  const url = rc.logsHttp || rc.http;
  if (!url) throw new Error(`${chain} 缺少 HTTP RPC (检查 .env)`);
  const client = createPublicClient({
    chain: buildChain(chain),
    transport: http(url, { batch: true, timeout: 15000, retryCount: 3 }),
  });
  clients.set(key, client);
  return client;
}

// 出块间隔（秒/块）：不同链差异极大（BSC ~0.45、Robinhood ~0.1、Arc ~0.5），
// 写死会让回填窗口跨度与历史成交 ts 估算整体偏移（Robinhood 写 2s 实际 0.1s → 时间戳放大 20 倍，
// 刚回填的币被新鲜度门误判过期）。启动时对每条链实测一次，缓存供回填复用；失败回落 config.secPerBlockFallback。
const secPerBlockCache = new Map();
// 启动实测时顺带缓存「实测那一刻的 latest 块 + 墙钟」，供回填期把块号估算成时间戳（见 estimateTsFromBlock）。
// 回填在启动测速后立刻跑，此 hint 仍新鲜；实时事件不用它（块≈now，调用方直接传 Date.now()）。
const latestHint = new Map(); // chain -> { block: bigint, atMs }

export async function measureSecPerBlock(chain) {
  const client = httpClient(chain);
  try {
    const latest = await client.getBlockNumber();
    latestHint.set(chain, { block: latest, atMs: Date.now() });
    const span = latest > 1000n ? 1000n : latest > 10n ? 10n : 1n;
    const [b1, b0] = await Promise.all([
      client.getBlock({ blockNumber: latest }),
      client.getBlock({ blockNumber: latest - span }),
    ]);
    const dt = Number(b1.timestamp - b0.timestamp) / Number(span);
    if (dt > 0.01 && dt < 30) { secPerBlockCache.set(chain, dt); return dt; }
  } catch (e) {
    log.debug({ chain, err: e.message }, 'measureSecPerBlock 失败(用 fallback)');
  }
  return getSecPerBlock(chain);
}

export function getSecPerBlock(chain) {
  return secPerBlockCache.get(chain) || chainConfig(chain).secPerBlockFallback || 1;
}

// 由块号估算墙钟时间戳(ms)：ts ≈ hint.atMs − (hintBlock − block) × secPerBlock × 1000。
// 仅回填用（block 落后于 hint）；hint 缺失或块号异常时回落 Date.now()，不再额外查块（避免每币一次 RPC）。
export function estimateTsFromBlock(chain, block) {
  const h = latestHint.get(chain);
  if (!h || !block) return Date.now();
  const sec = getSecPerBlock(chain);
  const ts = h.atMs - Number(h.block - BigInt(block)) * sec * 1000;
  return Number.isFinite(ts) && ts > 0 ? Math.round(ts) : Date.now();
}

// WebSocket 客户端：用于订阅日志 (discover)。自动重连。
// ws 支持逗号分隔的多路(主路,第二路…)：组成 viem fallback，主路断线/限流自动切第二路，事件不漏。
export function wsClient(chain) {
  const key = `ws:${chain}`;
  if (clients.has(key)) return clients.get(key);
  const wsList = wsUrls(chain);
  const httpUrl = config.rpc[chain]?.http;
  const transports = [];
  for (const url of wsList) {
    transports.push(webSocket(url, { reconnect: { attempts: 999, delay: 2000 }, keepAlive: true }));
  }
  if (httpUrl) transports.push(http(httpUrl, { batch: true })); // 兜底轮询
  if (!transports.length) throw new Error(`${chain} 缺少 WS/HTTP RPC`);
  const client = createPublicClient({
    chain: buildChain(chain),
    transport: transports.length > 1 ? fallback(transports) : transports[0],
    pollingInterval: 4000,
  });
  clients.set(key, client);
  if (!wsList.length) log.warn({ chain }, 'WS 未配置，回退到 HTTP 轮询（延迟更高，强烈建议配置 BSC_WS）');
  else if (wsList.length > 1) log.info({ chain, routes: wsList.map(endpointLabel) }, 'WS 多路 fallback 已启用');
  return client;
}
