import jwt from 'jsonwebtoken';
import { getAuthEnv } from '../env.js';

const ISSUER = 'bookapi';
const AUDIENCE = 'bookapi';
const ALGORITHM = 'HS256';

// Stateless access token: subject = customer id. There is no refresh token yet, so
// clients log in again when it expires.
export function signAccessToken(
  customerId: string,
  ttlSeconds: number = getAuthEnv().ACCESS_TOKEN_TTL_SECONDS,
): string {
  return jwt.sign({}, getAuthEnv().JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: customerId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ttlSeconds,
  });
}

/** Throws if the token is expired, tampered with, or not meant for this API. */
export function verifyAccessToken(token: string): { customerId: string } {
  const payload = jwt.verify(token, getAuthEnv().JWT_SECRET, {
    algorithms: [ALGORITHM], // pinned: rejects "none" and algorithm-confusion tricks
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  // jsonwebtoken accepts tokens that have no expiry; this API never does.
  if (typeof payload === 'string' || !payload.sub || typeof payload.exp !== 'number') {
    throw new Error('Token is missing required claims');
  }
  return { customerId: payload.sub };
}
