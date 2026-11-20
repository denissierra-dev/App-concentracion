import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase, type AppDatabase } from '../src/db/database.js';
import { EventLogRepository } from '../src/repositories/eventLogRepository.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Fase 7: Mini Buscador (/api/v1/search)', () => {
  let db: AppDatabase;
  let deviceId: string;
  let userId: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    const app = createApp({ db });
    const reg = await request(app).post('/api/v1/auth/device').send({});
    deviceId = reg.body.deviceId;
    userId = reg.body.user.id;
  });

  afterEach(() => {
    db.close();
  });

  it('requires authentication for all /api/v1/search endpoints', async () => {
    const app = createApp({ db });

    expect((await request(app).get('/api/v1/search?q=pomodoro')).status).toBe(401);
    expect((await request(app).get('/api/v1/search/engines')).status).toBe(401);
    expect((await request(app).get('/api/v1/search/history')).status).toBe(401);
    expect(
      (await request(app).delete(`/api/v1/search/history/${crypto.randomUUID()}`)).status
    ).toBe(401);
    expect((await request(app).delete('/api/v1/search/history')).status).toBe(401);
  });

  it('lists supported search engines and reflects Google configuration status', async () => {
    const appUnconfigured = createApp({ db });
    const res1 = await request(appUnconfigured)
      .get('/api/v1/search/engines')
      .set('x-device-id', deviceId);

    expect(res1.status).toBe(200);
    expect(res1.body.engines).toEqual([
      { id: 'google', name: 'Google', configured: false, requiresApiKey: true },
      { id: 'wikipedia', name: 'Wikipedia', configured: true, requiresApiKey: false },
      { id: 'stackoverflow', name: 'Stack Overflow', configured: true, requiresApiKey: false },
    ]);

    const appConfigured = createApp({
      db,
      searchConfig: { googleApiKey: 'test-key', googleCx: 'test-cx' },
    });
    const res2 = await request(appConfigured)
      .get('/api/v1/search/engines')
      .set('x-device-id', deviceId);

    expect(res2.status).toBe(200);
    expect(res2.body.engines[0].configured).toBe(true);
  });

  it('proxies Wikipedia searches, sanitizes HTML snippets, and records history', async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://es.wikipedia.org');
      expect(url.pathname).toBe('/w/api.php');
      expect(url.searchParams.get('srsearch')).toBe('tecnica pomodoro');
      expect(url.searchParams.get('srlimit')).toBe('5');

      return jsonResponse({
        query: {
          search: [
            {
              pageid: 42100,
              title: 'Técnica <b>Pomodoro</b>',
              snippet:
                'La <span class="searchmatch">técnica</span> Pomodoro usa intervalos &amp; pausas.',
            },
          ],
        },
      });
    });

    const app = createApp({ db, searchFetchImpl: mockFetch });
    const res = await request(app)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'tecnica pomodoro', limit: 5, lang: 'es' })
      .set('x-device-id', deviceId);

    expect(res.status).toBe(200);
    expect(res.body.engine).toBe('wikipedia');
    expect(res.body.query).toBe('tecnica pomodoro');
    expect(res.body.lang).toBe('es');
    expect(res.body.configured).toBe(true);
    expect(res.body.externalUrl).toBe(
      'https://es.wikipedia.org/wiki/Special:Search?search=tecnica%20pomodoro'
    );
    expect(res.body.totalResults).toBe(1);
    expect(res.body.results).toEqual([
      {
        title: 'Técnica Pomodoro',
        url: 'https://es.wikipedia.org/?curid=42100',
        snippet: 'La técnica Pomodoro usa intervalos & pausas.',
        displayUrl: 'es.wikipedia.org',
        engine: 'wikipedia',
        metadata: { pageId: 42100 },
      },
    ]);
    expect(res.body.historyEntry).toMatchObject({
      userId,
      engine: 'wikipedia',
      query: 'tecnica pomodoro',
      resultsCount: 1,
    });

    const events = new EventLogRepository(db).listByUser(userId);
    expect(events.some((e) => e.eventType === 'SEARCH_EXECUTED')).toBe(true);
  });

  it('proxies Stack Overflow searches, decodes entities, and drops unsafe URLs', async () => {
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.stackexchange.com');
      expect(url.searchParams.get('site')).toBe('stackoverflow');
      expect(url.searchParams.get('q')).toBe('sqlite wal');
      expect(url.searchParams.get('key')).toBe('se-secret');

      return jsonResponse({
        items: [
          {
            question_id: 12345,
            title: 'Why doesn&#39;t SQLite &quot;WAL&quot; block readers?',
            link: 'https://stackoverflow.com/questions/12345/sqlite-wal',
            score: 42,
            answer_count: 3,
            is_answered: true,
            tags: ['sqlite', 'wal'],
          },
          {
            question_id: 99999,
            title: 'Malicious link',
            link: 'javascript:alert(1)',
            score: 0,
            answer_count: 0,
            is_answered: false,
            tags: [],
          },
        ],
      });
    });

    const app = createApp({
      db,
      searchConfig: { stackExchangeApiKey: 'se-secret' },
      searchFetchImpl: mockFetch,
    });

    const res = await request(app)
      .get('/api/v1/search')
      .query({ engine: 'stackoverflow', q: 'sqlite wal' })
      .set('x-device-id', deviceId);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toEqual({
      title: 'Why doesn\'t SQLite "WAL" block readers?',
      url: 'https://stackoverflow.com/questions/12345/sqlite-wal',
      snippet: 'Tags: sqlite, wal · Score: 42 · Answers: 3',
      displayUrl: 'stackoverflow.com',
      engine: 'stackoverflow',
      metadata: {
        questionId: 12345,
        score: 42,
        answerCount: 3,
        isAnswered: true,
        tags: ['sqlite', 'wal'],
      },
    });
  });

  it('handles Google search gracefully when unconfigured and proxies Google CSE when configured', async () => {
    const appUnconfigured = createApp({ db });
    const unconfiguredRes = await request(appUnconfigured)
      .get('/api/v1/search')
      .query({ engine: 'google', q: 'deep work' })
      .set('x-device-id', deviceId);

    expect(unconfiguredRes.status).toBe(200);
    expect(unconfiguredRes.body.configured).toBe(false);
    expect(unconfiguredRes.body.results).toEqual([]);
    expect(unconfiguredRes.body.externalUrl).toBe('https://www.google.com/search?q=deep%20work');
    expect(unconfiguredRes.body.notice).toEqual(expect.any(String));
    expect(unconfiguredRes.body.historyEntry).toMatchObject({
      engine: 'google',
      query: 'deep work',
      resultsCount: 0,
    });

    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://www.googleapis.com');
      expect(url.searchParams.get('key')).toBe('google-key');
      expect(url.searchParams.get('cx')).toBe('google-cx');
      expect(url.searchParams.get('num')).toBe('10');

      return jsonResponse({
        items: [
          {
            title: 'Deep Work Summary',
            link: 'https://example.com/deep-work',
            displayLink: 'example.com',
            snippet: 'Rules for focused <b>success</b>.',
          },
        ],
      });
    });

    const appConfigured = createApp({
      db,
      searchConfig: { googleApiKey: 'google-key', googleCx: 'google-cx' },
      searchFetchImpl: mockFetch,
    });

    const configuredRes = await request(appConfigured)
      .get('/api/v1/search')
      .query({ engine: 'google', q: 'deep work', limit: 15, saveHistory: 'false' })
      .set('x-device-id', deviceId);

    expect(configuredRes.status).toBe(200);
    expect(configuredRes.body.configured).toBe(true);
    expect(configuredRes.body.notice).toBeNull();
    expect(configuredRes.body.historyEntry).toBeNull();
    expect(configuredRes.body.results).toEqual([
      {
        title: 'Deep Work Summary',
        url: 'https://example.com/deep-work',
        displayUrl: 'example.com',
        snippet: 'Rules for focused success.',
        engine: 'google',
      },
    ]);
  });

  it('supports filtering, per-user isolation, single deletion, and clearing search history', async () => {
    const mockFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ query: { search: [] }, items: [] })
    );
    const app = createApp({ db, searchFetchImpl: mockFetch });

    const r1 = await request(app)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'first query' })
      .set('x-device-id', deviceId);
    const r2 = await request(app)
      .get('/api/v1/search')
      .query({ engine: 'stackoverflow', q: 'second query' })
      .set('x-device-id', deviceId);
    await request(app)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'third query' })
      .set('x-device-id', deviceId);

    const allHistory = await request(app)
      .get('/api/v1/search/history')
      .set('x-device-id', deviceId);
    expect(allHistory.status).toBe(200);
    expect(allHistory.body.total).toBe(3);
    expect(allHistory.body.history).toHaveLength(3);

    const wikiHistory = await request(app)
      .get('/api/v1/search/history')
      .query({ engine: 'wikipedia', limit: 1 })
      .set('x-device-id', deviceId);
    expect(wikiHistory.status).toBe(200);
    expect(wikiHistory.body.total).toBe(2);
    expect(wikiHistory.body.history).toHaveLength(1);

    // Other user isolation
    const otherUser = await request(app).post('/api/v1/auth/device').send({});
    const otherDeviceId = otherUser.body.deviceId;

    const otherHistory = await request(app)
      .get('/api/v1/search/history')
      .set('x-device-id', otherDeviceId);
    expect(otherHistory.body.total).toBe(0);

    const crossDelete = await request(app)
      .delete(`/api/v1/search/history/${r1.body.historyEntry.id}`)
      .set('x-device-id', otherDeviceId);
    expect(crossDelete.status).toBe(404);
    expect(crossDelete.body.error.code).toBe('SEARCH_HISTORY_NOT_FOUND');

    // Delete single entry
    const delOne = await request(app)
      .delete(`/api/v1/search/history/${r2.body.historyEntry.id}`)
      .set('x-device-id', deviceId);
    expect(delOne.status).toBe(200);
    expect(delOne.body.deleted).toBe(true);

    // Clear remaining wikipedia entries
    const clearWiki = await request(app)
      .delete('/api/v1/search/history')
      .query({ engine: 'wikipedia' })
      .set('x-device-id', deviceId);
    expect(clearWiki.status).toBe(200);
    expect(clearWiki.body.deletedCount).toBe(2);

    const afterClear = await request(app)
      .get('/api/v1/search/history')
      .set('x-device-id', deviceId);
    expect(afterClear.body.total).toBe(0);
  });

  it('validates query params and maps upstream errors/timeouts cleanly', async () => {
    const appBadQuery = createApp({ db });
    expect(
      (
        await request(appBadQuery)
          .get('/api/v1/search')
          .query({ q: '   ' })
          .set('x-device-id', deviceId)
      ).status
    ).toBe(400);

    expect(
      (
        await request(appBadQuery)
          .get('/api/v1/search')
          .query({ engine: 'bing', q: 'test' })
          .set('x-device-id', deviceId)
      ).status
    ).toBe(400);

    expect(
      (
        await request(appBadQuery)
          .get('/api/v1/search')
          .query({ engine: 'wikipedia', q: 'test', lang: 'en.evil.com#' })
          .set('x-device-id', deviceId)
      ).status
    ).toBe(400);

    const failingFetch = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'bad' }, 503));
    const appUpstreamFail = createApp({ db, searchFetchImpl: failingFetch });
    const failRes = await request(appUpstreamFail)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'focus' })
      .set('x-device-id', deviceId);

    expect(failRes.status).toBe(502);
    expect(failRes.body.error.code).toBe('SEARCH_UPSTREAM_ERROR');

    // Timeout simulation
    const slowFetch = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        })
    );
    const appTimeout = createApp({
      db,
      searchConfig: { timeoutMs: 25 },
      searchFetchImpl: slowFetch,
    });
    const timeoutRes = await request(appTimeout)
      .get('/api/v1/search')
      .query({ engine: 'wikipedia', q: 'focus' })
      .set('x-device-id', deviceId);

    expect(timeoutRes.status).toBe(504);
    expect(timeoutRes.body.error.code).toBe('SEARCH_UPSTREAM_TIMEOUT');

    // Failed searches are not saved to history
    const historyAfterFailures = await request(appTimeout)
      .get('/api/v1/search/history')
      .set('x-device-id', deviceId);
    expect(historyAfterFailures.body.total).toBe(0);
  });
});
