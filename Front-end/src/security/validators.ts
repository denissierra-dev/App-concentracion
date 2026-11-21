import { z } from 'zod';

export const SESSION_LIMITS = {
  MIN_FOCUS_MIN: 5,
  MAX_FOCUS_MIN: 180,
  MIN_CYCLES: 1,
  MAX_CYCLES: 12,
  CYCLES_BEFORE_LONG_BREAK: 4,
  SHORT_BREAK_STANDARD_MIN: 5,
  SHORT_BREAK_EXTENDED_MIN: 10,
  LONG_BREAK_MIN: 20,
  MIN_LONG_BREAK_MIN: 5,
  MAX_LONG_BREAK_MIN: 120,
  EXTENDED_FOCUS_THRESHOLD_MIN: 40,
} as const;

export const TASK_LIMITS = {
  TITLE_MIN_LEN: 1,
  TITLE_MAX_LEN: 200,
  DESCRIPTION_MAX_LEN: 2000,
  TAG_MIN_LEN: 1,
  TAG_MAX_LEN: 32,
  MAX_TAGS_PER_TASK: 10,
  SEARCH_MAX_LEN: 100,
} as const;

export const SEARCH_LIMITS = {
  QUERY_MIN_LEN: 1,
  QUERY_MAX_LEN: 500,
  MIN_LIMIT: 1,
  MAX_LIMIT: 20,
  HISTORY_MAX_LIMIT: 100,
} as const;

export const AUTH_LIMITS = {
  USERNAME_MIN_LEN: 3,
  USERNAME_MAX_LEN: 32,
  PASSWORD_MIN_LEN: 8,
  PASSWORD_MAX_LEN: 128,
  DISPLAY_NAME_MAX_LEN: 80,
  EMAIL_MAX_LEN: 254,
} as const;

export const STATS_LIMITS = {
  MIN_DAYS: 1,
  MAX_DAYS: 365,
  DEFAULT_DAYS: 30,
} as const;

export class SecurityValidationError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'SECURITY_VALIDATION_ERROR') {
    super(message);
    this.name = 'SecurityValidationError';
    this.code = code;
  }
}

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Control characters (C0, DEL, C1) and Unicode bidirectional override characters
// eslint-disable-next-line no-control-regex
const CONTROL_AND_BIDI_PATTERN = '[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]';
const CONTROL_AND_BIDI_TEST_REGEX = new RegExp(CONTROL_AND_BIDI_PATTERN);
const CONTROL_AND_BIDI_REPLACE_REGEX = new RegExp(CONTROL_AND_BIDI_PATTERN, 'g');

// For multiline text (task descriptions), allow '\n' (0x0A) while still blocking all other control/bidi chars
const MULTILINE_CONTROL_PATTERN =
  '[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]';
const MULTILINE_CONTROL_TEST_REGEX = new RegExp(MULTILINE_CONTROL_PATTERN);
const MULTILINE_CONTROL_REPLACE_REGEX = new RegExp(MULTILINE_CONTROL_PATTERN, 'g');

const UNSAFE_MARKUP_REGEX = /[<>]/;
const UNSAFE_SCHEME_REGEX = /(javascript|vbscript|data|file):/i;
const SAFE_TRACK_ID_REGEX = /^[a-z0-9-]{1,64}$/;
const SAFE_AUDIO_STREAM_PATH_REGEX = /^\/api\/v1\/audio\/tracks\/[a-z0-9-]{1,64}\/stream$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_CODE_REGEX = /^[a-z]{2}(-[a-z]{2})?$/i;
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;
const BEARER_TOKEN_REGEX = /^[A-Za-z0-9._~+/=-]{16,512}$/;

/**
 * Strips control, null, and bidi-spoofing characters from plain single-line text.
 */
export function sanitizePlainText(value: string, maxLength = 240): string {
  const cleaned = value.replace(CONTROL_AND_BIDI_REPLACE_REGEX, '').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength);
}

/**
 * Strips dangerous control/bidi chars from multiline text while preserving safe line breaks.
 */
export function sanitizeMultilineText(value: string, maxLength = 2000): string {
  const cleaned = value.replace(MULTILINE_CONTROL_REPLACE_REGEX, '').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength);
}

/**
 * Rejects strings containing HTML delimiters, control characters, CRLF, or unsafe URI schemes.
 */
