import { memo, useRef, useState, type FormEvent } from 'react';
import type {
  AuthProvidersResponse,
  AuthSessionEntry,
  PublicUser,
} from '../domain/types';
import { useModalEscape } from '../hooks/useModalEscape';
import {
  assertNoInjectionChars,
  loginInputSchema,
  registerInputSchema,
  uuidSchema,
} from '../security/validators';

interface AccountModalProps {
  user: PublicUser | null;
  deviceId: string | null;
  providers: AuthProvidersResponse['providers'] | null;
  authSessions: AuthSessionEntry[];
  isLoadingSessions: boolean;
  isSubmitting: boolean;
  externalError?: string | null;
  onClose: () => void;
  onLogin: (input: {
    identifier: string;
    password: string;
    rememberMe: boolean;
  }) => Promise<void>;
  onRegister: (input: {
    username: string;
    password: string;
    email?: string | null;
    displayName?: string | null;
    rememberMe: boolean;
  }) => Promise<void>;
  onGoogleLogin: (rememberMe: boolean) => Promise<void>;
  onLinkGoogle: () => Promise<void>;
  onLogout: () => Promise<void>;
  onLogoutAll: () => Promise<void>;
  onRevokeSession: (sessionId: string) => Promise<void>;
  onRecoverDevice: (uuid: string) => Promise<void>;
  onResetNewDevice: () => Promise<void>;
}

type GuestTab = 'login' | 'register' | 'guest';

