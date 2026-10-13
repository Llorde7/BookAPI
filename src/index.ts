import { app } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { getAuthEnv } from './env.js';

// Refuse to boot on a missing or weak JWT_SECRET instead of failing on the first login.
try {
  getAuthEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  console.log(`BookAPI listening on :${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
