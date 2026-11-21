import { memo, useState, type FormEvent } from 'react';
import type {
  SearchEngine,
  SearchEngineInfo,
  SearchHistoryEntry,
  SearchResponse,
} from '../domain/types';
import { SEARCH_LIMITS, searchQueryInputSchema } from '../security/validators';

interface MiniSearchPanelProps {
  engines: SearchEngineInfo[];
  history: SearchHistoryEntry[];
  lastResponse: SearchResponse | null;
  isSearching: boolean;
  searchError: string | null;
  embedded?: boolean;
  onSearch: (input: {
    q: string;
    engine: SearchEngine;
    lang: string;
    limit: number;
    saveHistory: boolean;
  }) => Promise<void>;
  onDeleteHistoryEntry: (id: string) => Promise<void>;
  onClearHistory: (engine?: SearchEngine) => Promise<void>;
}

const DEFAULT_ENGINES: SearchEngineInfo[] = [
  { id: 'wikipedia', name: 'Wikipedia', configured: true, requiresApiKey: false },
  { id: 'stackoverflow', name: 'Stack Overflow', configured: true, requiresApiKey: false },
  { id: 'google', name: 'Google', configured: false, requiresApiKey: true },
];

const WIKI_LANGS = ['es', 'en', 'pt', 'fr', 'de'] as const;

