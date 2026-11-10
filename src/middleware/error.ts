import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler = (_req: Request, res: Response) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError)
    return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid input',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: { code: err.code ?? 'ERROR', message: err.message, details: err.details } });
  if ((err as any)?.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'File too large' } });
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
