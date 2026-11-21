import { safeStorage } from './safeStorage';
import { assertNoInjectionChars, SecurityValidationError } from './validators';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function computeS256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(new Uint8Array(digest));
}

export function getGoogleRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

export async function startGoogleOAuthRedirect(params: {
  clientId: string;
  mode: 'login' | 'link';
  rememberMe: boolean;
}): Promise<void> {
  const cleanClientId = params.clientId.trim();
  assertNoInjectionChars(cleanClientId, 'clientId');
  if (!cleanClientId || /\s/.test(cleanClientId)) {
    throw new SecurityValidationError('Invalid Google clientId', 'INVALID_OAUTH_CLIENT');
  }

  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await computeS256Challenge(codeVerifier);

  safeStorage.setGooglePkce({
    state,
    codeVerifier,
    mode: params.mode,
    rememberMe: params.rememberMe,
  });

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', cleanClientId);
  authUrl.searchParams.set('redirect_uri', getGoogleRedirectUri());
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');

  window.location.assign(authUrl.toString());
}
