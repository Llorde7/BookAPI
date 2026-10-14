import express from 'express';
import { authRouter } from './auth/routes.js';
import { bookingsRouter } from './bookings/routes.js';
import { prisma } from './db.js';
import { errorHandler, notFound } from './errors.js';

export const app = express();

app.disable('x-powered-by');
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'up' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

app.use('/auth', authRouter);
app.use('/bookings', bookingsRouter);

app.use(notFound);
app.use(errorHandler);
