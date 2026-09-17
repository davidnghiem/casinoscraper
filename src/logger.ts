import pino from 'pino';

// JSON-line logging — easy to grep, drop into Loki/Grafana, or pipe through
// `pino-pretty` for local dev. Default INFO; tune via LOG_LEVEL env.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { app: 'casinoscraper' },
  timestamp: pino.stdTimeFunctions.isoTime
});

export type Logger = typeof logger;
