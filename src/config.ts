import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // How long an unpaid booking holds its slot. Generous on purpose: a paying
  // customer can still take the slot sooner (see appointments.ts).
  holdMinutes: Number(process.env.HOLD_MINUTES ?? 24 * 60),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://bookapi:bookapi@localhost:5432/bookapi',
};