const SESSION_DATE_FORMATTER = new Intl.DateTimeFormat('es-ES', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const AccountModal = memo(function AccountModal({
  user,
  deviceId,
  providers,
  authSessions,
  isLoadingSessions,
  isSubmitting,
  externalError = null,
  onClose,
  onLogin,
  onRegister,
  onGoogleLogin,
  onLinkGoogle,
  onLogout,
  onLogoutAll,
  onRevokeSession,
  onRecoverDevice,
  onResetNewDevice,
}: AccountModalProps) {
  const isAccountAuthenticated = Boolean(user && user.authProvider !== 'device');
  const [tab, setTab] = useState<GuestTab>('login');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Login form
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  // Register form
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regPassword, setRegPassword] = useState('');

  // Guest UUID recovery
  const [inputUuid, setInputUuid] = useState('');

  const googleAvailable = Boolean(
    providers?.google.enabled && providers.google.codeFlowEnabled && providers.google.clientId
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalEscape(dialogRef, onClose, isSubmitting);

  const activeError = error ?? externalError;

  const handleCopyDevice = async () => {
    if (!deviceId) return;
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsed = loginInputSchema.safeParse({
      identifier: loginIdentifier,
      password: loginPassword,
      rememberMe,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Credenciales inválidas');
      return;
    }

    await onLogin({
      identifier: parsed.data.identifier,
      password: parsed.data.password,
      rememberMe: parsed.data.rememberMe ?? rememberMe,
    });
  };

  const handleRegisterSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsed = registerInputSchema.safeParse({
      username: regUsername,
      password: regPassword,
      email: regEmail.trim() ? regEmail : null,
      displayName: regDisplayName.trim() ? regDisplayName : null,
      rememberMe,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Datos de registro inválidos');
      return;
    }

    await onRegister({
      username: parsed.data.username,
      password: parsed.data.password,
      email: parsed.data.email ?? null,
      displayName: parsed.data.displayName ?? null,
      rememberMe: parsed.data.rememberMe ?? rememberMe,
    });
  };

  const handleRecoverSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      assertNoInjectionChars(inputUuid, 'deviceId');
    } catch {
      setError('Caracteres no permitidos en el identificador');
      return;
    }

    const parsed = uuidSchema.safeParse(inputUuid);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'UUID inválido');
      return;
    }

    await onRecoverDevice(parsed.data);
  };

  return (
    <div
      ref={dialogRef}
      className="liquid-backdrop fixed inset-0 z-50 flex items-end justify-center p-2 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div className="liquid-glass-strong liquid-modal-panel max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl p-5 sm:rounded-3xl sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="account-modal-title" className="text-lg font-bold text-heading">
            {isAccountAuthenticated ? 'Tu cuenta y sesiones' : 'Cuenta'}
          </h2>
          <button
            type="button"
            className="liquid-pill min-h-9 cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-semibold text-heading"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>

        {isAccountAuthenticated && user ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-canvas p-4">
              <div className="flex items-center gap-3">
                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt={user.displayName ?? user.username ?? 'Avatar'}
                    className="h-10 w-10 rounded-full border border-edge object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-bold text-brand-ink">
                    {(user.displayName ?? user.username ?? 'U').slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div>
                  <p className="text-sm font-bold text-heading">
                    {user.displayName ?? user.username ?? 'Usuario'}
                  </p>
                  <p className="text-xs text-muted">{user.email ?? `@${user.username}`}</p>
                </div>
              </div>
              <span className="rounded-full bg-elevated px-2.5 py-1 text-[11px] font-semibold uppercase text-ink">
                {user.authProvider}
              </span>
            </div>

            {googleAvailable && !user.hasGoogleLinked && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void onLinkGoogle()}
                className="cursor-pointer rounded-xl border border-edge bg-canvas px-4 py-2.5 text-xs font-semibold text-heading transition hover:border-brand disabled:opacity-55"
              >
                Vincular cuenta de Google
              </button>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted">
                Sesiones activas
              </h3>
              {isLoadingSessions ? (
                <p className="text-xs text-muted">Cargando sesiones...</p>
              ) : authSessions.length === 0 ? (
                <p className="text-xs text-muted">No hay sesiones guardadas activas.</p>
              ) : (
                <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {authSessions.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-edge bg-canvas px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-heading">
                          {entry.deviceLabel ?? `Sesión (${entry.provider})`}
                          {entry.isCurrent ? ' · Actual' : ''}
                        </p>
                        <p className="text-[11px] text-muted">
                          {entry.persistent ? 'Persistente' : 'Temporal'} · Expira{' '}
                          {SESSION_DATE_FORMATTER.format(new Date(entry.expiresAt))}
                        </p>
                      </div>
                      {!entry.isCurrent && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => void onRevokeSession(entry.id)}
                          className="shrink-0 cursor-pointer rounded-lg px-2.5 py-1 text-[11px] font-semibold text-danger hover:bg-danger-bg disabled:opacity-55"
                        >
                          Revocar
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2.5 pt-1">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void onLogoutAll()}
                className="cursor-pointer rounded-full px-3.5 py-2 text-xs font-semibold text-danger hover:bg-danger-bg disabled:opacity-55"
              >
                Cerrar todas las sesiones
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void onLogout()}
                className="cursor-pointer rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-55"
              >
                Cerrar sesión
              </button>
            </div>

            {activeError && (
              <p
                className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
                role="alert"
              >
                {activeError}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex gap-1.5 rounded-xl bg-canvas p-1" role="tablist">
              {(
                [
                  ['login', 'Iniciar sesión'],
                  ['register', 'Crear cuenta'],
                  ['guest', 'Modo invitado'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => {
                    setTab(id);
                    setError(null);
                  }}
                  className={`flex-1 cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                    tab === id
                      ? 'bg-brand text-brand-ink'
                      : 'text-ink hover:bg-elevated'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === 'login' && (
              <form className="flex flex-col gap-3.5" onSubmit={handleLoginSubmit} noValidate>
                <div className="flex flex-col gap-1">
                  <label htmlFor="login-identifier" className="text-xs font-semibold text-heading">
                    Usuario o correo electrónico
                  </label>
                  <input
                    id="login-identifier"
                    type="text"
                    autoComplete="username"
                    value={loginIdentifier}
                    onChange={(e) => {
                      setLoginIdentifier(e.target.value);
                      setError(null);
                    }}
                    className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor="login-password" className="text-xs font-semibold text-heading">
                    Contraseña
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => {
                      setLoginPassword(e.target.value);
                      setError(null);
                    }}
                    className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
                  />
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span>Mantener sesión iniciada (30 días)</span>
                </label>

                {activeError && (
                  <p
                    className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
                    role="alert"
                  >
                    {activeError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="cursor-pointer rounded-full bg-accent px-4 py-2.5 text-sm font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-55"
                >
                  {isSubmitting ? 'Iniciando...' : 'Iniciar sesión'}
                </button>

                {googleAvailable && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void onGoogleLogin(rememberMe)}
                    className="cursor-pointer rounded-xl border border-edge bg-canvas px-4 py-2.5 text-xs font-semibold text-heading transition hover:border-brand disabled:opacity-55"
                  >
                    Continuar con Google
                  </button>
                )}
              </form>
            )}

            {tab === 'register' && (
              <form className="flex flex-col gap-3.5" onSubmit={handleRegisterSubmit} noValidate>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor="reg-username" className="text-xs font-semibold text-heading">
                      Usuario (obligatorio)
                    </label>
                    <input
                      id="reg-username"
                      type="text"
                      autoComplete="username"
                      value={regUsername}
                      onChange={(e) => {
                        setRegUsername(e.target.value);
                        setError(null);
                      }}
                      placeholder="ej. denis_focus"
                      className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label htmlFor="reg-display-name" className="text-xs font-semibold text-heading">
                      Nombre (opcional)
                    </label>
                    <input
                      id="reg-display-name"
                      type="text"
                      autoComplete="name"
                      value={regDisplayName}
                      onChange={(e) => {
                        setRegDisplayName(e.target.value);
                        setError(null);
                      }}
                      className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor="reg-email" className="text-xs font-semibold text-heading">
                    Correo electrónico (opcional)
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    autoComplete="email"
                    value={regEmail}
                    onChange={(e) => {
                      setRegEmail(e.target.value);
                      setError(null);
                    }}
                    className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label htmlFor="reg-password" className="text-xs font-semibold text-heading">
                    Contraseña (mínimo 8 caracteres)
                  </label>
                  <input
                    id="reg-password"
                    type="password"
                    autoComplete="new-password"
                    value={regPassword}
                    onChange={(e) => {
                      setRegPassword(e.target.value);
                      setError(null);
                    }}
                    className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-heading"
                  />
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span>Mantener sesión iniciada (30 días)</span>
                </label>

                {activeError && (
                  <p
                    className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
                    role="alert"
                  >
                    {activeError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="cursor-pointer rounded-full bg-accent px-4 py-2.5 text-sm font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-55"
                >
                  {isSubmitting ? 'Creando cuenta...' : 'Crear cuenta'}
                </button>
              </form>
            )}

            {tab === 'guest' && (
              <div className="flex flex-col gap-4">
                <p className="text-xs text-muted">
                  El modo invitado guarda tu progreso localmente bajo un código anónimo de
                  dispositivo.
                </p>

                <div className="flex items-center justify-between gap-3 overflow-x-auto rounded-lg border border-edge bg-canvas px-3.5 py-2.5">
                  <code className="font-mono text-xs text-heading">
                    {deviceId ?? 'Sin asignar'}
                  </code>
                  {deviceId && (
                    <button
                      type="button"
                      className="shrink-0 cursor-pointer rounded-lg border border-edge bg-elevated px-3 py-1 text-xs font-semibold text-heading hover:border-brand"
                      onClick={handleCopyDevice}
                    >
                      {copied ? 'Copiado' : 'Copiar'}
                    </button>
                  )}
                </div>

                <form className="flex flex-col gap-3" onSubmit={handleRecoverSubmit} noValidate>
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="recover-device-uuid"
                      className="text-xs font-semibold text-heading"
                    >
                      Recuperar sesión de invitado (UUID)
                    </label>
                    <input
                      id="recover-device-uuid"
                      type="text"
                      value={inputUuid}
                      onChange={(e) => {
                        setInputUuid(e.target.value);
                        setError(null);
                      }}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-xs text-heading"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  {activeError && (
                    <p
                      className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
                      role="alert"
                    >
                      {activeError}
                    </p>
                  )}

                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="cursor-pointer rounded-xl px-3.5 py-2 text-xs font-semibold text-ink hover:bg-elevated disabled:opacity-55"
                      onClick={() => void onResetNewDevice()}
                      disabled={isSubmitting}
                    >
                      Nuevo invitado
                    </button>
                    <button
                      type="submit"
                      className="cursor-pointer rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-55"
                      disabled={isSubmitting}
                    >
                      Recuperar UUID
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
