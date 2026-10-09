import { app } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

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
