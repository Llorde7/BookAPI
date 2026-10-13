import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { getAuthEnv } from '../env.js';
import { HttpError } from '../errors.js';
import { requireAuth } from './middleware.js';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from './refreshTokens.js';
import { hashPassword, verifyPassword } from './password.js';
import { signAccessToken } from './tokens.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const registerBody = z.object({
  email,
  // Length matters more than composition rules. The upper bound stops
  // someone submitting megabytes to burn CPU in the hash function.
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(1).max(30).optional(),
});

// Our refresh tokens are 43 characters; the cap just stops oversized input.
const refreshBody = z.object({ refreshToken: z.string().min(1).max(512) });

const loginBody = z.object({ email, password: z.string().min(1).max(128) });

// Never select passwordHash into anything that is sent to the client.
const publicCustomer = { id: true, email: true, name: true, phone: true, createdAt: true } as const;

// Per IP, counting every attempt. Slows password guessing and signup spam.
// Behind a reverse proxy, set app.set('trust proxy', ...) so this sees real client IPs.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.authRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many attempts, try again later' },
});

function isUniqueViolation(err: unknown): boolean {
  const text = JSON.stringify(err, Object.getOwnPropertyNames(Object(err)));
  return (err as { code?: unknown } | null)?.code === 'P2002' || text.includes('23505');
}

// The response shape shared by login and refresh.
function sendTokens(res: Response, customerId: string, refreshToken: string) {
  res.set('Cache-Control', 'no-store');
  res.json({
    accessToken: signAccessToken(customerId),
    tokenType: 'Bearer',
    expiresIn: getAuthEnv().ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
  });
}

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = registerBody.parse(req.body);
  const passwordHash = await hashPassword(body.password);
  try {
    const customer = await prisma.customer.create({
      data: { email: body.email, name: body.name, phone: body.phone, passwordHash },
      select: { id: true, email: true },
    });
    res.status(201).json(customer);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    }
    throw err;
  }
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = loginBody.parse(req.body);
  const customer = await prisma.customer.findUnique({
    where: { email: body.email },
    select: { id: true, passwordHash: true },
  });
  const valid = await verifyPassword(customer?.passwordHash, body.password);
  if (!customer || !valid) {
    // Same answer for "no such email" and "wrong password".
    throw new HttpError(401, 'invalid_credentials', 'Invalid credentials');
  }
  const refreshToken = await issueRefreshToken(prisma, customer.id);
  sendTokens(res, customer.id, refreshToken);
});

// Trade a refresh token for a new access token and a NEW refresh token. The old
// refresh token is dead afterwards; replaying it ends all of that customer's sessions.
authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  const rotated = await rotateRefreshToken(refreshToken);
  sendTokens(res, rotated.customerId, rotated.refreshToken);
});

// Ends one session. Needs only the refresh token (the access token may have expired).
// Always 204, so it cannot be used to test whether a token exists.
// The access token already issued stays valid until it expires (15 minutes by default).
authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshBody.parse(req.body);
  await revokeRefreshToken(refreshToken);
  res.status(204).end();
});

// Who am I? Also proves the token works.
authRouter.get('/me', requireAuth, async (req, res) => {
  const customer = await prisma.customer.findUnique({
    where: { id: req.auth!.customerId },
    select: publicCustomer,
  });
  if (!customer) throw new HttpError(401, 'invalid_token', 'Account no longer exists');
  res.json({ customer });
});
