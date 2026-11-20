import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalNonEmptyString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().min(1).optional()
);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_PATH: z.string().min(1).default('./data/deep-work.db'),
  AUDIO_DIR: z.string().min(1).default('./assets/audio'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  GOOGLE_CSE_API_KEY: optionalNonEmptyString,
  GOOGLE_CSE_CX: optionalNonEmptyString,
  STACKEXCHANGE_API_KEY: optionalNonEmptyString,
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(8000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
