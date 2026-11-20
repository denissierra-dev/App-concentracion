import { createApp } from './app.js';
import { env } from './config/env.js';
import { createDatabase } from './db/database.js';

const db = createDatabase(env.DATABASE_PATH);
const app = createApp({
  db,
  corsOrigin: env.CORS_ORIGIN,
});

const server = app.listen(env.PORT, () => {
  console.log(`[deep-work-backend] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`[deep-work-backend] received ${signal}, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
