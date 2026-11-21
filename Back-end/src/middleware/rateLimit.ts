import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
  message?: string;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  maxBuckets?: number;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window rate limiter with bounded bucket storage and periodic pruning.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, RateBucket>();
  const maxBuckets = options.maxBuckets ?? 10_000;
  const message = options.message ?? 'Too many requests; please try again later';

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }, Math.max(30_000, options.windowMs));
  cleanupTimer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.skip?.(req)) {
      next();
      return;
    }

    const now = Date.now();
    const rawKey = options.keyGenerator
      ? options.keyGenerator(req)
      : (req.ip || req.socket.remoteAddress || 'unknown');
    const key = `${options.keyPrefix}:${rawKey}`;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (bucket) {
        // Re-insert refreshed key at the tail so Map iteration order tracks window recency.
        buckets.delete(key);
      } else if (buckets.size >= maxBuckets) {
        // Purge all expired windows first before rejecting new keys.
        for (const [candidateKey, candidateBucket] of buckets) {
          if (candidateBucket.resetAt <= now) {
            buckets.delete(candidateKey);
          }
        }
        // Preserve active rate-limit windows (fail closed instead of FIFO-evicting active buckets).
        if (buckets.size >= maxBuckets) {
          const oldestActive = buckets.values().next().value;
          const resetAt = oldestActive ? oldestActive.resetAt : now + options.windowMs;
          const retryAfterSec = Math.max(1, Math.ceil((resetAt - now) / 1000));
          res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
          res.setHeader('Retry-After', String(retryAfterSec));
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message,
            },
          });
          return;
        }
      }
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.maxRequests - bucket.count);
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.maxRequests) {
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message,
        },
      });
      return;
    }

    next();
  };
}