export function assertNoInjectionChars(
  value: string,
  fieldName = 'input',
  options?: { allowNewlines?: boolean }
): string {
  const controlRegex = options?.allowNewlines
    ? MULTILINE_CONTROL_TEST_REGEX
    : CONTROL_AND_BIDI_TEST_REGEX;

  if (controlRegex.test(value)) {
    throw new SecurityValidationError(
      `Invalid control characters detected in ${fieldName}`,
      'INJECTION_CONTROL_CHARS'
    );
  }

  if (UNSAFE_MARKUP_REGEX.test(value)) {
    throw new SecurityValidationError(
      `Disallowed markup characters detected in ${fieldName}`,
      'INJECTION_MARKUP_CHARS'
    );
  }

  if (UNSAFE_SCHEME_REGEX.test(value)) {
    throw new SecurityValidationError(
      `Disallowed URI scheme detected in ${fieldName}`,
      'INJECTION_URI_SCHEME'
    );
  }

  return value;
}

/**
 * Parses JSON safely while blocking prototype pollution keys (`__proto__`, `constructor`, `prototype`).
 */
export function safeJsonParse(raw: string, maxBytes = 1_048_576): unknown {
  if (typeof raw !== 'string') {
    throw new SecurityValidationError('Expected JSON string payload', 'INVALID_JSON_TYPE');
  }
  if (raw.length > maxBytes) {
    throw new SecurityValidationError('JSON payload exceeds maximum allowed size', 'PAYLOAD_TOO_LARGE');
  }

  return JSON.parse(raw, (key, val: unknown) => {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new SecurityValidationError(
        `Blocked forbidden key "${key}" in JSON payload`,
        'PROTOTYPE_POLLUTION_BLOCKED'
      );
    }
    return val;
  });
}

/**
 * Validates that an API path is strictly a relative `/api/v1/...` path without traversal or CRLF.
 */
export function assertSafeApiPath(path: string): string {
  assertNoInjectionChars(path, 'apiPath');
  if (!path.startsWith('/api/v1/')) {
    throw new SecurityValidationError('API path must start with /api/v1/', 'UNSAFE_API_PATH');
  }
  if (path.includes('..') || path.includes('\\') || path.startsWith('//')) {
    throw new SecurityValidationError('Path traversal or protocol-relative URL blocked', 'PATH_TRAVERSAL');
  }
  return path;
}

/**
 * Validates a track or entity ID and returns an encoded path segment.
 */
export function safePathSegment(value: string, schema: z.ZodType<string>): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SecurityValidationError('Invalid identifier for path segment', 'INVALID_PATH_SEGMENT');
  }
  return encodeURIComponent(parsed.data);
}

/**
 * Validates a same-origin audio stream URL returned by the backend.
 */
export function assertSafeAudioStreamUrl(url: string): string {
  assertNoInjectionChars(url, 'streamUrl');
  if (!SAFE_AUDIO_STREAM_PATH_REGEX.test(url)) {
    throw new SecurityValidationError('Untrusted audio stream URL blocked', 'UNSAFE_MEDIA_URL');
  }
  return url;
}

/**
 * Validates that an external link is strictly http: or https:
 * without embedded credentials, control chars, or scriptable schemes.
 */
export function assertSafeExternalHttpUrl(rawUrl: string): string {
  if (CONTROL_AND_BIDI_TEST_REGEX.test(rawUrl)) {
    throw new SecurityValidationError('External URL contains control characters', 'UNSAFE_EXTERNAL_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SecurityValidationError('Invalid external URL format', 'UNSAFE_EXTERNAL_URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SecurityValidationError(
      `Disallowed external URL protocol: ${parsed.protocol}`,
      'UNSAFE_EXTERNAL_URL'
    );
  }

  if (parsed.username || parsed.password) {
    throw new SecurityValidationError('Credentials in external URL are blocked', 'UNSAFE_EXTERNAL_URL');
  }

  return parsed.toString();
}

// --- Core Primitive Schemas ---

export const uuidSchema = z
  .string()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'El UUID contiene caracteres de control no permitidos',
  })
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(UUID_REGEX, 'Debe ser un UUID válido (formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)'));

export const trackIdSchema = z
  .string()
  .trim()
  .regex(SAFE_TRACK_ID_REGEX, 'Track ID inválido');

export const authTokenSchema = z
  .string()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'Token contiene caracteres inválidos',
  })
  .transform((v) => v.trim())
  .pipe(z.string().regex(BEARER_TOKEN_REGEX, 'Token de sesión inválido'));

const safeTextSchema = (maxLen = 200) =>
  z.string().transform((val) => sanitizePlainText(val, maxLen));

const safeMultilineTextSchema = (maxLen = 2000) =>
  z.string().transform((val) => sanitizeMultilineText(val, maxLen));

const safeAudioStreamUrlSchema = z
  .string()
  .refine((val) => SAFE_AUDIO_STREAM_PATH_REGEX.test(val), {
    message: 'Stream URL must match /api/v1/audio/tracks/<id>/stream',
  });

