import 'dotenv/config';
import { z } from 'zod';

export const JWT_SECRET_PLACEHOLDER = 'change-me-to-a-long-random-string-at-least-32-chars';

const authEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    JWT_SECRET: z
      .string({ error: 'is required' })
      .min(32, 'must be at least 32 characters (try: openssl rand -base64 48)'),
    // Access tokens are deliberately short-lived: default 15 minutes, max 1 hour.
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3600)
      .default(15 * 60),
    // Refresh tokens last much longer so users stay logged in: default 30 days, max 90.
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET === JWT_SECRET_PLACEHOLDER) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'must not be the placeholder from .env.example',
      });
    }
  });

export type AuthEnv = z.infer<typeof authEnvSchema>;

/** Validates the auth settings. Throws one readable error that never contains the secret. */
export function loadAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const result = authEnvSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: AuthEnv | undefined;

/** Validated once, on first use. index.ts calls it at startup so a bad config stops the boot. */
export function getAuthEnv(): AuthEnv {
  return (cached ??= loadAuthEnv());
}
