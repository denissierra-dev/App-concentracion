import { z } from 'zod';
import type { AppTheme } from '../domain/types';
import {
  appThemeSchema,
  authTokenSchema,
  safeJsonParse,
  trackIdSchema,
  uuidSchema,
} from './validators';

const STORAGE_KEYS = {
  deviceId: 'deepwork:v1:deviceId',
  authToken: 'deepwork:v1:authToken',
  selectedTrackId: 'deepwork:v1:selectedTrackId',
  localMuted: 'deepwork:v1:localMuted',
  themePalette: 'deepwork:v1:themePalette',
  googlePkce: 'deepwork:v1:googlePkce',
} as const;

const booleanSchema = z.boolean();

const googlePkceSchema = z
  .object({
    state: z.string().min(16).max(128),
    codeVerifier: z.string().min(43).max(128),
    mode: z.enum(['login', 'link']),
    rememberMe: z.boolean(),
  })
  .strict();

export type GooglePkceState = z.infer<typeof googlePkceSchema>;

function readValidatedFromStorage<T>(
  storage: Storage,
  key: string,
  schema: z.ZodType<T>
): T | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) {
      return null;
    }

    const parsedJson = safeJsonParse(raw, 4096);
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      storage.removeItem(key);
      return null;
    }
    return result.data;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore storage errors in restricted environments
    }
    return null;
  }
}

function writeValidatedToStorage<T>(
  storage: Storage,
  key: string,
  value: T,
  schema: z.ZodType<T>
): boolean {
  const result = schema.safeParse(value);
  if (!result.success) {
    return false;
  }

  try {
    storage.setItem(key, JSON.stringify(result.data));
    return true;
  } catch {
    return false;
  }
}

export const safeStorage = {
  getDeviceId(): string | null {
    return readValidatedFromStorage(window.localStorage, STORAGE_KEYS.deviceId, uuidSchema);
  },
  setDeviceId(deviceId: string): boolean {
    return writeValidatedToStorage(window.localStorage, STORAGE_KEYS.deviceId, deviceId, uuidSchema);
  },
  clearDeviceId(): void {
    try {
      window.localStorage.removeItem(STORAGE_KEYS.deviceId);
    } catch {
      // Ignore
    }
  },

  getAuthToken(): string | null {
    const sessionToken = readValidatedFromStorage(
      window.sessionStorage,
      STORAGE_KEYS.authToken,
      authTokenSchema
    );
    if (sessionToken) {
      return sessionToken;
    }
    return readValidatedFromStorage(window.localStorage, STORAGE_KEYS.authToken, authTokenSchema);
  },
  setAuthToken(token: string, rememberMe: boolean): boolean {
    this.clearAuthToken();
    const target = rememberMe ? window.localStorage : window.sessionStorage;
    return writeValidatedToStorage(target, STORAGE_KEYS.authToken, token, authTokenSchema);
  },
  clearAuthToken(): void {
    try {
      window.sessionStorage.removeItem(STORAGE_KEYS.authToken);
      window.localStorage.removeItem(STORAGE_KEYS.authToken);
    } catch {
      // Ignore
    }
  },

  getGooglePkce(): GooglePkceState | null {
    return readValidatedFromStorage(
      window.sessionStorage,
      STORAGE_KEYS.googlePkce,
      googlePkceSchema
    );
  },
  setGooglePkce(value: GooglePkceState): boolean {
    return writeValidatedToStorage(
      window.sessionStorage,
      STORAGE_KEYS.googlePkce,
      value,
      googlePkceSchema
    );
  },
  clearGooglePkce(): void {
    try {
      window.sessionStorage.removeItem(STORAGE_KEYS.googlePkce);
    } catch {
      // Ignore
    }
  },

  getSelectedTrackId(): string | null {
    return readValidatedFromStorage(window.localStorage, STORAGE_KEYS.selectedTrackId, trackIdSchema);
  },
  setSelectedTrackId(trackId: string): boolean {
    return writeValidatedToStorage(
      window.localStorage,
      STORAGE_KEYS.selectedTrackId,
      trackId,
      trackIdSchema
    );
  },

  getLocalMuted(): boolean {
    return readValidatedFromStorage(window.localStorage, STORAGE_KEYS.localMuted, booleanSchema) ?? false;
  },
  setLocalMuted(muted: boolean): boolean {
    return writeValidatedToStorage(window.localStorage, STORAGE_KEYS.localMuted, muted, booleanSchema);
  },

  getThemePalette(): AppTheme | null {
    return readValidatedFromStorage(window.localStorage, STORAGE_KEYS.themePalette, appThemeSchema);
  },
  setThemePalette(theme: AppTheme): boolean {
    return writeValidatedToStorage(
      window.localStorage,
      STORAGE_KEYS.themePalette,
      theme,
      appThemeSchema
    );
  },
};
