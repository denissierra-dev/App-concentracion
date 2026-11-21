import crypto from 'node:crypto';
import type { GoogleIdentityClaims, GoogleTokenVerifier } from '../auth/googleVerifier.js';
import { hashPassword, verifyPassword } from '../auth/passwordHash.js';
import { hashSessionToken } from '../auth/SessionTokenAuthProvider.js';
import type { AppDatabase } from '../db/database.js';
import type { AuthProviderType, AuthSession, Preference, User } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';
import type { AuthSessionRepository } from '../repositories/authSessionRepository.js';
import type { EventLogRepository } from '../repositories/eventLogRepository.js';
import type { UserRepository } from '../repositories/userRepository.js';

export interface AuthServiceConfig {
  sessionTtlHours?: number;
  rememberMeDays?: number;
}

export interface AuthServiceDeps {
  db: AppDatabase;
  userRepo: UserRepository;
  authSessionRepo: AuthSessionRepository;
  eventLogRepo: EventLogRepository;
  googleVerifier: GoogleTokenVerifier;
  config?: AuthServiceConfig;
}

export interface PublicUserDto {
  id: string;
  authProvider: AuthProviderType;
  deviceId?: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  hasPassword: boolean;
  hasGoogleLinked: boolean;
  createdAt: number;
}

export interface AuthSuccessResult {
  token: string;
  tokenType: 'Bearer';
  expiresAt: number;
  rememberMe: boolean;
  provider: Exclude<AuthProviderType, 'device'>;
  created: boolean;
  user: PublicUserDto;
  preferences: Preference;
  session: {
    id: string;
    persistent: boolean;
    expiresAt: number;
  };
}

export function toPublicUser(user: User): PublicUserDto {
  return {
    id: user.id,
    authProvider: user.authProvider,
    ...(user.authProvider === 'device' ? { deviceId: user.externalId } : {}),
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    hasPassword: user.hasPassword,
    hasGoogleLinked: user.googleSub !== null,
    createdAt: user.createdAt,
  };
}

