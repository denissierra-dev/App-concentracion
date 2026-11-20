import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiClientError } from '../src/api/client';
import { safeStorage } from '../src/security/safeStorage';
import {
  assertNoInjectionChars,
  assertSafeApiPath,
  assertSafeAudioStreamUrl,
  assertSafeExternalHttpUrl,
  audioTracksResponseSchema,
  createSessionInputSchema,
  createTaskInputSchema,
  safeJsonParse,
  safePathSegment,
  sanitizePlainText,
  searchQueryInputSchema,
  searchResponseSchema,
  SecurityValidationError,
  taskQuerySchema,
  taskTagsArraySchema,
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

  it('closes IndexedDB connection only after transaction completes (never prematurely)', async () => {
    const devA = '11111111-1111-4111-8111-111111111111';
    const devB = '22222222-2222-4222-8222-222222222222';
    const closeSpy = vi.fn();
    let txCompleteHandler: (() => void) | null = null;

    const fakeDb = {
      objectStoreNames: { contains: () => true },
      close: closeSpy,
      transaction: () => {
        const tx = {
          oncomplete: null as (() => void) | null,
          onerror: null as (() => void) | null,
          onabort: null as (() => void) | null,
          objectStore: () => ({
            put: () => {
              setTimeout(() => {
                txCompleteHandler = tx.oncomplete;
                tx.oncomplete?.();
              }, 0);
            },
          }),
        };
        return tx;
      },
    };

    const originalIdb = window.indexedDB;
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          const req = {
            result: fakeDb,
            onupgradeneeded: null as (() => void) | null,
            onsuccess: null as (() => void) | null,
            onerror: null as (() => void) | null,
          };
          setTimeout(() => req.onsuccess?.(), 0);
          return req;
        },
      },
    });

    try {
      const savePromise = syncStore.saveQueue(devA, [
        {
          eventId: devB,
          entityType: 'task',
          entityId: devB,
          eventType: 'TASK_DELETED',
          payload: {},
        },
      ]);

      // Flush microtasks before setTimeout(0) for tx.oncomplete fires
      await Promise.resolve();
      await Promise.resolve();
      expect(closeSpy).not.toHaveBeenCalled();

      await savePromise;
      expect(txCompleteHandler).not.toBeNull();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
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
});
