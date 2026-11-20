import type { Request } from 'express';
import type { User } from '../domain/types.js';

export interface AuthContext {
  user: User;
  provider: string;
}

/**
 * Extensible authentication provider interface.
 * New providers (e.g. OAuth, JWT/email) can implement this contract
 * without modifying business logic or route handlers.
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(req: Request): Promise<AuthContext | null>;
}
