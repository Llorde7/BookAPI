import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../errors.js';
import { requireAuth } from './middleware.js';
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

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const body = registerBody.parse(req.body);
  const passwordHash = await hashPassword(body.password);
  try {
    const customer = await prisma.customer.create({
      data: { email: body.email, name: body.name, phone: body.phone, passwordHash },
      select: publicCustomer,
    });
    res.status(201).json({ customer });
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
    throw new HttpError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const accessToken = await signAccessToken(customer.id);
  res.set('Cache-Control', 'no-store');
  res.json({ accessToken, tokenType: 'Bearer', expiresIn: config.accessTokenTtlSeconds });
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
