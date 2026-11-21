import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { AuthProviderType, Preference, ThemePreference, User } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';

interface UserRow {
  id: string;
  auth_provider: string;
  external_id: string;
  username: string | null;
  username_normalized: string | null;
  email: string | null;
  email_verified: number;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  google_sub: string | null;
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

export type UpdatePreferenceInput = Partial<Omit<Preference, 'userId' | 'updatedAt'>>;

export interface UserWithPasswordHash {
  user: User;
  passwordHash: string | null;
}

const USER_SELECT_COLS = `
  id, auth_provider, external_id, username, username_normalized,
  email, email_verified, password_hash, display_name, avatar_url,
  google_sub, created_at, updated_at
`;

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    authProvider: row.auth_provider as AuthProviderType,
    externalId: row.external_id,
    username: row.username,
    email: row.email,
    emailVerified: row.email_verified === 1,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    googleSub: row.google_sub,
    hasPassword: row.password_hash !== null && row.password_hash.length > 0,
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
  private readonly stmtFindByUsernameNorm: Database.Statement<[string], UserRow>;
  private readonly stmtFindPasswordUserByEmail: Database.Statement<[string], UserRow>;
  private readonly stmtFindForLogin: Database.Statement<[string, string], UserRow>;
  private readonly stmtFindByGoogleSub: Database.Statement<[string], UserRow>;
  private readonly stmtFindVerifiedByEmail: Database.Statement<[string], UserRow>;
  private readonly stmtGetPrefs: Database.Statement<[string], PreferenceRow>;
  private readonly stmtInsertUser: Database.Statement<
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      number,
      number,
    ]
  >;
  private readonly stmtLinkGoogle: Database.Statement<
    [
      string,
      string | null,
      string | null,
      number,
      string | null,
      string | null,
      number,
      string | null,
      string | null,
      number,
      string,
      string,
    ]
  >;
  private readonly stmtInsertDefaultPrefs: Database.Statement<[string, number]>;
  private readonly stmtUpdatePrefs: Database.Statement<
    [number, number, number, number, number, number, number, string, number, string]
  >;

  constructor(private readonly db: AppDatabase) {
    this.stmtFindById = this.db.prepare(`SELECT ${USER_SELECT_COLS} FROM users WHERE id = ?`);
    this.stmtFindByExternalId = this.db.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE auth_provider = ? AND external_id = ?`
    );
    this.stmtFindByUsernameNorm = this.db.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE username_normalized = ? LIMIT 1`
    );
    this.stmtFindPasswordUserByEmail = this.db.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE password_hash IS NOT NULL AND email = ? LIMIT 1`
    );
    this.stmtFindForLogin = this.db.prepare(
      `SELECT ${USER_SELECT_COLS}
       FROM users
       WHERE username_normalized = ?
          OR (password_hash IS NOT NULL AND email = ?)
       LIMIT 1`
    );
    this.stmtFindByGoogleSub = this.db.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE google_sub = ? LIMIT 1`
    );
    this.stmtFindVerifiedByEmail = this.db.prepare(
      `SELECT ${USER_SELECT_COLS} FROM users WHERE email = ? AND email_verified = 1 AND google_sub IS NULL LIMIT 1`
    );
    this.stmtGetPrefs = this.db.prepare(
      `SELECT user_id, focus_duration_min, short_break_min, long_break_min,
              cycles_before_long_break, volume_focus, volume_break,
              notifications_enabled, theme, updated_at
       FROM preferences WHERE user_id = ?`
    );
    this.stmtInsertUser = this.db.prepare(
      `INSERT INTO users (
         id, auth_provider, external_id, username, username_normalized,
         email, email_verified, password_hash, display_name, avatar_url,
         google_sub, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtLinkGoogle = this.db.prepare(
      `UPDATE users
       SET google_sub = ?,
           email = COALESCE(email, ?),
           email_verified = CASE
             WHEN (email IS NULL AND ? IS NOT NULL AND ? = 1)
               OR (email IS NOT NULL AND ? IS NOT NULL AND LOWER(email) = LOWER(?) AND ? = 1)
             THEN 1
             ELSE email_verified
           END,
           display_name = COALESCE(display_name, ?),
           avatar_url = COALESCE(avatar_url, ?),
           updated_at = ?
       WHERE id = ? AND (google_sub IS NULL OR google_sub = ?)`
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

  findByUsernameNormalized(usernameNormalized: string): User | null {
    const row = this.stmtFindByUsernameNorm.get(usernameNormalized);
    return row ? mapUser(row) : null;
  }

  findPasswordUserByEmail(emailNormalized: string): User | null {
    const row = this.stmtFindPasswordUserByEmail.get(emailNormalized);
    return row ? mapUser(row) : null;
  }

  findByIdentifierForLogin(identifierNormalized: string): UserWithPasswordHash | null {
    const row = this.stmtFindForLogin.get(identifierNormalized, identifierNormalized);
    if (!row) {
      return null;
    }
    return {
      user: mapUser(row),
      passwordHash: row.password_hash,
    };
  }

  findByGoogleSub(googleSub: string): User | null {
    const row = this.stmtFindByGoogleSub.get(googleSub);
    return row ? mapUser(row) : null;
  }

  findVerifiedUserByEmail(emailNormalized: string): User | null {
    const row = this.stmtFindVerifiedByEmail.get(emailNormalized);
    return row ? mapUser(row) : null;
  }

  getPreferencesByUserId(userId: string): Preference | null {
    const row = this.stmtGetPrefs.get(userId);
    return row ? mapPreference(row) : null;
  }

  ensurePreferences(userId: string, nowMs: number = Date.now()): Preference {
    return this.getPreferencesByUserId(userId) ?? this.insertDefaultPreferences(userId, nowMs);
  }

  updatePreferences(
    userId: string,
    patch: UpdatePreferenceInput,
    nowMs: number = Date.now()
  ): Preference {
    const current = this.ensurePreferences(userId, nowMs);

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
      const preferences = this.ensurePreferences(existing.id, nowMs);
      return { user: existing, preferences, created: false };
    }

    const userId = crypto.randomUUID();
    const run = this.db.transaction(() => {
      this.stmtInsertUser.run(
        userId,
        authProvider,
        externalId,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        null,
        nowMs,
        nowMs
      );
      const preferences = this.insertDefaultPreferences(userId, nowMs);
      const user: User = {
        id: userId,
        authProvider,
        externalId,
        username: null,
        email: null,
        emailVerified: false,
        displayName: null,
        avatarUrl: null,
        googleSub: null,
        hasPassword: false,
        createdAt: nowMs,
        updatedAt: nowMs,
      };
      return { user, preferences, created: true };
    });

    return run();
  }

  createPasswordUser(params: {
    username: string;
    usernameNormalized: string;
    email: string | null;
    passwordHash: string;
    displayName: string | null;
    nowMs: number;
  }): { user: User; preferences: Preference } {
    const userId = crypto.randomUUID();
    this.stmtInsertUser.run(
      userId,
      'password',
      userId,
      params.username,
      params.usernameNormalized,
      params.email,
      0,
      params.passwordHash,
      params.displayName ?? params.username,
      null,
      null,
      params.nowMs,
      params.nowMs
    );
    const preferences = this.insertDefaultPreferences(userId, params.nowMs);
    const user: User = {
      id: userId,
      authProvider: 'password',
      externalId: userId,
      username: params.username,
      email: params.email,
      emailVerified: false,
      displayName: params.displayName ?? params.username,
      avatarUrl: null,
      googleSub: null,
      hasPassword: true,
      createdAt: params.nowMs,
      updatedAt: params.nowMs,
    };
    return { user, preferences };
  }

  createGoogleUser(params: {
    googleSub: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    avatarUrl: string | null;
    nowMs: number;
  }): { user: User; preferences: Preference } {
    const userId = crypto.randomUUID();
    this.stmtInsertUser.run(
      userId,
      'google',
      params.googleSub,
      null,
      null,
      params.email,
      params.emailVerified ? 1 : 0,
      null,
      params.displayName,
      params.avatarUrl,
      params.googleSub,
      params.nowMs,
      params.nowMs
    );
    const preferences = this.insertDefaultPreferences(userId, params.nowMs);
    const user: User = {
      id: userId,
      authProvider: 'google',
      externalId: params.googleSub,
      username: null,
      email: params.email,
      emailVerified: params.emailVerified,
      displayName: params.displayName,
      avatarUrl: params.avatarUrl,
      googleSub: params.googleSub,
      hasPassword: false,
      createdAt: params.nowMs,
      updatedAt: params.nowMs,
    };
    return { user, preferences };
  }

  linkGoogleToUser(params: {
    userId: string;
    googleSub: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    avatarUrl: string | null;
    nowMs: number;
  }): User {
    const verifiedFlag = params.emailVerified ? 1 : 0;
    const result = this.stmtLinkGoogle.run(
      params.googleSub,
      params.email,
      params.email,
      verifiedFlag,
      params.email,
      params.email,
      verifiedFlag,
      params.displayName,
      params.avatarUrl,
      params.nowMs,
      params.userId,
      params.googleSub
    );
    if (result.changes === 0) {
      throw new AppError(
        409,
        'GOOGLE_ACCOUNT_ALREADY_LINKED',
        'A different Google account is already linked to this user'
      );
    }
    const updated = this.findById(params.userId);
    if (!updated) {
      throw new Error(`User ${params.userId} disappeared after linking Google`);
    }
    return updated;
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
