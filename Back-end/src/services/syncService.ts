import { z } from 'zod';
import type { Preference, Session, SessionPlanPhase, Task } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';
import type { TaskCounts, TaskRepository } from '../repositories/taskRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';
import { preferencePatchSchema, type PreferenceService } from './preferenceService.js';
import type { PriorityRecalcQueue } from './priorityQueue.js';
import { SESSION_LIMITS } from './sessionPlanner.js';
import type { SessionService } from './sessionService.js';
import type { TaskService } from './taskService.js';

const baseEventFields = {
  eventId: z.string().uuid(),
  entityId: z.string().uuid(),
  clientTimestamp: z.number().int().positive().optional(),
};

const sessionStartEventSchema = z.object({
  ...baseEventFields,
  entityType: z.literal('session'),
  eventType: z.literal('SESSION_STARTED'),
  payload: z
    .object({
      focusDurationMin: z
        .number()
        .int()
        .min(SESSION_LIMITS.MIN_FOCUS_MIN)
        .max(SESSION_LIMITS.MAX_FOCUS_MIN)
        .optional(),
      totalCycles: z
        .number()
        .int()
        .min(SESSION_LIMITS.MIN_CYCLES)
        .max(SESSION_LIMITS.MAX_CYCLES)
        .optional(),
    })
    .optional()
    .default({}),
});

const sessionControlEventSchema = z.object({
  ...baseEventFields,
  entityType: z.literal('session'),
  eventType: z.enum([
    'SESSION_PAUSED',
    'SESSION_RESUMED',
    'PHASE_SKIPPED',
    'SESSION_RESET',
    'SESSION_ENDED',
  ]),
  expectedVersion: z.number().int().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
});

const preferenceUpdateEventSchema = z.object({
  ...baseEventFields,
  entityType: z.literal('preference'),
  eventType: z.literal('PREFERENCES_UPDATED'),
  payload: preferencePatchSchema,
});

const taskCreateEventSchema = z.object({
  ...baseEventFields,
  entityType: z.literal('task'),
  eventType: z.literal('TASK_CREATED'),
  payload: z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    dueAt: z.number().int().positive().nullable().optional(),
  }),
});

const taskUpdateEventSchema = z.object({
  ...baseEventFields,
  entityType: z.literal('task'),
  eventType: z.literal('TASK_UPDATED'),
  payload: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      completed: z.boolean().optional(),
      dueAt: z.number().int().positive().nullable().optional(),
    })
    .refine(
      (data) =>
        data.title !== undefined ||
        data.description !== undefined ||
        data.completed !== undefined ||
        data.dueAt !== undefined,
      { message: 'At least one updatable task field must be provided' }
    ),
});

const taskDeleteEventSchema = z.object({
  ...baseEventFields,
  entityType: z.literal('task'),
  eventType: z.literal('TASK_DELETED'),
  payload: z.record(z.unknown()).optional(),
});

/**
 * Phase 4A synchronization contract: only significant state-changing events are accepted.
 * Phase transitions, clock ticks, and minor UI changes (mute/temporary volume) stay local.
 */
export const syncEventSchema = z.union([
  sessionStartEventSchema,
  sessionControlEventSchema,
  preferenceUpdateEventSchema,
  taskCreateEventSchema,
  taskUpdateEventSchema,
  taskDeleteEventSchema,
]);

export const syncBatchSchema = z.object({
  events: z.array(syncEventSchema).min(1).max(100),
});

export type SyncEventInput = z.infer<typeof syncEventSchema>;

export interface SyncEventResult {
  eventId: string;
  entityType: SyncEventInput['entityType'];
  entityId: string;
  eventType: SyncEventInput['eventType'];
  status: 'applied' | 'duplicate' | 'conflict';
  version?: number;
  errorCode?: string;
  message?: string;
  details?: unknown;
}

export interface SyncSnapshot {
  activeSession: Session | null;
  currentPhase: SessionPlanPhase | null;
  preferences: Preference | null;
  taskCounts: TaskCounts;
  serverTimeMs: number;
}

export interface FullSyncState extends SyncSnapshot {
  tasks: Task[];
}

export interface SyncServiceDeps {
  sessionService: SessionService;
  preferenceService: PreferenceService;
  taskService: TaskService;
  userRepo: UserRepository;
  taskRepo: TaskRepository;
  priorityQueue: PriorityRecalcQueue;
}

