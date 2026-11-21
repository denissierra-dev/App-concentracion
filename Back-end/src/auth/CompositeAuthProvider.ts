import type { Request } from 'express';
import type { AuthContext, AuthProvider } from './AuthProvider.js';
import type { DeviceIdAuthProvider } from './DeviceIdAuthProvider.js';
import type { SessionTokenAuthProvider } from './SessionTokenAuthProvider.js';

/**
 * Supports modern session tokens (Bearer / HttpOnly cookie) issued by
 * username+password and Google Sign-In, while preserving legacy deviceId auth
 * when no session token credential is supplied.
 */
export class CompositeAuthProvider implements AuthProvider {
  public readonly name = 'composite';

  constructor(
    private readonly sessionTokenProvider: SessionTokenAuthProvider,
    private readonly deviceIdProvider: DeviceIdAuthProvider
  ) {}

  async authenticate(req: Request): Promise<AuthContext | null> {
    if (this.sessionTokenProvider.hasCredentials(req)) {
      return this.sessionTokenProvider.authenticate(req);
    }

    return this.deviceIdProvider.authenticate(req);
  }
}
