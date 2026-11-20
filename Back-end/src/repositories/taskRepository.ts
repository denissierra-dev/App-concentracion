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
    [string, string | null, number, number | null, number | null, number, string, string]
  >;
  private readonly stmtDeleteForUser: Database.Statement<[string, string]>;

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
       ORDER BY completed ASC, created_at DESC`
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
           due_at = ?,
           updated_at = ?
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

  listByUser(userId: string): Task[] {
    return this.stmtListByUser.all(userId).map(mapTask);
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
      task.dueAt,
      task.updatedAt,
      task.id,
      task.userId
    );

    return task;
  }

  deleteForUser(id: string, userId: string): boolean {
    const result = this.stmtDeleteForUser.run(id, userId);
    return result.changes > 0;
  }
}
