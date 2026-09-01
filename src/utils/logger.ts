import config from '../config';
import { getCorrelationId } from './requestContext';
import { redactLogArg } from './logRedaction';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 } as const;

function shouldLog(level: keyof typeof LEVELS): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel as keyof typeof LEVELS] ?? 0;
}

/**
 * Prepends a `correlationId=<id>` token to the first string argument when an
 * AsyncLocalStorage request context is active.  Non-string first arguments
 * (e.g. Error objects passed directly) are left untouched so callers don't
 * need to know about context at all.
 */
function injectCorrelationId(args: unknown[]): unknown[] {
  const cid = getCorrelationId();
  if (!cid) return args;
  if (args.length > 0 && typeof args[0] === 'string') {
    return [`[cid=${cid}] ${args[0]}`, ...args.slice(1)];
  }
  // Prepend a labelled string so the CID is always the first token in the log line.
  return [`[cid=${cid}]`, ...args];
}

export const logger = {
  debug:    (...args: unknown[]) => shouldLog('debug')    && console.debug('[debug]',    ...injectCorrelationId(args).map(redactLogArg).map(sanitizeLogArg)),
  info:     (...args: unknown[]) => shouldLog('info')     && console.info('[info]',     ...injectCorrelationId(args).map(redactLogArg).map(sanitizeLogArg)),
  warn:     (...args: unknown[]) => shouldLog('warn')     && console.warn('[warn]',     ...injectCorrelationId(args).map(redactLogArg).map(sanitizeLogArg)),
  error:    (...args: unknown[]) => shouldLog('error')    && console.error('[error]',   ...injectCorrelationId(args).map(redactLogArg).map(sanitizeLogArg)),
  critical: (...args: unknown[]) => console.error('[critical]', ...injectCorrelationId(args).map(redactLogArg).map(sanitizeLogArg)),
};

function sanitizeLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') {
    // Strip newlines to prevent log forging (CWE-117)
    return arg.replace(/[\r\n]+/g, ' ');
  }
  return arg;
}
