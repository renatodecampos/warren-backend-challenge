import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { createRoutes } from './routes';

const SAFE_REQUEST_ID = /^[\w.-]{8,100}$/;

function log(level: 'info' | 'error', entry: Record<string, unknown>) {
  if (process.env.NODE_ENV === 'test') return;
  const line = JSON.stringify({ level, ...entry });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Gives every request an id, returned in `X-Request-Id` and written in its log line. */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  // The id is echoed in a header and in logs, so an incoming one is only reused when it is a plain token.
  const requestId = incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    log('info', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
};

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
};

/** body-parser reports a body it could not read (bad JSON, too large) as an error with a 4xx status. */
function isUnreadableBody(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('type' in err) || !('status' in err)) return false;
  return typeof err.status === 'number' && err.status >= 400 && err.status < 500;
}

/** PostgreSQL's `lock_not_available` and `query_canceled`: what `lock_timeout` and `statement_timeout` raise. */
const TIMEOUT_CODES = new Set(['55P03', '57014']);

function isDatabaseTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && TIMEOUT_CODES.has(String(err.code));
}

/** Turns every failure into the one error shape. Anything unexpected is logged, never shown. */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (isUnreadableBody(err)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is not valid JSON' } });
    return;
  }
  if (isDatabaseTimeout(err)) {
    res.status(503).json({ error: { code: 'BUSY', message: 'The server is busy; retry the request' } });
    return;
  }
  log('error', {
    requestId: res.getHeader('X-Request-Id'),
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
};

export function createApp(pool: Pool): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use(express.json({ limit: '10kb' }));
  app.use(createRoutes(pool));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
