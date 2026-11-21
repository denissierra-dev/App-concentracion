import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiClientError } from '../src/api/client';
import { startGoogleOAuthRedirect } from '../src/security/pkce';
import { safeStorage } from '../src/security/safeStorage';
import {
  assertNoInjectionChars,
  assertSafeApiPath,
  assertSafeAudioStreamUrl,
  assertSafeExternalHttpUrl,
  audioTracksResponseSchema,
  authTokenSchema,
  createSessionInputSchema,
  createTaskInputSchema,
  googleAuthInputSchema,
  loginInputSchema,
  preferenceSchema,
  publicUserSchema,
  registerInputSchema,
  safeJsonParse,
  safePathSegment,
  sanitizePlainText,
  searchQueryInputSchema,
  searchResponseSchema,
  SecurityValidationError,
  statsDashboardResponseSchema,
  taskQuerySchema,
  taskTagsArraySchema,
  updatePreferencesInputSchema,
  updateTaskInputSchema,
  uuidSchema,
} from '../src/security/validators';
import { syncStore } from '../src/sync/syncStore';

describe('Front-end Strict Security & Anti-Injection Layer', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('blocks XSS markup, URI schemes, control chars, and bidi overrides', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(document.cookie)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'valid\r\nX-Injected-Header: evil',
      'null\u0000byte',
      'spoof\u202Etxt.exe',
    ];

    for (const payload of payloads) {
      expect(() => assertNoInjectionChars(payload, 'testField')).toThrow(SecurityValidationError);
    }

    const sanitized = sanitizePlainText('Hello\u0000\u202E World\x1B[31m');
    expect(sanitized).toBe('Hello World[31m');
  });

  it('blocks JSON prototype pollution payloads without mutating Object.prototype', () => {
    const protoPayload = '{"__proto__":{"polluted":true}}';
    const ctorPayload = '{"constructor":{"prototype":{"isAdmin":true}}}';

    expect(() => safeJsonParse(protoPayload)).toThrow(SecurityValidationError);
    expect(() => safeJsonParse(ctorPayload)).toThrow(SecurityValidationError);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it('blocks path traversal, protocol-relative URLs, and invalid path segments', () => {
    expect(() => assertSafeApiPath('/api/v1/sessions/../../etc/passwd')).toThrow(
      SecurityValidationError
    );
    expect(() => assertSafeApiPath('//evil.com/api/v1/auth/me')).toThrow(SecurityValidationError);
    expect(() => assertSafeApiPath('https://evil.com/api/v1/auth/me')).toThrow(
      SecurityValidationError
    );
    expect(() => assertSafeApiPath('/api/v1/sessions\\..\\admin')).toThrow(
      SecurityValidationError
    );

    expect(() => safePathSegment('../admin', uuidSchema)).toThrow(SecurityValidationError);
    expect(() =>
      safePathSegment('11111111-1111-4111-8111-111111111111\r\n', uuidSchema)
    ).toThrow(SecurityValidationError);
    expect(() =>
      assertNoInjectionChars('11111111-1111-4111-8111-111111111111\r\nX-Evil: 1')
    ).toThrow(SecurityValidationError);
  });

  it('blocks untrusted audio stream URLs (SSRF / XSS via media src)', () => {
    expect(assertSafeAudioStreamUrl('/api/v1/audio/tracks/rain-ambient/stream')).toBe(
      '/api/v1/audio/tracks/rain-ambient/stream'
    );

    const maliciousUrls = [
      'javascript:alert(1)',
      'data:audio/wav;base64,AAAA',
      'https://evil.com/api/v1/audio/tracks/rain-ambient/stream',
      '//evil.com/api/v1/audio/tracks/rain-ambient/stream',
      '/api/v1/audio/tracks/../../secret/stream',
      '/api/v1/audio/tracks/rain-ambient/stream?token=steal',
    ];

    for (const url of maliciousUrls) {
      expect(() => assertSafeAudioStreamUrl(url)).toThrow(SecurityValidationError);
      expect(
        audioTracksResponseSchema.safeParse({
          tracks: [
            {
              id: 'rain-ambient',
              title: 'Soft Rain',
              category: 'ambient',
              mimeType: 'audio/wav',
              sizeBytes: 1024,
              streamUrl: url,
            },
          ],
          volumePolicy: { focus: 0.7, short_break: 0.3, long_break: 0.3 },
        }).success
      ).toBe(false);
    }
  });

  it('validates and purges tampered localStorage values', () => {
    window.localStorage.setItem('deepwork:v1:deviceId', JSON.stringify('<script>alert(1)</script>'));
    expect(safeStorage.getDeviceId()).toBeNull();
    expect(window.localStorage.getItem('deepwork:v1:deviceId')).toBeNull();

    window.localStorage.setItem('deepwork:v1:selectedTrackId', JSON.stringify('../../etc/passwd'));
    expect(safeStorage.getSelectedTrackId()).toBeNull();
    expect(window.localStorage.getItem('deepwork:v1:selectedTrackId')).toBeNull();

    window.localStorage.setItem('deepwork:v1:deviceId', '{"__proto__":{"x":1}}');
    expect(safeStorage.getDeviceId()).toBeNull();

    const validUuid = '11111111-1111-4111-8111-111111111111';
    expect(safeStorage.setDeviceId(validUuid)).toBe(true);
    expect(safeStorage.getDeviceId()).toBe(validUuid);
  });

  it('rejects out-of-range or NaN session inputs before hitting network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(createSessionInputSchema.safeParse({ focusDurationMin: 4, totalCycles: 4 }).success).toBe(
      false
    );
    expect(
      createSessionInputSchema.safeParse({ focusDurationMin: 181, totalCycles: 4 }).success
    ).toBe(false);
    expect(
      createSessionInputSchema.safeParse({ focusDurationMin: Number.NaN, totalCycles: 4 }).success
    ).toBe(false);
    expect(
      createSessionInputSchema.safeParse({
        focusDurationMin: 25,
        totalCycles: 4,
        extraInjectedField: 'evil',
      }).success
    ).toBe(false);

    await expect(
      apiClient.getSessionState('11111111-1111-4111-8111-111111111111', '../admin')
    ).rejects.toThrow(SecurityValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-JSON HTML error responses and prototype-polluted API responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><body><script>alert(1)</script></body></html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      })
    );

    await expect(apiClient.checkHealth()).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'UNEXPECTED_CONTENT_TYPE',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"status":"ok","timestamp":123,"__proto__":{"pwned":true}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(apiClient.checkHealth()).rejects.toThrow(SecurityValidationError);
    expect(ApiClientError).toBeDefined();
  });

  it('blocks XSS, URI schemes, and control chars in task creation and updates', () => {
    expect(createTaskInputSchema.safeParse({ title: '<script>alert(1)</script>' }).success).toBe(
      false
    );
    expect(
      createTaskInputSchema.safeParse({
        title: 'Valid title',
        description: 'Check javascript:alert(1)',
      }).success
    ).toBe(false);
    expect(createTaskInputSchema.safeParse({ title: 'Line1\r\nLine2' }).success).toBe(false);
    expect(
      updateTaskInputSchema.safeParse({ description: 'Contains <img src=x onerror=alert(1)>' })
        .success
    ).toBe(false);

    const validMultiline = createTaskInputSchema.safeParse({
      title: '  Estudiar arquitectura  ',
      description: 'Paso 1\nPaso 2',
      dueAt: null,
    });
    expect(validMultiline.success).toBe(true);
    if (validMultiline.success) {
      expect(validMultiline.data.title).toBe('Estudiar arquitectura');
    }
  });

  it('purges tampered offline cache/queue and blocks disallowed sync eventTypes', async () => {
    const devA = '11111111-1111-4111-8111-111111111111';
    const devB = '22222222-2222-4222-8222-222222222222';

    // Cross-device snapshot tampering is rejected & purged
    window.localStorage.setItem(
      `deepwork:idb:snapshot:${devA}`,
      JSON.stringify({
        deviceId: devB,
        activeSession: null,
        preferences: null,
        tasks: [],
        taskCounts: { total: 0, pending: 0, completed: 0 },
        serverTimeMs: 1700000000000,
        cachedAt: 1700000000000,
      })
    );
    expect(await syncStore.loadSnapshot(devA)).toBeNull();
    expect(window.localStorage.getItem(`deepwork:idb:snapshot:${devA}`)).toBeNull();

    // Disallowed eventType (e.g. CLOCK_TICK) in queue is purged
    window.localStorage.setItem(
      `deepwork:idb:queue:${devA}`,
      JSON.stringify([
        {
          eventId: devB,
          entityType: 'session',
          entityId: devB,
          eventType: 'CLOCK_TICK',
          payload: {},
        },
      ])
    );
    expect(await syncStore.loadQueue(devA)).toEqual([]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      apiClient.postSyncBatch(devA, [
        {
          eventId: devB,
          entityType: 'session',
          entityId: devB,
          eventType: 'CLOCK_TICK' as unknown as 'SESSION_PAUSED',
          payload: {},
        },
      ])
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reuses singleton IndexedDB connection across operations without closing per transaction', async () => {
    const devA = '11111111-1111-4111-8111-111111111111';
    const devB = '22222222-2222-4222-8222-222222222222';
    const closeSpy = vi.fn();
    let storedRaw: string | null = null;

    const fakeDb = {
      objectStoreNames: { contains: () => true },
      close: closeSpy,
      onversionchange: null as (() => void) | null,
      onclose: null as (() => void) | null,
      transaction: () => {
        const tx = {
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          objectStore: () => ({
            put: (value: string) => {
              storedRaw = value;
              setTimeout(() => tx.oncomplete?.(), 0);
            },
            get: () => {
              const req = {
                result: storedRaw,
                onsuccess: null as (() => void) | null,
              };
              setTimeout(() => {
                req.onsuccess?.();
                tx.oncomplete?.();
              }, 0);
              return req;
            },
          }),
        };
        return tx;
      },
    };

    const openSpy = vi.fn(() => {
      const req = {
        result: fakeDb,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    });

    const originalIdb = window.indexedDB;
    await syncStore.closeConnection();
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: { open: openSpy },
    });

    try {
      await syncStore.saveQueue(devA, [
        {
          eventId: devB,
          entityType: 'task',
          entityId: devB,
          eventType: 'TASK_DELETED',
          payload: {},
        },
      ]);
      const loaded = await syncStore.loadQueue(devA);
      expect(loaded).toHaveLength(1);
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).not.toHaveBeenCalled();

      // Version change closes and resets singleton so next operation re-opens
      fakeDb.onversionchange?.();
      expect(closeSpy).toHaveBeenCalledTimes(1);

      await syncStore.loadQueue(devA);
      expect(openSpy).toHaveBeenCalledTimes(2);
    } finally {
      await syncStore.closeConnection();
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        value: originalIdb,
      });
    }
  });

  it('blocks unsafe external URLs, XSS search queries, and invalid task tags', async () => {
    const unsafeUrls = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'https://admin:secret@evil.com/phish',
      'https://es.wikipedia.org/\r\nX-Evil: 1',
    ];

    for (const url of unsafeUrls) {
      expect(() => assertSafeExternalHttpUrl(url)).toThrow(SecurityValidationError);
      expect(
        searchResponseSchema.safeParse({
          engine: 'wikipedia',
          query: 'pomodoro',
          lang: 'es',
          configured: true,
          externalUrl: 'https://es.wikipedia.org/wiki/Pomodoro',
          results: [
            {
              title: 'Pomodoro',
              url,
              snippet: 'Texto seguro',
              displayUrl: 'es.wikipedia.org',
              engine: 'wikipedia',
            },
          ],
          totalResults: 1,
          notice: null,
          historyEntry: null,
          serverTimeMs: 1700000000000,
        }).success
      ).toBe(false);
    }

    expect(assertSafeExternalHttpUrl('https://es.wikipedia.org/wiki/Pomodoro')).toBe(
      'https://es.wikipedia.org/wiki/Pomodoro'
    );

    expect(
      searchQueryInputSchema.safeParse({ q: '<script>alert(1)</script>', engine: 'wikipedia' })
        .success
    ).toBe(false);
    expect(
      searchQueryInputSchema.safeParse({ q: 'pomodoro', engine: 'wikipedia', lang: 'es/../' })
        .success
    ).toBe(false);
    expect(taskTagsArraySchema.safeParse(['<img src=x>']).success).toBe(false);
    expect(taskTagsArraySchema.safeParse(Array.from({ length: 11 }, (_, i) => `t${i}`)).success).toBe(
      false
    );
    expect(taskQuerySchema.safeParse({ search: '<script>' }).success).toBe(false);
  });

  it('encodes task query params safely and rejects malicious search response URLs in apiClient', async () => {
    const devId = '11111111-1111-4111-8111-111111111111';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tasks: [],
          counts: { total: 0, pending: 0, completed: 0 },
          filteredCount: 0,
          serverTimeMs: 1700000000000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await apiClient.getTasks(devId, {
      status: 'pending',
      priority: 'HIGH',
      tag: 'estudio',
      search: 'react hooks',
      overdue: true,
      sortBy: 'priority',
    });

    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(calledUrl).toBe(
      '/api/v1/tasks?status=pending&priority=HIGH&tag=estudio&search=react+hooks&overdue=true&sortBy=priority'
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          engine: 'wikipedia',
          query: 'test',
          lang: 'es',
          configured: true,
          externalUrl: 'javascript:alert(1)',
          results: [],
          totalResults: 0,
          notice: null,
          historyEntry: null,
          serverTimeMs: 1700000000000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await expect(
      apiClient.searchWeb(devId, { q: 'test', engine: 'wikipedia', lang: 'es' })
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE_SCHEMA',
    });
  });

  it('rejects and purges queued offline sync events with bloated payloads', async () => {
    const devA = '11111111-1111-4111-8111-111111111111';
    const eventId = '22222222-2222-4222-8222-222222222222';
    const bloatedPayload = Object.fromEntries(
      Array.from({ length: 25 }, (_, idx) => [`k${idx}`, 'val'])
    );

    window.localStorage.setItem(
      `deepwork:idb:queue:${devA}`,
      JSON.stringify([
        {
          eventId,
          entityType: 'task',
          entityId: eventId,
          eventType: 'TASK_DELETED',
          payload: bloatedPayload,
        },
      ])
    );

    expect(await syncStore.loadQueue(devA)).toEqual([]);
    expect(window.localStorage.getItem(`deepwork:idb:queue:${devA}`)).toBeNull();
  });

  it('validates auth inputs, rejects CRLF/XSS tokens & javascript: avatarUrl, and scopes token storage by rememberMe', () => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    expect(
      loginInputSchema.safeParse({
        identifier: '<script>alert(1)</script>',
        password: 'ValidPassword123',
      }).success
    ).toBe(false);

    expect(
      registerInputSchema.safeParse({
        username: 'ab',
        password: '123',
      }).success
    ).toBe(false);

    expect(
      registerInputSchema.safeParse({
        username: 'denis_focus',
        password: 'StrongPassword123',
        email: 'denis@example.com',
        displayName: 'Denis',
        rememberMe: true,
      }).success
    ).toBe(true);

    expect(authTokenSchema.safeParse('tok\r\nX-Inject: 1').success).toBe(false);
    expect(authTokenSchema.safeParse('valid_token_abc_123').success).toBe(true);

    expect(
      publicUserSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        authProvider: 'google',
        username: 'denis',
        email: 'denis@example.com',
        displayName: 'Denis',
        avatarUrl: 'javascript:alert(1)',
        hasPassword: false,
        hasGoogleLinked: true,
        createdAt: 1700000000000,
      }).success
    ).toBe(false);

    expect(
      publicUserSchema.safeParse({
        id: '11111111-1111-4111-8111-111111111111',
        authProvider: 'google',
        username: 'denis',
        email: 'denis@example.com',
        displayName: 'Denis',
        avatarUrl: 'https://lh3.googleusercontent.com/a/avatar',
        hasPassword: false,
        hasGoogleLinked: true,
        createdAt: 1700000000000,
      }).success
    ).toBe(true);

    expect(taskQuerySchema.parse({ priority: 'CRITICAL' }).priority).toBe('CRITICAL');
    expect(
      statsDashboardResponseSchema.safeParse({
        today: {
          date: '2026-11-20',
          sessionsCompleted: 1,
          focusMs: 1500000,
          focusMinutes: 25,
          tasksCompleted: 1,
        },
        totals: {
          sessionsCompleted: 1,
          focusMs: 1500000,
          focusMinutes: 25,
          cyclesCompleted: 1,
          tasksCompleted: 1,
          tasksPending: 0,
        },
        streaks: { currentDays: 1, longestDays: 1, lastActiveDate: '2026-11-20' },
        primordial: { completedBeforeDeadline: 0, ignored: 0, activePending: 0, completionRate: null },
        productivity: {
          windowDays: 30,
          byDay: [],
          byWeekday: [],
          byHour: [],
          peakHour: null,
        },
        serverTimeMs: 1700000000000,
      }).success
    ).toBe(true);

    // Session-only token (rememberMe = false -> sessionStorage only)
    expect(safeStorage.setAuthToken('ephemeral_token_value', false)).toBe(true);
    expect(safeStorage.getAuthToken()).toBe('ephemeral_token_value');
    expect(window.sessionStorage.length).toBeGreaterThan(0);

    // Persistent token (rememberMe = true -> localStorage)
    expect(safeStorage.setAuthToken('persistent_token_value', true)).toBe(true);
    expect(safeStorage.getAuthToken()).toBe('persistent_token_value');
    safeStorage.clearAuthToken();
    expect(safeStorage.getAuthToken()).toBeNull();

    // PKCE state validation & purge on tampering (RFC 7636 requires >=43 chars codeVerifier)
    expect(
      safeStorage.setGooglePkce({
        state: 'state_token_123456',
        codeVerifier: 'too_short',
        mode: 'login',
        rememberMe: true,
      })
    ).toBe(false);
    expect(
      safeStorage.setGooglePkce({
        state: 'state_token_123456',
        codeVerifier: 'verifier_value_abcdef1234567890_ghijklmnopqrstuvwxyz',
        mode: 'login',
        rememberMe: true,
      })
    ).toBe(true);
    expect(safeStorage.getGooglePkce()?.state).toBe('state_token_123456');
    safeStorage.clearGooglePkce();
    expect(safeStorage.getGooglePkce()).toBeNull();
  });

  it('validates Google OAuth inputs, rejects unsafe export content-types, and blocks invalid OAuth clientId', async () => {
    expect(
      googleAuthInputSchema.safeParse({
        code: 'valid_code_1234',
        redirectUri: 'javascript:alert(1)',
      }).success
    ).toBe(false);

    expect(
      googleAuthInputSchema.safeParse({
        idToken: 'header.payload\r\n.sig',
      }).success
    ).toBe(false);

    await expect(
      startGoogleOAuthRedirect({
        clientId: 'bad client id\r\n',
        mode: 'login',
        rememberMe: true,
      })
    ).rejects.toThrow(SecurityValidationError);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html><body>evil</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    await expect(
      apiClient.exportStats('11111111-1111-4111-8111-111111111111', { format: 'csv', days: 7 })
    ).rejects.toMatchObject({
      code: 'UNEXPECTED_CONTENT_TYPE',
    });

    // Contract update: longBreakMin accepts 5..120 and rejects >120
    expect(updatePreferencesInputSchema.safeParse({ longBreakMin: 120 }).success).toBe(true);
    expect(updatePreferencesInputSchema.safeParse({ longBreakMin: 121 }).success).toBe(false);
    expect(
      preferenceSchema.safeParse({
        userId: '11111111-1111-4111-8111-111111111111',
        focusDurationMin: 25,
        shortBreakMin: 45,
        longBreakMin: 90,
        cyclesBeforeLongBreak: 4,
        volumeFocus: 0.7,
        volumeBreak: 0.3,
        notificationsEnabled: true,
        theme: 'system',
        updatedAt: 1700000000000,
      }).success
    ).toBe(true);
  });

  it('generates valid v4 UUIDs via getRandomValues fallback on non-HTTPS LAN origins', async () => {
    const { generateUuid } = await import('../src/api/client');
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => originalCrypto.getRandomValues(arr),
    });

    try {
      const uuid = generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
