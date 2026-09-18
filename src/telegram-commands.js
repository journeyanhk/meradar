// 序C：Telegram 入站命令(getUpdates 长轮询)。只读原则不变——命令仅建立/关闭本站的模拟/追踪仓位，
// 绝不触发任何链上交易。白名单校验 chat_id；token 必须解析为本站已存在的候选。
// 默认关闭，需 TELEGRAM_COMMANDS=1 + 已配置 bot token/chatId。
import { config } from './config.js';
import { store } from './db.js';
import { child } from './logger.js';
import { sendTelegram } from './notify/telegram.js';
import { openUserPosition, closeUserPosition, bindRuleToPosition, userPositionsView } from './paper.js';

const log = child('tg-cmd');

const HELP = [
  '雷达仓位命令(只读追踪，不下单)：',
  '/buy &lt;地址或key&gt; — 手动模拟仓($100)',
  '/watch &lt;地址或key&gt; — 加入关注',
  '/real &lt;地址或key&gt; &lt;数量&gt; — 记录实盘持仓',
  '/rule &lt;地址或key&gt; &lt;tp,sl,trail,持有分钟&gt; — 绑定退出规则(如 50,30,25,240)',
  '/close &lt;地址或key&gt; [manual|real|watch] — 平仓(默认 manual)',
  '/list — 查看我的持仓',
].join('\n');

// —— 纯函数：命令解析(可单测) ——
// 返回 { cmd, args:[] } 或 null。去掉 @botname 后缀；命令小写。
export function parseCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const parts = t.split(/\s+/);
  let cmd = parts[0].slice(1).toLowerCase();
  const at = cmd.indexOf('@');
  if (at >= 0) cmd = cmd.slice(0, at);
  return { cmd, args: parts.slice(1) };
}

// 校验 chat_id 是否在白名单。空白名单(未配置) → 一律拒绝(安全默认)。
export function isAllowed(chatId) {
  const wl = config.telegram.allowedChatIds || [];
  return wl.length > 0 && wl.includes(String(chatId));
}

// —— key 解析：优先精确 key，其次按地址(可能跨链多候选→要求用完整 key) ——
function resolveKey(input) {
  if (!input) return { error: '缺少代币地址或 key' };
  const raw = String(input).trim();
  if (store.get(raw)) return { key: raw };
  // 按地址查(可能是 0x… 或含链前缀被误传)
  const addr = raw.includes(':') ? raw.split(':').pop() : raw;
  const rows = store.candidatesByAddress(addr);
  if (rows.length === 1) return { key: rows[0].key };
  if (rows.length > 1) return { error: `该地址在多条链上都有候选，请用完整 key：${rows.map((r) => r.key).join(' / ')}` };
  return { error: `未找到候选：${raw}(需是本站已发现的代币)` };
}

