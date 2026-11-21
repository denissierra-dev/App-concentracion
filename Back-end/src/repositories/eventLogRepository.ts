import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { EventEntityType, EventLog } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';

interface EventLogRow {
  id: string;
  event_id: string;
  user_id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  payload_json: string;
  client_timestamp: number | null;
  server_timestamp: number;
}

export interface AppendEventInput {
  eventId?: string;
  userId: string;
  entityType: EventEntityType;
  entityId: string;
  eventType: string;
  payload?: Record<string, unknown>;
  clientTimestamp?: number | null;
  serverTimestamp?: number;
}

function mapEventLog(row: EventLogRow): EventLog {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    entityType: row.entity_type as EventEntityType,
    entityId: row.entity_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    clientTimestamp: row.client_timestamp,
    serverTimestamp: row.server_timestamp,
  };
}

/**
 * Immutable append-only event log repository with idempotency by eventId
 * and precompiled SQLite statements.
 */
export class EventLogRepository {
  private readonly stmtInsert: Database.Statement<
    [string, string, string, string, string, string, string, number | null, number]
  >;
  private readonly stmtFindByEventId: Database.Statement<[string], EventLogRow>;
  private readonly stmtFindByEventIdForUser: Database.Statement<[string, string], EventLogRow>;
  private readonly stmtFindLatestForEntityForUser: Database.Statement<
    [string, EventEntityType, string, string],
    EventLogRow
  >;
  private readonly stmtFindLatestForEntityActionForUser: Database.Statement<
    [string, EventEntityType, string, string, string],
    EventLogRow
  >;
  private readonly stmtListByUser: Database.Statement<[string, number], EventLogRow>;

  constructor(private readonly db: AppDatabase) {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO event_logs (
         id, event_id, user_id, entity_type, entity_id,
         event_type, payload_json, client_timestamp, server_timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtFindByEventId = this.db.prepare(
      `SELECT id, event_id, user_id, entity_type, entity_id,
              event_type, payload_json, client_timestamp, server_timestamp
       FROM event_logs WHERE event_id = ?`
    );
    this.stmtFindByEventIdForUser = this.db.prepare(
      `SELECT id, event_id, user_id, entity_type, entity_id,
              event_type, payload_json, client_timestamp, server_timestamp
       FROM event_logs WHERE event_id = ? AND user_id = ?`
    );
    this.stmtFindLatestForEntityForUser = this.db.prepare(
      `SELECT id, event_id, user_id, entity_type, entity_id,
              event_type, payload_json, client_timestamp, server_timestamp
       FROM event_logs
       WHERE user_id = ? AND entity_type = ? AND entity_id = ? AND event_type = ?
       ORDER BY server_timestamp DESC, rowid DESC
       LIMIT 1`
    );
    this.stmtFindLatestForEntityActionForUser = this.db.prepare(
      `SELECT id, event_id, user_id, entity_type, entity_id,
              event_type, payload_json, client_timestamp, server_timestamp
       FROM event_logs
       WHERE user_id = ?
         AND entity_type = ?
         AND entity_id = ?
         AND event_type = ?
         AND json_extract(payload_json, '$.action') = ?
       ORDER BY server_timestamp DESC, rowid DESC
       LIMIT 1`
    );
    this.stmtListByUser = this.db.prepare(
      `SELECT id, event_id, user_id, entity_type, entity_id,
              event_type, payload_json, client_timestamp, server_timestamp
       FROM event_logs
       WHERE user_id = ?
       ORDER BY server_timestamp DESC
       LIMIT ?`
    );
  }

  append(input: AppendEventInput): { event: EventLog; inserted: boolean } {
    const eventId = input.eventId ?? crypto.randomUUID();
    const existing = this.stmtFindByEventId.get(eventId);
    if (existing) {
      if (existing.user_id !== input.userId) {
        throw new AppError(409, 'EVENT_ID_CONFLICT', 'Event ID is already in use');
      }
      return { event: mapEventLog(existing), inserted: false };
    }

    const id = crypto.randomUUID();
    const serverTimestamp = input.serverTimestamp ?? Date.now();
    const payload = input.payload ?? {};
    const clientTimestamp = input.clientTimestamp ?? null;

    this.stmtInsert.run(
      id,
      eventId,
      input.userId,
      input.entityType,
      input.entityId,
      input.eventType,
      JSON.stringify(payload),
      clientTimestamp,
      serverTimestamp
    );

    return {
      inserted: true,
      event: {
        id,
        eventId,
        userId: input.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        eventType: input.eventType,
        payload,
        clientTimestamp,
        serverTimestamp,
      },
    };
  }

  findByEventIdForUser(eventId: string, userId: string): EventLog | null {
    const row = this.stmtFindByEventIdForUser.get(eventId, userId);
    return row ? mapEventLog(row) : null;
  }

  findLatestForEntityForUser(
    userId: string,
    entityType: EventEntityType,
    entityId: string,
    eventType: string
  ): EventLog | null {
    const row = this.stmtFindLatestForEntityForUser.get(userId, entityType, entityId, eventType);
    return row ? mapEventLog(row) : null;
  }

  findLatestForEntityActionForUser(
    userId: string,
    entityType: EventEntityType,
    entityId: string,
    eventType: string,
    action: string
  ): EventLog | null {
    const row = this.stmtFindLatestForEntityActionForUser.get(
      userId,
      entityType,
      entityId,
      eventType,
      action
    );
    return row ? mapEventLog(row) : null;
  }

  listByUser(userId: string, limit: number = 50): EventLog[] {
    return this.stmtListByUser.all(userId, limit).map(mapEventLog);
  }
}
