import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import type { TaskRepository } from '../../repositories/taskRepository.js';
import type { PriorityRecalcQueue } from '../../services/priorityQueue.js';
import type { TaskService } from '../../services/taskService.js';

const taskIdParamSchema = z.object({
  id: z.string().uuid(),
});

const createTaskSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  dueAt: z.number().int().positive().nullable().optional(),
  eventId: z.string().uuid().optional(),
  clientTimestamp: z.number().int().positive().optional(),
});

const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    completed: z.boolean().optional(),
    dueAt: z.number().int().positive().nullable().optional(),
    eventId: z.string().uuid().optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
  .refine(
    (data) =>
      data.title !== undefined ||
      data.description !== undefined ||
      data.completed !== undefined ||
      data.dueAt !== undefined,
    { message: 'At least one updatable task field must be provided' }
  );

const deleteTaskSchema = z
  .object({
    eventId: z.string().uuid().optional(),
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

  router.get('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const tasks = taskRepo.listByUser(userId);
      const counts = taskRepo.getCountsByUser(userId);

      res.json({
        tasks,
        counts,
        serverTimeMs: Date.now(),
      });
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
