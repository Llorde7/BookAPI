import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db.js';
import { getAuthEnv } from '../env.js';
import { HttpError } from '../errors.js';

type Db = Prisma.TransactionClient | typeof prisma;

const DAY_MS = 24 * 60 * 60 * 1000;

// The raw token is 256 random bits, so a fast hash is enough here (unlike passwords).
export const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

// Every failure looks the same to the client: no hint whether a token never existed,
// expired, was already used, or was logged out.
const invalid = () => new HttpError(401, 'invalid_refresh_token', 'Invalid refresh token');

/** Creates a refresh token for the customer. The raw value is returned once and only its hash is stored. */
export async function issueRefreshToken(db: Db, customerId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.refreshToken.create({
    data: {
      customerId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + getAuthEnv().REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    },
  });
  return token;
}

async function revokeAllForCustomer(customerId: string, at: Date) {
  await prisma.refreshToken.updateMany({
    where: { customerId, revokedAt: null },
    data: { revokedAt: at },
  });
}

// A used or revoked token showing up again means it was stolen or replayed (or two
// requests raced with it). We cannot tell which token the thief holds, so every
// session for that customer is ended and they log in again.
async function rejectReuse(customerId: string): Promise<never> {
  await revokeAllForCustomer(customerId, new Date());
  console.warn(`Refresh token reuse detected: revoked all sessions for customer ${customerId}`);
  throw invalid();
}

/**
 * Exchanges a refresh token for a new one (rotation). The old token stops working
 * immediately; presenting it again revokes all of the customer's sessions.
 */
export async function rotateRefreshToken(
  rawToken: string,
): Promise<{ customerId: string; refreshToken: string }> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
  });
  if (!stored) throw invalid();
  if (stored.revokedAt) return rejectReuse(stored.customerId);
  if (stored.expiresAt <= new Date()) throw invalid(); // just expired: not a sign of theft

  const rotated = await prisma.$transaction(async (tx) => {
    // Only one request can flip revokedAt from null; the database decides who wins a race.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count !== 1) return null;
    return issueRefreshToken(tx, stored.customerId);
  });
  if (!rotated) return rejectReuse(stored.customerId); // another request used it first
  return { customerId: stored.customerId, refreshToken: rotated };
}

/** Logs out one session. Idempotent: an unknown or already-revoked token is not an error. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
