import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/database.js';
import type { PriorityLevel, Task } from '../domain/types.js';

interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  completed: number;
  completed_at: number | null;
  user_priority: string;
  ai_priority: string | null;
  effective_priority: string;
  priority_score: number;
  priority_reason: string | null;
  priority_computed_at: number | null;
  priority_dismissed_until: number | null;
  priority_dismiss_count: number;
  tags_json: string;
  due_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TaskCountsRow {
  total: number;
  pending: number | null;
  completed: number | null;
}

export interface TaskCounts {
  total: number;
  pending: number;
  completed: number;
}

export type TaskStatusFilter = 'all' | 'pending' | 'completed';
export type TaskSortBy = 'default' | 'priority' | 'dueAt' | 'createdAt' | 'updatedAt';
export type SortOrder = 'asc' | 'desc';

export interface TaskQueryOptions {
  status?: TaskStatusFilter;
  priority?: PriorityLevel;
  tag?: string;
  search?: string;
  overdue?: boolean;
  hasDueDate?: boolean;
  sortBy?: TaskSortBy;
  sortOrder?: SortOrder;
  nowMs?: number;
}

const PRIORITY_RANK_SQL = `CASE effective_priority
  WHEN 'CRITICAL' THEN 4
  WHEN 'HIGH' THEN 3
  WHEN 'MEDIUM' THEN 2
  ELSE 1
END`;

const DEFAULT_ORDER_SQL = `completed ASC, ${PRIORITY_RANK_SQL} DESC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC, due_at ASC, created_at DESC`;

const SORT_CLAUSES: Record<TaskSortBy, Record<SortOrder, string>> = {
  default: {
    asc: DEFAULT_ORDER_SQL,
    desc: DEFAULT_ORDER_SQL,
  },
  priority: {
    asc: `${PRIORITY_RANK_SQL} ASC, created_at DESC`,
    desc: `${PRIORITY_RANK_SQL} DESC, created_at DESC`,
  },
  dueAt: {
    asc: 'CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC, due_at ASC, created_at DESC',
    desc: 'CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC, due_at DESC, created_at DESC',
  },
  createdAt: {
    asc: 'created_at ASC',
    desc: 'created_at DESC',
  },
  updatedAt: {
    asc: 'updated_at ASC',
    desc: 'updated_at DESC',
  },
};

