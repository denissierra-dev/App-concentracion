import type { NextFunction, Request, Response } from 'express';
import type { AuthContext, AuthProvider } from '../auth/AuthProvider.js';
import { AppError } from '../errors/AppError.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function createAuthenticateMiddleware(authProvider: AuthProvider) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = await authProvider.authenticate(req);
      if (!context) {
        next(new AppError(401, 'UNAUTHORIZED', 'Valid authentication credentials are required'));
        return;
      }

      req.auth = context;
      next();
    } catch (err) {
      next(err);
    }
  };
}
