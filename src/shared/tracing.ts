import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

export interface Span {
  spanId: string;
  log: typeof logger;
}

/**
 * Create a traced logger context with traceId, spanId, and operation name.
 * Returns the spanId and a logger-like object that includes trace context.
 */
export function createSpan(traceId: string, operation: string): Span {
  const spanId = randomUUID().slice(0, 8);
  const tracedLog = {
    trace: (obj: unknown, msg?: string) => logger.trace({ ...(typeof obj === 'object' ? obj : {}), traceId, spanId, operation } as any, msg ?? String(obj)),
    debug: (obj: unknown, msg?: string) => logger.debug({ ...(typeof obj === 'object' ? obj : {}), traceId, spanId, operation } as any, msg ?? String(obj)),
    info: (obj: unknown, msg?: string) => logger.info({ ...(typeof obj === 'object' ? obj : {}), traceId, spanId, operation } as any, msg ?? String(obj)),
    warn: (obj: unknown, msg?: string) => logger.warn({ ...(typeof obj === 'object' ? obj : {}), traceId, spanId, operation } as any, msg ?? String(obj)),
    error: (obj: unknown, msg?: string) => logger.error({ ...(typeof obj === 'object' ? obj : {}), traceId, spanId, operation } as any, msg ?? String(obj)),
  };
  return { spanId, log: tracedLog };
}
