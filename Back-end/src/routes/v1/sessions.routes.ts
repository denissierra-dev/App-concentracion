import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { SESSION_LIMITS } from '../../services/sessionPlanner.js';
import type { SessionService } from '../../services/sessionService.js';

const createSessionSchema = z.object({
  sessionId: z.string().uuid().optional(),
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
    .default(SESSION_LIMITS.CYCLES_BEFORE_LONG_BREAK),
  eventId: z.string().uuid().optional(),
  clientTimestamp: z.number().int().positive().optional(),
});

const controlEventSchema = z
  .object({
    eventId: z.string().uuid().optional(),
    expectedVersion: z.number().int().min(1).optional(),
    clientTimestamp: z.number().int().positive().optional(),
  })
  .optional()
  .default({});

const sessionIdParamSchema = z.object({
  id: z.string().uuid(),
});

export interface SessionsRouterDeps {
  sessionService: SessionService;
  authenticate: RequestHandler;
}

function getAuthenticatedUserId(req: Express.Request): string {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
  }
  return req.auth.user.id;
}

export function createSessionsRouter({
  sessionService,
  authenticate,
}: SessionsRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  router.post('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const body = createSessionSchema.parse(req.body ?? {});
      const nowMs = Date.now();

      const result = sessionService.createSession({
        userId,
        sessionId: body.sessionId,
        focusDurationMin: body.focusDurationMin,
        totalCycles: body.totalCycles,
        eventId: body.eventId,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });

      res.status(result.created ? 201 : 200).json({
        created: result.created,
        session: result.session,
        serverTimeMs: nowMs,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/active', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const nowMs = Date.now();
      const state = sessionService.getActiveSessionState(userId, nowMs);
      res.json({ ...state, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/state', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const nowMs = Date.now();
      const state = sessionService.getSessionState(userId, id, nowMs);
      res.json({ ...state, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/pause', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();
      const result = sessionService.pauseSession({
        userId,
        sessionId: id,
        eventId: body.eventId,
        expectedVersion: body.expectedVersion,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });
      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/resume', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();
      const result = sessionService.resumeSession({
        userId,
        sessionId: id,
        eventId: body.eventId,
        expectedVersion: body.expectedVersion,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });
      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/skip', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();
      const result = sessionService.skipPhase({
        userId,
        sessionId: id,
        eventId: body.eventId,
        expectedVersion: body.expectedVersion,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });
      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/reset', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();
      const result = sessionService.resetSession({
        userId,
        sessionId: id,
        eventId: body.eventId,
        expectedVersion: body.expectedVersion,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });
      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/end', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = sessionIdParamSchema.parse(req.params);
      const body = controlEventSchema.parse(req.body);
      const nowMs = Date.now();
      const result = sessionService.endSession({
        userId,
        sessionId: id,
        eventId: body.eventId,
        expectedVersion: body.expectedVersion,
        clientTimestamp: body.clientTimestamp,
        nowMs,
      });
      res.json({ ...result, serverTimeMs: nowMs });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
