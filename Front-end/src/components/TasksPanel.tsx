import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  PriorityLevel,
  Task,
  TaskCounts,
  TaskQueryParams,
  UserTaskPriority,
} from '../domain/types';
import {
  createTaskInputSchema,
  TASK_LIMITS,
  taskQuerySchema,
  taskTagsArraySchema,
  updateTaskInputSchema,
} from '../security/validators';

interface TasksPanelProps {
  tasks: Task[];
  counts: TaskCounts;
  filteredCount?: number;
  availableTags: string[];
  query: TaskQueryParams;
  isBusy: boolean;
  onQueryChange: (nextQuery: TaskQueryParams) => void;
  onCreateTask: (input: {
    title: string;
    description: string | null;
    userPriority: UserTaskPriority;
    tags: string[];
    dueAt: number | null;
  }) => Promise<void>;
  onToggleComplete: (task: Task) => Promise<void>;
  onUpdateTask: (
    taskId: string,
    patch: {
      title: string;
      description: string | null;
      userPriority: UserTaskPriority;
      tags: string[];
      dueAt: number | null;
    }
  ) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
}

const PRIORITY_STYLES: Record<PriorityLevel, { label: string; className: string }> = {
  CRITICAL: { label: 'Crítica', className: 'bg-danger text-danger-ink' },
  HIGH: { label: 'Alta', className: 'bg-accent text-accent-ink' },
  MEDIUM: { label: 'Media', className: 'bg-brand text-brand-ink' },
  LOW: { label: 'Baja', className: 'bg-elevated text-muted' },
};

function toDatetimeLocalValue(timestampMs: number | null): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) {
    return '';
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function parseDueAtInput(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const ms = new Date(trimmed).getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return 'invalid';
  }
  return Math.trunc(ms);
}

const DUE_DATE_FORMATTER = new Intl.DateTimeFormat('es-ES', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDueAtDisplay(ms: number | null): string | null {
  if (!ms || !Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return DUE_DATE_FORMATTER.format(date);
}

function parseTagsCsv(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of parts) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(tag);
    }
  }
  return unique;
}

function toUserPriority(priority: PriorityLevel): UserTaskPriority {
  return priority === 'CRITICAL' ? 'HIGH' : priority;
}

