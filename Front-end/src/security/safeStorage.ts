import { z } from 'zod';
import type { AppTheme } from '../domain/types';
import { appThemeSchema, safeJsonParse, trackIdSchema, uuidSchema } from './validators';

const STORAGE_KEYS = {
  deviceId: 'deepwork:v1:deviceId',
  selectedTrackId: 'deepwork:v1:selectedTrackId',
  localMuted: 'deepwork:v1:localMuted',
  themePalette: 'deepwork:v1:themePalette',
} as const;

const booleanSchema = z.boolean();

function readValidated<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return null;
    }

    const parsedJson = safeJsonParse(raw, 4096);
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      window.localStorage.removeItem(key);
      return null;
    }
    return result.data;
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage errors in restricted environments
    }
    return null;
  }
}

function writeValidated<T>(key: string, value: T, schema: z.ZodType<T>): boolean {
  const result = schema.safeParse(value);
  if (!result.success) {
    return false;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(result.data));
    return true;
  } catch {
    return false;
  }
}

export const safeStorage = {
  getDeviceId(): string | null {
    return readValidated(STORAGE_KEYS.deviceId, uuidSchema);
  },
  setDeviceId(deviceId: string): boolean {
    return writeValidated(STORAGE_KEYS.deviceId, deviceId, uuidSchema);
  },
  clearDeviceId(): void {
    try {
      window.localStorage.removeItem(STORAGE_KEYS.deviceId);
    } catch {
      // Ignore
    }
  },

  getSelectedTrackId(): string | null {
    return readValidated(STORAGE_KEYS.selectedTrackId, trackIdSchema);
  },
  setSelectedTrackId(trackId: string): boolean {
    return writeValidated(STORAGE_KEYS.selectedTrackId, trackId, trackIdSchema);
  },

  getLocalMuted(): boolean {
    return readValidated(STORAGE_KEYS.localMuted, booleanSchema) ?? false;
  },
  setLocalMuted(muted: boolean): boolean {
    return writeValidated(STORAGE_KEYS.localMuted, muted, booleanSchema);
  },

  getThemePalette(): AppTheme | null {
    return readValidated(STORAGE_KEYS.themePalette, appThemeSchema);
  },
  setThemePalette(theme: AppTheme): boolean {
    return writeValidated(STORAGE_KEYS.themePalette, theme, appThemeSchema);
  },
};
