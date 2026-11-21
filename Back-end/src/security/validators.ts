import { z } from 'zod';

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Control characters (C0, DEL, C1) and Unicode bidirectional override characters
const CONTROL_AND_BIDI_PATTERN = '[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]';
export const CONTROL_AND_BIDI_TEST_REGEX = new RegExp(CONTROL_AND_BIDI_PATTERN);
export const CONTROL_AND_BIDI_REPLACE_REGEX = new RegExp(CONTROL_AND_BIDI_PATTERN, 'g');

// Allow '\n' (0x0A) for multiline task descriptions (CRLF '\r\n' is normalized to '\n' before validation)
// while blocking lone '\r' and all other control/bidi chars
const MULTILINE_CONTROL_PATTERN =
  '[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]';
const MULTILINE_CONTROL_TEST_REGEX = new RegExp(MULTILINE_CONTROL_PATTERN);

const UNSAFE_MARKUP_REGEX = /[<>]/;
const UNSAFE_SCHEME_REGEX = /(javascript|vbscript|data|file):/i;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Canonicalizes and validates UUIDs in lowercase so auth, idempotency,
 * and ownership checks are never bypassed or fragmented by case differences.
 */
export const uuidSchema = z
  .string()
  .refine((v) => !CONTROL_AND_BIDI_TEST_REGEX.test(v), {
    message: 'UUID contains disallowed control characters',
  })
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(UUID_REGEX, 'Invalid uuid'));

export const nonNilUuidSchema = uuidSchema.refine((v) => v !== NIL_UUID, {
  message: 'Nil UUID is not allowed',
});

export function stripControlAndBidiChars(value: string, maxLength = 200): string {
  const cleaned = value.replace(CONTROL_AND_BIDI_REPLACE_REGEX, '').trim();
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength);
}

function addTextSecurityIssues(
  val: string,
  ctx: z.RefinementCtx,
  fieldName: string,
  allowNewlines: boolean
): void {
  const controlRegex = allowNewlines
    ? MULTILINE_CONTROL_TEST_REGEX
    : CONTROL_AND_BIDI_TEST_REGEX;

  if (controlRegex.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldName} contains disallowed control characters`,
    });
  }
  if (UNSAFE_MARKUP_REGEX.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldName} contains disallowed markup characters (< or >)`,
    });
  }
  if (UNSAFE_SCHEME_REGEX.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldName} contains a disallowed URI scheme`,
    });
  }
}

export function safeSingleLineTextSchema(minLen: number, maxLen: number, fieldName = 'Input') {
  return z
    .string()
    .superRefine((val, ctx) => addTextSecurityIssues(val, ctx, fieldName, false))
    .transform((v) => v.trim())
    .pipe(z.string().min(minLen).max(maxLen));
}

export function safeMultilineTextSchema(maxLen: number, fieldName = 'Description') {
  return z
    .string()
    .transform((v) => v.replace(/\r\n/g, '\n'))
    .superRefine((val, ctx) => addTextSecurityIssues(val, ctx, fieldName, true))
    .transform((v) => v.trim())
    .pipe(z.string().max(maxLen));
}

export const boundedSyncPayloadSchema = z
  .record(z.unknown())
  .superRefine((obj, ctx) => {
    const keys = Object.keys(obj);
    if (keys.length > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Payload exceeds maximum allowed keys',
      });
      return;
    }
    for (const key of keys) {
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Payload contains forbidden key',
        });
        return;
      }
    }
    try {
      if (JSON.stringify(obj).length > 2048) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Payload exceeds maximum allowed size',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Payload is not serializable',
      });
    }
  });

/**
 * JSON.parse reviver that strips prototype-pollution keys at parse time.
 */
export function safeJsonReviver(key: string, value: unknown): unknown {
  if (FORBIDDEN_JSON_KEYS.has(key)) {
    return undefined;
  }
  return value;
}