export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {}

  getFullState(userId: string, nowMs: number = Date.now()): FullSyncState {
    const active = this.deps.sessionService.getActiveSessionState(userId, nowMs);
    const preferences = this.deps.userRepo.getPreferencesByUserId(userId);
    const tasks = this.deps.taskRepo.listByUser(userId);
    const taskCounts = this.deps.taskRepo.getCountsByUser(userId);

    return {
      activeSession: active.session,
      currentPhase: active.currentPhase,
      preferences,
      tasks,
      taskCounts,
      serverTimeMs: nowMs,
    };
  }

  processBatch(
    userId: string,
    events: SyncEventInput[],
    nowMs: number = Date.now()
  ): { results: SyncEventResult[]; snapshot: SyncSnapshot } {
    const results: SyncEventResult[] = [];
    const tasksToRecalc = new Set<string>();

    for (const event of events) {
      try {
        const outcome = this.applySingleEvent(userId, event, nowMs);
        if (outcome.recalcTaskId) {
          tasksToRecalc.add(outcome.recalcTaskId);
        }
        results.push({
          eventId: event.eventId,
          entityType: event.entityType,
          entityId: event.entityId,
          eventType: event.eventType,
          status: outcome.duplicate ? 'duplicate' : 'applied',
          ...(outcome.version !== undefined ? { version: outcome.version } : {}),
        });
      } catch (err) {
        if (err instanceof AppError) {
          results.push({
            eventId: event.eventId,
            entityType: event.entityType,
            entityId: event.entityId,
            eventType: event.eventType,
            status: 'conflict',
            errorCode: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          });
        } else {
          throw err;
        }
      }
    }

    for (const taskId of tasksToRecalc) {
      this.deps.priorityQueue.enqueue(userId, taskId);
    }

    const active = this.deps.sessionService.getActiveSessionState(userId, nowMs);
    const snapshot: SyncSnapshot = {
      activeSession: active.session,
      currentPhase: active.currentPhase,
      preferences: this.deps.userRepo.getPreferencesByUserId(userId),
      taskCounts: this.deps.taskRepo.getCountsByUser(userId),
      serverTimeMs: nowMs,
    };

    return { results, snapshot };
  }

  private applySingleEvent(
    userId: string,
    event: SyncEventInput,
    nowMs: number
  ): { duplicate: boolean; version?: number; recalcTaskId?: string } {
    switch (event.eventType) {
      case 'SESSION_STARTED': {
        const res = this.deps.sessionService.createSession({
          userId,
          sessionId: event.entityId,
          focusDurationMin: event.payload.focusDurationMin,
          totalCycles: event.payload.totalCycles,
          eventId: event.eventId,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: !res.created, version: res.session.version };
      }

      case 'SESSION_PAUSED': {
        const res = this.deps.sessionService.pauseSession({
          userId,
          sessionId: event.entityId,
          eventId: event.eventId,
          expectedVersion: event.expectedVersion,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent, version: res.session.version };
      }

      case 'SESSION_RESUMED': {
        const res = this.deps.sessionService.resumeSession({
          userId,
          sessionId: event.entityId,
          eventId: event.eventId,
          expectedVersion: event.expectedVersion,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent, version: res.session.version };
      }

      case 'PHASE_SKIPPED': {
        const res = this.deps.sessionService.skipPhase({
          userId,
          sessionId: event.entityId,
          eventId: event.eventId,
          expectedVersion: event.expectedVersion,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent, version: res.session.version };
      }

      case 'SESSION_RESET': {
        const res = this.deps.sessionService.resetSession({
          userId,
          sessionId: event.entityId,
          eventId: event.eventId,
          expectedVersion: event.expectedVersion,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent, version: res.session.version };
      }

      case 'SESSION_ENDED': {
        const res = this.deps.sessionService.endSession({
          userId,
          sessionId: event.entityId,
          eventId: event.eventId,
          expectedVersion: event.expectedVersion,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent, version: res.session.version };
      }

      case 'PREFERENCES_UPDATED': {
        const res = this.deps.preferenceService.updatePreferences({
          userId,
          patch: event.payload,
          eventId: event.eventId,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent };
      }

      case 'TASK_CREATED': {
        const res = this.deps.taskService.createTask({
          userId,
          id: event.entityId,
          title: event.payload.title,
          description: event.payload.description,
          dueAt: event.payload.dueAt,
          eventId: event.eventId,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return {
          duplicate: !res.created,
          recalcTaskId: res.created ? res.task.id : undefined,
        };
      }

      case 'TASK_UPDATED': {
        const res = this.deps.taskService.updateTask({
          userId,
          taskId: event.entityId,
          title: event.payload.title,
          description: event.payload.description,
          completed: event.payload.completed,
          dueAt: event.payload.dueAt,
          eventId: event.eventId,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return {
          duplicate: res.idempotent,
          recalcTaskId: res.shouldRecalc ? res.task.id : undefined,
        };
      }

      case 'TASK_DELETED': {
        const res = this.deps.taskService.deleteTask({
          userId,
          taskId: event.entityId,
          eventId: event.eventId,
          clientTimestamp: event.clientTimestamp,
          nowMs,
        });
        return { duplicate: res.idempotent };
      }
    }
  }
}
