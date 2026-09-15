// 元数据补读退避（纯逻辑，无 RPC/DB，便于单测）。
//
// 背景：Pons 的 TokenLaunched 不带 name/symbol/totalSupply，代码在 promote 那一刻读一次链上元数据；
// 若那一刻 readToken 撞 429/超时(回填后一批 promote 集中触发) → 返回 null → 字段永久留空 →
// 卡片名字「?」、市值 = 供应量×价格 = null×价格 = 0。修法：把一次性读取变成最终一致——
// pollCandidate 每轮检查缺字段，按退避重试，成功即 enrich，失败到上限才放弃(极可能非标准 ERC20)。

// 退避表(ms)：1m,1m,5m,5m,15m,15m,…；索引超界取末位(15m)。
export const META_BACKOFF_MS = [60_000, 60_000, 300_000, 300_000, 900_000];
export const META_MAX_ATTEMPTS = 10;

// 第 n 次尝试(n≥1)的退避时长：attempts 1,2→1m；3,4→5m；5+→15m。索引 attempts-1，超界取末位。
export function metaBackoffMs(attempts) {
  const i = Math.max(0, Math.min(attempts - 1, META_BACKOFF_MS.length - 1));
  return META_BACKOFF_MS[i];
}

// 该候选本轮是否需要补读元数据。state = { attempts, nextAt } 或 undefined(从未尝试)。
// 缺 symbol 或 total_supply 才补；已达上限不再试；退避窗口内跳过。
export function shouldRetryMeta({ symbol, totalSupply }, state, now = Date.now()) {
  if (symbol && totalSupply) return false;         // 字段齐全 → 无需补读
  const st = state || { attempts: 0, nextAt: 0 };
  if (st.attempts >= META_MAX_ATTEMPTS) return false; // 放弃(非标准 ERC20 / 永久读不到)
  return now >= (st.nextAt || 0);                  // 不在退避窗口内才试
}

// 一次失败后推进退避状态。
export function nextMetaState(state, now = Date.now()) {
  const attempts = (state?.attempts || 0) + 1;
  return { attempts, nextAt: now + metaBackoffMs(attempts) };
}
