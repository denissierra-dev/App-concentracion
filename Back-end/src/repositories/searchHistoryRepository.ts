import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { SearchEngine, SearchHistoryEntry } from '../domain/types.js';

interface SearchHistoryRow {
  id: string;
  user_id: string;
  engine: string;
  query: string;
  results_count: number;
  created_at: number;
}

function mapSearchHistory(row: SearchHistoryRow): SearchHistoryEntry {
  return {
    id: row.id,
    userId: row.user_id,
    engine: row.engine as SearchEngine,
    query: row.query,
    resultsCount: row.results_count,
    createdAt: row.created_at,
  };
}

/**
 * Per-user search history repository backed by precompiled SQLite statements.
 */
export class SearchHistoryRepository {
  private readonly stmtInsert: Database.Statement<
    [string, string, string, string, number, number]
  >;
  private readonly stmtFindByIdForUser: Database.Statement<[string, string], SearchHistoryRow>;
  private readonly stmtListByUser: Database.Statement<[string, number], SearchHistoryRow>;
  private readonly stmtListByUserAndEngine: Database.Statement<
    [string, string, number],
    SearchHistoryRow
  >;
  private readonly stmtCountByUser: Database.Statement<[string], { total: number }>;
  private readonly stmtCountByUserAndEngine: Database.Statement<
    [string, string],
    { total: number }
  >;
  private readonly stmtDeleteByIdForUser: Database.Statement<[string, string]>;
  private readonly stmtDeleteAllForUser: Database.Statement<[string]>;
  private readonly stmtDeleteAllForUserAndEngine: Database.Statement<[string, string]>;

  constructor(private readonly db: AppDatabase) {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO search_history (
         id, user_id, engine, query, results_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.stmtFindByIdForUser = this.db.prepare(
      `SELECT id, user_id, engine, query, results_count, created_at
       FROM search_history
       WHERE id = ? AND user_id = ?`
    );
    this.stmtListByUser = this.db.prepare(
      `SELECT id, user_id, engine, query, results_count, created_at
       FROM search_history
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );
    this.stmtListByUserAndEngine = this.db.prepare(
      `SELECT id, user_id, engine, query, results_count, created_at
       FROM search_history
       WHERE user_id = ? AND engine = ?
       ORDER BY created_at DESC
       LIMIT ?`
    );
    this.stmtCountByUser = this.db.prepare(
      'SELECT COUNT(*) AS total FROM search_history WHERE user_id = ?'
    );
    this.stmtCountByUserAndEngine = this.db.prepare(
      'SELECT COUNT(*) AS total FROM search_history WHERE user_id = ? AND engine = ?'
    );
    this.stmtDeleteByIdForUser = this.db.prepare(
      'DELETE FROM search_history WHERE id = ? AND user_id = ?'
    );
    this.stmtDeleteAllForUser = this.db.prepare('DELETE FROM search_history WHERE user_id = ?');
    this.stmtDeleteAllForUserAndEngine = this.db.prepare(
      'DELETE FROM search_history WHERE user_id = ? AND engine = ?'
    );
  }

  create(entry: SearchHistoryEntry): SearchHistoryEntry {
    this.stmtInsert.run(
      entry.id,
      entry.userId,
      entry.engine,
      entry.query,
      entry.resultsCount,
      entry.createdAt
    );

    return entry;
  }

  findByIdForUser(id: string, userId: string): SearchHistoryEntry | null {
    const row = this.stmtFindByIdForUser.get(id, userId);
    return row ? mapSearchHistory(row) : null;
  }

  listByUser(
    userId: string,
    options?: { engine?: SearchEngine; limit?: number }
  ): SearchHistoryEntry[] {
    const limit = options?.limit ?? 20;
    const rows = options?.engine
      ? this.stmtListByUserAndEngine.all(userId, options.engine, limit)
      : this.stmtListByUser.all(userId, limit);

    return rows.map(mapSearchHistory);
  }

  countByUser(userId: string, engine?: SearchEngine): number {
    const row = engine
      ? this.stmtCountByUserAndEngine.get(userId, engine)
      : this.stmtCountByUser.get(userId);
    return row?.total ?? 0;
  }

  deleteByIdForUser(id: string, userId: string): boolean {
    const result = this.stmtDeleteByIdForUser.run(id, userId);
    return result.changes > 0;
  }

  deleteAllForUser(userId: string, engine?: SearchEngine): number {
    const result = engine
      ? this.stmtDeleteAllForUserAndEngine.run(userId, engine)
      : this.stmtDeleteAllForUser.run(userId);
    return result.changes;
  }
}
