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
