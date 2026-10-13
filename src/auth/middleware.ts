import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
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
    req.auth = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      // A different code from "invalid" so a client knows to call /auth/refresh
      // instead of sending the user back to the login screen.
      res.set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="expired"');
      throw new HttpError(401, 'token_expired', 'Access token expired');
    }
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    throw new HttpError(401, 'invalid_token', 'Invalid access token');
  }
  next();
};
