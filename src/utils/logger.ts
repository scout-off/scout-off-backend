import config from '../config';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

function shouldLog(level: keyof typeof LEVELS): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel];
}

export const logger = {
  debug: (...args: unknown[]) => shouldLog('debug') && console.debug('[debug]', ...args),
  info: (...args: unknown[]) => shouldLog('info') && console.info('[info]', ...args),
  warn: (...args: unknown[]) => shouldLog('warn') && console.warn('[warn]', ...args),
  error: (...args: unknown[]) => shouldLog('error') && console.error('[error]', ...args),
};
