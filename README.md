# Meme 雷达 (meradar)

只读的 Meme 币雷达：监控 **BSC / Four.meme + PancakeSwap** 上的新币，对候选做 **动量跟踪**，并按 **T0→T3 分级** 通过 **Telegram + Server酱** 告警。单进程、独立端口、自带极简网页（手机可用、自动黑白模式）。Arc 测试网适配器待命，主网 9/16 后接入。

> 纯只读：**无需私钥、无需钱包、无需资金、无授权**。人工复核后自行决策。非投资建议。

## 特性

- **发现**：按工厂地址订阅日志（WebSocket）。Four.meme 订阅 Token Manager，按 `TokenCreate/TokenPurchase/TokenSale` 事件解码（topic0 已对照真实链上日志核验）；PancakeSwap V2/V3 用标准 `PairCreated`/`PoolCreated`（也捕获毕业迁移）。
- **准入闸门**：`TokenCreate` 只登记为 `seen`（不轮询、零 RPC）；同一代币累计 **≥5 个独立买家**才升级为 `active` 并进入跟踪，从源头过滤噪声。启动时回填最近 ~2h 的 `TokenCreate`，且任何未登记代币**首次出现买入即懒注册**——确保「服务启动前创建、之后才启动」的慢热币也能被抓到。
- **富化**：读取 name/symbol/decimals/totalSupply、创建者、池子储备 → 流动性/价格/市值。BNB 现价每 60s 从 Pancake WBNB/USDT 池只读刷新。
- **打分（只否决）**：创建者批量发币检测 + GoPlus 貔貅/高卖税检测 + 只读往返貔貅模拟（`getAmountsOut`）。安全指标只做减法，动量与叙事负责发现。
- **跟踪层**：曲线期动量（独立买家、市值、成交量）全部来自**内存事件流状态机**（零 `eth_getLogs`）；毕业到 Pancake 后用池子真实储备定价。并发受限、每 45s 一轮，长期无动量自动归档。
- **叙事 + 仿盘**：中文关键词命中作为**阈值乘数**（命中即放宽各档触发线）；同名最早者为「原版」，仿盘热度只让原版升级。
- **分级告警**：T1 → Telegram 轻提示；T2/T3 → Telegram 强提示 + Server酱（微信）。
- **网页**：SSE 实时 feed、迷你走势图、统计（含漏杀率）、扁平极简、移动优先、自动/手动黑白。

## 快速开始

> **要求 Node ≥ 22.13**：存储用 Node 内置 `node:sqlite`（无原生编译、无 `node-gyp`、换机器/升级都不会再遇到 `better_sqlite3.node` 找不到的报错）。

```bash
git clone <repo> && cd meradar
npm install               # 纯 JS 依赖，无需 build-essential/python3
cp .env.example .env      # 按下方填写
npm start                 # 默认 http://127.0.0.1:8787
```

## 需要配置的 Key（`.env`）

| 变量 | 必需 | 说明 |
|---|---|---|
| `BSC_WS` | 强烈建议 | BSC WebSocket。公共 WS 常不稳，建议填 QuickNode/Alchemy/GetBlock 付费 WS |
| `BSC_HTTP` | 是 | BSC HTTP RPC（只读调用 + 兜底轮询） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 是 | @BotFather 建 bot；发条消息后用 `getUpdates` 拿 chat id |
| `SERVERCHAN_SENDKEY` | 是 | sct.ftqq.com 扫码登录复制（SCT 开头）。只走 T2/T3 |
| `ARC_HTTP` / `ARC_WS` | 否 | `CHAINS=bsc,arc` 时才用 |

不填 Telegram/Server酱 也能运行，只是不推送。不填任何链 RPC 时仅启动网页（看历史）。

## 阈值与关键词

全部在 `config.json`，热改后重启生效：

- `admission.minBuyersToActivate`：seen→active 的独立买家阈值（默认 5）。
- `tiers.T1/T2`：动量/爆发阈值（独立买家、市值、流动性、仿盘数）。
- `tiers.narrativeMultiplier`：命中叙事关键词时的阈值乘数（<1，默认 0.5，越低越易触发）。
- `narrative.keywords`：中文叙事关键词表。
- `chains.bsc.launchpads`：工厂地址与事件签名。**Four.meme Token Manager `0x5c95…762b`、Pancake V2/V3 工厂已内置**；上线前请对照 BscScan 复核。
- `tracking`：轮询间隔、并发、归档策略、快照保留天数。

## 部署（Caddy 反代）

```
# Caddyfile
radar.example.com {
    reverse_proxy 127.0.0.1:8787
}
```
SSE 走 Caddy 无需额外配置。systemd 见 `meradar.service.example`。

## 已知边界

- **Four.meme 曲线阶段**无 AMM 池，价格/市值由 `TokenPurchase` 事件携带的 `price × totalSupply × BNB 现价`推算，毕业到 Pancake 后切换为池子真实储备定价（更精确）。
- 曲线期动量走**内存事件流**（订阅 Token Manager 全量日志），因此**不依赖 `eth_getLogs` 扫 Transfer**——规避了公共 RPC 的日志范围限制，也把候选轮询降到零 RPC。
- **启动回填**用带地址的 `eth_getLogs` 拉最近 ~2h 的 `TokenCreate`。公共 RPC（publicnode）通常只服务近 ~1h 的日志、更早的分段会 403 被跳过（属正常，非故障）；付费 RPC 可覆盖完整窗口。无论回填是否命中，任何代币**首次买入都会懒注册**，慢热币不会漏。
- 事件签名的 `topic0` 已用 `viem.toEventSelector` 对照真实链上日志核验（见 `test/unit.test.js`）；若 Four.meme 升级合约改了事件，替换 `src/abi.js` 的签名即可。
- 貔貅 `getAmountsOut` 往返只反映定价/滑点，**不含 transfer 税**；transfer 税由 GoPlus 卖出税字段兜底，深度税检测（`eth_call` + stateOverride 真实 swap）为后续项。
- 启动自检会用一次窄范围 `eth_getLogs`（带发射台地址）验证毕业池定价可用；若 RPC 封禁则只影响毕业池的精确定价，曲线期监控不受影响。
- **毕业后成交（Swap）单订阅**：一条订阅、地址数组 + V2/V3 双 `topic0` 覆盖所有已毕业活跃池，`setPool`/归档时整体重建。V2 `Swap` 的买家取事件里的 `to`，对**经 GMGN 机器人或聚合器**的买入，`to` 是路由/机器人合约而非真实钱包——这类买入会被归到同一地址，因此**毕业后的「新买家」数会略偏低**；曲线期直接用 `TokenPurchase.account`，不受影响。
- **净流入/最大单笔/买卖比/新买家** 全部来自 `trades` 表（仅落 active 币，30 天清理），`quote_amount` 统一按美元计价，跨报价币（BNB/USDT）可直接求和。`buyers` 表在 promote 时整体落库、`first_ts` 记 0，此后增量才用真实时间，避免升级后 30 分钟内「新买家」虚高为全部买家。

## 架构

```
发现(WS日志) → 富化(只读RPC) → 打分(否决) → 跟踪(动量) → 分级告警(TG/Server酱) → 展示(SSE网页)
                         └── SQLite: candidates / snapshots / alerts ──┘
```
适配器三件套：`chain`（RPC/链ID）· `launchpad`（工厂/事件）· `enricher`（读流动性/买家）。新增 EVM 链只需填 `config.json`。
