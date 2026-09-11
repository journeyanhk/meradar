import { config } from '../config.js';
import { child } from '../logger.js';

const log = child('telegram');

export async function sendTelegram(text, { silent = false } = {}) {
  if (!config.telegram.enabled) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: silent,
      }),
    });
    const j = await res.json();
    if (!j.ok) log.warn({ desc: j.description }, 'Telegram 发送失败');
    return j.ok;
  } catch (e) {
    log.warn({ err: e.message }, 'Telegram 请求异常');
    return false;
  }
}
