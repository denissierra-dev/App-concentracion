import { Router, type RequestHandler } from 'express';
import { AppError } from '../../errors/AppError.js';
import { syncBatchSchema, type SyncService } from '../../services/syncService.js';

export interface SyncRouterDeps {
  syncService: SyncService;
  authenticate: RequestHandler;
}

function getAuthenticatedUserId(req: Express.Request): string {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
  }
  return req.auth.user.id;
}

export function createSyncRouter({ syncService, authenticate }: SyncRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  /**
   * On-demand full authoritative state pull for initial hydration or version reconciliation.
   */
  router.get('/state', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const state = syncService.getFullState(userId);
      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Phase 4B batch sync endpoint: processes queued idempotent client events
   * (eventId + version check) and returns per-event outcomes plus authoritative snapshot.
   */
  router.post('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const body = syncBatchSchema.parse(req.body ?? {});
      const outcome = syncService.processBatch(userId, body.events);
      res.json(outcome);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
