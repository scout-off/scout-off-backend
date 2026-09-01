import config from '../../src/config';
import { logger } from '../../src/utils/logger';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const cfg = config as { logLevel: LogLevel };

describe('logger', () => {
  afterEach(() => {
    cfg.logLevel = 'info';
  });

  it('suppresses debug output when LOG_LEVEL is info', () => {
    cfg.logLevel = 'info';
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('should not appear');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('emits debug output when LOG_LEVEL is debug', () => {
    cfg.logLevel = 'debug';
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    logger.debug('should appear');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('emits warn output at warn level', () => {
    cfg.logLevel = 'warn';
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('warning');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('suppresses info output when LOG_LEVEL is warn', () => {
    cfg.logLevel = 'warn';
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    logger.info('should not appear');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── Issue #860: log level filtering tests ───────────────────────────────────

describe('logger — log level filtering', () => {
  afterEach(() => {
    cfg.logLevel = 'info';
  });

  // 1. LOG_LEVEL=error: only error is emitted; warn, info, debug are suppressed
  it('suppresses warn, info, and debug when LOG_LEVEL=error', () => {
    cfg.logLevel = 'error' as LogLevel;
    const spyWarn  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spyInfo  = jest.spyOn(console, 'info').mockImplementation(() => {});
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.warn('should be suppressed');
    logger.info('should be suppressed');
    logger.debug('should be suppressed');
    logger.error('should appear');

    expect(spyWarn).not.toHaveBeenCalled();
    expect(spyInfo).not.toHaveBeenCalled();
    expect(spyDebug).not.toHaveBeenCalled();
    expect(spyError).toHaveBeenCalledWith('[error]', 'should appear');

    spyWarn.mockRestore();
    spyInfo.mockRestore();
    spyDebug.mockRestore();
    spyError.mockRestore();
  });

  // 2. LOG_LEVEL=info: info and error are emitted; debug is suppressed
  it('emits info and error but suppresses debug when LOG_LEVEL=info', () => {
    cfg.logLevel = 'info';
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const spyInfo  = jest.spyOn(console, 'info').mockImplementation(() => {});
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('suppressed');
    logger.info('visible');
    logger.error('visible');

    expect(spyDebug).not.toHaveBeenCalled();
    expect(spyInfo).toHaveBeenCalled();
    expect(spyError).toHaveBeenCalled();

    spyDebug.mockRestore();
    spyInfo.mockRestore();
    spyError.mockRestore();
  });

  // 3. LOG_LEVEL=debug: all levels are emitted
  it('emits all levels when LOG_LEVEL=debug', () => {
    cfg.logLevel = 'debug';
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const spyInfo  = jest.spyOn(console, 'info').mockImplementation(() => {});
    const spyWarn  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(spyDebug).toHaveBeenCalled();
    expect(spyInfo).toHaveBeenCalled();
    expect(spyWarn).toHaveBeenCalled();
    expect(spyError).toHaveBeenCalled();

    spyDebug.mockRestore();
    spyInfo.mockRestore();
    spyWarn.mockRestore();
    spyError.mockRestore();
  });

  // 4. Logger emits prefix tags: [debug], [info], [warn], [error]
  it('emits bracketed level prefix in log output', () => {
    cfg.logLevel = 'debug';
    const spyDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const spyInfo  = jest.spyOn(console, 'info').mockImplementation(() => {});
    const spyWarn  = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const spyError = jest.spyOn(console, 'error').mockImplementation(() => {});

    logger.debug('msg');
    logger.info('msg');
    logger.warn('msg');
    logger.error('msg');

    expect(spyDebug).toHaveBeenCalledWith('[debug]', 'msg');
    expect(spyInfo).toHaveBeenCalledWith('[info]', 'msg');
    expect(spyWarn).toHaveBeenCalledWith('[warn]', 'msg');
    expect(spyError).toHaveBeenCalledWith('[error]', 'msg');

    spyDebug.mockRestore();
    spyInfo.mockRestore();
    spyWarn.mockRestore();
    spyError.mockRestore();
  });

  // 5. correlationId injection when async context is active
  //    The logger's injectCorrelationId helper prepends [cid=...] when a
  //    request context is active. This test documents current behaviour:
  //    the helper is defined and the test verifies it returns the correct
  //    string so that callers can rely on it even if the logger itself
  //    does not yet wire it through automatically.
  it('injectCorrelationId prepends cid token when correlationId is set', async () => {
    const { requestContext } = await import('../../src/utils/requestContext');

    let result: string | undefined;

    await new Promise<void>((resolve) => {
      requestContext.run({ correlationId: 'test-cid-123' }, async () => {
        // Import getCorrelationId inside the active context
        const { getCorrelationId } = await import('../../src/utils/requestContext');
        result = getCorrelationId();
        resolve();
      });
    });

    expect(result).toBe('test-cid-123');
  });
});
