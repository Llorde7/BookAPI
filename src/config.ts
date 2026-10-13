import 'dotenv/config';

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  // How long an unpaid booking holds its slot. Generous on purpose: a paying
  // customer can still take the slot sooner (see appointments.ts).
  holdMinutes: Number(process.env.HOLD_MINUTES ?? 24 * 60),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://bookapi:bookapi@localhost:5432/bookapi',
  // Secret used to sign access tokens. Validated by getJwtSecret(), not here, so
  // scripts that never issue tokens (like the seed) don't need it.
  jwtSecret: process.env.JWT_SECRET,
  // Access tokens are deliberately short-lived (default 15 minutes, max 1 hour).
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60),
  // Max register/login requests per IP per 15 minutes.
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20),
};

export const JWT_SECRET_PLACEHOLDER = 'change-me-to-a-long-random-string-at-least-32-chars';

// Throws a clear error if auth is misconfigured. Called at startup so a bad
// config fails immediately instead of on the first login.
export function getJwtSecret(): string {
  const secret = config.jwtSecret;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET must be set to at least 32 characters (try: openssl rand -base64 48)',
    );
  }
  if (config.nodeEnv === 'production' && secret === JWT_SECRET_PLACEHOLDER) {
    throw new Error('JWT_SECRET is still the placeholder from .env.example');
  }
  const ttl = config.accessTokenTtlSeconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600) {
    throw new Error('ACCESS_TOKEN_TTL_SECONDS must be a whole number between 1 and 3600');
  }
  return secret;
}
