import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

export interface Span {
  spanId: string;
  logger: Logger;
}

/**
 * Create a child logger annotated with traceId, a new spanId, and an
 * operation name.  The returned spanId can be forwarded to downstream
 * systems so that all log lines for a single logical operation share the
 * same trace context.
 */
export function createSpan(logger: Logger, traceId: string, operation: string): Span {
  const spanId = randomUUID().slice(0, 8);
  return {
    spanId,
    logger: logger.child({ traceId, spanId, operation }),
  };
}