export const safeExternalUrlSchema = z.string().transform((val, ctx) => {
  try {
    return assertSafeExternalHttpUrl(val);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'URL externa insegura o inválida bloqueada',
    });
    return z.NEVER;
  }
});

function safeSingleLineInputSchema(fieldLabel: string, minLen: number, maxLen: number) {
  return z
    .string()
    .superRefine((val, ctx) => {
      if (CONTROL_AND_BIDI_TEST_REGEX.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldLabel} contiene caracteres de control no permitidos`,
        });
      }
      if (UNSAFE_MARKUP_REGEX.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No se permiten los caracteres < o > en ${fieldLabel.toLowerCase()}`,
        });
      }
      if (UNSAFE_SCHEME_REGEX.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Esquema URI no permitido en ${fieldLabel.toLowerCase()}`,
        });
      }
    })
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .min(minLen, `${fieldLabel} requiere al menos ${minLen} carácter(es)`)
        .max(maxLen, `${fieldLabel} permite máximo ${maxLen} caracteres`)
    );
}

function safeUserDescriptionSchema() {
  return z
    .string()
    .superRefine((val, ctx) => {
      if (MULTILINE_CONTROL_TEST_REGEX.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'La descripción contiene caracteres de control no permitidos',
        });
      }
      if (UNSAFE_MARKUP_REGEX.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'No se permiten los caracteres < o > en la descripción',
        });
      }
      if (UNSAFE_SCHEME_REGEX.test(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Esquema URI no permitido en la descripción',
        });
      }
    })
    .transform((v) => v.trim())
    .pipe(
      z
        .string()
        .max(
          TASK_LIMITS.DESCRIPTION_MAX_LEN,
          `Máximo ${TASK_LIMITS.DESCRIPTION_MAX_LEN} caracteres`
        )
    );
}

// --- Auth Input Schemas (Section 4.2) ---

export const usernameInputSchema = z
  .string()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'El usuario contiene caracteres de control no permitidos',
  })
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .regex(
        USERNAME_REGEX,
        'Usuario: 3–32 caracteres alfanuméricos, guion, punto o guion bajo'
      )
  );

export const emailInputSchema = safeSingleLineInputSchema(
  'El correo',
  3,
  AUTH_LIMITS.EMAIL_MAX_LEN
).pipe(z.string().email('Ingresa un correo electrónico válido'));

export const registerPasswordSchema = z
  .string()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'La contraseña contiene caracteres de control no permitidos',
  })
  .pipe(
    z
      .string()
      .min(
        AUTH_LIMITS.PASSWORD_MIN_LEN,
        `La contraseña debe tener al menos ${AUTH_LIMITS.PASSWORD_MIN_LEN} caracteres`
      )
      .max(AUTH_LIMITS.PASSWORD_MAX_LEN, 'La contraseña excede el máximo permitido')
  );

export const loginPasswordSchema = z
  .string()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'La contraseña contiene caracteres de control no permitidos',
  })
  .pipe(
    z
      .string()
      .min(1, 'Ingresa tu contraseña')
      .max(AUTH_LIMITS.PASSWORD_MAX_LEN, 'La contraseña excede el máximo permitido')
  );

export const registerInputSchema = z
  .object({
    username: usernameInputSchema,
    password: registerPasswordSchema,
    email: emailInputSchema.nullable().optional(),
    displayName: safeSingleLineInputSchema('El nombre', 1, AUTH_LIMITS.DISPLAY_NAME_MAX_LEN)
      .nullable()
      .optional(),
    rememberMe: z.boolean().optional(),
    deviceLabel: safeSingleLineInputSchema('Dispositivo', 1, 80).optional(),
  })
  .strict();

export const loginInputSchema = z
  .object({
    identifier: safeSingleLineInputSchema('Usuario o correo', 1, AUTH_LIMITS.EMAIL_MAX_LEN),
    password: loginPasswordSchema,
    rememberMe: z.boolean().optional(),
    deviceLabel: safeSingleLineInputSchema('Dispositivo', 1, 80).optional(),
  })
  .strict();

const googleOpaqueFieldSchema = z
  .string()
  .trim()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'Credencial de Google contiene caracteres no permitidos',
  });

export const googleAuthInputSchema = z
  .union([
    z
      .object({
        idToken: googleOpaqueFieldSchema.pipe(z.string().min(10).max(8192)),
        rememberMe: z.boolean().optional(),
        deviceLabel: safeSingleLineInputSchema('Dispositivo', 1, 80).optional(),
      })
      .strict(),
    z
      .object({
        code: googleOpaqueFieldSchema.pipe(z.string().min(4).max(2048)),
        redirectUri: safeExternalUrlSchema,
        codeVerifier: googleOpaqueFieldSchema.pipe(z.string().min(16).max(256)).optional(),
        rememberMe: z.boolean().optional(),
        deviceLabel: safeSingleLineInputSchema('Dispositivo', 1, 80).optional(),
      })
      .strict(),
  ]);

// --- Input Schemas (Client -> Server) ---

export const themePreferenceSchema = z.enum(['light', 'dark', 'system']);

export const appThemeSchema = z.enum([
  'system',
  'light',
  'dark',
  'blue',
  'purple',
  'red',
  'orange',
  'green',
]);

export const createSessionInputSchema = z
  .object({
    sessionId: uuidSchema.optional(),
    focusDurationMin: z
      .number()
      .finite()
      .int('La duración debe ser un número entero de minutos')
      .min(SESSION_LIMITS.MIN_FOCUS_MIN, `Mínimo ${SESSION_LIMITS.MIN_FOCUS_MIN} minutos`)
      .max(SESSION_LIMITS.MAX_FOCUS_MIN, `Máximo ${SESSION_LIMITS.MAX_FOCUS_MIN} minutos`),
    totalCycles: z
      .number()
      .finite()
      .int('Los ciclos deben ser un número entero')
      .min(SESSION_LIMITS.MIN_CYCLES, `Mínimo ${SESSION_LIMITS.MIN_CYCLES} ciclo`)
      .max(SESSION_LIMITS.MAX_CYCLES, `Máximo ${SESSION_LIMITS.MAX_CYCLES} ciclos`),
  })
  .strict();

export const updatePreferencesInputSchema = z
  .object({
    focusDurationMin: z
      .number()
      .finite()
      .int()
      .min(SESSION_LIMITS.MIN_FOCUS_MIN)
      .max(SESSION_LIMITS.MAX_FOCUS_MIN)
      .optional(),
    shortBreakMin: z.number().finite().int().min(1).max(60).optional(),
    longBreakMin: z
      .number()
      .finite()
      .int()
      .min(SESSION_LIMITS.MIN_LONG_BREAK_MIN)
      .max(SESSION_LIMITS.MAX_LONG_BREAK_MIN)
      .optional(),
    cyclesBeforeLongBreak: z
      .number()
      .finite()
      .int()
      .min(SESSION_LIMITS.MIN_CYCLES)
      .max(SESSION_LIMITS.MAX_CYCLES)
      .optional(),
    volumeFocus: z.number().finite().min(0).max(1).optional(),
    volumeBreak: z.number().finite().min(0).max(1).optional(),
    notificationsEnabled: z.boolean().optional(),
    theme: themePreferenceSchema.optional(),
  })
  .strict()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'Debes modificar al menos una preferencia',
  });

export const priorityLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const userTaskPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

export const taskTagSchema = safeSingleLineInputSchema(
  'La etiqueta',
  TASK_LIMITS.TAG_MIN_LEN,
  TASK_LIMITS.TAG_MAX_LEN
);

export const taskTagsArraySchema = z
  .array(taskTagSchema)
  .max(TASK_LIMITS.MAX_TAGS_PER_TASK, `Máximo ${TASK_LIMITS.MAX_TAGS_PER_TASK} etiquetas por tarea`);

export const createTaskInputSchema = z
  .object({
    id: uuidSchema.optional(),
    title: safeSingleLineInputSchema('El título', TASK_LIMITS.TITLE_MIN_LEN, TASK_LIMITS.TITLE_MAX_LEN),
    description: safeUserDescriptionSchema().nullable().optional(),
    userPriority: userTaskPrioritySchema.optional(),
    tags: taskTagsArraySchema.optional(),
    dueAt: z.number().finite().int().positive().nullable().optional(),
  })
  .strict();

export const updateTaskInputSchema = z
  .object({
    title: safeSingleLineInputSchema(
      'El título',
      TASK_LIMITS.TITLE_MIN_LEN,
      TASK_LIMITS.TITLE_MAX_LEN
    ).optional(),
    description: safeUserDescriptionSchema().nullable().optional(),
    completed: z.boolean().optional(),
    userPriority: userTaskPrioritySchema.optional(),
    tags: taskTagsArraySchema.optional(),
    dueAt: z.number().finite().int().positive().nullable().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.title !== undefined ||
      data.description !== undefined ||
      data.completed !== undefined ||
      data.userPriority !== undefined ||
      data.tags !== undefined ||
      data.dueAt !== undefined,
    { message: 'Debes modificar al menos un campo de la tarea' }
  );

export const taskQuerySchema = z
  .object({
    status: z.enum(['all', 'pending', 'completed']).optional(),
    priority: priorityLevelSchema.optional(),
    tag: taskTagSchema.optional(),
    search: safeSingleLineInputSchema('La búsqueda', 1, TASK_LIMITS.SEARCH_MAX_LEN).optional(),
    overdue: z.boolean().optional(),
    hasDueDate: z.boolean().optional(),
    sortBy: z.enum(['default', 'priority', 'dueAt', 'createdAt', 'updatedAt']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

// --- Search Input Schemas (Phase 7) ---

export const searchEngineSchema = z.enum(['google', 'wikipedia', 'stackoverflow']);

export const searchLangSchema = z
  .string()
  .trim()
  .regex(LANG_CODE_REGEX, 'Código de idioma inválido (ej. es, en, es-mx)')
  .transform((v) => v.toLowerCase());

export const searchQueryInputSchema = z
  .object({
    q: safeSingleLineInputSchema(
      'La consulta',
      SEARCH_LIMITS.QUERY_MIN_LEN,
      SEARCH_LIMITS.QUERY_MAX_LEN
    ),
    engine: searchEngineSchema.default('wikipedia'),
    limit: z
      .number()
      .finite()
      .int()
      .min(SEARCH_LIMITS.MIN_LIMIT)
      .max(SEARCH_LIMITS.MAX_LIMIT)
      .default(10),
    lang: searchLangSchema.default('en'),
    saveHistory: z.boolean().default(true),
  })
  .strict();

export const searchHistoryQuerySchema = z
  .object({
    engine: searchEngineSchema.optional(),
    limit: z
      .number()
      .finite()
      .int()
      .min(1)
      .max(SEARCH_LIMITS.HISTORY_MAX_LIMIT)
      .optional(),
  })
  .strict();

// --- Stats Input Schemas (Phase 8) ---

export const statsDaysSchema = z
  .number()
  .finite()
  .int()
  .min(STATS_LIMITS.MIN_DAYS)
  .max(STATS_LIMITS.MAX_DAYS);

export const statsExportFormatSchema = z.enum(['json', 'csv']);

// --- Response Schemas (Server -> Client) ---
// Using default Zod stripping so unexpected/extraneous fields are dropped safely.

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.number().finite().nonnegative(),
});

export const timeResponseSchema = z.object({
  serverTimeMs: z.number().finite().positive(),
  iso: safeTextSchema(64),
});

export const preferenceSchema = z.object({
  userId: uuidSchema,
  focusDurationMin: z.number().int().min(1).max(180),
  shortBreakMin: z.number().int().min(1).max(60),
  longBreakMin: z
    .number()
    .int()
    .min(SESSION_LIMITS.MIN_LONG_BREAK_MIN)
    .max(SESSION_LIMITS.MAX_LONG_BREAK_MIN),
  cyclesBeforeLongBreak: z.number().int().min(1).max(12),
  volumeFocus: z.number().min(0).max(1),
  volumeBreak: z.number().min(0).max(1),
  notificationsEnabled: z.boolean(),
  theme: themePreferenceSchema,
  updatedAt: z.number().finite().nonnegative(),
});

export const authProviderTypeSchema = z.enum(['password', 'google', 'device']);

export const publicUserSchema = z.object({
  id: uuidSchema,
  authProvider: authProviderTypeSchema,
  deviceId: uuidSchema.optional(),
  username: safeTextSchema(64).nullable().optional(),
  email: safeTextSchema(254).nullable().optional(),
  emailVerified: z.boolean().optional(),
  displayName: safeTextSchema(80).nullable().optional(),
  avatarUrl: safeExternalUrlSchema.nullable().optional(),
  hasPassword: z.boolean().optional(),
  hasGoogleLinked: z.boolean().optional(),
  createdAt: z.number().finite().nonnegative(),
});

export const authProvidersResponseSchema = z.object({
  providers: z.object({
    password: z.object({ enabled: z.boolean() }),
    google: z.object({
      enabled: z.boolean(),
      codeFlowEnabled: z.boolean(),
      clientId: safeTextSchema(200).nullable().optional(),
    }),
    device: z.object({ enabled: z.boolean() }),
  }),
  serverTimeMs: z.number().finite().positive(),
});

export const authSessionSummarySchema = z.object({
  id: uuidSchema,
  persistent: z.boolean(),
  expiresAt: z.number().finite().positive(),
  deviceLabel: safeTextSchema(80).nullable().optional(),
});

export const authSuccessResponseSchema = z.object({
  token: authTokenSchema,
  tokenType: z.literal('Bearer'),
  expiresAt: z.number().finite().positive(),
  rememberMe: z.boolean(),
  provider: authProviderTypeSchema,
  created: z.boolean(),
  user: publicUserSchema,
  preferences: preferenceSchema.nullable(),
  session: authSessionSummarySchema,
});

export const authDeviceResponseSchema = z.object({
  deviceId: uuidSchema,
  created: z.boolean(),
  user: z.object({
    id: uuidSchema,
    authProvider: z.literal('device'),
    createdAt: z.number().finite().nonnegative(),
  }),
  preferences: preferenceSchema.nullable(),
});

export const authMeResponseSchema = z.object({
  provider: authProviderTypeSchema,
  user: publicUserSchema,
  preferences: preferenceSchema.nullable(),
  session: authSessionSummarySchema.nullable().optional(),
});

export const authLinkGoogleResponseSchema = z.object({
  linked: z.literal(true),
  user: publicUserSchema,
});

export const authLogoutResponseSchema = z.object({
  loggedOut: z.literal(true),
  revokedCount: z.number().int().nonnegative().optional(),
});

export const authSessionEntrySchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  provider: authProviderTypeSchema,
  persistent: z.boolean(),
  deviceLabel: safeTextSchema(80).nullable(),
  createdAt: z.number().finite().nonnegative(),
  lastUsedAt: z.number().finite().nonnegative(),
  expiresAt: z.number().finite().positive(),
  revokedAt: z.number().finite().nonnegative().nullable(),
  isCurrent: z.boolean(),
});

export const authSessionsListResponseSchema = z.object({
  sessions: z.array(authSessionEntrySchema).max(100),
  serverTimeMs: z.number().finite().positive(),
});

export const revokeAuthSessionResponseSchema = z.object({
  revoked: z.literal(true),
  id: uuidSchema,
});

export const preferencesResponseSchema = z.object({
  preferences: preferenceSchema.nullable(),
  serverTimeMs: z.number().finite().positive().optional(),
});

export const phaseTypeSchema = z.enum(['focus', 'short_break', 'long_break']);
export const sessionStatusSchema = z.enum(['active', 'paused', 'completed', 'reset']);

export const sessionPlanPhaseSchema = z.object({
  index: z.number().int().nonnegative(),
  cycleNumber: z.number().int().positive(),
  phaseType: phaseTypeSchema,
  durationMs: z.number().finite().positive(),
  startsAt: z.number().finite().positive(),
  endsAt: z.number().finite().positive(),
});

export const sessionSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  status: sessionStatusSchema,
  plan: z.array(sessionPlanPhaseSchema).max(64),
  currentIndex: z.number().int().nonnegative(),
  startedAt: z.number().finite().positive(),
  accumulatedPauseMs: z.number().finite().nonnegative(),
  pausedAt: z.number().finite().positive().nullable(),
  endedAt: z.number().finite().positive().nullable(),
  version: z.number().int().positive(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

export const createSessionResponseSchema = z.object({
  created: z.boolean(),
  session: sessionSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const sessionStateResponseSchema = z.object({
  session: sessionSchema.nullable(),
  currentPhase: sessionPlanPhaseSchema.nullable(),
  serverTimeMs: z.number().finite().positive(),
});

export const sessionControlResponseSchema = z.object({
  idempotent: z.boolean(),
  session: sessionSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const volumePolicySchema = z.object({
  focus: z.number().min(0).max(1),
  short_break: z.number().min(0).max(1),
  long_break: z.number().min(0).max(1),
});

export const audioTrackSchema = z.object({
  id: trackIdSchema,
  title: safeTextSchema(100),
  category: z.enum(['ambient', 'noise', 'drone']),
  mimeType: z.enum(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm']),
  sizeBytes: z.number().int().positive(),
  streamUrl: safeAudioStreamUrlSchema,
});

export const audioTracksResponseSchema = z.object({
  tracks: z.array(audioTrackSchema).max(50),
  volumePolicy: volumePolicySchema,
});

export const audioPolicyResponseSchema = z.object({
  volumePolicy: volumePolicySchema,
});

// --- Task Schemas (Section 4.6) ---

export const taskSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  title: safeTextSchema(TASK_LIMITS.TITLE_MAX_LEN),
  description: safeMultilineTextSchema(TASK_LIMITS.DESCRIPTION_MAX_LEN).nullable(),
  completed: z.boolean(),
  completedAt: z.number().finite().positive().nullable(),
  userPriority: priorityLevelSchema,
  aiPriority: priorityLevelSchema.nullable(),
  effectivePriority: priorityLevelSchema,
  priorityScore: z.number().finite(),
  priorityReason: safeTextSchema(240).nullable(),
  priorityComputedAt: z.number().finite().positive().nullable(),
  priorityDismissedUntil: z.number().finite().positive().nullable(),
  priorityDismissCount: z.number().int().nonnegative(),
  tags: z.array(safeTextSchema(TASK_LIMITS.TAG_MAX_LEN)).max(30),
  dueAt: z.number().finite().positive().nullable(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

export const taskCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});

export const taskListResponseSchema = z.object({
  tasks: z.array(taskSchema).max(500),
  counts: taskCountsSchema,
  filteredCount: z.number().int().nonnegative().optional(),
  serverTimeMs: z.number().finite().positive(),
});

export const taskTagsResponseSchema = z.object({
  tags: z.array(safeTextSchema(TASK_LIMITS.TAG_MAX_LEN)).max(200),
  serverTimeMs: z.number().finite().positive(),
});

export const singleTaskResponseSchema = z.object({
  task: taskSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const createTaskResponseSchema = z.object({
  created: z.boolean(),
  task: taskSchema,
  counts: taskCountsSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const updateTaskResponseSchema = z.object({
  idempotent: z.boolean(),
  task: taskSchema,
  counts: taskCountsSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const deleteTaskResponseSchema = z.object({
  idempotent: z.boolean(),
  deleted: z.literal(true),
  counts: taskCountsSchema,
  serverTimeMs: z.number().finite().positive(),
});

// --- Sync Schemas (Section 4.7) ---

export const allowedSyncEventTypeSchema = z.enum([
  'SESSION_STARTED',
  'SESSION_PAUSED',
  'SESSION_RESUMED',
  'PHASE_SKIPPED',
  'SESSION_RESET',
  'SESSION_ENDED',
  'PREFERENCES_UPDATED',
  'TASK_CREATED',
  'TASK_UPDATED',
  'TASK_DELETED',
]);

export const queuedSyncEventSchema = z.object({
  eventId: uuidSchema,
  entityType: z.enum(['session', 'preference', 'task']),
  entityId: uuidSchema,
  eventType: allowedSyncEventTypeSchema,
  expectedVersion: z.number().int().positive().optional(),
  clientTimestamp: z.number().finite().positive().optional(),
  payload: z
    .record(z.unknown())
    .refine((obj) => Object.keys(obj).length <= 20, {
      message: 'Payload de sincronización excede el máximo de campos permitidos',
    })
    .refine(
      (obj) => {
        try {
          return JSON.stringify(obj).length <= 8192;
        } catch {
          return false;
        }
      },
      { message: 'Payload de sincronización excede el tamaño máximo permitido' }
    ),
});

export const syncBatchRequestSchema = z
  .object({
    events: z.array(queuedSyncEventSchema).min(1).max(100),
  })
  .strict();

export const syncStateResponseSchema = z.object({
  activeSession: sessionSchema.nullable(),
  currentPhase: sessionPlanPhaseSchema.nullable(),
  preferences: preferenceSchema.nullable(),
  tasks: z.array(taskSchema).max(500),
  taskCounts: taskCountsSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const syncEventResultSchema = z.object({
  eventId: uuidSchema,
  entityType: z.enum(['session', 'preference', 'task']),
  entityId: uuidSchema,
  eventType: allowedSyncEventTypeSchema,
  status: z.enum(['applied', 'duplicate', 'conflict']),
  version: z.number().int().positive().optional(),
  errorCode: safeTextSchema(64).optional(),
  message: safeTextSchema(240).optional(),
});

export const syncBatchResponseSchema = z.object({
  results: z.array(syncEventResultSchema),
  snapshot: z.object({
    activeSession: sessionSchema.nullable(),
    currentPhase: sessionPlanPhaseSchema.nullable(),
    preferences: preferenceSchema.nullable(),
    taskCounts: taskCountsSchema,
    serverTimeMs: z.number().finite().positive(),
  }),
});

export const cachedSnapshotSchema = z.object({
  deviceId: uuidSchema,
  activeSession: sessionSchema.nullable(),
  preferences: preferenceSchema.nullable(),
  tasks: z.array(taskSchema).max(500),
  taskCounts: taskCountsSchema,
  serverTimeMs: z.number().finite().positive(),
  cachedAt: z.number().finite().nonnegative(),
});

// --- Search Response Schemas (Section 4.8) ---

export const searchEngineInfoSchema = z.object({
  id: searchEngineSchema,
  name: safeTextSchema(64),
  configured: z.boolean(),
  requiresApiKey: z.boolean(),
});

export const searchEnginesResponseSchema = z.object({
  engines: z.array(searchEngineInfoSchema).max(10),
  serverTimeMs: z.number().finite().positive(),
});

export const searchResultMetadataSchema = z.object({
  pageId: z.number().int().nonnegative().optional(),
  questionId: z.number().int().nonnegative().optional(),
  score: z.number().finite().optional(),
  answerCount: z.number().int().nonnegative().optional(),
  isAnswered: z.boolean().optional(),
  tags: z.array(safeTextSchema(40)).max(20).optional(),
});

export const searchResultItemSchema = z.object({
  title: safeTextSchema(240),
  url: safeExternalUrlSchema,
  snippet: safeTextSchema(600),
  displayUrl: safeTextSchema(200).nullable(),
  engine: searchEngineSchema,
  metadata: searchResultMetadataSchema.optional(),
});

export const searchHistoryEntrySchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  engine: searchEngineSchema,
  query: safeTextSchema(SEARCH_LIMITS.QUERY_MAX_LEN),
  resultsCount: z.number().int().nonnegative(),
  createdAt: z.number().finite().nonnegative(),
});

export const searchResponseSchema = z.object({
  engine: searchEngineSchema,
  query: safeTextSchema(SEARCH_LIMITS.QUERY_MAX_LEN),
  lang: safeTextSchema(16),
  configured: z.boolean(),
  externalUrl: safeExternalUrlSchema,
  results: z.array(searchResultItemSchema).max(30),
  totalResults: z.number().int().nonnegative(),
  notice: safeTextSchema(300).nullable(),
  historyEntry: searchHistoryEntrySchema.nullable(),
  serverTimeMs: z.number().finite().positive(),
});

export const searchHistoryResponseSchema = z.object({
  history: z.array(searchHistoryEntrySchema).max(200),
  total: z.number().int().nonnegative(),
  serverTimeMs: z.number().finite().positive(),
});

export const deleteSearchHistoryEntryResponseSchema = z.object({
  deleted: z.literal(true),
  id: uuidSchema,
  serverTimeMs: z.number().finite().positive(),
});

export const deleteSearchHistoryResponseSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  serverTimeMs: z.number().finite().positive(),
});

// --- Stats Response Schemas (Section 4.9 — Phase 8) ---

export const dailyProductivityPointSchema = z.object({
  date: safeTextSchema(16),
  sessionsCompleted: z.number().int().nonnegative(),
  focusMs: z.number().finite().nonnegative(),
  focusMinutes: z.number().finite().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  primordialCompleted: z.number().int().nonnegative(),
  primordialIgnored: z.number().int().nonnegative(),
});

export const weekdayProductivityPointSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  label: safeTextSchema(16),
  sessionsCompleted: z.number().int().nonnegative(),
  focusMs: z.number().finite().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
});

export const hourlyProductivityPointSchema = z.object({
  hour: z.number().int().min(0).max(23),
  focusCycles: z.number().int().nonnegative(),
  focusMs: z.number().finite().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
});

export const statsDashboardResponseSchema = z.object({
  today: z.object({
    date: safeTextSchema(16),
    sessionsCompleted: z.number().int().nonnegative(),
    focusMs: z.number().finite().nonnegative(),
    focusMinutes: z.number().finite().nonnegative(),
    tasksCompleted: z.number().int().nonnegative(),
  }),
  totals: z.object({
    sessionsCompleted: z.number().int().nonnegative(),
    focusMs: z.number().finite().nonnegative(),
    focusMinutes: z.number().finite().nonnegative(),
    cyclesCompleted: z.number().int().nonnegative(),
    tasksCompleted: z.number().int().nonnegative(),
    tasksPending: z.number().int().nonnegative(),
  }),
  streaks: z.object({
    currentDays: z.number().int().nonnegative(),
    longestDays: z.number().int().nonnegative(),
    lastActiveDate: safeTextSchema(16).nullable(),
  }),
  primordial: z.object({
    completedBeforeDeadline: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
    activePending: z.number().int().nonnegative(),
    completionRate: z.number().min(0).max(1).nullable(),
  }),
  productivity: z.object({
    windowDays: z.number().int().positive(),
    byDay: z.array(dailyProductivityPointSchema).max(366),
    byWeekday: z.array(weekdayProductivityPointSchema).max(7),
    byHour: z.array(hourlyProductivityPointSchema).max(24),
    peakHour: z
      .object({
        hour: z.number().int().min(0).max(23),
        focusMs: z.number().finite().nonnegative(),
        tasksCompleted: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
  serverTimeMs: z.number().finite().positive(),
});

export const apiErrorPayloadSchema = z.object({
  error: z.object({
    code: safeTextSchema(64),
    message: safeTextSchema(240),
  }),
});