export const TasksPanel = memo(function TasksPanel({
  tasks,
  counts,
  filteredCount,
  availableTags,
  query,
  isBusy,
  onQueryChange,
  onCreateTask,
  onToggleComplete,
  onUpdateTask,
  onDeleteTask,
}: TasksPanelProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<UserTaskPriority>('LOW');
  const [newTagsInput, setNewTagsInput] = useState('');
  const [newDueAt, setNewDueAt] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [searchDraft, setSearchDraft] = useState(query.search ?? '');
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const expandedTaskRef = useRef<HTMLLIElement | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState<UserTaskPriority>('LOW');
  const [editTagsInput, setEditTagsInput] = useState('');
  const [editDueAt, setEditDueAt] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (!expandedTaskId || editingId !== null) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (expandedTaskRef.current && !expandedTaskRef.current.contains(event.target as Node)) {
        setExpandedTaskId(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')
      ) {
        setExpandedTaskId(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [expandedTaskId, editingId]);

  useEffect(() => {
    if (expandedTaskId && !tasks.some((item) => item.id === expandedTaskId)) {
      setExpandedTaskId(null);
    }
  }, [tasks, expandedTaskId]);

  const dueLabelsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const formatted = formatDueAtDisplay(task.dueAt);
      if (formatted) {
        map.set(task.id, formatted);
      }
    }
    return map;
  }, [tasks]);

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const parsedDueAt = parseDueAtInput(newDueAt);
    if (parsedDueAt === 'invalid') {
      setFormError('Fecha límite inválida');
      return;
    }

    const parsedTags = taskTagsArraySchema.safeParse(parseTagsCsv(newTagsInput));
    if (!parsedTags.success) {
      setFormError(parsedTags.error.issues[0]?.message ?? 'Etiquetas inválidas');
      return;
    }

    const parsed = createTaskInputSchema.safeParse({
      title: newTitle,
      description: newDescription.trim() ? newDescription : null,
      userPriority: newPriority,
      tags: parsedTags.data,
      dueAt: parsedDueAt,
    });

    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'Datos de tarea inválidos');
      return;
    }

    setNewTitle('');
    setNewDescription('');
    setNewPriority('LOW');
    setNewTagsInput('');
    setNewDueAt('');
    setShowDetails(false);

    await onCreateTask({
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      userPriority: parsed.data.userPriority ?? 'LOW',
      tags: parsed.data.tags ?? [],
      dueAt: parsed.data.dueAt ?? null,
    });
  };

  const handleSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSearchError(null);
    const trimmed = searchDraft.trim();

    if (!trimmed) {
      const next = { ...query };
      delete next.search;
      onQueryChange(next);
      return;
    }

    const parsed = taskQuerySchema.safeParse({ ...query, search: trimmed });
    if (!parsed.success) {
      setSearchError(parsed.error.issues[0]?.message ?? 'Texto de búsqueda inválido');
      return;
    }
    onQueryChange(parsed.data);
  };

  const startEdit = (task: Task) => {
    setEditingId(task.id);
    setEditTitle(task.title);
    setEditDescription(task.description ?? '');
    setEditPriority(toUserPriority(task.userPriority));
    setEditTagsInput(task.tags.join(', '));
    setEditDueAt(toDatetimeLocalValue(task.dueAt));
    setEditError(null);
  };

  const handleEditSubmit = async (e: FormEvent, taskId: string) => {
    e.preventDefault();
    setEditError(null);

    const parsedDueAt = parseDueAtInput(editDueAt);
    if (parsedDueAt === 'invalid') {
      setEditError('Fecha límite inválida');
      return;
    }

    const parsedTags = taskTagsArraySchema.safeParse(parseTagsCsv(editTagsInput));
    if (!parsedTags.success) {
      setEditError(parsedTags.error.issues[0]?.message ?? 'Etiquetas inválidas');
      return;
    }

    const parsed = updateTaskInputSchema.safeParse({
      title: editTitle,
      description: editDescription.trim() ? editDescription : null,
      userPriority: editPriority,
      tags: parsedTags.data,
      dueAt: parsedDueAt,
    });

    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? 'Datos inválidos');
      return;
    }

    setEditingId(null);
    await onUpdateTask(taskId, {
      title: parsed.data.title ?? editTitle.trim(),
      description: parsed.data.description ?? null,
      userPriority: parsed.data.userPriority ?? editPriority,
      tags: parsed.data.tags ?? [],
      dueAt: parsed.data.dueAt ?? null,
    });
  };

  const activeStatus = query.status ?? 'all';
  const hasActiveFilters = Boolean(
    query.priority || query.tag || query.search || query.overdue !== undefined
  );

  const filtersOpen = showFilters || hasActiveFilters;

  return (
    <section
      className="liquid-glass liquid-panel-enter rounded-3xl p-5 sm:p-6"
      aria-labelledby="tasks-heading"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <h2 id="tasks-heading" className="text-lg font-bold tracking-tight text-heading">
            Tareas
          </h2>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
            <span className="liquid-glass-subtle rounded-full px-2.5 py-0.5 text-heading">
              {counts.pending} pend.
            </span>
            <span className="liquid-glass-subtle rounded-full px-2.5 py-0.5 text-muted">
              {counts.completed} comp.
            </span>
            {hasActiveFilters && filteredCount !== undefined && (
              <span className="rounded-full bg-brand px-2.5 py-0.5 text-brand-ink">
                {filteredCount} filt.
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          className={`liquid-pill min-h-9 cursor-pointer rounded-full px-3 py-1 text-xs font-semibold ${
            filtersOpen ? 'border-brand text-brand' : 'text-heading'
          }`}
          aria-expanded={filtersOpen}
          onClick={() => setShowFilters((v) => !v)}
        >
          {filtersOpen ? 'Ocultar filtros' : 'Filtros'}
        </button>
      </div>

      {/* Create Task Form */}
      <form className="mb-4 flex flex-col gap-3" onSubmit={handleCreateSubmit} noValidate>
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="new-task-title" className="sr-only">
            Título de nueva tarea
          </label>
          <input
            id="new-task-title"
            type="text"
            maxLength={TASK_LIMITS.TITLE_MAX_LEN}
            value={newTitle}
            onChange={(e) => {
              setNewTitle(e.target.value);
              setFormError(null);
            }}
            placeholder="Agregar tarea enfocada..."
            className="liquid-glass-subtle min-h-10 flex-1 rounded-2xl px-3.5 py-2 text-sm text-heading placeholder:text-muted"
          />
          <div className="flex gap-2">
            <select
              aria-label="Prioridad de nueva tarea"
              value={newPriority}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'LOW' || val === 'MEDIUM' || val === 'HIGH') {
                  setNewPriority(val);
                }
              }}
              className="liquid-glass-subtle min-h-10 rounded-2xl px-3 py-2 text-xs font-semibold text-heading"
            >
              <option value="LOW">Baja</option>
              <option value="MEDIUM">Media</option>
              <option value="HIGH">Alta</option>
            </select>
            <button
              type="button"
              className="liquid-pill min-h-10 cursor-pointer rounded-2xl px-3 py-2 text-xs font-semibold text-ink"
              onClick={() => setShowDetails((v) => !v)}
            >
              {showDetails ? 'Menos' : 'Detalles'}
            </button>
            <button
              type="submit"
              className="min-h-10 cursor-pointer rounded-2xl bg-accent px-4 py-2 text-sm font-bold text-accent-ink shadow-sm transition hover:bg-accent-hover active:scale-[0.98] disabled:opacity-55"
              disabled={isBusy}
            >
              Agregar
            </button>
          </div>
        </div>

        {showDetails && (
          <div className="liquid-glass-subtle liquid-panel-enter grid grid-cols-1 gap-3 rounded-2xl p-3.5 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label htmlFor="new-task-desc" className="text-xs font-semibold text-heading">
                Descripción (opcional)
              </label>
              <textarea
                id="new-task-desc"
                rows={2}
                maxLength={TASK_LIMITS.DESCRIPTION_MAX_LEN}
                value={newDescription}
                onChange={(e) => {
                  setNewDescription(e.target.value);
                  setFormError(null);
                }}
                placeholder="Contexto breve o criterios de terminado..."
                className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-xs text-heading"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="new-task-tags" className="text-xs font-semibold text-heading">
                Etiquetas (separadas por coma)
              </label>
              <input
                id="new-task-tags"
                type="text"
                value={newTagsInput}
                onChange={(e) => {
                  setNewTagsInput(e.target.value);
                  setFormError(null);
                }}
                placeholder="ej. api, estudio, urgente"
                className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-heading"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="new-task-due" className="text-xs font-semibold text-heading">
                Fecha límite (opcional)
              </label>
              <input
                id="new-task-due"
                type="datetime-local"
                value={newDueAt}
                onChange={(e) => {
                  setNewDueAt(e.target.value);
                  setFormError(null);
                }}
                className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-heading"
              />
            </div>
          </div>
        )}

        {formError && (
          <p
            className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
            role="alert"
          >
            {formError}
          </p>
        )}
      </form>

      {/* Filters, Search & Sort Controls */}
      {filtersOpen && (
        <div className="liquid-glass-subtle liquid-panel-enter mb-4 flex flex-col gap-2.5 rounded-2xl p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filtrar tareas por estado">
              {(
                [
                  ['all', `Todas (${counts.total})`],
                  ['pending', `Pendientes (${counts.pending})`],
                  ['completed', `Completadas (${counts.completed})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={activeStatus === value}
                  onClick={() => onQueryChange({ ...query, status: value })}
                  className={`cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition ${
                    activeStatus === value
                      ? 'bg-brand text-brand-ink'
                      : 'liquid-pill text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                className="cursor-pointer rounded-full px-2.5 py-1 text-xs font-semibold text-brand hover:bg-elevated/60"
                onClick={() => {
                  setSearchDraft('');
                  setSearchError(null);
                  onQueryChange({ status: 'all', sortBy: query.sortBy, sortOrder: query.sortOrder });
                }}
              >
                Limpiar filtros
              </button>
            )}
          </div>

          <form className="flex flex-wrap gap-2" onSubmit={handleSearchSubmit} noValidate>
            <label htmlFor="task-search-input" className="sr-only">
              Buscar tareas
            </label>
          <input
            id="task-search-input"
            type="search"
            maxLength={TASK_LIMITS.SEARCH_MAX_LEN}
            value={searchDraft}
            onChange={(e) => {
              setSearchDraft(e.target.value);
              setSearchError(null);
            }}
            placeholder="Buscar tareas..."
            className="min-w-40 flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-heading"
          />
          <button
            type="submit"
            className="cursor-pointer rounded-lg border border-edge bg-elevated px-3 py-1.5 text-xs font-semibold text-heading hover:border-brand"
          >
            Filtrar
          </button>

          <select
            aria-label="Filtrar por prioridad"
            value={query.priority ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              const next = { ...query };
              if (val === 'LOW' || val === 'MEDIUM' || val === 'HIGH' || val === 'CRITICAL') {
                next.priority = val;
              } else {
                delete next.priority;
              }
              onQueryChange(next);
            }}
            className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-heading"
          >
            <option value="">Prioridad: Todas</option>
            <option value="CRITICAL">Crítica</option>
            <option value="HIGH">Alta</option>
            <option value="MEDIUM">Media</option>
            <option value="LOW">Baja</option>
          </select>

          <select
            aria-label="Ordenar tareas"
            value={query.sortBy ?? 'default'}
            onChange={(e) => {
              const val = e.target.value;
              if (
                val === 'default' ||
                val === 'priority' ||
                val === 'dueAt' ||
                val === 'createdAt' ||
                val === 'updatedAt'
              ) {
                onQueryChange({ ...query, sortBy: val });
              }
            }}
            className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-heading"
          >
            <option value="default">Orden: Predeterminado</option>
            <option value="priority">Orden: Prioridad</option>
            <option value="dueAt">Orden: Fecha límite</option>
            <option value="createdAt">Orden: Creación</option>
            <option value="updatedAt">Orden: Actualización</option>
          </select>

          <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-ink">
            <input
              type="checkbox"
              checked={query.overdue === true}
              onChange={(e) => {
                const next = { ...query };
                if (e.target.checked) {
                  next.overdue = true;
                } else {
                  delete next.overdue;
                }
                onQueryChange(next);
              }}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span>Vencidas</span>
          </label>
        </form>

        {availableTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-muted">Etiquetas:</span>
            {availableTags.map((tag) => {
              const selected = query.tag?.toLowerCase() === tag.toLowerCase();
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    const next = { ...query };
                    if (selected) {
                      delete next.tag;
                    } else {
                      next.tag = tag;
                    }
                    onQueryChange(next);
                  }}
                  className={`cursor-pointer rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition ${
                    selected
                      ? 'bg-brand text-brand-ink'
                      : 'bg-elevated text-ink hover:border-brand'
                  }`}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        )}

        {searchError && (
          <p className="text-xs font-medium text-danger" role="alert">
            {searchError}
          </p>
        )}
        </div>
      )}

      {/* Task List */}
      {tasks.length === 0 ? (
        <p className="liquid-glass-subtle rounded-2xl border-dashed px-4 py-8 text-center text-xs text-muted">
          No hay tareas en esta vista.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {tasks.map((task) => {
            const priorityMeta = PRIORITY_STYLES[task.effectivePriority];
            const dueDisplay = dueLabelsById.get(task.id) ?? null;
            const isEditing = editingId === task.id;
            const isExpanded = expandedTaskId === task.id;

            return (
              <li
                key={task.id}
                ref={isExpanded ? expandedTaskRef : undefined}
                className="liquid-glass-subtle liquid-task-enter rounded-2xl p-3.5 transition-all duration-300 ease-out hover:border-brand/60"
              >
                {isEditing ? (
                  <form
                    className="flex flex-col gap-2.5"
                    onSubmit={(e) => void handleEditSubmit(e, task.id)}
                    noValidate
                  >
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        maxLength={TASK_LIMITS.TITLE_MAX_LEN}
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        aria-label="Editar título de tarea"
                        className="flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm text-heading"
                      />
                      <select
                        aria-label="Editar prioridad de tarea"
                        value={editPriority}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === 'LOW' || val === 'MEDIUM' || val === 'HIGH') {
                            setEditPriority(val);
                          }
                        }}
                        className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs font-semibold text-heading"
                      >
                        <option value="LOW">Baja</option>
                        <option value="MEDIUM">Media</option>
                        <option value="HIGH">Alta</option>
                      </select>
                    </div>

                    <textarea
                      rows={2}
                      maxLength={TASK_LIMITS.DESCRIPTION_MAX_LEN}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      aria-label="Editar descripción de tarea"
                      className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-heading"
                    />

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        value={editTagsInput}
                        onChange={(e) => setEditTagsInput(e.target.value)}
                        aria-label="Editar etiquetas de tarea"
                        placeholder="Etiquetas separadas por coma"
                        className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-heading"
                      />
                      <input
                        type="datetime-local"
                        value={editDueAt}
                        onChange={(e) => setEditDueAt(e.target.value)}
                        aria-label="Editar fecha límite"
                        className="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-heading"
                      />
                    </div>

                    {editError && (
                      <p
                        className="rounded-lg border border-danger bg-danger-bg px-3 py-1.5 text-xs text-danger"
                        role="alert"
                      >
                        {editError}
                      </p>
                    )}

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        className="cursor-pointer rounded-lg px-3 py-1 text-xs font-semibold text-ink hover:bg-elevated"
                        onClick={() => setEditingId(null)}
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        className="cursor-pointer rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-brand-ink hover:bg-brand-hover"
                      >
                        Guardar
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-col">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={task.completed}
                        onChange={() => void onToggleComplete(task)}
                        aria-label={`Marcar "${task.title}" como ${
                          task.completed ? 'pendiente' : 'completada'
                        }`}
                        className="h-4 w-4 shrink-0 cursor-pointer accent-accent"
                      />
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        aria-controls={`task-extra-${task.id}`}
                        onClick={() =>
                          setExpandedTaskId((prev) => (prev === task.id ? null : task.id))
                        }
                        className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 text-left sm:cursor-default"
                      >
                        <span
                          className={`min-w-0 break-words text-sm font-semibold ${
                            task.completed ? 'line-through text-muted' : 'text-heading'
                          }`}
                        >
                          {task.title}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${priorityMeta.className}`}
                        >
                          {priorityMeta.label}
                        </span>
                      </button>
                    </div>

                    <div
                      id={`task-extra-${task.id}`}
                      data-open={isExpanded ? 'true' : 'false'}
                      className="task-mobile-accordion"
                    >
                      <div className="liquid-accordion-inner">
                        <div className="mt-2.5 flex flex-wrap items-start justify-between gap-3 border-t border-edge/40 pt-2.5 pl-7">
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            {dueDisplay && (
                              <span className="text-[11px] text-muted">Vence: {dueDisplay}</span>
                            )}

                            {task.description && (
                              <p className="whitespace-pre-line text-xs text-muted">
                                {task.description}
                              </p>
                            )}

                            {task.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-0.5">
                                {task.tags.map((tag) => (
                                  <button
                                    key={tag}
                                    type="button"
                                    onClick={() => onQueryChange({ ...query, tag })}
                                    className="cursor-pointer rounded-full bg-elevated px-2 py-0.5 text-[10px] font-semibold text-ink hover:border-brand"
                                  >
                                    #{tag}
                                  </button>
                                ))}
                              </div>
                            )}

                            {task.priorityReason && (
                              <p className="text-[11px] font-medium text-brand">
                                {task.priorityReason}
                              </p>
                            )}
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold text-ink hover:bg-elevated"
                              onClick={() => startEdit(task)}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold text-danger hover:bg-danger-bg"
                              onClick={() => void onDeleteTask(task.id)}
                            >
                              Eliminar
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
});
