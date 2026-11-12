import { createApp } from './app';
import { config } from './config';
import { createPool } from './db';

const SHUTDOWN_GRACE_MS = 10_000;

const pool = createPool(config.databaseUrl);
const server = createApp(pool).listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', message: `API listening on :${config.port}` }));
});

// Graceful shutdown: stop accepting, let requests in flight finish, then close the pool.
function shutdown(signal: string) {
  console.log(JSON.stringify({ level: 'info', message: `${signal} received, shutting down` }));
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