export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly rememberMeTtlMs: number;

  constructor(private readonly deps: AuthServiceDeps) {
    this.sessionTtlMs = (deps.config?.sessionTtlHours ?? 24) * 3_600_000;
    this.rememberMeTtlMs = (deps.config?.rememberMeDays ?? 30) * 86_400_000;
  }

  getProvidersInfo() {
    return {
      password: { enabled: true },
      google: {
        enabled: this.deps.googleVerifier.isConfigured(),
        codeFlowEnabled: this.deps.googleVerifier.isCodeFlowConfigured(),
        clientId: this.deps.googleVerifier.getClientId(),
      },
      device: { enabled: true },
    };
  }

  async registerWithPassword(params: {
    username: string;
    password: string;
    email?: string | null;
    displayName?: string | null;
    rememberMe: boolean;
    deviceLabel?: string | null;
    userAgent?: string | null;
    clientTimestamp?: number;
  }): Promise<AuthSuccessResult> {
    const username = params.username.trim();
    const usernameNormalized = username.toLowerCase();
    const emailNormalized = params.email ? params.email.trim().toLowerCase() : null;
    const displayName = params.displayName ? params.displayName.trim() : null;

    // Hash password before opening SQLite write transaction.
    const passwordHash = await hashPassword(params.password);
    const nowMs = Date.now();

    return this.deps.db.transaction(() => {
      if (this.deps.userRepo.findByUsernameNormalized(usernameNormalized)) {
        throw new AppError(409, 'USERNAME_ALREADY_EXISTS', 'Username is already taken');
      }

      if (emailNormalized && this.deps.userRepo.findPasswordUserByEmail(emailNormalized)) {
        throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email is already registered');
      }

      const { user, preferences } = this.deps.userRepo.createPasswordUser({
        username,
        usernameNormalized,
        email: emailNormalized,
        passwordHash,
        displayName,
        nowMs,
      });

      this.deps.eventLogRepo.append({
        userId: user.id,
        entityType: 'user',
        entityId: user.id,
        eventType: 'USER_REGISTERED',
        payload: { authProvider: 'password' },
        clientTimestamp: params.clientTimestamp ?? null,
        serverTimestamp: nowMs,
      });

      return this.issueSession({
        user,
        preferences,
        provider: 'password',
        created: true,
        rememberMe: params.rememberMe,
        deviceLabel: params.deviceLabel ?? null,
        userAgent: params.userAgent ?? null,
        clientTimestamp: params.clientTimestamp ?? null,
        nowMs,
      });
    })();
  }

  async loginWithPassword(params: {
    identifier: string;
    password: string;
    rememberMe: boolean;
    deviceLabel?: string | null;
    userAgent?: string | null;
    clientTimestamp?: number;
  }): Promise<AuthSuccessResult> {
    const identifierNorm = params.identifier.trim().toLowerCase();
    const found = this.deps.userRepo.findByIdentifierForLogin(identifierNorm);
    const isValid = await verifyPassword(params.password, found?.passwordHash ?? null);

    if (!found || !isValid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username/email or password');
    }

    const nowMs = Date.now();

    return this.deps.db.transaction(() => {
      const preferences = this.deps.userRepo.ensurePreferences(found.user.id, nowMs);

      return this.issueSession({
        user: found.user,
        preferences,
        provider: 'password',
        created: false,
        rememberMe: params.rememberMe,
        deviceLabel: params.deviceLabel ?? null,
        userAgent: params.userAgent ?? null,
        clientTimestamp: params.clientTimestamp ?? null,
        nowMs,
      });
    })();
  }

  async signInWithGoogle(params: {
    idToken?: string;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
    rememberMe: boolean;
    deviceLabel?: string | null;
    userAgent?: string | null;
    clientTimestamp?: number;
  }): Promise<AuthSuccessResult> {
    const claims = await this.resolveGoogleClaims(params);
    const nowMs = Date.now();

    return this.deps.db.transaction(() => {
      let created = false;
      let user = this.deps.userRepo.findByGoogleSub(claims.sub);

      if (!user && claims.email && claims.emailVerified) {
        const verifiedOwner = this.deps.userRepo.findVerifiedUserByEmail(claims.email);
        if (verifiedOwner && verifiedOwner.googleSub === null) {
          user = this.deps.userRepo.linkGoogleToUser({
            userId: verifiedOwner.id,
            googleSub: claims.sub,
            email: claims.email,
            emailVerified: claims.emailVerified,
            displayName: claims.name,
            avatarUrl: claims.picture,
            nowMs,
          });
        }
      }

      let preferences: Preference;
      if (!user) {
        const createdResult = this.deps.userRepo.createGoogleUser({
          googleSub: claims.sub,
          email: claims.email,
          emailVerified: claims.emailVerified,
          displayName: claims.name,
          avatarUrl: claims.picture,
          nowMs,
        });
        user = createdResult.user;
        preferences = createdResult.preferences;
        created = true;

        this.deps.eventLogRepo.append({
          userId: user.id,
          entityType: 'user',
          entityId: user.id,
          eventType: 'USER_REGISTERED',
          payload: { authProvider: 'google' },
          clientTimestamp: params.clientTimestamp ?? null,
          serverTimestamp: nowMs,
        });
      } else {
        preferences = this.deps.userRepo.ensurePreferences(user.id, nowMs);
      }

      return this.issueSession({
        user,
        preferences,
        provider: 'google',
        created,
        rememberMe: params.rememberMe,
        deviceLabel: params.deviceLabel ?? null,
        userAgent: params.userAgent ?? null,
        clientTimestamp: params.clientTimestamp ?? null,
        nowMs,
      });
    })();
  }

  async linkGoogleAccount(params: {
    userId: string;
    idToken?: string;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
  }): Promise<PublicUserDto> {
    const claims = await this.resolveGoogleClaims(params);
    const nowMs = Date.now();

    return this.deps.db.transaction(() => {
      const currentUser = this.deps.userRepo.findById(params.userId);
      if (!currentUser) {
        throw new AppError(404, 'USER_NOT_FOUND', 'Authenticated user not found');
      }
      if (currentUser.googleSub && currentUser.googleSub !== claims.sub) {
        throw new AppError(
          409,
          'GOOGLE_ACCOUNT_ALREADY_LINKED',
          'A different Google account is already linked to this user'
        );
      }

      const existingOwner = this.deps.userRepo.findByGoogleSub(claims.sub);
      if (existingOwner && existingOwner.id !== params.userId) {
        throw new AppError(
          409,
          'GOOGLE_ACCOUNT_ALREADY_LINKED',
          'This Google account is already linked to another user'
        );
      }

      if (currentUser.hasPassword && currentUser.email === null && claims.email) {
        const existingEmailOwner = this.deps.userRepo.findPasswordUserByEmail(claims.email);
        if (existingEmailOwner && existingEmailOwner.id !== currentUser.id) {
          throw new AppError(
            409,
            'EMAIL_ALREADY_EXISTS',
            'Email from this Google account is already registered to another user'
          );
        }
      }

      const updatedUser = this.deps.userRepo.linkGoogleToUser({
        userId: params.userId,
        googleSub: claims.sub,
        email: claims.email,
        emailVerified: claims.emailVerified,
        displayName: claims.name,
        avatarUrl: claims.picture,
        nowMs,
      });

      this.deps.eventLogRepo.append({
        userId: params.userId,
        entityType: 'user',
        entityId: params.userId,
        eventType: 'GOOGLE_ACCOUNT_LINKED',
        payload: { hasEmail: Boolean(claims.email) },
        serverTimestamp: nowMs,
      });

      return toPublicUser(updatedUser);
    })();
  }

  logoutCurrent(userId: string, authSessionId?: string): { loggedOut: true } {
    if (authSessionId) {
      this.deps.authSessionRepo.revokeByIdForUser(authSessionId, userId, Date.now());
    }
    return { loggedOut: true };
  }

  logoutAll(userId: string): { loggedOut: true; revokedCount: number } {
    const revokedCount = this.deps.authSessionRepo.revokeAllForUser(userId, Date.now());
    return { loggedOut: true, revokedCount };
  }

  listActiveSessions(
    userId: string,
    currentSessionId?: string
  ): Array<Omit<AuthSession, 'userAgent'> & { isCurrent: boolean }> {
    const nowMs = Date.now();
    return this.deps.authSessionRepo.listActiveByUser(userId, nowMs).map((session) => ({
      id: session.id,
      userId: session.userId,
      provider: session.provider,
      persistent: session.persistent,
      deviceLabel: session.deviceLabel,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      isCurrent: session.id === currentSessionId,
    }));
  }

  revokeSession(userId: string, sessionId: string): { revoked: true; id: string } {
    const revoked = this.deps.authSessionRepo.revokeByIdForUser(sessionId, userId, Date.now());
    if (!revoked) {
      throw new AppError(404, 'AUTH_SESSION_NOT_FOUND', 'Auth session not found');
    }
    return { revoked: true, id: sessionId };
  }

  private async resolveGoogleClaims(params: {
    idToken?: string;
    code?: string;
    redirectUri?: string;
    codeVerifier?: string;
  }): Promise<GoogleIdentityClaims> {
    if (params.idToken) {
      return this.deps.googleVerifier.verifyIdToken(params.idToken);
    }

    if (params.code && params.redirectUri) {
      return this.deps.googleVerifier.exchangeCode({
        code: params.code,
        redirectUri: params.redirectUri,
        codeVerifier: params.codeVerifier,
      });
    }

    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Either idToken or code with redirectUri is required for Google authentication'
    );
  }

  private issueSession(params: {
    user: User;
    preferences: Preference;
    provider: Exclude<AuthProviderType, 'device'>;
    created: boolean;
    rememberMe: boolean;
    deviceLabel: string | null;
    userAgent: string | null;
    clientTimestamp: number | null;
    nowMs: number;
  }): AuthSuccessResult {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(rawToken);
    const sessionId = crypto.randomUUID();
    const ttlMs = params.rememberMe ? this.rememberMeTtlMs : this.sessionTtlMs;
    const expiresAt = params.nowMs + ttlMs;

    const authSession = this.deps.authSessionRepo.create({
      id: sessionId,
      userId: params.user.id,
      tokenHash,
      provider: params.provider,
      persistent: params.rememberMe,
      deviceLabel: params.deviceLabel,
      userAgent: params.userAgent,
      createdAt: params.nowMs,
      expiresAt,
    });
    this.deps.authSessionRepo.pruneAndCapForUser(params.user.id, 50, params.nowMs, authSession.id);

    this.deps.eventLogRepo.append({
      userId: params.user.id,
      entityType: 'user',
      entityId: params.user.id,
      eventType: 'USER_LOGGED_IN',
      payload: {
        provider: params.provider,
        persistent: params.rememberMe,
        sessionId: authSession.id,
      },
      clientTimestamp: params.clientTimestamp,
      serverTimestamp: params.nowMs,
    });

    return {
      token: rawToken,
      tokenType: 'Bearer',
      expiresAt,
      rememberMe: params.rememberMe,
      provider: params.provider,
      created: params.created,
      user: toPublicUser(params.user),
      preferences: params.preferences,
      session: {
        id: authSession.id,
        persistent: authSession.persistent,
        expiresAt: authSession.expiresAt,
      },
    };
  }
}
