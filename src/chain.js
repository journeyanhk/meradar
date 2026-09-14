import { createPublicClient, http, webSocket, fallback } from 'viem';
import { config, chainConfig } from './config.js';
import { child } from './logger.js';

const log = child('chain');
const clients = new Map();

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

// HTTP 客户端：用于只读调用 (enrich / track / honeypot)
export function httpClient(chain) {
  const key = `http:${chain}`;
  if (clients.has(key)) return clients.get(key);
  const url = config.rpc[chain]?.http;
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

export async function measureSecPerBlock(chain) {
  const client = httpClient(chain);
  try {
    const latest = await client.getBlockNumber();
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

// WebSocket 客户端：用于订阅日志 (discover)。自动重连。
export function wsClient(chain) {
  const key = `ws:${chain}`;
  if (clients.has(key)) return clients.get(key);
  const ws = config.rpc[chain]?.ws;
  const httpUrl = config.rpc[chain]?.http;
  const transports = [];
  if (ws) transports.push(webSocket(ws, { reconnect: { attempts: 999, delay: 2000 }, keepAlive: true }));
  if (httpUrl) transports.push(http(httpUrl, { batch: true })); // 兜底轮询
  if (!transports.length) throw new Error(`${chain} 缺少 WS/HTTP RPC`);
  const client = createPublicClient({
    chain: buildChain(chain),
    transport: transports.length > 1 ? fallback(transports) : transports[0],
    pollingInterval: 4000,
  });
  clients.set(key, client);
  if (!ws) log.warn({ chain }, 'WS 未配置，回退到 HTTP 轮询（延迟更高，强烈建议配置 BSC_WS）');
  return client;
}
