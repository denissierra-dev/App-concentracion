import type { z } from 'zod';
import {
  apiErrorPayloadSchema,
  assertSafeApiPath,
  audioPolicyResponseSchema,
  audioTracksResponseSchema,
  authDeviceResponseSchema,
  authLinkGoogleResponseSchema,
  authLogoutResponseSchema,
  authMeResponseSchema,
  authProvidersResponseSchema,
  authSessionsListResponseSchema,
  authSuccessResponseSchema,
  authTokenSchema,
  createSessionInputSchema,
  createSessionResponseSchema,
  createTaskInputSchema,
  createTaskResponseSchema,
  deleteSearchHistoryEntryResponseSchema,
  deleteSearchHistoryResponseSchema,
  deleteTaskResponseSchema,
  googleAuthInputSchema,
  healthResponseSchema,
  loginInputSchema,
  preferencesResponseSchema,
  registerInputSchema,
  revokeAuthSessionResponseSchema,
  safeJsonParse,
  safePathSegment,
  sanitizePlainText,
  searchEngineSchema,
  searchEnginesResponseSchema,
  searchHistoryQuerySchema,
  searchHistoryResponseSchema,
  searchQueryInputSchema,
  searchResponseSchema,
  SecurityValidationError,
  sessionControlResponseSchema,
  sessionStateResponseSchema,
  singleTaskResponseSchema,
  statsDashboardResponseSchema,
  statsDaysSchema,
  statsExportFormatSchema,
  syncBatchRequestSchema,
  syncBatchResponseSchema,
  syncStateResponseSchema,
  taskListResponseSchema,
  taskQuerySchema,
  taskTagsResponseSchema,
  timeResponseSchema,
  updatePreferencesInputSchema,
  updateTaskInputSchema,
  updateTaskResponseSchema,
  uuidSchema,
} from '../security/validators';
import type { QueuedSyncEvent, SearchEngine, StatsExportFormat } from '../domain/types';

const REQUEST_TIMEOUT_MS = 10_000;

export type AuthCredential =
  | string
  | {
      token?: string | null;
      deviceId?: string | null;
    }
  | null
  | undefined;

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(sanitizePlainText(message, 240) || 'Error de comunicación con el servidor');
    this.name = 'ApiClientError';
    this.status = status;
    this.code = sanitizePlainText(code, 64) || 'API_ERROR';
  }
}

export function generateUuid(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      // RFC 4122 version 4 & variant 1 bits
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  throw new SecurityValidationError(
    'Secure crypto UUID generation is unavailable in this environment',
    'CRYPTO_UNAVAILABLE'
  );
}

function attachAuthHeader(headers: Record<string, string>, auth: AuthCredential): void {
  if (!auth) {
    return;
  }

  if (typeof auth === 'string') {
    headers['x-device-id'] = uuidSchema.parse(auth);
    return;
  }

  if (auth.token) {
    const validToken = authTokenSchema.parse(auth.token);
    headers.Authorization = `Bearer ${validToken}`;
    return;
  }

  if (auth.deviceId) {
    headers['x-device-id'] = uuidSchema.parse(auth.deviceId);
  }
}

interface RequestOptions<TResponse> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  queryParams?: URLSearchParams;
  auth?: AuthCredential;
  body?: unknown;
  responseSchema: z.ZodType<TResponse>;
}

