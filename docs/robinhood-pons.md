# Robinhood Chain · Pons V2 事件目录（M0 核实结果）

> 本文冻结 M0 阶段链上核实的全部权威参数，供 M1（曲线适配器）/ M2（毕业 + v4 定价）实现直接引用。
> 所有 topic0、事件签名、字段布局均已用真实交易回执解码验证（见文末 fixtures）。

## 链参数

| 项 | 值 |
| --- | --- |
| chainId | `4663` |
| 原生资产 | ETH（gas + 主流曲线报价币；currency 字段里 = `address(0)`） |
| 官方 HTTP RPC | `https://rpc.mainnet.chain.robinhood.com`（getLogs 回填用，≤1400 块/段 + ~400ms 间隔，避免 429） |
| dRPC 公共 WS | `wss://robinhood.drpc.org`（实时订阅用） |
| multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11`（规范地址，已确认部署） |

## Pons V2 合约

| 角色 | 地址 |
| --- | --- |
| Factory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| Router | `0xe33e9e479df8802cb0866d5d05258bec4cf62948` |
| Hook | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |
| Locker | `0x267444d099b10fb5ed7c3cc7b7c767adca574952` |
| PoolManager (v4) | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| V1 旧工厂（忽略） | `0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb` |

## 事件签名（topic0 已用 keccak 离线核对 + 真实回执解码）

**每个签名后面的 topic0 都必须精确匹配；类型顺序错一位 topic0 就变，viem 的 `events` 参数会静默丢弃不匹配日志。**

### 工厂发出（address = Factory）
```
event TokenLaunched(address indexed token, address indexed curve, address indexed deployer,
                    address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
  topic0 0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607

event PoolGraduated(address indexed token, uint256 a, uint256 b, uint256 c)
  topic0 0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259

event LaunchSwept(address indexed token, uint256 a, uint256 b)
  topic0 0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4
```
- `pairToken == address(0)` → 原生 ETH 计价曲线（标准 meme，`graduationThreshold = 4.2 ETH`）。
- `pairToken != address(0)` → ERC-20 计价曲线，`graduationThreshold` 以该 ERC-20 计（如 72.2 / 41.6）。
- `LaunchSwept` = 毕业清算中（"毕业中"过渡态）；`PoolGraduated` = 已建 v4 池。

### 曲线发出（address = 每币独立的 curve 合约）
```
event CurveBuy(address indexed wallet, address indexed recipient,
               uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)
  topic0 0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455

event CurveSell(address indexed wallet, address indexed recipient,
                uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)
  topic0 0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df

event SnipeTaxCharged(...)   // topic0 0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934（税，M2c 再解码）
```
- ⚠️ **`wallet` 是 Router（`0xe33e9e47…`），不是买家。真正的买家/接收人是 `recipient`。**
  买家计数、聪明钱建模一律用 `recipient`（买入）。已在 fixture 中验证（wallet=router, recipient=deployer）。
- 曲线价格 = `quoteIn * 10^quoteDec / tokensOut`（报价币最小单位 / 每个人类可读 token），口径与 momentum.lastPriceWei 一致。

### Hook 发出（address = Hook）
```
event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)
  topic0 0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573

