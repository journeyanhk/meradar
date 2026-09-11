import { config } from './config.js';
import { startServer } from './server.js';
import { startEngine } from './engine.js';
import { logger } from './logger.js';

async function main() {
  logger.info({ chains: config.enabledChains }, 'Meme 雷达启动中…');

  if (!config.telegram.enabled) logger.warn('Telegram 未配置（.env: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID）');
  if (!config.serverchan.enabled) logger.warn('Server酱 未配置（.env: SERVERCHAN_SENDKEY）');

  await startServer();

  // 允许仅启动 Web（无 RPC 时也能看历史）；有 RPC 才启动链引擎
  const hasRpc = config.enabledChains.some((c) => config.rpc[c]?.http || config.rpc[c]?.ws);
  if (hasRpc) {
    startEngine();
  } else {
    logger.warn('未配置任何链 RPC，仅启动 Web（不监听链上事件）');
  }
}

main().catch((e) => {
  logger.error({ err: e.message, stack: e.stack }, '启动失败');
  process.exit(1);
});

process.on('unhandledRejection', (e) => logger.error({ err: e?.message }, 'unhandledRejection'));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