export const MiniSearchPanel = memo(function MiniSearchPanel({
  engines,
  history,
  lastResponse,
  isSearching,
  searchError,
  embedded = false,
  onSearch,
  onDeleteHistoryEntry,
  onClearHistory,
}: MiniSearchPanelProps) {
  const [engine, setEngine] = useState<SearchEngine>('wikipedia');
  const [lang, setLang] = useState<string>('es');
  const [queryInput, setQueryInput] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState<boolean>(false);

  const engineList = engines.length > 0 ? engines : DEFAULT_ENGINES;

  const submitQuery = async (q: string, targetEngine: SearchEngine, targetLang: string) => {
    setValidationError(null);
    const parsed = searchQueryInputSchema.safeParse({
      q,
      engine: targetEngine,
      lang: targetLang,
      limit: 10,
      saveHistory: true,
    });

    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'Consulta inválida');
      return;
    }

    await onSearch(parsed.data);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitQuery(queryInput, engine, lang);
  };

  const displayError = validationError ?? searchError;

  const content = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        {!embedded ? (
          <div>
            <h2 id="search-heading" className="text-base font-bold text-heading">
              Buscador de enfoque
            </h2>
            <p className="text-xs text-muted">Consulta rápida sin salir de tu sesión</p>
          </div>
        ) : (
          <p className="text-xs text-muted">Consulta rápida sin abrir pestañas distractoras</p>
        )}
        <button
          type="button"
          className="liquid-pill cursor-pointer rounded-full px-3 py-1 text-xs font-semibold text-heading"
          onClick={() => setShowHistory((v) => !v)}
        >
          {showHistory ? 'Ver resultados' : `Historial (${history.length})`}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Motor de búsqueda">
        {engineList.map((item) => {
          const active = item.id === engine;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setEngine(item.id);
                setValidationError(null);
              }}
              className={`min-h-9 cursor-pointer rounded-full border px-3 py-1 text-xs font-semibold transition ${
                active
                  ? 'border-brand bg-brand text-brand-ink'
                  : 'liquid-glass-subtle text-ink hover:border-brand'
              }`}
            >
              {item.name}
              {!item.configured ? ' (externo)' : ''}
            </button>
          );
        })}

        {engine === 'wikipedia' && (
          <select
            aria-label="Idioma de Wikipedia"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="liquid-glass-subtle ml-auto min-h-9 rounded-full px-3 py-1 text-xs font-semibold text-heading"
          >
            {WIKI_LANGS.map((code) => (
              <option key={code} value={code}>
                Wiki: {code.toUpperCase()}
              </option>
            ))}
          </select>
        )}
      </div>

      <form className="mb-4 flex gap-2" onSubmit={handleSubmit} noValidate>
        <label htmlFor="mini-search-input" className="sr-only">
          Consulta de búsqueda rápida
        </label>
        <input
          id="mini-search-input"
          type="search"
          maxLength={SEARCH_LIMITS.QUERY_MAX_LEN}
          value={queryInput}
          onChange={(e) => {
            setQueryInput(e.target.value);
            setValidationError(null);
          }}
          placeholder="Buscar concepto, documentación o error..."
          className="liquid-glass-subtle min-h-10 flex-1 rounded-2xl px-3.5 py-2 text-xs text-heading placeholder:text-muted"
        />
        <button
          type="submit"
          className="min-h-10 cursor-pointer rounded-2xl bg-accent px-4 py-2 text-xs font-bold text-accent-ink transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-55"
          disabled={isSearching}
        >
          {isSearching ? 'Buscando...' : 'Buscar'}
        </button>
      </form>

      {displayError && (
        <p
          className="mb-3 rounded-2xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
          role="alert"
        >
          {displayError}
        </p>
      )}

      {showHistory ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-heading">Búsquedas recientes</span>
            {history.length > 0 && (
              <button
                type="button"
                className="cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold text-danger hover:bg-danger-bg"
                onClick={() => void onClearHistory()}
              >
                Limpiar todo
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <p className="liquid-glass-subtle rounded-2xl border-dashed px-3 py-5 text-center text-xs text-muted">
              Aún no hay búsquedas en el historial.
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
              {history.map((entry) => (
                <li
                  key={entry.id}
                  className="liquid-glass-subtle flex items-center justify-between gap-2 rounded-2xl px-3.5 py-2 text-xs"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left font-medium text-heading hover:text-brand"
                    onClick={() => {
                      setEngine(entry.engine);
                      setQueryInput(entry.query);
                      setShowHistory(false);
                      void submitQuery(entry.query, entry.engine, lang);
                    }}
                  >
                    <span className="mr-1.5 rounded-full bg-elevated px-2 py-0.5 text-[10px] uppercase text-muted">
                      {entry.engine}
                    </span>
                    {entry.query}
                  </button>
                  <span className="shrink-0 text-[11px] text-muted">{entry.resultsCount} res.</span>
                  <button
                    type="button"
                    className="shrink-0 cursor-pointer rounded-full px-2 py-0.5 text-[11px] text-danger hover:bg-danger-bg"
                    onClick={() => void onDeleteHistoryEntry(entry.id)}
                    aria-label={`Eliminar "${entry.query}" del historial`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : lastResponse ? (
        <div className="flex flex-col gap-2.5">
          {lastResponse.notice && (
            <div className="liquid-glass-subtle rounded-2xl p-3.5 text-xs text-ink">
              <p>{lastResponse.notice}</p>
              <a
                href={lastResponse.externalUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="mt-2 inline-block font-semibold text-brand underline"
              >
                Abrir búsqueda en nueva pestaña ↗
              </a>
            </div>
          )}

          {lastResponse.results.length === 0 && !lastResponse.notice ? (
            <p className="liquid-glass-subtle rounded-2xl border-dashed px-3 py-5 text-center text-xs text-muted">
              Sin resultados para «{lastResponse.query}».
            </p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {lastResponse.results.map((item) => (
                <li
                  key={item.url}
                  className="liquid-glass-subtle rounded-2xl p-3.5 text-xs transition hover:border-brand"
                >
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="font-semibold text-brand hover:underline"
                  >
                    {item.title} ↗
                  </a>
                  {item.displayUrl && (
                    <p className="truncate text-[11px] text-muted">{item.displayUrl}</p>
                  )}
                  {item.snippet && <p className="mt-1 text-ink">{item.snippet}</p>}
                  {item.metadata && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-muted">
                      {item.metadata.score !== undefined && (
                        <span className="rounded-full bg-elevated px-2 py-0.5">
                          Score: {item.metadata.score}
                        </span>
                      )}
                      {item.metadata.answerCount !== undefined && (
                        <span className="rounded-full bg-elevated px-2 py-0.5">
                          Respuestas: {item.metadata.answerCount}
                        </span>
                      )}
                      {item.metadata.isAnswered && (
                        <span className="rounded-full bg-success-bg px-2 py-0.5 font-semibold text-success">
                          Resuelta
                        </span>
                      )}
                      {item.metadata.tags?.slice(0, 4).map((tag) => (
                        <span key={tag} className="rounded-full bg-elevated px-2 py-0.5">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">
          Consulta Wikipedia o Stack Overflow sin abrir pestañas distractoras.
        </p>
      )}
    </>
  );

  if (embedded) {
    return <div aria-label="Buscador de enfoque">{content}</div>;
  }

  return (
    <section
      className="liquid-glass rounded-3xl p-6"
      aria-labelledby="search-heading"
    >
      {content}
    </section>
  );
});