// —— 处理一条命令，返回给用户的回复文本(HTML) ——
export function handleCommand(cmd, args) {
  switch (cmd) {
    case 'start':
    case 'help':
      return HELP;
    case 'list': {
      const ups = userPositionsView().filter((u) => u.status === 'open');
      if (!ups.length) return '当前无持仓。用 /buy 或 /watch 添加。';
      const L = { manual: '模拟', real: '实盘', watch: '关注' };
      return '我的持仓：\n' + ups.map((u) => {
        const p = u.curPct == null ? '—' : (u.curPct > 0 ? '+' : '') + Math.round(u.curPct) + '%';
        return `· [${L[u.origin] || u.origin}] ${u.symbol || u.key} ${p}${u.ruleFiredReason ? ' ⚑' + u.ruleFiredReason : ''}`;
      }).join('\n');
    }
    case 'buy':
    case 'watch': {
      const origin = cmd === 'buy' ? 'manual' : 'watch';
      const { key, error } = resolveKey(args[0]);
      if (error) return '⚠ ' + error;
      const r = openUserPosition(key, origin);
      return r.ok ? `✅ 已建立「${cmd === 'buy' ? '手动模拟' : '关注'}」仓位：${key}` : '⚠ ' + r.error;
    }
    case 'real': {
      const { key, error } = resolveKey(args[0]);
      if (error) return '⚠ ' + error;
      const qty = Number(args[1]);
      if (!(qty > 0)) return '⚠ 用法：/real <地址> <数量>';
      const r = openUserPosition(key, 'real', { qty });
      return r.ok ? `✅ 已记录实盘持仓 ${qty}：${key}` : '⚠ ' + r.error;
    }
    case 'close': {
      const { key, error } = resolveKey(args[0]);
      if (error) return '⚠ ' + error;
      const origin = ['manual', 'real', 'watch'].includes(args[1]) ? args[1] : 'manual';
      const r = closeUserPosition(key, origin);
      return r.ok ? `✅ 已平仓(${origin})：${key}` : '⚠ ' + r.error;
    }
    case 'rule': {
      const { key, error } = resolveKey(args[0]);
      if (error) return '⚠ ' + error;
      const [tp, sl, trail, maxHoldMin] = (args[1] || '').split(',').map((x) => x.trim());
      const origin = ['manual', 'real', 'watch'].includes(args[2]) ? args[2] : 'manual';
      const r = bindRuleToPosition(key, origin, { tp, sl, trail, maxHoldMin });
      return r.ok ? `✅ 规则已绑定(${origin})：tp${r.rule.tp ?? '-'}/sl${r.rule.sl ?? '-'}/追${r.rule.trail ?? '-'}/${r.rule.maxHoldMin ?? '-'}m` : '⚠ ' + r.error;
    }
    default:
      return null; // 未知命令：忽略(不回复，避免噪音)
  }
}

// 处理单条 update(供轮询循环 + 测试)。校验白名单后分发命令并回复。
export async function handleUpdate(update) {
  const msg = update?.message || update?.edited_message;
  const text = msg?.text;
  const chatId = msg?.chat?.id;
  if (!text || chatId == null) return;
  const parsed = parseCommand(text);
  if (!parsed) return;
  if (!isAllowed(chatId)) {
    log.warn({ chatId }, 'Telegram 命令：chat_id 不在白名单，已拒绝');
    await sendTelegram('⛔ 未授权的会话。', { chatId });
    return;
  }
  let reply;
  try { reply = handleCommand(parsed.cmd, parsed.args); }
  catch (e) { log.warn({ err: e.message, cmd: parsed.cmd }, '命令处理异常'); reply = '⚠ 处理失败'; }
  if (reply) await sendTelegram(reply, { chatId });
}

// —— getUpdates 长轮询循环 ——
let offset = 0;
let running = false;

async function pollOnce() {
  const url = `https://api.telegram.org/bot${config.telegram.token}/getUpdates?timeout=25&offset=${offset}`;
  const res = await fetch(url);
  const j = await res.json();
  if (!j.ok) { log.warn({ desc: j.description }, 'getUpdates 失败'); return; }
  for (const u of j.result || []) {
    offset = Math.max(offset, u.update_id + 1);
    try { await handleUpdate(u); } catch (e) { log.warn({ err: e.message }, 'update 处理失败'); }
  }
}

export function startTelegramCommands() {
  if (!config.telegram.enabled || !config.telegram.commands) return;
  if (!(config.telegram.allowedChatIds || []).length) {
    log.warn('TELEGRAM_COMMANDS 已开启但白名单为空，入站命令不会启动(安全默认)');
    return;
  }
  running = true;
  log.info({ whitelist: config.telegram.allowedChatIds.length }, 'Telegram 入站命令已启动(getUpdates 长轮询)');
  (async function loop() {
    while (running) {
      try { await pollOnce(); }
      catch (e) { log.warn({ err: e.message }, 'poll 循环异常，2s 后重试'); await new Promise((r) => setTimeout(r, 2000)); }
    }
  })();
}

export function stopTelegramCommands() { running = false; }
