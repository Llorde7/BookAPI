import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = app.listen(config.port, () => {
  console.log(`BookAPI listening on :${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
