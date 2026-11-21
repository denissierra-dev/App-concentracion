import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError.js';
import { stripControlAndBidiChars } from '../security/validators.js';

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  const safePath = stripControlAndBidiChars((req.originalUrl ?? '').split('?')[0] ?? '', 120);
  const safeMethod = stripControlAndBidiChars(req.method ?? 'GET', 16);
  next(new AppError(404, 'NOT_FOUND', `Route ${safeMethod} ${safePath} not found`));
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  if (err instanceof Error) {
    const bodyErr = err as BodyParserError;
    if (bodyErr.type === 'entity.parse.failed' || (err instanceof SyntaxError && bodyErr.status === 400)) {
      res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Malformed JSON request body',
        },
      });
      return;
    }

    if (bodyErr.type === 'entity.too.large' || bodyErr.status === 413) {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body exceeds maximum allowed size',
        },
      });
      return;
    }
  }

  console.error(
    'Unhandled error:',
    process.env.NODE_ENV === 'production'
      ? err instanceof Error
        ? err.message
        : 'Unknown error'
      : err
  );
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
