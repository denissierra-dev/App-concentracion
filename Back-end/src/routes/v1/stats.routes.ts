import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import type { StatsService } from '../../services/statsService.js';

const statsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const exportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export interface StatsRouterDeps {
  statsService: StatsService;
  authenticate: RequestHandler;
}

function getAuthenticatedUserId(req: Express.Request): string {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
  }
  return req.auth.user.id;
}

export function createStatsRouter({ statsService, authenticate }: StatsRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  /**
   * Computes on-demand dashboard aggregates, streaks, productivity breakdowns,
   * and primordial task completion rate for the authenticated user.
   */
  router.get('/', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { days } = statsQuerySchema.parse(req.query);
      const summary = statsService.getDashboardStats(userId, { days });

      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Exports user productivity metrics as downloadable JSON or CSV.
   */
  router.get('/export', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { format, days } = exportQuerySchema.parse(req.query);
      const exported = statsService.exportStats(userId, { format, days });

      res.setHeader('Content-Type', exported.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
      res.send(exported.body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
