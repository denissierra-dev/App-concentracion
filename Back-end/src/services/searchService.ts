import crypto from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { SearchEngine, SearchHistoryEntry, SearchResultItem } from '../domain/types.js';
import { AppError } from '../errors/AppError.js';
import type { EventLogRepository } from '../repositories/eventLogRepository.js';
import type { SearchHistoryRepository } from '../repositories/searchHistoryRepository.js';

export interface SearchConfig {
  googleApiKey?: string;
  googleCx?: string;
  stackExchangeApiKey?: string;
  timeoutMs?: number;
}

export interface SearchServiceDeps {
  db: AppDatabase;
  searchHistoryRepo: SearchHistoryRepository;
  eventLogRepo: EventLogRepository;
  config?: SearchConfig;
  fetchImpl?: typeof fetch;
}

export interface SearchEngineInfo {
  id: SearchEngine;
  name: string;
  configured: boolean;
  requiresApiKey: boolean;
}

export interface ExecuteSearchParams {
  userId: string;
  engine: SearchEngine;
  query: string;
  limit: number;
  lang: string;
  saveHistory: boolean;
}

export interface ExecuteSearchResult {
  engine: SearchEngine;
  query: string;
  lang: string;
  configured: boolean;
  externalUrl: string;
  results: SearchResultItem[];
  totalResults: number;
  notice: string | null;
  historyEntry: SearchHistoryEntry | null;
  serverTimeMs: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Strips HTML tags and decodes common HTML entities so upstream snippets
 * can never inject markup into client views.
 */
function sanitizeText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }

  const withBlockSpacing = raw.replace(/<\/?(?:br|p|div|li|tr|td|th|h[1-6])\b[^>]*>/gi, ' ');
  const withoutTags = withBlockSpacing.replace(/<[^>]*>/g, '');
  const decoded = withoutTags.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const codePoint = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      if (entity.startsWith('#')) {
        const codePoint = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match;
      }
      return NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? match;
    }
  );

  return decoded.replace(/\s+/g, ' ').trim();
}

/**
 * Accepts only http/https URLs from upstream search providers.
 */
function sanitizeHttpUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildExternalSearchUrl(engine: SearchEngine, query: string, lang: string): string {
  const encodedQuery = encodeURIComponent(query);
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${encodedQuery}`;
    case 'wikipedia':
      return `https://${lang}.wikipedia.org/wiki/Special:Search?search=${encodedQuery}`;
    case 'stackoverflow':
      return `https://stackoverflow.com/search?q=${encodedQuery}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Proxies search requests to external providers (Google CSE, Wikipedia, Stack Overflow)
 * and persists per-user search history in SQLite.
 */
export class SearchService {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly deps: SearchServiceDeps) {
    this.fetchFn = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = deps.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private isGoogleConfigured(): boolean {
    return Boolean(this.deps.config?.googleApiKey && this.deps.config?.googleCx);
  }

  listEngines(): SearchEngineInfo[] {
    return [
      {
        id: 'google',
        name: 'Google',
        configured: this.isGoogleConfigured(),
        requiresApiKey: true,
      },
      {
        id: 'wikipedia',
        name: 'Wikipedia',
        configured: true,
        requiresApiKey: false,
      },
      {
        id: 'stackoverflow',
        name: 'Stack Overflow',
        configured: true,
        requiresApiKey: false,
      },
    ];
  }

  async search(params: ExecuteSearchParams): Promise<ExecuteSearchResult> {
    const lang = params.lang.toLowerCase();
    const externalUrl = buildExternalSearchUrl(params.engine, params.query, lang);

    let configured = true;
    let notice: string | null = null;
    let results: SearchResultItem[] = [];

    if (params.engine === 'google') {
      if (!this.isGoogleConfigured()) {
        configured = false;
        notice =
          'Google Custom Search API is not configured on the server. Use externalUrl to open the query in a browser window.';
      } else {
        results = await this.searchGoogle(params.query, params.limit);
      }
    } else if (params.engine === 'wikipedia') {
      results = await this.searchWikipedia(params.query, params.limit, lang);
    } else {
      results = await this.searchStackOverflow(params.query, params.limit);
    }

    const nowMs = Date.now();
    const historyEntry = params.saveHistory
      ? this.recordHistory({
          userId: params.userId,
          engine: params.engine,
          query: params.query,
          resultsCount: results.length,
          configured,
          nowMs,
        })
      : null;

    return {
      engine: params.engine,
      query: params.query,
      lang,
      configured,
      externalUrl,
      results,
      totalResults: results.length,
      notice,
      historyEntry,
      serverTimeMs: nowMs,
    };
  }

  getHistory(
    userId: string,
    options?: { engine?: SearchEngine; limit?: number }
  ): { history: SearchHistoryEntry[]; total: number; serverTimeMs: number } {
    const history = this.deps.searchHistoryRepo.listByUser(userId, options);
    const total = this.deps.searchHistoryRepo.countByUser(userId, options?.engine);

    return {
      history,
      total,
      serverTimeMs: Date.now(),
    };
  }

  deleteHistoryEntry(
    userId: string,
    id: string
  ): { deleted: true; id: string; serverTimeMs: number } {
    const nowMs = Date.now();

    return this.deps.db.transaction(() => {
      const deleted = this.deps.searchHistoryRepo.deleteByIdForUser(id, userId);
      if (!deleted) {
        throw new AppError(404, 'SEARCH_HISTORY_NOT_FOUND', 'Search history entry not found');
      }

      this.deps.eventLogRepo.append({
        userId,
        entityType: 'search',
        entityId: id,
        eventType: 'SEARCH_HISTORY_ENTRY_DELETED',
        payload: {},
        serverTimestamp: nowMs,
      });

      return {
        deleted: true as const,
        id,
        serverTimeMs: nowMs,
      };
    })();
  }

  clearHistory(
    userId: string,
    engine?: SearchEngine
  ): { deletedCount: number; serverTimeMs: number } {
    const nowMs = Date.now();

    return this.deps.db.transaction(() => {
      const deletedCount = this.deps.searchHistoryRepo.deleteAllForUser(userId, engine);

      this.deps.eventLogRepo.append({
        userId,
        entityType: 'search',
        entityId: userId,
        eventType: 'SEARCH_HISTORY_CLEARED',
        payload: {
          ...(engine ? { engine } : {}),
          deletedCount,
        },
        serverTimestamp: nowMs,
      });

      return {
        deletedCount,
        serverTimeMs: nowMs,
      };
    })();
  }

  private recordHistory(input: {
    userId: string;
    engine: SearchEngine;
    query: string;
    resultsCount: number;
    configured: boolean;
    nowMs: number;
  }): SearchHistoryEntry {
    return this.deps.db.transaction(() => {
      const entry: SearchHistoryEntry = {
        id: crypto.randomUUID(),
        userId: input.userId,
        engine: input.engine,
        query: input.query,
        resultsCount: input.resultsCount,
        createdAt: input.nowMs,
      };

      this.deps.searchHistoryRepo.create(entry);
      this.deps.eventLogRepo.append({
        userId: input.userId,
        entityType: 'search',
        entityId: entry.id,
        eventType: 'SEARCH_EXECUTED',
        payload: {
          engine: input.engine,
          query: input.query,
          resultsCount: input.resultsCount,
          configured: input.configured,
        },
        serverTimestamp: input.nowMs,
      });

      return entry;
    })();
  }

  private async fetchUpstreamJson(url: string, engine: SearchEngine): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'DeepWorkApp/1.0 (https://localhost)',
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError(504, 'SEARCH_UPSTREAM_TIMEOUT', 'Search provider timed out', {
          engine,
        });
      }
      throw new AppError(502, 'SEARCH_UPSTREAM_ERROR', 'Failed to reach search provider', {
        engine,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AppError(502, 'SEARCH_UPSTREAM_ERROR', 'Search provider returned an error', {
        engine,
        statusCode: response.status,
      });
    }

    try {
      return await response.json();
    } catch {
      throw new AppError(502, 'SEARCH_UPSTREAM_ERROR', 'Invalid response from search provider', {
        engine,
      });
    }
  }

  private async searchWikipedia(
    query: string,
    limit: number,
    lang: string
  ): Promise<SearchResultItem[]> {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(limit));
    url.searchParams.set('format', 'json');
    url.searchParams.set('utf8', '1');

    const payload = await this.fetchUpstreamJson(url.toString(), 'wikipedia');
    if (!isRecord(payload) || !isRecord(payload.query) || !Array.isArray(payload.query.search)) {
      return [];
    }

    const items: SearchResultItem[] = [];
    for (const rawItem of payload.query.search) {
      if (!isRecord(rawItem)) continue;

      const title = sanitizeText(rawItem.title);
      const pageId = typeof rawItem.pageid === 'number' ? rawItem.pageid : undefined;
      if (!title || pageId === undefined) continue;

      const itemUrl = sanitizeHttpUrl(`https://${lang}.wikipedia.org/?curid=${pageId}`);
      if (!itemUrl) continue;

      items.push({
        title,
        url: itemUrl,
        snippet: sanitizeText(rawItem.snippet),
        displayUrl: `${lang}.wikipedia.org`,
        engine: 'wikipedia',
        metadata: { pageId },
      });
    }

    return items;
  }

  private async searchStackOverflow(query: string, limit: number): Promise<SearchResultItem[]> {
    const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('sort', 'relevance');
    url.searchParams.set('q', query);
    url.searchParams.set('site', 'stackoverflow');
    url.searchParams.set('pagesize', String(limit));

    if (this.deps.config?.stackExchangeApiKey) {
      url.searchParams.set('key', this.deps.config.stackExchangeApiKey);
    }

    const payload = await this.fetchUpstreamJson(url.toString(), 'stackoverflow');
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      return [];
    }

    const items: SearchResultItem[] = [];
    for (const rawItem of payload.items) {
      if (!isRecord(rawItem)) continue;

      const title = sanitizeText(rawItem.title);
      const itemUrl = sanitizeHttpUrl(rawItem.link);
      if (!title || !itemUrl) continue;

      const tags = Array.isArray(rawItem.tags)
        ? rawItem.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      const score = typeof rawItem.score === 'number' ? rawItem.score : 0;
      const answerCount = typeof rawItem.answer_count === 'number' ? rawItem.answer_count : 0;
      const isAnswered = Boolean(rawItem.is_answered);
      const questionId =
        typeof rawItem.question_id === 'number' ? rawItem.question_id : undefined;

      const snippetParts: string[] = [];
      if (tags.length > 0) {
        snippetParts.push(`Tags: ${tags.slice(0, 5).join(', ')}`);
      }
      snippetParts.push(`Score: ${score}`);
      snippetParts.push(`Answers: ${answerCount}`);

      items.push({
        title,
        url: itemUrl,
        snippet: snippetParts.join(' · '),
        displayUrl: 'stackoverflow.com',
        engine: 'stackoverflow',
        metadata: {
          ...(questionId !== undefined ? { questionId } : {}),
          score,
          answerCount,
          isAnswered,
          tags,
        },
      });
    }

    return items;
  }

  private async searchGoogle(query: string, limit: number): Promise<SearchResultItem[]> {
    const apiKey = this.deps.config?.googleApiKey;
    const cx = this.deps.config?.googleCx;
    if (!apiKey || !cx) {
      return [];
    }

    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    // Google Custom Search JSON API supports 1..10 results per page
    url.searchParams.set('num', String(Math.min(limit, 10)));

    const payload = await this.fetchUpstreamJson(url.toString(), 'google');
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      return [];
    }

    const items: SearchResultItem[] = [];
    for (const rawItem of payload.items) {
      if (!isRecord(rawItem)) continue;

      const title = sanitizeText(rawItem.title);
      const itemUrl = sanitizeHttpUrl(rawItem.link);
      if (!title || !itemUrl) continue;

      const displayUrl =
        typeof rawItem.displayLink === 'string' && rawItem.displayLink.trim() !== ''
          ? rawItem.displayLink.trim()
          : null;

      items.push({
        title,
        url: itemUrl,
        snippet: sanitizeText(rawItem.snippet),
        displayUrl,
        engine: 'google',
      });
    }

    return items;
  }
}