async function requestJson<TResponse>(options: RequestOptions<TResponse>): Promise<TResponse> {
  const safePath = assertSafeApiPath(options.path);
  const querySuffix =
    options.queryParams && options.queryParams.size > 0
      ? `?${options.queryParams.toString()}`
      : '';
  const targetUrl = `${safePath}${querySuffix}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  attachAuthHeader(headers, options.auth);

  let serializedBody: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    serializedBody = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: options.method,
      headers,
      body: serializedBody,
      credentials: 'include',
      redirect: 'error',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    const rawText = await response.text();

    if (!contentType.toLowerCase().includes('application/json')) {
      throw new ApiClientError(
        response.status || 502,
        'UNEXPECTED_CONTENT_TYPE',
        'El servidor devolvió una respuesta no JSON'
      );
    }

    const parsedJson = rawText ? safeJsonParse(rawText) : {};

    if (!response.ok) {
      const parsedError = apiErrorPayloadSchema.safeParse(parsedJson);
      if (parsedError.success) {
        throw new ApiClientError(
          response.status,
          parsedError.data.error.code,
          parsedError.data.error.message
        );
      }
      throw new ApiClientError(
        response.status,
        'HTTP_ERROR',
        `Error del servidor (${response.status})`
      );
    }

    const validated = options.responseSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new ApiClientError(
        502,
        'INVALID_RESPONSE_SCHEMA',
        'La respuesta del servidor no cumple el contrato esperado'
      );
    }

    return validated.data;
  } catch (err) {
    if (err instanceof ApiClientError || err instanceof SecurityValidationError) {
      throw err;
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiClientError(
        408,
        'REQUEST_TIMEOUT',
        'Tiempo de espera agotado al contactar el servidor'
      );
    }
    throw new ApiClientError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export interface ControlOptions {
  expectedVersion?: number;
  eventId?: string;
}

export type GoogleAuthInput =
  | {
      idToken: string;
      rememberMe?: boolean;
      deviceLabel?: string;
    }
  | {
      code: string;
      redirectUri: string;
      codeVerifier?: string;
      rememberMe?: boolean;
      deviceLabel?: string;
    };

export const apiClient = {
  async checkHealth() {
    return requestJson({
      method: 'GET',
      path: '/api/v1/health',
      responseSchema: healthResponseSchema,
    });
  },

  async getServerTime() {
    return requestJson({
      method: 'GET',
      path: '/api/v1/time',
      responseSchema: timeResponseSchema,
    });
  },

  // --- Auth (Section 4.2) ---

  async getAuthProviders() {
    return requestJson({
      method: 'GET',
      path: '/api/v1/auth/providers',
      responseSchema: authProvidersResponseSchema,
    });
  },

  async register(input: z.input<typeof registerInputSchema>) {
    const validated = registerInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/register',
      body: {
        ...validated,
        clientTimestamp: Date.now(),
      },
      responseSchema: authSuccessResponseSchema,
    });
  },

  async login(input: z.input<typeof loginInputSchema>) {
    const validated = loginInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {
        ...validated,
        clientTimestamp: Date.now(),
      },
      responseSchema: authSuccessResponseSchema,
    });
  },

  async googleAuth(input: GoogleAuthInput) {
    const validated = googleAuthInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/google',
      body: {
        ...validated,
        clientTimestamp: Date.now(),
      },
      responseSchema: authSuccessResponseSchema,
    });
  },

  async linkGoogle(auth: AuthCredential, input: GoogleAuthInput) {
    const validated = googleAuthInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/link/google',
      auth,
      body: validated,
      responseSchema: authLinkGoogleResponseSchema,
    });
  },

  async logout(auth: AuthCredential) {
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/logout',
      auth,
      body: {},
      responseSchema: authLogoutResponseSchema,
    });
  },

  async logoutAll(auth: AuthCredential) {
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/logout-all',
      auth,
      body: {},
      responseSchema: authLogoutResponseSchema,
    });
  },

  async getAuthSessions(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/auth/sessions',
      auth,
      responseSchema: authSessionsListResponseSchema,
    });
  },

  async revokeAuthSession(auth: AuthCredential, sessionId: string) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'DELETE',
      path: `/api/v1/auth/sessions/${safeId}`,
      auth,
      responseSchema: revokeAuthSessionResponseSchema,
    });
  },

  async registerDevice(deviceId?: string) {
    const validDeviceId = deviceId !== undefined ? uuidSchema.parse(deviceId) : undefined;
    return requestJson({
      method: 'POST',
      path: '/api/v1/auth/device',
      body: {
        ...(validDeviceId ? { deviceId: validDeviceId } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: authDeviceResponseSchema,
    });
  },

  async getMe(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/auth/me',
      auth,
      responseSchema: authMeResponseSchema,
    });
  },

  // --- Preferences (Section 4.3) ---

  async getPreferences(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/preferences',
      auth,
      responseSchema: preferencesResponseSchema,
    });
  },

  async updatePreferences(auth: AuthCredential, input: z.input<typeof updatePreferencesInputSchema>) {
    const validated = updatePreferencesInputSchema.parse(input);
    return requestJson({
      method: 'PATCH',
      path: '/api/v1/preferences',
      auth,
      body: {
        ...validated,
        eventId: generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: preferencesResponseSchema,
    });
  },

  // --- Sessions (Section 4.4) ---

  async createSession(auth: AuthCredential, input: z.input<typeof createSessionInputSchema>) {
    const validated = createSessionInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/sessions',
      auth,
      body: {
        sessionId: validated.sessionId ?? generateUuid(),
        focusDurationMin: validated.focusDurationMin,
        totalCycles: validated.totalCycles,
        eventId: generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: createSessionResponseSchema,
    });
  },

  async getActiveSession(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/sessions/active',
      auth,
      responseSchema: sessionStateResponseSchema,
    });
  },

  async getSessionState(auth: AuthCredential, sessionId: string) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'GET',
      path: `/api/v1/sessions/${safeId}/state`,
      auth,
      responseSchema: sessionStateResponseSchema,
    });
  },

  async pauseSession(auth: AuthCredential, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/pause`,
      auth,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async resumeSession(auth: AuthCredential, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/resume`,
      auth,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async skipPhase(auth: AuthCredential, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/skip`,
      auth,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async resetSession(auth: AuthCredential, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/reset`,
      auth,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async endSession(auth: AuthCredential, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/end`,
      auth,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  // --- Audio (Section 4.5) ---

  async getAudioTracks(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/audio/tracks',
      auth,
      responseSchema: audioTracksResponseSchema,
    });
  },

  async getAudioPolicy(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/audio/policy',
      auth,
      responseSchema: audioPolicyResponseSchema,
    });
  },

  // --- Tasks (Section 4.6) ---

  async getTasks(auth: AuthCredential, query?: z.input<typeof taskQuerySchema>) {
    const params = new URLSearchParams();
    if (query) {
      const validated = taskQuerySchema.parse(query);
      if (validated.status) params.set('status', validated.status);
      if (validated.priority) params.set('priority', validated.priority);
      if (validated.tag) params.set('tag', validated.tag);
      if (validated.search) params.set('search', validated.search);
      if (validated.overdue !== undefined) params.set('overdue', String(validated.overdue));
      if (validated.hasDueDate !== undefined) params.set('hasDueDate', String(validated.hasDueDate));
      if (validated.sortBy) params.set('sortBy', validated.sortBy);
      if (validated.sortOrder) params.set('sortOrder', validated.sortOrder);
    }

    return requestJson({
      method: 'GET',
      path: '/api/v1/tasks',
      queryParams: params,
      auth,
      responseSchema: taskListResponseSchema,
    });
  },

  async getTaskTags(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/tasks/tags',
      auth,
      responseSchema: taskTagsResponseSchema,
    });
  },

  async getTask(auth: AuthCredential, taskId: string) {
    const safeId = safePathSegment(taskId, uuidSchema);
    return requestJson({
      method: 'GET',
      path: `/api/v1/tasks/${safeId}`,
      auth,
      responseSchema: singleTaskResponseSchema,
    });
  },

  async createTask(
    auth: AuthCredential,
    input: z.input<typeof createTaskInputSchema>,
    eventId?: string
  ) {
    const validated = createTaskInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/tasks',
      auth,
      body: {
        id: validated.id ?? generateUuid(),
        title: validated.title,
        ...(validated.description !== undefined ? { description: validated.description } : {}),
        ...(validated.userPriority !== undefined ? { userPriority: validated.userPriority } : {}),
        ...(validated.tags !== undefined ? { tags: validated.tags } : {}),
        ...(validated.dueAt !== undefined ? { dueAt: validated.dueAt } : {}),
        eventId: eventId ?? generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: createTaskResponseSchema,
    });
  },

  async updateTask(
    auth: AuthCredential,
    taskId: string,
    input: z.input<typeof updateTaskInputSchema>,
    eventId?: string
  ) {
    const safeId = safePathSegment(taskId, uuidSchema);
    const validated = updateTaskInputSchema.parse(input);
    return requestJson({
      method: 'PATCH',
      path: `/api/v1/tasks/${safeId}`,
      auth,
      body: {
        ...validated,
        eventId: eventId ?? generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: updateTaskResponseSchema,
    });
  },

  async deleteTask(auth: AuthCredential, taskId: string, eventId?: string) {
    const safeId = safePathSegment(taskId, uuidSchema);
    return requestJson({
      method: 'DELETE',
      path: `/api/v1/tasks/${safeId}`,
      auth,
      body: {
        eventId: eventId ?? generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: deleteTaskResponseSchema,
    });
  },

  // --- Sync (Section 4.7) ---

  async getSyncState(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/sync/state',
      auth,
      responseSchema: syncStateResponseSchema,
    });
  },

  async postSyncBatch(auth: AuthCredential, events: QueuedSyncEvent[]) {
    const validated = syncBatchRequestSchema.parse({ events });
    return requestJson({
      method: 'POST',
      path: '/api/v1/sync',
      auth,
      body: validated,
      responseSchema: syncBatchResponseSchema,
    });
  },

  // --- Mini Buscador (Section 4.8) ---

  async getSearchEngines(auth: AuthCredential) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/search/engines',
      auth,
      responseSchema: searchEnginesResponseSchema,
    });
  },

  async searchWeb(auth: AuthCredential, input: z.input<typeof searchQueryInputSchema>) {
    const validated = searchQueryInputSchema.parse(input);
    const params = new URLSearchParams();
    params.set('q', validated.q);
    params.set('engine', validated.engine);
    params.set('limit', String(validated.limit));
    params.set('lang', validated.lang);
    params.set('saveHistory', String(validated.saveHistory));

    return requestJson({
      method: 'GET',
      path: '/api/v1/search',
      queryParams: params,
      auth,
      responseSchema: searchResponseSchema,
    });
  },

  async getSearchHistory(auth: AuthCredential, query?: z.input<typeof searchHistoryQuerySchema>) {
    const params = new URLSearchParams();
    if (query) {
      const validated = searchHistoryQuerySchema.parse(query);
      if (validated.engine) params.set('engine', validated.engine);
      if (validated.limit !== undefined) params.set('limit', String(validated.limit));
    }

    return requestJson({
      method: 'GET',
      path: '/api/v1/search/history',
      queryParams: params,
      auth,
      responseSchema: searchHistoryResponseSchema,
    });
  },

  async deleteSearchHistoryEntry(auth: AuthCredential, entryId: string) {
    const safeId = safePathSegment(entryId, uuidSchema);
    return requestJson({
      method: 'DELETE',
      path: `/api/v1/search/history/${safeId}`,
      auth,
      responseSchema: deleteSearchHistoryEntryResponseSchema,
    });
  },

  async clearSearchHistory(auth: AuthCredential, engine?: SearchEngine) {
    const params = new URLSearchParams();
    if (engine) {
      const validEngine = searchEngineSchema.parse(engine);
      params.set('engine', validEngine);
    }

    return requestJson({
      method: 'DELETE',
      path: '/api/v1/search/history',
      queryParams: params,
      auth,
      responseSchema: deleteSearchHistoryResponseSchema,
    });
  },

  // --- Stats & Export (Section 4.9 — Phase 8) ---

  async getStats(auth: AuthCredential, days = 30) {
    const validDays = statsDaysSchema.parse(days);
    const params = new URLSearchParams({ days: String(validDays) });
    return requestJson({
      method: 'GET',
      path: '/api/v1/stats',
      queryParams: params,
      auth,
      responseSchema: statsDashboardResponseSchema,
    });
  },

  async exportStats(
    auth: AuthCredential,
    formatOrOptions: StatsExportFormat | { format: StatsExportFormat; days?: number },
    daysArg = 30
  ): Promise<{ blob: Blob; filename: string; format: StatsExportFormat }> {
    const rawFormat =
      typeof formatOrOptions === 'string' ? formatOrOptions : formatOrOptions.format;
    const rawDays =
      typeof formatOrOptions === 'string' ? daysArg : (formatOrOptions.days ?? daysArg);
    const validFormat = statsExportFormatSchema.parse(rawFormat);
    const validDays = statsDaysSchema.parse(rawDays);
    const safePath = assertSafeApiPath('/api/v1/stats/export');
    const targetUrl = `${safePath}?format=${encodeURIComponent(validFormat)}&days=${encodeURIComponent(
      String(validDays)
    )}`;

    const headers: Record<string, string> = {};
    attachAuthHeader(headers, auth);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers,
        credentials: 'include',
        redirect: 'error',
        signal: controller.signal,
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('application/json')) {
          const parsed = safeJsonParse(await response.text());
          const errParsed = apiErrorPayloadSchema.safeParse(parsed);
          if (errParsed.success) {
            throw new ApiClientError(
              response.status,
              errParsed.data.error.code,
              errParsed.data.error.message
            );
          }
        }
        throw new ApiClientError(response.status, 'EXPORT_ERROR', 'No se pudo exportar');
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const expectedMime = validFormat === 'csv' ? 'text/csv' : 'application/json';
      if (!contentType.includes(expectedMime)) {
        throw new ApiClientError(
          502,
          'UNEXPECTED_CONTENT_TYPE',
          'Tipo de contenido inesperado al exportar métricas'
        );
      }

      const blob = await response.blob();
      if (blob.size > 10 * 1024 * 1024) {
        throw new ApiClientError(
          502,
          'PAYLOAD_TOO_LARGE',
          'El archivo exportado excede el tamaño máximo permitido'
        );
      }
      return {
        blob,
        filename: `deep-work-stats-${validDays}d.${validFormat}`,
        format: validFormat,
      };
    } catch (err) {
      if (err instanceof ApiClientError || err instanceof SecurityValidationError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ApiClientError(408, 'REQUEST_TIMEOUT', 'Tiempo de espera agotado');
      }
      throw new ApiClientError(0, 'NETWORK_ERROR', 'No se pudo descargar el archivo');
    } finally {
      window.clearTimeout(timeoutId);
    }
  },
};
