import type { AppDatabase } from '../db/database.js';
import type { PriorityLevel, Task } from '../domain/types.js';
import type { TaskRepository } from '../repositories/taskRepository.js';

export interface PriorityRulesConfig {
  criticalThresholdMs: number;
  highThresholdMs: number;
  mediumThresholdMs: number;
}

export const DEFAULT_PRIORITY_RULES_CONFIG: PriorityRulesConfig = {
  criticalThresholdMs: 4 * 60 * 60 * 1000,
  highThresholdMs: 24 * 60 * 60 * 1000,
  mediumThresholdMs: 72 * 60 * 60 * 1000,
};

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const BASE_PRIORITY_SCORE: Record<PriorityLevel, number> = {
  LOW: 10,
  MEDIUM: 40,
  HIGH: 70,
  CRITICAL: 90,
};

export interface PriorityEvaluation {
  aiPriority: PriorityLevel | null;
  effectivePriority: PriorityLevel;
  priorityScore: number;
  priorityReason: string | null;
  priorityComputedAt: number;
}

export interface PriorityServiceDeps {
  db: AppDatabase;
  taskRepo: TaskRepository;
  config?: Partial<PriorityRulesConfig>;
}

/**
 * Returns the higher priority level between a manual user priority and an automated priority.
 */
export function maxPriority(
  userPriority: PriorityLevel,
  aiPriority: PriorityLevel | null | undefined
): PriorityLevel {
  if (!aiPriority) {
    return userPriority;
  }
  return PRIORITY_RANK[userPriority] >= PRIORITY_RANK[aiPriority] ? userPriority : aiPriority;
}

function formatDueReason(remainingMs: number, config: PriorityRulesConfig): string {
  if (remainingMs <= 0) {
    return 'Overdue task';
  }
  if (remainingMs < 60 * 60 * 1000) {
    return `Due in ${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  }
  if (remainingMs <= config.highThresholdMs) {
    return `Due in ${Math.ceil(remainingMs / 3_600_000)}h`;
  }
  if (remainingMs <= config.mediumThresholdMs) {
    return `Due in ${Math.ceil(remainingMs / 86_400_000)}d`;
  }
  return 'Due in more than 72h';
}

/**
 * Evaluates deterministic Phase 6.5A priority rules for a task at `nowMs`.
 */
export function evaluateTaskPriority(
  task: Task,
  nowMs: number,
  config: PriorityRulesConfig = DEFAULT_PRIORITY_RULES_CONFIG
): PriorityEvaluation {
  if (task.completed) {
    return {
      aiPriority: null,
      effectivePriority: task.userPriority,
      priorityScore: 0,
      priorityReason: null,
      priorityComputedAt: nowMs,
    };
  }

  if (task.priorityDismissedUntil !== null && task.priorityDismissedUntil > nowMs) {
    return {
      aiPriority: null,
      effectivePriority: task.userPriority,
      priorityScore: BASE_PRIORITY_SCORE[task.userPriority],
      priorityReason: null,
      priorityComputedAt: nowMs,
    };
  }

  if (task.dueAt === null) {
    const aiPriority: PriorityLevel = 'LOW';
    const effectivePriority = maxPriority(task.userPriority, aiPriority);
    return {
      aiPriority,
      effectivePriority,
      priorityScore: BASE_PRIORITY_SCORE[effectivePriority],
      priorityReason: 'No due date',
      priorityComputedAt: nowMs,
    };
  }

  const remainingMs = task.dueAt - nowMs;

  if (remainingMs <= config.criticalThresholdMs) {
    const aiPriority: PriorityLevel = 'CRITICAL';
    const effectivePriority = maxPriority(task.userPriority, aiPriority);
    const urgencyBonus =
      remainingMs <= 0
        ? 10
        : Math.round((1 - Math.max(0, remainingMs) / config.criticalThresholdMs) * 9);

    return {
      aiPriority,
      effectivePriority,
      priorityScore: 90 + urgencyBonus,
      priorityReason: formatDueReason(remainingMs, config),
      priorityComputedAt: nowMs,
    };
  }

  if (remainingMs <= config.highThresholdMs) {
    const aiPriority: PriorityLevel = 'HIGH';
    const effectivePriority = maxPriority(task.userPriority, aiPriority);
    const span = Math.max(1, config.highThresholdMs - config.criticalThresholdMs);
    const ratio = Math.max(0, Math.min(1, (config.highThresholdMs - remainingMs) / span));

    return {
      aiPriority,
      effectivePriority,
      priorityScore: 70 + Math.round(ratio * 19),
      priorityReason: formatDueReason(remainingMs, config),
      priorityComputedAt: nowMs,
    };
  }

  if (remainingMs <= config.mediumThresholdMs) {
    const aiPriority: PriorityLevel = 'MEDIUM';
    const effectivePriority = maxPriority(task.userPriority, aiPriority);
    const span = Math.max(1, config.mediumThresholdMs - config.highThresholdMs);
    const ratio = Math.max(0, Math.min(1, (config.mediumThresholdMs - remainingMs) / span));
    const deadlineScore = 40 + Math.round(ratio * 29);

    return {
      aiPriority,
      effectivePriority,
      priorityScore: Math.max(BASE_PRIORITY_SCORE[effectivePriority], deadlineScore),
      priorityReason: formatDueReason(remainingMs, config),
      priorityComputedAt: nowMs,
    };
  }

  const aiPriority: PriorityLevel = 'LOW';
  const effectivePriority = maxPriority(task.userPriority, aiPriority);
  return {
    aiPriority,
    effectivePriority,
    priorityScore: Math.max(BASE_PRIORITY_SCORE[effectivePriority], 15),
    priorityReason: formatDueReason(remainingMs, config),
    priorityComputedAt: nowMs,
  };
}

export class PriorityService {
  private readonly config: PriorityRulesConfig;

  constructor(private readonly deps: PriorityServiceDeps) {
    this.config = {
      ...DEFAULT_PRIORITY_RULES_CONFIG,
      ...deps.config,
    };
  }

  recalculateTask(userId: string, taskId: string, nowMs: number = Date.now()): Task | null {
    if (!this.deps.db.open) {
      return null;
    }

    const task = this.deps.taskRepo.findByIdForUser(taskId, userId);
    if (!task) {
      return null;
    }

    const evaluation = evaluateTaskPriority(task, nowMs, this.config);
    this.deps.taskRepo.updatePriorityMetadata({
      id: task.id,
      userId: task.userId,
      aiPriority: evaluation.aiPriority,
      effectivePriority: evaluation.effectivePriority,
      priorityScore: evaluation.priorityScore,
      priorityReason: evaluation.priorityReason,
      priorityComputedAt: evaluation.priorityComputedAt,
    });

    return {
      ...task,
      ...evaluation,
    };
  }
}
