# M2c · 买家质量分级（跨链）

> 把「买家」从一个计数，升级为带标签的地址画像；画像**跨链通用、跨币累积**，为 M4 纸面引擎与后续「自建聪明钱」铺路。
> 核心原则：**分级先展示、不门控**——`evaluateTier` 的 T1/T2 阈值输入完全不变，M2c 只并行产出 `natural_buyers_30m` 与 `soft_flags`。

## 为什么不解码 `SnipeTaxCharged` / `HookFeeCollected`

- 狙击税已在 `CurveBuy.tax` → M2b 落库为 `trades.tax_raw`，无需再订阅 `SnipeTaxCharged`。
- `HookFeeCollected.payer` 已核验 = memecoin 合约地址（见 robinhood-pons.md），对买家分级零信息量。
- 省下的工作量投入到三个**跨链通用**信号：`farm` / `fresh` / `flipper`。

## 买家标签（纯函数 `src/buyer.js`，无 RPC / 无 DB）

一个地址可命中多个标签；`natural` = 无任何标签。默认阈值见 `BUYER_DEFAULTS`。

| 标签 | 规则 | 数据来源 | 链 |
|---|---|---|---|
| `sniper` | `tax_raw > 0` **或** 首买距发射 ≤ 60s | trades + `candidates.launch_time` | 全部（BSC/Arc 无税，靠时间窗） |
| `bot` | 同块 ≥ 3 笔买入，或任意 5min 窗口 ≥ 10 笔 | trades（`block` / `ts`） | 全部 |
| `farm` | 该地址 24h 内在库里买过 ≥ 15 个不同新币 | `buyers` 表跨币 `COUNT(DISTINCT key)` | 全部 |
| `dust` | 该币累计买入 < $1 | trades（`quote_amount`） | 全部 |
| `fresh` | nonce ≤ 3 | `eth_getTransactionCount`，仅金额前 30 且未查过的买家 | 全部 |
| `flipper` | 首买后 10min 内卖出 ≥ 90% 持仓 | trades（buy/sell `token_amount`） | 全部 |

`natural_buyers_30m` = 30min 内**首次买入**且**无任何标签**的地址数。与现有 `new_buyers_30m` **并行存储**，跑一周对比后再决定是否切换阈值输入（切换时 `auditVersion +1`）。

## 数据落点

- `trades.block`（新列）：实时路径写入（`discover → engine → addTrade`）；回填只喂 momentum、不写 trades，故历史行 `block=NULL`（`bot` 同块规则自动降级到 5min 窗口）。
- `candidates.natural_buyers_30m` / `candidates.soft_flags`（新列）：每轮轮询由 `track.pollCandidate` 写入。`soft_flags` 只存**计数**——`{buyerCount, naturalBuyers, sniper, bot, farm, dust, fresh, flipper}`；各标签占比（`sniperRatio` 等）由 `server.decorate` 按 `count/buyerCount` 现算，避免同一份分布存两遍。写库带变更检测：`natural_buyers_30m` 与 `soft_flags` 均无变化时跳过 `UPDATE`。
- `buyer_profiles`（新表，跨链画像）：`addBuyer` 首次命中某(链,地址,新币)即 `tokens_bought_total += 1` 并更新 `first/last_seen`；轮询时写 `tags` 与 `tokens_bought_24h`；`fresh` 查得的 nonce 存 `nonce_at_check/nonce_checked_at`（查过即不再查）。`early_hits/early_total/realized_pnl_usd` 留给聪明钱模块，M2c 只建列不填。

## 成本上限

- `farm`/`tokens_24h`：一次分组扫描（`buyerTokenCounts24h`），`track` 侧按链缓存 60s。`buyers(account)` / `buyers(first_ts)` 建索引。
- `fresh` nonce：仅 active 币、金额前 30、且 `nonce_checked_at` 为空的地址各查一次（viem batch 合并）。查过即永不再查。
- 画像读取：每候选每轮**一次批量查**（`buyerProfilesForAccounts`，`IN(...)` 按占位符个数缓存 prepared statement）取全部买家的 `tags`/`nonce`，替代逐地址点查（避免 N+1）。
- **M2c 不新增任何 WS 订阅。**

## 配置（`config.buyerGrading`）

```json
"buyerGrading": { "farmMinTokens24h": 15, "nonceCheck": { "enabled": true, "topN": 30 } }
```

## 验收门（可执行）

1. **狙击定义自洽**：Robinhood 上 `tax_raw > 0` 的买入，应有 ≥ 90% 落在发射后 60s 内（时间窗与狙击税交叉验证）。运行数据积累后用一次性脚本核对；不达标则调时间窗。
2. **标签抽样人工核**：随机取 10 个 `farm` / 10 个 `fresh` 地址，浏览器看 tx 历史，命中率 ≥ 8/10。
3. **不改变现有告警**：切换阈值输入前后 T1/T2 触发集合完全一致（因为 `evaluateTier` 输入未变）；`node --test` 全绿（含新增分级单测）。← 直接验证「并行存储、不动阈值」这条护栏。
