import crypto from 'node:crypto';
import type { Request } from 'express';
import type { AuthSessionRepository } from '../repositories/authSessionRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';
import type { AuthContext, AuthProvider } from './AuthProvider.js';

export const SESSION_COOKIE_NAME = 'dw_session';
const TOUCH_INTERVAL_MS = 60_000;

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.header('authorization');
  if (!authHeader) {
    return null;
  }

  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  return null;
}

export function extractSessionCookie(req: Request): string | null {
  const cookieHeader = req.header('cookie');
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = part.slice(0, eqIndex).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eqIndex + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

export class SessionTokenAuthProvider implements AuthProvider {
  public readonly name = 'session_token';

  constructor(
    private readonly authSessionRepo: AuthSessionRepository,
    private readonly userRepo: UserRepository
  ) {}

  hasCredentials(req: Request): boolean {
    return extractBearerToken(req) !== null || extractSessionCookie(req) !== null;
  }

  async authenticate(req: Request): Promise<AuthContext | null> {
    const token = extractBearerToken(req) ?? extractSessionCookie(req);
    if (!token || token.length < 16 || token.length > 512) {
      return null;
    }

    const nowMs = Date.now();
    const tokenHash = hashSessionToken(token);
    const session = this.authSessionRepo.findActiveByTokenHash(tokenHash, nowMs);
    if (!session) {
      return null;
    }

    const user = this.userRepo.findById(session.userId);
    if (!user) {
      return null;
    }

    if (nowMs - session.lastUsedAt >= TOUCH_INTERVAL_MS) {
      this.authSessionRepo.touchLastUsed(session.id, nowMs);
    }

    return {
      user,
      provider: session.provider,
      authSession: session,
    };
  }
}