function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    completed: row.completed === 1,
    completedAt: row.completed_at,
    userPriority: row.user_priority as PriorityLevel,
    aiPriority: row.ai_priority as PriorityLevel | null,
    effectivePriority: row.effective_priority as PriorityLevel,
    priorityScore: row.priority_score,
    priorityReason: row.priority_reason,
    priorityComputedAt: row.priority_computed_at,
    priorityDismissedUntil: row.priority_dismissed_until,
    priorityDismissCount: row.priority_dismiss_count,
    tags: JSON.parse(row.tags_json) as string[],
    dueAt: row.due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskRepository {
  private readonly stmtExistsById: Database.Statement<[string], { found: number }>;
  private readonly stmtFindByIdForUser: Database.Statement<[string, string], TaskRow>;
  private readonly stmtListByUser: Database.Statement<[string], TaskRow>;
  private readonly stmtListTagsByUser: Database.Statement<[string], { tag: string }>;
  private readonly stmtGetCountsByUser: Database.Statement<[string], TaskCountsRow>;
  private readonly stmtInsert: Database.Statement<
    [
      string,
      string,
      string,
      string | null,
      number,
      number | null,
      string,
      string | null,
      string,
      number,
      string | null,
      number | null,
      number | null,
      number,
      string,
      number | null,
      number,
      number,
    ]
  >;
  private readonly stmtUpdate: Database.Statement<
    [
      string,
      string | null,
      number,
      number | null,
      string,
      string | null,
      string,
      number,
      string | null,
      number | null,
      string,
      number | null,
      number,
      string,
      string,
    ]
  >;
  private readonly stmtUpdatePriorityMetadata: Database.Statement<
    [string | null, string, number, string | null, number, string, string]
  >;
  private readonly stmtDeleteForUser: Database.Statement<[string, string]>;
  private readonly filteredStmtCache = new Map<
    string,
    Database.Statement<Array<string | number>, TaskRow>
  >();
  private static readonly MAX_FILTERED_STMT_CACHE = 256;

  constructor(private readonly db: AppDatabase) {
    this.stmtExistsById = this.db.prepare('SELECT 1 AS found FROM tasks WHERE id = ? LIMIT 1');
    this.stmtFindByIdForUser = this.db.prepare(
      `SELECT id, user_id, title, description, completed, completed_at,
              user_priority, ai_priority, effective_priority, priority_score,
              priority_reason, priority_computed_at, priority_dismissed_until,
              priority_dismiss_count, tags_json, due_at, created_at, updated_at
       FROM tasks
       WHERE id = ? AND user_id = ?`
    );
    this.stmtListByUser = this.db.prepare(
      `SELECT id, user_id, title, description, completed, completed_at,
              user_priority, ai_priority, effective_priority, priority_score,
              priority_reason, priority_computed_at, priority_dismissed_until,
              priority_dismiss_count, tags_json, due_at, created_at, updated_at
       FROM tasks
       WHERE user_id = ?
       ORDER BY ${DEFAULT_ORDER_SQL}`
    );
    this.stmtListTagsByUser = this.db.prepare(
      `SELECT DISTINCT json_each.value AS tag
       FROM tasks, json_each(tasks.tags_json)
       WHERE tasks.user_id = ?
       ORDER BY LOWER(json_each.value) ASC`
    );
    this.stmtGetCountsByUser = this.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completed
       FROM tasks
       WHERE user_id = ?`
    );
    this.stmtInsert = this.db.prepare(
      `INSERT INTO tasks (
         id, user_id, title, description, completed, completed_at,
         user_priority, ai_priority, effective_priority, priority_score,
         priority_reason, priority_computed_at, priority_dismissed_until,
         priority_dismiss_count, tags_json, due_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtUpdate = this.db.prepare(
      `UPDATE tasks
       SET title = ?,
           description = ?,
           completed = ?,
           completed_at = ?,
           user_priority = ?,
           ai_priority = ?,
           effective_priority = ?,
           priority_score = ?,
           priority_reason = ?,
           priority_computed_at = ?,
           tags_json = ?,
           due_at = ?,
           updated_at = ?
       WHERE id = ? AND user_id = ?`
    );
    this.stmtUpdatePriorityMetadata = this.db.prepare(
      `UPDATE tasks
       SET ai_priority = ?,
           effective_priority = ?,
           priority_score = ?,
           priority_reason = ?,
           priority_computed_at = ?
       WHERE id = ? AND user_id = ?`
    );
    this.stmtDeleteForUser = this.db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?');
  }

  existsById(id: string): boolean {
    return this.stmtExistsById.get(id) !== undefined;
  }

  findByIdForUser(id: string, userId: string): Task | null {
    const row = this.stmtFindByIdForUser.get(id, userId);
    return row ? mapTask(row) : null;
  }

  listByUser(userId: string, options?: TaskQueryOptions): Task[] {
    if (
      !options ||
      ((options.status === undefined || options.status === 'all') &&
        options.priority === undefined &&
        options.tag === undefined &&
        options.search === undefined &&
        options.overdue === undefined &&
        options.hasDueDate === undefined &&
        (options.sortBy === undefined || options.sortBy === 'default'))
    ) {
      return this.stmtListByUser.all(userId).map(mapTask);
    }

    const conditions: string[] = ['user_id = ?'];
    const params: Array<string | number> = [userId];

    if (options.status === 'pending') {
      conditions.push('completed = 0');
    } else if (options.status === 'completed') {
      conditions.push('completed = 1');
    }

    if (options.priority !== undefined) {
      conditions.push('effective_priority = ?');
      params.push(options.priority);
    }

    if (options.tag !== undefined && options.tag.trim() !== '') {
      conditions.push(
        'EXISTS (SELECT 1 FROM json_each(tasks.tags_json) WHERE LOWER(json_each.value) = LOWER(?))'
      );
      params.push(options.tag.trim());
    }

    if (options.search !== undefined && options.search.trim() !== '') {
      const pattern = `%${escapeLikePattern(options.search.trim())}%`;
      conditions.push("(title LIKE ? ESCAPE '\\' OR COALESCE(description, '') LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }

    if (options.overdue === true) {
      conditions.push('completed = 0 AND due_at IS NOT NULL AND due_at < ?');
      params.push(options.nowMs ?? Date.now());
    } else if (options.overdue === false) {
      conditions.push('(completed = 1 OR due_at IS NULL OR due_at >= ?)');
      params.push(options.nowMs ?? Date.now());
    }

    if (options.hasDueDate === true) {
      conditions.push('due_at IS NOT NULL');
    } else if (options.hasDueDate === false) {
      conditions.push('due_at IS NULL');
    }

    const sortBy = options.sortBy ?? 'default';
    const defaultOrder: SortOrder = sortBy === 'dueAt' ? 'asc' : 'desc';
    const sortOrder = options.sortOrder ?? defaultOrder;
    const orderSql = SORT_CLAUSES[sortBy][sortOrder];

    const sql = `SELECT id, user_id, title, description, completed, completed_at,
                        user_priority, ai_priority, effective_priority, priority_score,
                        priority_reason, priority_computed_at, priority_dismissed_until,
                        priority_dismiss_count, tags_json, due_at, created_at, updated_at
                 FROM tasks
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY ${orderSql}`;

    let stmt = this.filteredStmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.filteredStmtCache.size >= TaskRepository.MAX_FILTERED_STMT_CACHE) {
        const oldestKey = this.filteredStmtCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.filteredStmtCache.delete(oldestKey);
        }
      }
      this.filteredStmtCache.set(sql, stmt);
    }

    const rows = stmt.all(...params);
    return rows.map(mapTask);
  }

  listTagsByUser(userId: string): string[] {
    return this.stmtListTagsByUser.all(userId).map((row) => row.tag);
  }

  getCountsByUser(userId: string): TaskCounts {
    const row = this.stmtGetCountsByUser.get(userId);
    return {
      total: row?.total ?? 0,
      pending: row?.pending ?? 0,
      completed: row?.completed ?? 0,
    };
  }

  create(task: Task): Task {
    this.stmtInsert.run(
      task.id,
      task.userId,
      task.title,
      task.description,
      task.completed ? 1 : 0,
      task.completedAt,
      task.userPriority,
      task.aiPriority,
      task.effectivePriority,
      task.priorityScore,
      task.priorityReason,
      task.priorityComputedAt,
      task.priorityDismissedUntil,
      task.priorityDismissCount,
      JSON.stringify(task.tags),
      task.dueAt,
      task.createdAt,
      task.updatedAt
    );

    return task;
  }

  update(task: Task): Task {
    this.stmtUpdate.run(
      task.title,
      task.description,
      task.completed ? 1 : 0,
      task.completedAt,
      task.userPriority,
      task.aiPriority,
      task.effectivePriority,
      task.priorityScore,
      task.priorityReason,
      task.priorityComputedAt,
      JSON.stringify(task.tags),
      task.dueAt,
      task.updatedAt,
      task.id,
      task.userId
    );

    return task;
  }

  updatePriorityMetadata(params: {
    id: string;
    userId: string;
    aiPriority: PriorityLevel | null;
    effectivePriority: PriorityLevel;
    priorityScore: number;
    priorityReason: string | null;
    priorityComputedAt: number;
  }): boolean {
    const result = this.stmtUpdatePriorityMetadata.run(
      params.aiPriority,
      params.effectivePriority,
      params.priorityScore,
      params.priorityReason,
      params.priorityComputedAt,
      params.id,
      params.userId
    );

    return result.changes > 0;
  }

  deleteForUser(id: string, userId: string): boolean {
    const result = this.stmtDeleteForUser.run(id, userId);
    return result.changes > 0;
  }
}
