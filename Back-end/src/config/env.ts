import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalNonEmptyString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().min(1).optional()
);

const trustProxySchema = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean' || typeof val === 'number') return val;
    if (typeof val !== 'string') return val;

    const trimmed = val.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'false') return false;
    if (trimmed.toLowerCase() === 'true') return true;
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    if (trimmed.includes(',')) {
      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return trimmed;
  },
  z
    .union([
      z.boolean(),
      z.number().int().min(0).max(10),
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
    ])
    .default(false)
);

const envSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_PATH: z.string().min(1).default('./data/deep-work.db'),
  AUDIO_DIR: z.string().min(1).default('./assets/audio'),
  CORS_ORIGIN: z.string().trim().min(1).default('http://localhost:5173'),
  TRUST_PROXY: trustProxySchema,
  GOOGLE_CSE_API_KEY: optionalNonEmptyString,
  GOOGLE_CSE_CX: optionalNonEmptyString,
  STACKEXCHANGE_API_KEY: optionalNonEmptyString,
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(8000),
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  AUTH_REMEMBER_ME_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
