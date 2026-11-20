import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { PriorityLevel, Task } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';
import type { EventLogRepository } from '../repositories/eventLogRepository.js';
import type { StatsRepository } from '../repositories/statsRepository.js';
import type { TaskRepository } from '../repositories/taskRepository.js';
import { maxPriority } from './priorityService.js';

export type ManualPriorityLevel = Extract<PriorityLevel, 'LOW' | 'MEDIUM' | 'HIGH'>;

export interface TaskServiceDeps {
  db: AppDatabase;
  taskRepo: TaskRepository;
  statsRepo: StatsRepository;
  eventLogRepo: EventLogRepository;
}

export interface CreateTaskParams {
  userId: string;
  id?: string;
  title: string;
  description?: string | null;
  userPriority?: ManualPriorityLevel;
  tags?: string[];
  dueAt?: number | null;
  eventId?: string;
  clientTimestamp?: number;
  nowMs?: number;
}

export interface UpdateTaskParams {
  userId: string;
  taskId: string;
  title?: string;
  description?: string | null;
  completed?: boolean;
  userPriority?: ManualPriorityLevel;
  tags?: string[];
  dueAt?: number | null;
  eventId?: string;
  clientTimestamp?: number;
  nowMs?: number;
}

export interface DeleteTaskParams {
  userId: string;
  taskId: string;
  eventId?: string;
  clientTimestamp?: number;
  nowMs?: number;
}

/**
 * Trims and deduplicates tags case-insensitively while preserving first-seen casing.
 */
export function normalizeTags(tags?: string[]): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function checkIdempotentTaskEvent(
  eventLogRepo: EventLogRepository,
  params: { eventId?: string; userId: string; taskId?: string; eventType: string }
): string | null {
  if (!params.eventId) {
    return null;
  }

  const existing = eventLogRepo.findByEventIdForUser(params.eventId, params.userId);
  if (!existing) {
    return null;
  }

  if (
    existing.entityType !== 'task' ||
    existing.eventType !== params.eventType ||
    (params.taskId !== undefined && existing.entityId !== params.taskId)
  ) {
    throw new AppError(
      409,
      'EVENT_ID_CONFLICT',
      'Event ID was already used for a different action'
    );
  }

  return existing.entityId;
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  createTask(params: CreateTaskParams): { created: boolean; task: Task } {
    const nowMs = params.nowMs ?? Date.now();
    const userPriority = params.userPriority ?? 'LOW';
    const tags = normalizeTags(params.tags);

    return this.deps.db.transaction(() => {
      const replayEntityId = checkIdempotentTaskEvent(this.deps.eventLogRepo, {
        eventId: params.eventId,
        userId: params.userId,
        taskId: params.id,
        eventType: 'TASK_CREATED',
      });
      if (replayEntityId) {
        const replayedTask = this.deps.taskRepo.findByIdForUser(replayEntityId, params.userId);
        if (replayedTask) {
          return { created: false, task: replayedTask };
        }
      }

      if (params.id) {
        const existing = this.deps.taskRepo.findByIdForUser(params.id, params.userId);
        if (existing) {
          return { created: false, task: existing };
        }
        if (this.deps.taskRepo.existsById(params.id)) {
          throw new AppError(409, 'TASK_ID_CONFLICT', 'Task ID is already in use');
        }
      }

      const task: Task = {
        id: params.id ?? crypto.randomUUID(),
        userId: params.userId,
        title: params.title,
        description: params.description ?? null,
        completed: false,
        completedAt: null,
        userPriority,
        aiPriority: null,
        effectivePriority: userPriority,
        priorityScore: 0,
        priorityReason: null,
        priorityComputedAt: null,
        priorityDismissedUntil: null,
        priorityDismissCount: 0,
        tags,
        dueAt: params.dueAt ?? null,
        createdAt: nowMs,
        updatedAt: nowMs,
      };

      this.deps.taskRepo.create(task);
      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'task',
        entityId: task.id,
        eventType: 'TASK_CREATED',
        payload: {
          title: task.title,
          userPriority: task.userPriority,
          tags: task.tags,
          dueAt: task.dueAt,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { created: true, task };
    })();
  }

  updateTask(params: UpdateTaskParams): {
    idempotent: boolean;
    task: Task;
    shouldRecalc: boolean;
  } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      const existing = this.deps.taskRepo.findByIdForUser(params.taskId, params.userId);

      if (
        checkIdempotentTaskEvent(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          taskId: params.taskId,
          eventType: 'TASK_UPDATED',
        })
      ) {
        if (!existing) {
          throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
        }
        return { idempotent: true, task: existing, shouldRecalc: false };
      }

      if (!existing) {
        throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
      }

      const nextCompleted = params.completed ?? existing.completed;
      const completedChanged = nextCompleted !== existing.completed;
      const dueAtChanged = params.dueAt !== undefined && params.dueAt !== existing.dueAt;
      const nextUserPriority = params.userPriority ?? existing.userPriority;
      const userPriorityChanged = nextUserPriority !== existing.userPriority;
      const nextTags = params.tags !== undefined ? normalizeTags(params.tags) : existing.tags;

      let nextCompletedAt = existing.completedAt;
      if (completedChanged) {
        nextCompletedAt = nextCompleted ? nowMs : null;
        this.deps.statsRepo.adjustTasksCompleted(params.userId, nextCompleted ? 1 : -1, nowMs);
      }

      const updated: Task = {
        ...existing,
        title: params.title ?? existing.title,
        description: params.description !== undefined ? params.description : existing.description,
        completed: nextCompleted,
        completedAt: nextCompletedAt,
        userPriority: nextUserPriority,
        effectivePriority: maxPriority(nextUserPriority, existing.aiPriority),
        tags: nextTags,
        dueAt: params.dueAt !== undefined ? params.dueAt : existing.dueAt,
        updatedAt: nowMs,
      };

      this.deps.taskRepo.update(updated);

      const action = completedChanged ? (nextCompleted ? 'completed' : 'reopened') : 'edited';

      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'task',
        entityId: updated.id,
        eventType: 'TASK_UPDATED',
        payload: {
          action,
          completed: updated.completed,
          userPriority: updated.userPriority,
          tags: updated.tags,
          dueAt: updated.dueAt,
        },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return {
        idempotent: false,
        task: updated,
        shouldRecalc: completedChanged || dueAtChanged || userPriorityChanged,
      };
    })();
  }

  deleteTask(params: DeleteTaskParams): { idempotent: boolean; deleted: true } {
    const nowMs = params.nowMs ?? Date.now();

    return this.deps.db.transaction(() => {
      if (
        checkIdempotentTaskEvent(this.deps.eventLogRepo, {
          eventId: params.eventId,
          userId: params.userId,
          taskId: params.taskId,
          eventType: 'TASK_DELETED',
        })
      ) {
        return { idempotent: true, deleted: true as const };
      }

      const deleted = this.deps.taskRepo.deleteForUser(params.taskId, params.userId);
      if (!deleted) {
        throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
      }

      this.deps.eventLogRepo.append({
        eventId: params.eventId,
        userId: params.userId,
        entityType: 'task',
        entityId: params.taskId,
        eventType: 'TASK_DELETED',
        payload: {},
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return { idempotent: false, deleted: true as const };
    })();
  }
}
