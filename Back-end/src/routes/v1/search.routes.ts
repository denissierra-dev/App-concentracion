import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import { nonNilUuidSchema, safeSingleLineTextSchema } from '../../security/validators.js';
import type { SearchService } from '../../services/searchService.js';

const engineSchema = z.enum(['google', 'wikipedia', 'stackoverflow']);

const queryBooleanSchema = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return val;
}, z.boolean());

const searchQuerySchema = z.object({
  q: safeSingleLineTextSchema(1, 500, 'Search query'),
  engine: engineSchema.default('wikipedia'),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  lang: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]{2})?$/i, 'Invalid language code')
    .default('en'),
  saveHistory: queryBooleanSchema.default(true),
});

const historyQuerySchema = z.object({
  engine: engineSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const clearHistoryQuerySchema = z.object({
  engine: engineSchema.optional(),
});

const historyIdParamSchema = z.object({
  id: nonNilUuidSchema,
});

export interface SearchRouterDeps {
  searchService: SearchService;
  authenticate: RequestHandler;
  searchLimiter?: RequestHandler;
}

function getAuthenticatedUserId(req: Express.Request): string {
  if (!req.auth) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
  }
  return req.auth.user.id;
}

export function createSearchRouter({
  searchService,
  authenticate,
  searchLimiter,
}: SearchRouterDeps): Router {
  const router = Router();
  router.use(authenticate);

  router.get('/engines', (_req, res, next) => {
    try {
      res.json({
        engines: searchService.listEngines(),
        serverTimeMs: Date.now(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/history', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const query = historyQuerySchema.parse(req.query);
      const result = searchService.getHistory(userId, {
        engine: query.engine,
        limit: query.limit,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/history/:id', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const { id } = historyIdParamSchema.parse(req.params);
      const result = searchService.deleteHistoryEntry(userId, id);

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/history', (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const query = clearHistoryQuerySchema.parse(req.query);
      const result = searchService.clearHistory(userId, query.engine);

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  const handleSearch: RequestHandler = async (req, res, next) => {
    try {
      const userId = getAuthenticatedUserId(req);
      const params = searchQuerySchema.parse(req.query);

      const result = await searchService.search({
        userId,
        engine: params.engine,
        query: params.q,
        limit: params.limit,
        lang: params.lang,
        saveHistory: params.saveHistory,
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  };

  if (searchLimiter) {
    router.get('/', searchLimiter, handleSearch);
  } else {
    router.get('/', handleSearch);
  }

  return router;
}