event HookFeeCollected(bytes32 indexed poolId, address payer, uint256 amount0, uint256 amount1)  // topic0 0xc532c43b…
```
- `PoolRegistered` 是 **poolId ↔ token 映射的主源**（M2b）；辅源 = PoolManager `Initialize` 命中已跟踪 token。
- ⚠️ `HookFeeCollected.payer` = **memecoin 合约地址，不是买家**（已核验，详见下方 M2b 结论）。买家取 `tx.from`。

### v4 PoolManager（M2b）
```
Initialize      topic0 0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438
Swap            topic0 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f
ModifyLiquidity topic0 0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec
```
- v4 Swap 全链每块 ~2.6 条 → **必须按 poolId 精准订阅**，不能全量。poolId 是 indexed，可复用 rebuildSwaps 的定向订阅模式。
- v4 金额符号与 V3 相反：v4 是用户视角 delta（负 = 用户付出，正 = 用户收到）。normalizeSwap v4 分支必须翻转，并配已知方向的 fixture 单测。
- 忽略：`CreatorFeeRecipientUpdated 0x308c390e…`、`PoolFeesSwept 0x2f3c4357…`。

## M2b 实现结论（已链上核验，权威）

### 买家 = `tx.from`（**不是** `HookFeeCollected.payer`，也不是 `Swap.sender`）
链上双样本核验（毕业腿 tx `0x76cf7df7…` + 真实用户买单 tx `0x5ef3d4f3…`）：
- `HookFeeCollected.payer` 恒等于 **memecoin 合约地址**（= `Initialize.currency1`），并非买家 —— 原 review 的"优先取 payer"假设不成立。
- `Swap.sender` 是 **Router**（`0x9689…` / `0x8876…`），也不是买家。
- **真实买家 = `tx.from`**（真实买单 tx.from = `0x22d9b8…`）。故 `normalizeSwapV4` 对买单额外 `getTransaction` 取 `from`，取不到/零地址则不计买家（double-zero 兜底）。

### v4 定价 = `extsload` 直读 PoolManager 状态（无独立池合约）
- `POOLS_SLOT = 6`；`base = keccak256(abi.encode(poolId, uint256(6)))`。
- `slot0 @ base`：低 160 位 = `sqrtPriceX96`，次 24 位 = tick（有符号）。
- `liquidity @ base+3`：低 128 位。**已核验**：读出的 liquidity 与同池 Swap 事件的 `liquidity` 完全一致 → 布局确认。
- 价格：`(sqrtPriceX96/2^96)² = currency1/currency0 (raw)` → `×10^(dec0−dec1)` 得 human → 取 quote-per-meme → `×quoteUsd`。
- 深度：全区间(Pons)虚拟储备 `currency0 = L/sqrtP`、`currency1 = L·sqrtP`，报价腿 ×2。
  ⚠️ **集中流动性(非全区间)池会高估深度**（虚拟储备 > 实际储备）；仅 Pons 全区间毕业池准确。

### 报价币不止原生 ETH：USDG（Global Dollar，$1 稳定币，6 位）
- 实盘发现 Pons 毕业池可用 **USDG**(`0x5fc5360D…`) 计价（如 $AI/Artificial Inu）。已加入 `config.robinhood.quoteTokens` 且 `quoteUsdPrice` 视 USDG=1。
- v4 currency 按地址升序排序，原生 ETH(0x0) 恒为最小 → currency0；ERC-20 报价则按地址比较。`memeIsCurrency0 = memeAddr < quoteAddr`。

### 定价门（gate，已通过）
- $AI（`0x2E8c3116…1e18`，USDG 计价，poolId `0x7aebd80…`）：`extsload` 链上直读价 **$0.25584** vs DexScreener **$0.2559** → 偏差 **0.02%**（门槛 ≤20%）；市值 $253.6M vs FDV $253.2M（0.17%）。
- 纯函数 `computeV4Metrics` / `classifyV4Swap` 已抽出，冻结样本进 `test/fixtures/robinhood.json` 的 `v4` 段做无网络单测。

## 曲线募集额（funds）语义 —— 已实测

对 **原生 ETH 计价曲线**：`curve 合约的 ETH 余额 == 累计 (quoteIn − quoteOut)`（多币逐笔核对，精确相等）。
→ `funds = getBalance(curve)`，`progress = funds / graduationThreshold`。
对 **ERC-20 计价曲线**：curve 的 ETH 余额为 0，募集额存为该 ERC-20 → `funds = erc20.balanceOf(curve)`。
毕业后 curve 余额被清空（→ 0），此时改用 v4 池定价（M2b）。

## ⚠️ viem getLogs 的 `topics` 陷阱（M0 期两次误判的根因）

`client.getLogs({ address, topics: [TOPIC0], ... })` —— **原始 `topics` 参数不是 viem 的合法入参，会被静默忽略**，
结果返回该地址下的**全部**日志（每段几千条），而非按 topic0 过滤。M0 曾因此把 PoolGraduated/LaunchSwept/PoolRegistered
误报为 0（其实只是稀有 + 被淹没）。

正确姿势（三选一）：
1. `getLogs({ address, event: parseAbiItem('event X(...)'), ... })` —— 单事件，viem 自动算 topic0；
2. `getLogs({ address, events: [ev1, ev2], ... })` —— 多事件；
3. 直接走 `request({ method: 'eth_getLogs', params: [{ topics: [TOPIC0] }] })` 原始 JSON-RPC（回填大范围时用）。

另：Robinhood 官方 HTTP 对密集 getLogs 会 429 → 分段 ≤1400 块 + 段间 ~400ms sleep + 退避重试。

## 冻结 fixtures（test/fixtures/robinhood.json）

- 毕业交易 `0x76cf7df788b8f979aab89274ca33bea3f2992b87d081f09e85e39e22e9739cb9`（block 62426801）：
  PoolRegistered(emitter=hook) + PoolGraduated(emitter=factory)。
- LaunchSwept 交易 `0x99b7e1e4…8fab9`（block 62426800）。
- 实时样本 TokenLaunched + CurveBuy（token BAO `0x4d7a45D5…`，curve `0xc6e30E3a…`，见 json）——
  验证 `recipient` 才是买家、pairToken=0x0=原生 ETH、graduationThreshold=4.2 ETH。
- `v4` 段（M2b）：毕业腿 `Initialize/Swap/HookFeeCollected` + 真实用户买单 `Swap/HookFeeCollected`（各含 `txFrom`）
  + `$AI` USDG 计价池的定价门样本（poolId/sqrtPriceX96/liquidity/期望价）。供 `computeV4Metrics`、`classifyV4Swap`、buyer=tx.from 单测。
