import pino from 'pino';

export const logger = pino({
  level: process.env.COORD_LOG_LEVEL ?? 'info',
});
