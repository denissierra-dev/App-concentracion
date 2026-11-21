import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { AuthProviderType, AuthSession } from '../domain/types.js';

interface AuthSessionRow {
  id: string;
  user_id: string;
  provider: string;
  persistent: number;
  device_label: string | null;
  user_agent: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface CreateAuthSessionInput {
  id: string;
  userId: string;
  tokenHash: string;
  provider: Exclude<AuthProviderType, 'device'>;
  persistent: boolean;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: number;
  expiresAt: number;
}

function mapAuthSession(row: AuthSessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as Exclude<AuthProviderType, 'device'>,
    persistent: row.persistent === 1,
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Stores opaque session token hashes in SQLite for revocable persistent ("remember me")
 * and short-lived login sessions.
 */
export class AuthSessionRepository {
  private readonly stmtInsert: Database.Statement<
    [string, string, string, string, number, string | null, string | null, number, number, number]
  >;
  private readonly stmtFindActiveByTokenHash: Database.Statement<[string, number], AuthSessionRow>;
  private readonly stmtTouchLastUsed: Database.Statement<[number, string]>;
  private readonly stmtListActiveByUser: Database.Statement<[string, number], AuthSessionRow>;
  private readonly stmtRevokeByIdForUser: Database.Statement<[number, string, string]>;
  private readonly stmtRevokeAllForUser: Database.Statement<[number, string]>;
  private readonly stmtDeleteExpiredForUser: Database.Statement<[string, number]>;
  private readonly stmtRevokeExcessForUser: Database.Statement<
    [number, string, number, string, number]
  >;

  constructor(private readonly db: AppDatabase) {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO auth_sessions (
         id, user_id, token_hash, provider, persistent,
         device_label, user_agent, created_at, last_used_at, expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    );
    this.stmtFindActiveByTokenHash = this.db.prepare(
      `SELECT id, user_id, provider, persistent, device_label, user_agent,
              created_at, last_used_at, expires_at, revoked_at
       FROM auth_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
       LIMIT 1`
    );
    this.stmtTouchLastUsed = this.db.prepare(
      'UPDATE auth_sessions SET last_used_at = ? WHERE id = ?'
    );
    this.stmtListActiveByUser = this.db.prepare(
      `SELECT id, user_id, provider, persistent, device_label, user_agent,
              created_at, last_used_at, expires_at, revoked_at
       FROM auth_sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_used_at DESC, created_at DESC, rowid DESC`
    );
    this.stmtRevokeByIdForUser = this.db.prepare(
      `UPDATE auth_sessions
       SET revoked_at = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
    );
    this.stmtRevokeAllForUser = this.db.prepare(
      `UPDATE auth_sessions
       SET revoked_at = ?
       WHERE user_id = ? AND revoked_at IS NULL`
    );
    this.stmtDeleteExpiredForUser = this.db.prepare(
      `DELETE FROM auth_sessions
       WHERE user_id = ? AND (expires_at <= ? OR revoked_at IS NOT NULL)`
    );
    this.stmtRevokeExcessForUser = this.db.prepare(
      `UPDATE auth_sessions
       SET revoked_at = ?
       WHERE id IN (
         SELECT id FROM auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY CASE WHEN id = ? THEN 1 ELSE 0 END DESC, last_used_at DESC, created_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`
    );
  }

  create(input: CreateAuthSessionInput): AuthSession {
    this.stmtInsert.run(
      input.id,
      input.userId,
      input.tokenHash,
      input.provider,
      input.persistent ? 1 : 0,
      input.deviceLabel,
      input.userAgent,
      input.createdAt,
      input.createdAt,
      input.expiresAt
    );

    return {
      id: input.id,
      userId: input.userId,
      provider: input.provider,
      persistent: input.persistent,
      deviceLabel: input.deviceLabel,
      userAgent: input.userAgent,
      createdAt: input.createdAt,
      lastUsedAt: input.createdAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
  }

  findActiveByTokenHash(tokenHash: string, nowMs: number = Date.now()): AuthSession | null {
    const row = this.stmtFindActiveByTokenHash.get(tokenHash, nowMs);
    return row ? mapAuthSession(row) : null;
  }

  touchLastUsed(id: string, nowMs: number = Date.now()): void {
    this.stmtTouchLastUsed.run(nowMs, id);
  }

  listActiveByUser(userId: string, nowMs: number = Date.now()): AuthSession[] {
    return this.stmtListActiveByUser.all(userId, nowMs).map(mapAuthSession);
  }

  revokeByIdForUser(id: string, userId: string, nowMs: number = Date.now()): boolean {
    const result = this.stmtRevokeByIdForUser.run(nowMs, id, userId);
    return result.changes > 0;
  }

  revokeAllForUser(userId: string, nowMs: number = Date.now()): number {
    const result = this.stmtRevokeAllForUser.run(nowMs, userId);
    return result.changes;
  }

  pruneAndCapForUser(
    userId: string,
    maxActiveSessions: number,
    nowMs: number = Date.now(),
    preserveSessionId: string | null = null
  ): void {
    this.stmtDeleteExpiredForUser.run(userId, nowMs);
    this.stmtRevokeExcessForUser.run(
      nowMs,
      userId,
      nowMs,
      preserveSessionId ?? '',
      maxActiveSessions
    );
  }
}
