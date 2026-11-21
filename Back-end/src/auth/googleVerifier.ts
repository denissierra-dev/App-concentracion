import crypto from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import { isAbortError, readBoundedResponseJson } from '../security/boundedFetch.js';
import {
  CONTROL_AND_BIDI_TEST_REGEX,
  safeJsonReviver,
  stripControlAndBidiChars,
} from '../security/validators.js';

export interface GoogleIdentityClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface GoogleTokenVerifier {
  isConfigured(): boolean;
  isCodeFlowConfigured(): boolean;
  getClientId(): string | null;
  verifyIdToken(idToken: string): Promise<GoogleIdentityClaims>;
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<GoogleIdentityClaims>;
}

export interface GoogleOidcConfig {
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  jwksRefreshCooldownMs?: number;
  fetchImpl?: typeof fetch;
}

interface JwkKey extends crypto.JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
}

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VALID_GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const DEFAULT_JWKS_TTL_MS = 3_600_000;
const DEFAULT_JWKS_REFRESH_COOLDOWN_MS = 30_000;
const CLOCK_SKEW_SEC = 60;
const MAX_GOOGLE_RESPONSE_BYTES = 1024 * 1024;
const MAX_ID_TOKEN_CHARS = 8192;

function parseJwtSegment(segment: string): Record<string, unknown> {
  const decoded = Buffer.from(segment, 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(decoded, safeJsonReviver);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid JWT segment');
  }
  return parsed as Record<string, unknown>;
}

function parseMaxAgeMs(cacheControl: string | null): number {
  if (!cacheControl) {
    return DEFAULT_JWKS_TTL_MS;
  }
  const match = /max-age=(\d+)/i.exec(cacheControl);
  if (!match || !match[1]) {
    return DEFAULT_JWKS_TTL_MS;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 24 * 3_600_000)
    : DEFAULT_JWKS_TTL_MS;
}

function sanitizeAvatarUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export class GoogleOidcVerifier implements GoogleTokenVerifier {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly jwksRefreshCooldownMs: number;
  private cachedKeys = new Map<string, crypto.KeyObject>();
  private cacheExpiresAt = 0;
  private lastJwksRefreshAt = 0;
  private inFlightJwksRefresh: Promise<void> | null = null;

  constructor(private readonly config: GoogleOidcConfig) {
    this.fetchFn = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.jwksRefreshCooldownMs = config.jwksRefreshCooldownMs ?? DEFAULT_JWKS_REFRESH_COOLDOWN_MS;
  }

  isConfigured(): boolean {
    return Boolean(this.config.clientId);
  }

  isCodeFlowConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  getClientId(): string | null {
    return this.config.clientId ?? null;
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentityClaims> {
    if (!this.config.clientId) {
      throw new AppError(
        503,
        'GOOGLE_AUTH_UNCONFIGURED',
        'Google Sign-In is not configured on the server'
      );
    }

    if (idToken.length > MAX_ID_TOKEN_CHARS) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google ID token exceeds maximum length');
    }

    const parts = idToken.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Malformed Google ID token');
    }

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = parseJwtSegment(parts[0]);
      payload = parseJwtSegment(parts[1]);
    } catch {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Invalid Google ID token encoding');
    }

    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.trim() === '') {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Unsupported Google ID token algorithm');
    }

    const key = await this.getPublicKey(header.kid);
    if (!key) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Unknown Google signing key');
    }

    const signedData = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], 'base64url');
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signedData);
    verifier.end();

    const validSignature = verifier.verify(key, signature);
    if (!validSignature) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Invalid Google ID token signature');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const iss = typeof payload.iss === 'string' ? payload.iss : '';
    if (!VALID_GOOGLE_ISSUERS.has(iss)) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Invalid Google ID token issuer');
    }

    const audMatches =
      payload.aud === this.config.clientId ||
      (Array.isArray(payload.aud) && payload.aud.includes(this.config.clientId));
    if (!audMatches) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Invalid Google ID token audience');
    }
    if (
      Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== this.config.clientId
    ) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Invalid Google ID token authorized party');
    }

    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < nowSec) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google ID token has expired');
    }

    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > nowSec) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google ID token is not yet active');
    }

    if (
      typeof payload.sub !== 'string' ||
      payload.sub.trim() === '' ||
      CONTROL_AND_BIDI_TEST_REGEX.test(payload.sub)
    ) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google ID token missing subject');
    }

    const rawEmail =
      typeof payload.email === 'string' && payload.email.trim() !== ''
        ? payload.email.trim().toLowerCase()
        : null;
    if (rawEmail && CONTROL_AND_BIDI_TEST_REGEX.test(rawEmail)) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Invalid Google email claim');
    }
    const email = rawEmail;
    const emailVerified = payload.email_verified === true;
    if (email && !emailVerified) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google email is not verified');
    }

    const name =
      typeof payload.name === 'string' && payload.name.trim() !== ''
        ? stripControlAndBidiChars(payload.name, 120) || null
        : null;

    return {
      sub: payload.sub.trim(),
      email,
      emailVerified,
      name,
      picture: sanitizeAvatarUrl(payload.picture),
    };
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<GoogleIdentityClaims> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new AppError(
        503,
        'GOOGLE_AUTH_UNCONFIGURED',
        'Google OAuth code exchange is not configured on the server'
      );
    }

    const form = new URLSearchParams({
      code: params.code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    });
    if (params.codeVerifier) {
      form.set('code_verifier', params.codeVerifier);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let tokenJson: unknown;
    try {
      let response: Response;
      try {
        response = await this.fetchFn(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: form.toString(),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Failed to reach Google OAuth');
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google authorization code exchange failed');
      }

      try {
        tokenJson = await readBoundedResponseJson(response, {
          maxBytes: MAX_GOOGLE_RESPONSE_BYTES,
          signal: controller.signal,
          onTooLarge: () =>
            new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Invalid response from Google OAuth'),
        });
      } catch (err) {
        if (err instanceof AppError) {
          throw err;
        }
        if (isAbortError(err, controller.signal)) {
          throw new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Failed to reach Google OAuth');
        }
        throw new AppError(
          502,
          'GOOGLE_AUTH_UPSTREAM_ERROR',
          'Invalid response from Google OAuth'
        );
      }
    } finally {
      clearTimeout(timer);
    }

    if (
      typeof tokenJson !== 'object' ||
      tokenJson === null ||
      typeof (tokenJson as Record<string, unknown>).id_token !== 'string'
    ) {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google OAuth response missing id_token');
    }

    return this.verifyIdToken((tokenJson as { id_token: string }).id_token);
  }

  private async getPublicKey(kid: string): Promise<crypto.KeyObject | null> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      const hit = this.cachedKeys.get(kid);
      if (hit) {
        return hit;
      }
      if (this.inFlightJwksRefresh) {
        await this.inFlightJwksRefresh;
        return this.cachedKeys.get(kid) ?? null;
      }
      if (now - this.lastJwksRefreshAt < this.jwksRefreshCooldownMs) {
        return null;
      }
      this.lastJwksRefreshAt = now;
    }

    await this.refreshJwksSingleFlight();
    return this.cachedKeys.get(kid) ?? null;
  }

  private async refreshJwksSingleFlight(): Promise<void> {
    if (this.inFlightJwksRefresh) {
      return this.inFlightJwksRefresh;
    }

    const promise = this.refreshJwks().finally(() => {
      if (this.inFlightJwksRefresh === promise) {
        this.inFlightJwksRefresh = null;
      }
    });
    this.inFlightJwksRefresh = promise;
    return promise;
  }

  private async refreshJwks(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let body: unknown;
    let cacheControl: string | null = null;
    try {
      let response: Response;
      try {
        response = await this.fetchFn(GOOGLE_JWKS_URL, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Failed to fetch Google signing keys');
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Google JWKS endpoint error');
      }

      cacheControl = response.headers.get('cache-control');
      try {
        body = await readBoundedResponseJson(response, {
          maxBytes: MAX_GOOGLE_RESPONSE_BYTES,
          signal: controller.signal,
          onTooLarge: () =>
            new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Invalid Google JWKS payload'),
        });
      } catch (err) {
        if (err instanceof AppError) {
          throw err;
        }
        if (isAbortError(err, controller.signal)) {
          throw new AppError(
            502,
            'GOOGLE_AUTH_UPSTREAM_ERROR',
            'Failed to fetch Google signing keys'
          );
        }
        throw new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Invalid Google JWKS payload');
      }
    } finally {
      clearTimeout(timer);
    }

    if (typeof body !== 'object' || body === null || !Array.isArray((body as { keys?: unknown }).keys)) {
      throw new AppError(502, 'GOOGLE_AUTH_UPSTREAM_ERROR', 'Malformed Google JWKS keys');
    }

    const nextMap = new Map<string, crypto.KeyObject>();
    for (const rawKey of (body as { keys: unknown[] }).keys) {
      if (typeof rawKey !== 'object' || rawKey === null) continue;
      const jwk = rawKey as JwkKey;
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.kid) continue;
      try {
        const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        nextMap.set(jwk.kid, keyObject);
      } catch {
        // Ignore malformed individual keys
      }
    }

    const fetchedAt = Date.now();
    this.cachedKeys = nextMap;
    this.lastJwksRefreshAt = fetchedAt;
    this.cacheExpiresAt = fetchedAt + parseMaxAgeMs(cacheControl);
  }
}
