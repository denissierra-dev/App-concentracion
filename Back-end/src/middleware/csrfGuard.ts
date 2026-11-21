import type { NextFunction, Request, Response } from 'express';
import { extractBearerToken, extractSessionCookie } from '../auth/SessionTokenAuthProvider.js';
import { AppError } from '../errors/AppError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function extractRequestOrigin(req: Request): string | null {
  const origin = req.header('origin');
  if (origin !== undefined) {
    return origin.trim();
  }

  const referer = req.header('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return 'invalid';
    }
  }

  return null;
}

/**
 * Protects state-changing endpoints authenticated via ambient `dw_session` cookies
 * against cross-site or untrusted-origin CSRF attacks.
 */
export function createCsrfCookieGuard(allowedOrigins: ReadonlySet<string>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    // Requests using explicit Bearer tokens or lacking a session cookie are not vulnerable to ambient cookie CSRF.
    if (extractBearerToken(req) !== null || extractSessionCookie(req) === null) {
      next();
      return;
    }

    const fetchSite = req.header('sec-fetch-site')?.trim().toLowerCase();
    if (fetchSite === 'cross-site') {
      next(new AppError(403, 'CSRF_VALIDATION_FAILED', 'Cross-site cookie request blocked'));
      return;
    }

    const requestOrigin = extractRequestOrigin(req);
    if (fetchSite === 'same-site' && requestOrigin === null) {
      next(
        new AppError(
          403,
          'CSRF_VALIDATION_FAILED',
          'Same-site cookie request without verifiable origin blocked'
        )
      );
      return;
    }

    if (requestOrigin !== null && !allowedOrigins.has('*') && !allowedOrigins.has(requestOrigin)) {
      next(new AppError(403, 'CSRF_VALIDATION_FAILED', 'Untrusted request origin blocked'));
      return;
    }

    next();
  };
}
