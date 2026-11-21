import { createApp } from './app.js';
import { env } from './config/env.js';
import { createDatabase } from './db/database.js';

const db = createDatabase(env.DATABASE_PATH);
const app = createApp({
  db,
  audioDir: env.AUDIO_DIR,
  corsOrigin: env.CORS_ORIGIN,
  trustProxy: env.TRUST_PROXY,
  authConfig: {
    sessionTtlHours: env.AUTH_SESSION_TTL_HOURS,
    rememberMeDays: env.AUTH_REMEMBER_ME_DAYS,
  },
  googleAuthConfig: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  },
  searchConfig: {
    googleApiKey: env.GOOGLE_CSE_API_KEY,
    googleCx: env.GOOGLE_CSE_CX,
    stackExchangeApiKey: env.STACKEXCHANGE_API_KEY,
    timeoutMs: env.SEARCH_TIMEOUT_MS,
  },
});

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(
    `[deep-work-backend] listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`
  );
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

function shutdown(signal: string): void {
  console.log(`[deep-work-backend] received ${signal}, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
