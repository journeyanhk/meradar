import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel || 'info',
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
  base: undefined,
});

export function child(scope) {
  return logger.child({ scope });
}
