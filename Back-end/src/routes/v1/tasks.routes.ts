import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import type { TaskRepository } from '../../repositories/taskRepository.js';
import {
  nonNilUuidSchema,
  safeMultilineTextSchema,
  safeSingleLineTextSchema,
} from '../../security/validators.js';
import type { PriorityRecalcQueue } from '../../services/priorityQueue.js';
import type { TaskService } from '../../services/taskService.js';

const taskIdParamSchema = z.object({
  id: nonNilUuidSchema,
});

const manualPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const effectivePriorityFilterSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const taskTagSchema = safeSingleLineTextSchema(1, 32, 'Tag');
const taskTagsSchema = z.array(taskTagSchema).max(10);

const listTasksQuerySchema = z.object({
  status: z.enum(['all', 'pending', 'completed']).optional().default('all'),
  priority: effectivePriorityFilterSchema.optional(),
  tag: taskTagSchema.optional(),
  search: safeSingleLineTextSchema(1, 100, 'Search filter').optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  hasDueDate: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  sortBy: z
    .enum(['default', 'priority', 'dueAt', 'createdAt', 'updatedAt'])
    .optional()
    .default('default'),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const createTaskSchema = z.object({
  id: nonNilUuidSchema.optional(),
  title: safeSingleLineTextSchema(1, 200, 'Title'),
  description: safeMultilineTextSchema(2000, 'Description').nullable().optional(),
  userPriority: manualPrioritySchema.optional(),
  tags: taskTagsSchema.optional(),
  dueAt: z.number().int().positive().nullable().optional(),
  eventId: nonNilUuidSchema.optional(),
  clientTimestamp: z.number().int().positive().optional(),
});

const updateTaskSchema = z
  .object({
    title: safeSingleLineTextSchema(1, 200, 'Title').optional(),
    description: safeMultilineTextSchema(2000, 'Description').nullable().optional(),
    completed: z.boolean().optional(),
    userPriority: manualPrioritySchema.optional(),
    tags: taskTagsSchema.optional(),
    dueAt: z.number().int().positive().nullable().optional(),
    eventId: nonNilUuidSchema.optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.description !== undefined ||
      data.completed !== undefined ||
      data.userPriority !== undefined ||
      data.tags !== undefined ||
      data.dueAt !== undefined,
    { message: 'At least one updatable task field must be provided' }
  );

const deleteTaskSchema = z
  .object({
    eventId: nonNilUuidSchema.optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
  .optional()
  .default({});

export interface TasksRouterDeps {
  taskRepo: TaskRepository;
  taskService: TaskService;
  priorityQueue: PriorityRecalcQueue;
  authenticate: RequestHandler;
}

function getAuthenticatedUserId(req: Express.Request): string {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
  }
  return req.auth.user.id;
}

export function createTasksRouter({
  taskRepo,
  taskService,
  priorityQueue,
  authenticate,
}: TasksRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  /**
   * Lists tasks with server-side filtering, search, and sorting.
   */
  router.get('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const query = listTasksQuerySchema.parse(req.query);
      const nowMs = Date.now();

      const tasks = taskRepo.listByUser(userId, {
        status: query.status,
        priority: query.priority,
        tag: query.tag,
        search: query.search,
        overdue: query.overdue,
        hasDueDate: query.hasDueDate,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        nowMs,
      });
      const counts = taskRepo.getCountsByUser(userId);

      res.json({
        tasks,
        counts,
        filteredCount: tasks.length,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Lists distinct tags used by the authenticated user's tasks.
   */
  router.get('/tags', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const tags = taskRepo.listTagsByUser(userId);
      res.json({ tags, serverTimeMs: Date.now() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = taskIdParamSchema.parse(req.params);
      const task = taskRepo.findByIdForUser(id, userId);
      if (!task) {
        throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
      }

      res.json({ task, serverTimeMs: Date.now() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const body = createTaskSchema.parse(req.body ?? {});
      const nowMs = Date.now();

      const result = taskService.createTask({
        userId,
        id: body.id,
        title: body.title,
        description: body.description,
        userPriority: body.userPriority,
        tags: body.tags,
        dueAt: body.dueAt,
        eventId: body.eventId,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });

      if (result.created) {
        priorityQueue.enqueue(userId, result.task.id);
      }

      const counts = taskRepo.getCountsByUser(userId);
      res.status(result.created ? 201 : 200).json({
        created: result.created,
        task: result.task,
        counts,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = taskIdParamSchema.parse(req.params);
      const body = updateTaskSchema.parse(req.body ?? {});
      const nowMs = Date.now();

      const result = taskService.updateTask({
        userId,
        taskId: id,
        title: body.title,
        description: body.description,
        completed: body.completed,
        userPriority: body.userPriority,
        tags: body.tags,
        dueAt: body.dueAt,
        eventId: body.eventId,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });

      if (result.shouldRecalc) {
        priorityQueue.enqueue(userId, result.task.id);
      }

      const counts = taskRepo.getCountsByUser(userId);
      res.json({
        idempotent: result.idempotent,
        task: result.task,
        counts,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = taskIdParamSchema.parse(req.params);
      const body = deleteTaskSchema.parse(req.body);
      const nowMs = Date.now();

      const result = taskService.deleteTask({
        userId,
        taskId: id,
        eventId: body.eventId,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });

      const counts = taskRepo.getCountsByUser(userId);
      res.json({
        ...result,
        counts,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
