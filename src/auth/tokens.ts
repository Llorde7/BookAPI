import { SignJWT, jwtVerify } from 'jose';
import { config, getJwtSecret } from '../config.js';

const ISSUER = 'bookapi';
const AUDIENCE = 'bookapi';
const ALGORITHM = 'HS256';

const key = () => new TextEncoder().encode(getJwtSecret());

// Stateless access token: subject = customer id. There is no refresh token yet, so
// clients log in again when it expires.
export function signAccessToken(
  customerId: string,
  ttlSeconds: number = config.accessTokenTtlSeconds,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(customerId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key());
}

/** Throws if the token is expired, tampered with, or not meant for this API. */
export async function verifyAccessToken(token: string): Promise<{ customerId: string }> {
  const { payload } = await jwtVerify(token, key(), {
    algorithms: [ALGORITHM], // pinned: rejects "none" and algorithm-confusion tricks
    issuer: ISSUER,
    audience: AUDIENCE,
    requiredClaims: ['sub', 'exp'],
  });
  return { customerId: payload.sub as string };
}
