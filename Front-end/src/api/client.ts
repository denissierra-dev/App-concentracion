import type { z } from 'zod';
import {
  apiErrorPayloadSchema,
  assertSafeApiPath,
  audioPolicyResponseSchema,
  audioTracksResponseSchema,
  authDeviceResponseSchema,
  authMeResponseSchema,
  createSessionInputSchema,
  createSessionResponseSchema,
  createTaskInputSchema,
  createTaskResponseSchema,
  deleteSearchHistoryEntryResponseSchema,
  deleteSearchHistoryResponseSchema,
  deleteTaskResponseSchema,
  healthResponseSchema,
  preferencesResponseSchema,
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
import type { QueuedSyncEvent, SearchEngine } from '../domain/types';

const REQUEST_TIMEOUT_MS = 10_000;

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
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new SecurityValidationError(
    'Secure crypto.randomUUID() is unavailable in this environment',
    'CRYPTO_UNAVAILABLE'
  );
}

interface RequestOptions<TResponse> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  queryParams?: URLSearchParams;
  deviceId?: string | null;
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

  if (options.deviceId !== undefined && options.deviceId !== null) {
    const validDeviceId = uuidSchema.parse(options.deviceId);
    headers['x-device-id'] = validDeviceId;
  }

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
      credentials: 'same-origin',
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
    throw new ApiClientError(0, 'NETWORK_ERROR', 'No se pudo conectar con el back-end');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export interface ControlOptions {
  expectedVersion?: number;
  eventId?: string;
}

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

  async getMe(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/auth/me',
      deviceId,
      responseSchema: authMeResponseSchema,
    });
  },

  async getPreferences(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/preferences',
      deviceId,
      responseSchema: preferencesResponseSchema,
    });
  },

  async updatePreferences(deviceId: string, input: z.input<typeof updatePreferencesInputSchema>) {
    const validated = updatePreferencesInputSchema.parse(input);
    return requestJson({
      method: 'PATCH',
      path: '/api/v1/preferences',
      deviceId,
      body: {
        ...validated,
        eventId: generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: preferencesResponseSchema,
    });
  },

  async createSession(deviceId: string, input: z.input<typeof createSessionInputSchema>) {
    const validated = createSessionInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/sessions',
      deviceId,
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

  async getActiveSession(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/sessions/active',
      deviceId,
      responseSchema: sessionStateResponseSchema,
    });
  },

  async getSessionState(deviceId: string, sessionId: string) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'GET',
      path: `/api/v1/sessions/${safeId}/state`,
      deviceId,
      responseSchema: sessionStateResponseSchema,
    });
  },

  async pauseSession(deviceId: string, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/pause`,
      deviceId,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async resumeSession(deviceId: string, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/resume`,
      deviceId,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async skipPhase(deviceId: string, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/skip`,
      deviceId,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async resetSession(deviceId: string, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/reset`,
      deviceId,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async endSession(deviceId: string, sessionId: string, opts?: ControlOptions) {
    const safeId = safePathSegment(sessionId, uuidSchema);
    return requestJson({
      method: 'POST',
      path: `/api/v1/sessions/${safeId}/end`,
      deviceId,
      body: {
        eventId: opts?.eventId ?? generateUuid(),
        ...(opts?.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
        clientTimestamp: Date.now(),
      },
      responseSchema: sessionControlResponseSchema,
    });
  },

  async getAudioTracks(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/audio/tracks',
      deviceId,
      responseSchema: audioTracksResponseSchema,
    });
  },

  async getAudioPolicy(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/audio/policy',
      deviceId,
      responseSchema: audioPolicyResponseSchema,
    });
  },

  // --- Tasks (Section 4.6 — Phase 5 & Phase 6.0) ---

  async getTasks(deviceId: string, query?: z.input<typeof taskQuerySchema>) {
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
      deviceId,
      responseSchema: taskListResponseSchema,
    });
  },

  async getTaskTags(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/tasks/tags',
      deviceId,
      responseSchema: taskTagsResponseSchema,
    });
  },

  async getTask(deviceId: string, taskId: string) {
    const safeId = safePathSegment(taskId, uuidSchema);
    return requestJson({
      method: 'GET',
      path: `/api/v1/tasks/${safeId}`,
      deviceId,
      responseSchema: singleTaskResponseSchema,
    });
  },

  async createTask(
    deviceId: string,
    input: z.input<typeof createTaskInputSchema>,
    eventId?: string
  ) {
    const validated = createTaskInputSchema.parse(input);
    return requestJson({
      method: 'POST',
      path: '/api/v1/tasks',
      deviceId,
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
    deviceId: string,
    taskId: string,
    input: z.input<typeof updateTaskInputSchema>,
    eventId?: string
  ) {
    const safeId = safePathSegment(taskId, uuidSchema);
    const validated = updateTaskInputSchema.parse(input);
    return requestJson({
      method: 'PATCH',
      path: `/api/v1/tasks/${safeId}`,
      deviceId,
      body: {
        ...validated,
        eventId: eventId ?? generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: updateTaskResponseSchema,
    });
  },

  async deleteTask(deviceId: string, taskId: string, eventId?: string) {
    const safeId = safePathSegment(taskId, uuidSchema);
    return requestJson({
      method: 'DELETE',
      path: `/api/v1/tasks/${safeId}`,
      deviceId,
      body: {
        eventId: eventId ?? generateUuid(),
        clientTimestamp: Date.now(),
      },
      responseSchema: deleteTaskResponseSchema,
    });
  },

  // --- Sync (Section 4.7) ---

  async getSyncState(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/sync/state',
      deviceId,
      responseSchema: syncStateResponseSchema,
    });
  },

  async postSyncBatch(deviceId: string, events: QueuedSyncEvent[]) {
    const validated = syncBatchRequestSchema.parse({ events });
    return requestJson({
      method: 'POST',
      path: '/api/v1/sync',
      deviceId,
      body: validated,
      responseSchema: syncBatchResponseSchema,
    });
  },

  // --- Mini Buscador (Section 4.8 — Phase 7) ---

  async getSearchEngines(deviceId: string) {
    return requestJson({
      method: 'GET',
      path: '/api/v1/search/engines',
      deviceId,
      responseSchema: searchEnginesResponseSchema,
    });
  },

  async searchWeb(deviceId: string, input: z.input<typeof searchQueryInputSchema>) {
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
      deviceId,
      responseSchema: searchResponseSchema,
    });
  },

  async getSearchHistory(deviceId: string, query?: z.input<typeof searchHistoryQuerySchema>) {
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
      deviceId,
      responseSchema: searchHistoryResponseSchema,
    });
  },

  async deleteSearchHistoryEntry(deviceId: string, entryId: string) {
    const safeId = safePathSegment(entryId, uuidSchema);
    return requestJson({
      method: 'DELETE',
      path: `/api/v1/search/history/${safeId}`,
      deviceId,
      responseSchema: deleteSearchHistoryEntryResponseSchema,
    });
  },

  async clearSearchHistory(deviceId: string, engine?: SearchEngine) {
    const params = new URLSearchParams();
    if (engine) {
      const validEngine = searchEngineSchema.parse(engine);
      params.set('engine', validEngine);
    }

    return requestJson({
      method: 'DELETE',
      path: '/api/v1/search/history',
      queryParams: params,
      deviceId,
      responseSchema: deleteSearchHistoryResponseSchema,
    });
  },
};
