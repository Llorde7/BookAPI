import type { RequestHandler } from 'express';
import { HttpError } from '../errors.js';
import { verifyAccessToken } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      auth?: { customerId: string };
    }
  }
}

// Protects a route: requires "Authorization: Bearer <access token>".
export const requireAuth: RequestHandler = async (req, res, next) => {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    res.set('WWW-Authenticate', 'Bearer');
    throw new HttpError(401, 'unauthorized', 'Missing access token');
  }
  try {
    req.auth = await verifyAccessToken(token);
  } catch {
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    throw new HttpError(401, 'invalid_token', 'Invalid or expired access token');
  }
  next();
};
