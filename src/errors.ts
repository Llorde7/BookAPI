import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

// An error that is safe to show to the client.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Route not found' });
};

// Express only treats a function as an error handler if it declares 4 parameters.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_error',
      message: 'Invalid request',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }
  // Malformed JSON, body too large, etc. (from express.json())
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad_request', message: 'Malformed request' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
};
