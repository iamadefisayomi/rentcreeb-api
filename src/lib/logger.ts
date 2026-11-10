import pino from 'pino';
import { isProd } from '../config/env';
export const logger = pino(
  isProd ? { level: 'info' } : { level: 'debug', transport: { target: 'pino-pretty' } },
);
