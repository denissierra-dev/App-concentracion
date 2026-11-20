import { Router } from 'express';

export function createTimeRouter(): Router {
  const router = Router();

  /**
   * Returns authoritative server timestamp so clients can compute
   * clock offset: offset = serverTimeMs - clientLocalMs.
   */
  router.get('/', (_req, res) => {
    const serverTimeMs = Date.now();
    res.json({
      serverTimeMs,
      iso: new Date(serverTimeMs).toISOString(),
    });
  });

  return router;
}
