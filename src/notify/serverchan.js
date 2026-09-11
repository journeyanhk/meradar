import { config } from '../config.js';
import { child } from '../logger.js';

const log = child('serverchan');

// 会员额度 50 条/分钟。保守限速到 45/min，超出丢弃并计数。
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 45;
let hits = [];
let dropped = 0;

function allow() {
  const now = Date.now();
  hits = hits.filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    dropped++;
    return false;
  }
  hits.push(now);
  return true;
}

export async function sendServerChan(title, desp) {
  if (!config.serverchan.enabled) return false;
  if (!allow()) {
    log.warn({ dropped }, 'Server酱 触发限速，本条丢弃（微信端保护）');
    return false;
  }
  try {
    const body = new URLSearchParams({ title: title.slice(0, 100), desp: desp || '' });
    const res = await fetch(`https://sctapi.ftqq.com/${config.serverchan.sendkey}.send`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await res.json();
    if (j.code !== 0) log.warn({ code: j.code, msg: j.message }, 'Server酱 发送失败');
    return j.code === 0;
  } catch (e) {
    log.warn({ err: e.message }, 'Server酱 请求异常');
    return false;
  }
}
