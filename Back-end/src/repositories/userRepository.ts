import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { AuthProviderType, Preference, ThemePreference, User } from '../domain/types.js';

interface UserRow {
  id: string;
  auth_provider: string;
  external_id: string;
  created_at: number;
  updated_at: number;
}

interface PreferenceRow {
  user_id: string;
  focus_duration_min: number;
  short_break_min: number;
  long_break_min: number;
  cycles_before_long_break: number;
  volume_focus: number;
  volume_break: number;
  notifications_enabled: number;
  theme: string;
  updated_at: number;
}

export type UpdatePreferenceInput = Partial<
  Omit<Preference, 'userId' | 'updatedAt'>
>;

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    authProvider: row.auth_provider as AuthProviderType,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPreference(row: PreferenceRow): Preference {
  return {
    userId: row.user_id,
    focusDurationMin: row.focus_duration_min,
    shortBreakMin: row.short_break_min,
    longBreakMin: row.long_break_min,
    cyclesBeforeLongBreak: row.cycles_before_long_break,
    volumeFocus: row.volume_focus,
    volumeBreak: row.volume_break,
    notificationsEnabled: row.notifications_enabled === 1,
    theme: row.theme as ThemePreference,
    updatedAt: row.updated_at,
  };
}

export class UserRepository {
  private readonly stmtFindById: Database.Statement<[string], UserRow>;
  private readonly stmtFindByExternalId: Database.Statement<[string, string], UserRow>;
  private readonly stmtGetPrefs: Database.Statement<[string], PreferenceRow>;
  private readonly stmtInsertUser: Database.Statement<[string, string, string, number, number]>;
  private readonly stmtInsertDefaultPrefs: Database.Statement<[string, number]>;
  private readonly stmtUpdatePrefs: Database.Statement<
    [number, number, number, number, number, number, number, string, number, string]
  >;

  constructor(private readonly db: AppDatabase) {
    this.stmtFindById = this.db.prepare(
      'SELECT id, auth_provider, external_id, created_at, updated_at FROM users WHERE id = ?'
    );
    this.stmtFindByExternalId = this.db.prepare(
      'SELECT id, auth_provider, external_id, created_at, updated_at FROM users WHERE auth_provider = ? AND external_id = ?'
    );
    this.stmtGetPrefs = this.db.prepare(
      `SELECT user_id, focus_duration_min, short_break_min, long_break_min,
              cycles_before_long_break, volume_focus, volume_break,
              notifications_enabled, theme, updated_at
       FROM preferences WHERE user_id = ?`
    );
    this.stmtInsertUser = this.db.prepare(
      `INSERT INTO users (id, auth_provider, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.stmtInsertDefaultPrefs = this.db.prepare(
      `INSERT INTO preferences (
         user_id, focus_duration_min, short_break_min, long_break_min,
         cycles_before_long_break, volume_focus, volume_break,
         notifications_enabled, theme, updated_at
       ) VALUES (?, 25, 5, 20, 4, 0.7, 0.3, 1, 'system', ?)`
    );
    this.stmtUpdatePrefs = this.db.prepare(
      `UPDATE preferences
       SET focus_duration_min = ?,
           short_break_min = ?,
           long_break_min = ?,
           cycles_before_long_break = ?,
           volume_focus = ?,
           volume_break = ?,
           notifications_enabled = ?,
           theme = ?,
           updated_at = ?
       WHERE user_id = ?`
    );
  }

  findById(id: string): User | null {
    const row = this.stmtFindById.get(id);
    return row ? mapUser(row) : null;
  }

  findByExternalId(authProvider: AuthProviderType, externalId: string): User | null {
    const row = this.stmtFindByExternalId.get(authProvider, externalId);
    return row ? mapUser(row) : null;
  }

  getPreferencesByUserId(userId: string): Preference | null {
    const row = this.stmtGetPrefs.get(userId);
    return row ? mapPreference(row) : null;
  }

  updatePreferences(
    userId: string,
    patch: UpdatePreferenceInput,
    nowMs: number = Date.now()
  ): Preference {
    const current =
      this.getPreferencesByUserId(userId) ?? this.insertDefaultPreferences(userId, nowMs);

    const updated: Preference = {
      userId,
      focusDurationMin: patch.focusDurationMin ?? current.focusDurationMin,
      shortBreakMin: patch.shortBreakMin ?? current.shortBreakMin,
      longBreakMin: patch.longBreakMin ?? current.longBreakMin,
      cyclesBeforeLongBreak: patch.cyclesBeforeLongBreak ?? current.cyclesBeforeLongBreak,
      volumeFocus: patch.volumeFocus ?? current.volumeFocus,
      volumeBreak: patch.volumeBreak ?? current.volumeBreak,
      notificationsEnabled: patch.notificationsEnabled ?? current.notificationsEnabled,
      theme: patch.theme ?? current.theme,
      updatedAt: nowMs,
    };

    this.stmtUpdatePrefs.run(
      updated.focusDurationMin,
      updated.shortBreakMin,
      updated.longBreakMin,
      updated.cyclesBeforeLongBreak,
      updated.volumeFocus,
      updated.volumeBreak,
      updated.notificationsEnabled ? 1 : 0,
      updated.theme,
      updated.updatedAt,
      userId
    );

    return updated;
  }

  /**
   * Finds an existing user for (authProvider, externalId) or creates one
   * together with default preferences inside a single transaction.
   */
  findOrCreateDeviceUser(
    authProvider: AuthProviderType,
    externalId: string,
    nowMs: number = Date.now()
  ): { user: User; preferences: Preference; created: boolean } {
    const existing = this.findByExternalId(authProvider, externalId);
    if (existing) {
      const preferences = this.getPreferencesByUserId(existing.id);
      if (!preferences) {
        const createdPrefs = this.insertDefaultPreferences(existing.id, nowMs);
        return { user: existing, preferences: createdPrefs, created: false };
      }
      return { user: existing, preferences, created: false };
    }

    const userId = crypto.randomUUID();
    const run = this.db.transaction(() => {
      this.stmtInsertUser.run(userId, authProvider, externalId, nowMs, nowMs);
      const preferences = this.insertDefaultPreferences(userId, nowMs);
      const user: User = {
        id: userId,
        authProvider,
        externalId,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      return { user, preferences, created: true };
    });

    return run();
  }

  private insertDefaultPreferences(userId: string, nowMs: number): Preference {
    this.stmtInsertDefaultPrefs.run(userId, nowMs);

    return {
      userId,
      focusDurationMin: 25,
      shortBreakMin: 5,
      longBreakMin: 20,
      cyclesBeforeLongBreak: 4,
      volumeFocus: 0.7,
      volumeBreak: 0.3,
      notificationsEnabled: true,
      theme: 'system',
      updatedAt: nowMs,
    };
  }
}
