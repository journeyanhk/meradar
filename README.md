# Meme 雷达 (meradar)

只读的 Meme 币雷达：监控 **BSC / Four.meme + PancakeSwap** 上的新币，对候选做 **动量跟踪**，并按 **T0→T3 分级** 通过 **Telegram + Server酱** 告警。单进程、独立端口、自带极简网页（手机可用、自动黑白模式）。Arc 测试网适配器待命，主网 9/16 后接入。

> 纯只读：**无需私钥、无需钱包、无需资金、无授权**。人工复核后自行决策。非投资建议。

## 特性

- **发现**：按工厂地址订阅日志（WebSocket）。Four.meme 用 ABI-agnostic 的 raw-log + ERC20 校验发现新币；PancakeSwap V2/V3 用标准 `PairCreated`/`PoolCreated`（也捕获毕业迁移）。
- **富化**：读取 name/symbol/decimals/totalSupply、创建者、池子储备 → 流动性/价格/市值。
- **打分（只否决）**：创建者批量发币检测 + 只读往返貔貅模拟（`getAmountsOut`）。安全指标只做减法，动量与叙事负责发现。
- **跟踪层**：对活跃候选每 45s 轮询独立买家、流动性、市值，写入时序表；长期无动量自动归档。
- **叙事 + 仿盘**：中文关键词命中、同名仿盘计数作为高权重发现信号。
- **分级告警**：T1 → Telegram 轻提示；T2/T3 → Telegram 强提示 + Server酱（微信）。
- **网页**：SSE 实时 feed、迷你走势图、统计（含漏杀率）、扁平极简、移动优先、自动/手动黑白。

## 快速开始

```bash
git clone <repo> && cd meradar
npm install
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

- `tiers.T1/T2`：动量/爆发阈值（独立买家、市值、流动性、仿盘数）。
- `narrative.keywords`：中文叙事关键词表。
- `chains.bsc.launchpads`：工厂地址与事件签名。**Four.meme Token Manager `0x5c95…762b`、Pancake V2/V3 工厂已内置**；上线前请对照 BscScan 复核。
- `tracking`：轮询间隔、归档策略。

## 部署（Caddy 反代）

```
# Caddyfile
radar.example.com {
    reverse_proxy 127.0.0.1:8787
}
```
SSE 走 Caddy 无需额外配置。systemd 见 `meradar.service.example`。

## 已知边界

- **Four.meme 曲线阶段**无 AMM 池，市值/价格在**毕业到 Pancake 后**才可精确定价；曲线阶段以「独立买家增速」为动量信号。
- `TokenCreate` 的精确 ABI 未公开核实，故发现采用 ABI-agnostic 的 raw-log + ERC20 校验（自纠错）；`TokenPurchase` topic0 已核实并内置。
- 貔貅 `getAmountsOut` 往返只反映定价/滑点，**不含 transfer 税**；深度税检测（`eth_call` + stateOverride 真实 swap）为后续项，代码已留位。
- 公共 BSC RPC 对 `eth_getLogs` 有范围限制，跟踪层已限制回看窗口（~1500 块）。

## 架构

```
发现(WS日志) → 富化(只读RPC) → 打分(否决) → 跟踪(动量) → 分级告警(TG/Server酱) → 展示(SSE网页)
                         └── SQLite: candidates / snapshots / alerts ──┘
```
适配器三件套：`chain`（RPC/链ID）· `launchpad`（工厂/事件）· `enricher`（读流动性/买家）。新增 EVM 链只需填 `config.json`。
