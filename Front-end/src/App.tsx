import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, ApiClientError, generateUuid, type ControlOptions } from './api/client';
import { AudioPlayer } from './components/AudioPlayer';
import { DeviceIdentityModal } from './components/DeviceIdentityModal';
import { HeaderBar } from './components/HeaderBar';
import { MiniSearchPanel } from './components/MiniSearchPanel';
import { PhaseTimeline } from './components/PhaseTimeline';
import { PreferencesModal } from './components/PreferencesModal';
import { SessionSetup } from './components/SessionSetup';
import { TasksPanel } from './components/TasksPanel';
import { TimerDisplay } from './components/TimerDisplay';
import {
  applyOfflineSessionControl,
  deriveTimerSnapshot,
  getPhaseLabel,
} from './domain/sessionClock';
import { toBackendTheme } from './domain/themes';
import type {
  AppTheme,
  AudioTrack,
  Preference,
  QueuedSyncEvent,
  SearchEngine,
  SearchEngineInfo,
  SearchHistoryEntry,
  SearchResponse,
  Session,
  Task,
  TaskCounts,
  TaskQueryParams,
  ThemePreference,
  UserTaskPriority,
  VolumePolicy,
} from './domain/types';
import { useAmbientAudio } from './hooks/useAmbientAudio';
import { useLocalChime } from './hooks/useLocalChime';
import { safeStorage } from './security/safeStorage';
import { sanitizePlainText } from './security/validators';
import { syncStore } from './sync/syncStore';

const DEFAULT_VOLUME_POLICY: VolumePolicy = {
  focus: 0.7,
  short_break: 0.3,
  long_break: 0.3,
};

const EMPTY_COUNTS: TaskCounts = {
  total: 0,
  pending: 0,
  completed: 0,
};

const HOURLY_BACKUP_SYNC_MS = 60 * 60 * 1000;

function computeCounts(tasks: Task[]): TaskCounts {
  const completed = tasks.filter((t) => t.completed).length;
  return {
    total: tasks.length,
    pending: tasks.length - completed,
    completed,
  };
}

function hasActiveTaskQuery(query: TaskQueryParams): boolean {
  return Boolean(
    (query.status && query.status !== 'all') ||
      query.priority ||
      query.tag ||
      query.search ||
      query.overdue !== undefined ||
      query.hasDueDate !== undefined ||
      (query.sortBy && query.sortBy !== 'default')
  );
}

function filterTasksLocally(tasks: Task[], query: TaskQueryParams, nowMs: number): Task[] {
  return tasks.filter((task) => {
    if (query.status === 'pending' && task.completed) return false;
    if (query.status === 'completed' && !task.completed) return false;
    if (query.priority && task.userPriority !== query.priority) return false;
    if (query.tag && !task.tags.some((t) => t.toLowerCase() === query.tag!.toLowerCase())) {
      return false;
    }
    if (query.overdue && (!task.dueAt || task.dueAt >= nowMs || task.completed)) return false;
    if (query.search) {
      const q = query.search.toLowerCase();
      const inTitle = task.title.toLowerCase().includes(q);
      const inDesc = (task.description ?? '').toLowerCase().includes(q);
      if (!inTitle && !inDesc) return false;
    }
    return true;
  });
}

export function App() {
  const [deviceId, setDeviceId] = useState<string | null>(() => safeStorage.getDeviceId());
  const [appTheme, setAppTheme] = useState<AppTheme>(() => safeStorage.getThemePalette() ?? 'system');
  const [preferences, setPreferences] = useState<Preference | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCounts, setTaskCounts] = useState<TaskCounts>(EMPTY_COUNTS);
  const [filteredCount, setFilteredCount] = useState<number | undefined>(undefined);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [taskQuery, setTaskQuery] = useState<TaskQueryParams>({ status: 'all', sortBy: 'default' });

  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [volumePolicy, setVolumePolicy] = useState<VolumePolicy>(DEFAULT_VOLUME_POLICY);
  const [pendingQueue, setPendingQueue] = useState<QueuedSyncEvent[]>([]);

  // Phase 7: Mini Buscador state
  const [searchEngines, setSearchEngines] = useState<SearchEngineInfo[]>([]);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryEntry[]>([]);
  const [lastSearchResponse, setLastSearchResponse] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [clockOffsetMs, setClockOffsetMs] = useState<number>(0);
  const [serverNowMs, setServerNowMs] = useState<number>(() => Date.now());
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [isBootstrapping, setIsBootstrapping] = useState<boolean>(true);
  const [isMutating, setIsMutating] = useState<boolean>(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [lastCompletedSummary, setLastCompletedSummary] = useState<string | null>(null);

  const [showPrefsModal, setShowPrefsModal] = useState<boolean>(false);
  const [showIdentityModal, setShowIdentityModal] = useState<boolean>(false);

  const { playTransitionChime, notifyLocal, requestNotificationPermission } = useLocalChime();
  const prevPhaseKeyRef = useRef<string | null>(null);
  const completedReconcileInFlightRef = useRef<string | null>(null);
  const flushingQueueRef = useRef<boolean>(false);
  const taskQueryRef = useRef<TaskQueryParams>(taskQuery);
  taskQueryRef.current = taskQuery;
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  const taskCountsRef = useRef<TaskCounts>(taskCounts);
  taskCountsRef.current = taskCounts;

  const clearInMemoryUserState = useCallback(() => {
    setSession(null);
    setPreferences(null);
    setTasks([]);
    setTaskCounts(EMPTY_COUNTS);
    setFilteredCount(undefined);
    setAvailableTags([]);
    setPendingQueue([]);
    setSearchHistory([]);
    setLastSearchResponse(null);
    setLastCompletedSummary(null);
  }, []);

  const applyServerTime = useCallback((serverTimeMs: number) => {
    const offset = serverTimeMs - Date.now();
    setClockOffsetMs(offset);
    setServerNowMs(Date.now() + offset);
  }, []);

  const formatError = useCallback((err: unknown): string => {
    if (err instanceof ApiClientError || err instanceof Error) {
      return sanitizePlainText(err.message, 220) || 'Error inesperado';
    }
    return 'Error inesperado';
  }, []);

  const persistSnapshot = useCallback(
    async (
      targetDeviceId: string,
      nextSession: Session | null,
      nextPrefs: Preference | null,
      nextTasks: Task[],
      nextCounts: TaskCounts,
      serverTimeMs: number
    ) => {
      await syncStore.saveSnapshot({
        deviceId: targetDeviceId,
        activeSession: nextSession,
        preferences: nextPrefs,
        tasks: nextTasks,
        taskCounts: nextCounts,
        serverTimeMs,
        cachedAt: Date.now(),
      });
    },
    []
  );

  const refreshTaskTags = useCallback(async (targetDeviceId: string) => {
    try {
      const tagsRes = await apiClient.getTaskTags(targetDeviceId);
      setAvailableTags(tagsRes.tags);
    } catch {
      // Non-critical if offline
    }
  }, []);

  const pullFullState = useCallback(
    async (targetDeviceId: string) => {
      const syncState = await apiClient.getSyncState(targetDeviceId);
      applyServerTime(syncState.serverTimeMs);
      setSession(syncState.activeSession);
      setPreferences(syncState.preferences);
      if (!safeStorage.getThemePalette() && syncState.preferences) {
        setAppTheme(syncState.preferences.theme);
      }
      setTaskCounts(syncState.taskCounts);
      setServerOnline(true);

      await persistSnapshot(
        targetDeviceId,
        syncState.activeSession,
        syncState.preferences,
        syncState.tasks,
        syncState.taskCounts,
        syncState.serverTimeMs
      );

      if (hasActiveTaskQuery(taskQueryRef.current)) {
        const filteredRes = await apiClient.getTasks(targetDeviceId, taskQueryRef.current);
        setTasks(filteredRes.tasks);
        setTaskCounts(filteredRes.counts);
        setFilteredCount(filteredRes.filteredCount);
      } else {
        setTasks(syncState.tasks);
        setFilteredCount(undefined);
      }

      void refreshTaskTags(targetDeviceId);
      return syncState;
    },
    [applyServerTime, persistSnapshot, refreshTaskTags]
  );

  const flushSyncQueue = useCallback(
    async (targetDeviceId: string): Promise<boolean> => {
      if (flushingQueueRef.current) {
        return false;
      }

      const queued = await syncStore.loadQueue(targetDeviceId);
      if (queued.length === 0) {
        setPendingQueue([]);
        return false;
      }

      flushingQueueRef.current = true;
      try {
        const batch = queued.slice(0, 100);
        const res = await apiClient.postSyncBatch(targetDeviceId, batch);
        const remaining = queued.slice(batch.length);
        await syncStore.saveQueue(targetDeviceId, remaining);
        setPendingQueue(remaining);

        applyServerTime(res.snapshot.serverTimeMs);
        setServerOnline(true);

        const hasConflict = res.results.some((r) => r.status === 'conflict');
        if (hasConflict) {
          setBannerError(
            'Se detectó un conflicto de versión al sincronizar; estado reconciliado con el servidor.'
          );
        }

        await pullFullState(targetDeviceId);
        return true;
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
        }
        return false;
      } finally {
        flushingQueueRef.current = false;
      }
    },
    [applyServerTime, pullFullState]
  );

  const bootstrapForDevice = useCallback(
    async (candidateDeviceId?: string) => {
      setIsBootstrapping(true);
      setBannerError(null);

      const storedId = candidateDeviceId ?? safeStorage.getDeviceId();
      if (storedId) {
        const [cached, queued] = await Promise.all([
          syncStore.loadSnapshot(storedId),
          syncStore.loadQueue(storedId),
        ]);
        setPendingQueue(queued);
        if (cached) {
          setSession(cached.activeSession);
          setPreferences(cached.preferences);
          setTasks(cached.tasks);
          setTaskCounts(cached.taskCounts);
        } else {
          setSession(null);
          setPreferences(null);
          setTasks([]);
          setTaskCounts(EMPTY_COUNTS);
          setFilteredCount(undefined);
        }
      }

      try {
        const [, timeRes] = await Promise.all([
          apiClient.checkHealth(),
          apiClient.getServerTime(),
        ]);
        applyServerTime(timeRes.serverTimeMs);
        setServerOnline(true);

        let resolvedDeviceId = storedId;
        if (resolvedDeviceId) {
          try {
            const me = await apiClient.getMe(resolvedDeviceId);
            resolvedDeviceId = me.user.deviceId;
          } catch (err) {
            if (err instanceof ApiClientError && err.status === 401) {
              const registered = await apiClient.registerDevice(resolvedDeviceId);
              resolvedDeviceId = registered.deviceId;
            } else {
              throw err;
            }
          }
        } else {
          const registered = await apiClient.registerDevice();
          resolvedDeviceId = registered.deviceId;
        }

        safeStorage.setDeviceId(resolvedDeviceId);
        setDeviceId(resolvedDeviceId);

        const flushed = await flushSyncQueue(resolvedDeviceId);
        if (!flushed) {
          await pullFullState(resolvedDeviceId);
        }

        const [audioRes, enginesRes, historyRes] = await Promise.all([
          apiClient.getAudioTracks(resolvedDeviceId),
          apiClient.getSearchEngines(resolvedDeviceId),
          apiClient.getSearchHistory(resolvedDeviceId, { limit: 20 }),
        ]);
        setTracks(audioRes.tracks);
        setVolumePolicy(audioRes.volumePolicy);
        setSearchEngines(enginesRes.engines);
        setSearchHistory(historyRes.history);
      } catch (err) {
        setServerOnline(false);
        setBannerError(formatError(err));
      } finally {
        setIsBootstrapping(false);
      }
    },
    [applyServerTime, flushSyncQueue, formatError, pullFullState]
  );

  useEffect(() => {
    void bootstrapForDevice();
  }, [bootstrapForDevice]);

  // Apply theme attribute to root HTML element (zero inline styles)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appTheme);
  }, [appTheme]);

  // Local 250ms tick loop ONLY when a session is active
  useEffect(() => {
    if (!session || session.status !== 'active') {
      return;
    }

    setServerNowMs(Date.now() + clockOffsetMs);
    const intervalId = window.setInterval(() => {
      setServerNowMs(Date.now() + clockOffsetMs);
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [session, clockOffsetMs]);

  const snapshot = useMemo(
    () => deriveTimerSnapshot(session, serverNowMs),
    [session, serverNowMs]
  );

  // Detect local phase transitions & natural plan completion
  useEffect(() => {
    if (!session || !snapshot) {
      prevPhaseKeyRef.current = null;
      return;
    }

    const currentKey = snapshot.isPlanCompleted
      ? `${session.id}:done`
      : `${session.id}:${session.version}:${snapshot.effectiveIndex}`;

    const previousKey = prevPhaseKeyRef.current;
    prevPhaseKeyRef.current = currentKey;

    if (previousKey && previousKey !== currentKey && session.status === 'active') {
      const notificationsOn = preferences?.notificationsEnabled ?? true;
      if (snapshot.isPlanCompleted) {
        playTransitionChime('completed');
        notifyLocal(
          'Sesión completada',
          'Terminaste todos los ciclos planificados.',
          notificationsOn
        );
      } else if (snapshot.currentPhase) {
        playTransitionChime(snapshot.currentPhase.phaseType);
        const label = getPhaseLabel(snapshot.currentPhase.phaseType);
        notifyLocal(
          `Fase: ${label}`,
          `Ciclo ${snapshot.currentPhase.cycleNumber} iniciado.`,
          notificationsOn
        );
      }
    }

    if (
      session.status === 'active' &&
      snapshot.isPlanCompleted &&
      deviceId &&
      completedReconcileInFlightRef.current !== session.id
    ) {
      completedReconcileInFlightRef.current = session.id;
      void apiClient
        .getSessionState(deviceId, session.id)
        .then((res) => {
          applyServerTime(res.serverTimeMs);
          if (res.session && (res.session.status === 'completed' || res.session.status === 'reset')) {
            setSession(null);
            setLastCompletedSummary('¡Sesión completada y registrada en el servidor!');
          } else {
            setSession(res.session);
          }
        })
        .catch(() => {
          // Keep local state if offline; user can reconcile manually
        })
        .finally(() => {
          completedReconcileInFlightRef.current = null;
        });
    }
  }, [
    session,
    snapshot,
    deviceId,
    preferences?.notificationsEnabled,
    playTransitionChime,
    notifyLocal,
    applyServerTime,
  ]);

  // Flush pending offline queue on reconnect, visibilitychange, and hourly backup
  useEffect(() => {
    if (!deviceId) {
      return;
    }

    const handleOnline = () => {
      void flushSyncQueue(deviceId);
    };

    const handleVisibility = () => {
      void flushSyncQueue(deviceId).then((didFlush) => {
        if (!didFlush && document.visibilityState === 'visible' && session?.status === 'active') {
          void apiClient
            .getSessionState(deviceId, session.id)
            .then((res) => {
              applyServerTime(res.serverTimeMs);
              if (res.session?.status === 'completed' || res.session?.status === 'reset') {
                setSession(null);
              } else if (res.session) {
                setSession(res.session);
              }
            })
            .catch(() => {
              // Silent reconnect failure; user retains local plan
            });
        }
      });
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);

    const hourlyId = window.setInterval(() => {
      void flushSyncQueue(deviceId);
    }, HOURLY_BACKUP_SYNC_MS);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(hourlyId);
    };
  }, [deviceId, session, flushSyncQueue, applyServerTime]);

  const activePhaseType = snapshot?.currentPhase?.phaseType ?? null;
  const ambientAudio = useAmbientAudio({
    tracks,
    volumePolicy,
    activePhaseType,
  });

  const handleStartSession = async (focusDurationMin: number, totalCycles: number) => {
    if (!deviceId) {
      return;
    }
    setIsMutating(true);
    setBannerError(null);
    setLastCompletedSummary(null);

    try {
      const res = await apiClient.createSession(deviceId, {
        focusDurationMin,
        totalCycles,
      });
      applyServerTime(res.serverTimeMs);
      setSession(res.session);
      setServerOnline(true);
      await persistSnapshot(deviceId, res.session, preferences, tasks, taskCounts, res.serverTimeMs);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'ACTIVE_SESSION_EXISTS') {
        await pullFullState(deviceId);
      }
      setBannerError(formatError(err));
    } finally {
      setIsMutating(false);
    }
  };

  const runSessionControl = useCallback(
    async (
      eventType:
        | 'SESSION_PAUSED'
        | 'SESSION_RESUMED'
        | 'PHASE_SKIPPED'
        | 'SESSION_RESET'
        | 'SESSION_ENDED',
      action: (
        dId: string,
        sId: string,
        opts: ControlOptions
      ) => Promise<{ session: Session; serverTimeMs: number }>,
      closeOnTerminal: boolean,
      terminalMessage?: string
    ) => {
      if (!deviceId || !session) {
        return;
      }
      setIsMutating(true);
      setBannerError(null);

      const eventId = generateUuid();
      const expectedVersion = session.version;

      try {
        const res = await action(deviceId, session.id, { eventId, expectedVersion });
        applyServerTime(res.serverTimeMs);
        setServerOnline(true);

        const isTerminal =
          closeOnTerminal &&
          (res.session.status === 'completed' || res.session.status === 'reset');
        const nextSession = isTerminal ? null : res.session;
        setSession(nextSession);
        if (isTerminal && terminalMessage) {
          setLastCompletedSummary(terminalMessage);
        }
        await persistSnapshot(deviceId, nextSession, preferences, tasks, taskCounts, res.serverTimeMs);
      } catch (err) {
        if (err instanceof ApiClientError && err.code === 'VERSION_CONFLICT') {
          await pullFullState(deviceId);
          setBannerError(
            'La sesión cambió en otro dispositivo; estado actualizado desde el servidor.'
          );
        } else if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const queued = await syncStore.enqueueEvent(deviceId, {
            eventId,
            entityType: 'session',
            entityId: session.id,
            eventType,
            expectedVersion,
            clientTimestamp: Date.now(),
            payload: {},
          });
          setPendingQueue(queued);

          const nextOfflineSession = applyOfflineSessionControl(session, eventType, serverNowMs);
          setSession(nextOfflineSession);
          await persistSnapshot(
            deviceId,
            nextOfflineSession,
            preferences,
            tasks,
            taskCounts,
            serverNowMs
          );
          setBannerError('Sin conexión: evento guardado en cola offline para sincronizar.');
        } else {
          setBannerError(formatError(err));
        }
      } finally {
        setIsMutating(false);
      }
    },
    [
      deviceId,
      session,
      preferences,
      tasks,
      taskCounts,
      serverNowMs,
      applyServerTime,
      persistSnapshot,
      pullFullState,
      formatError,
    ]
  );

  // Keyboard shortcuts (Phase 9 UX polish): Escape closes modals, Space toggles pause/resume
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showPrefsModal) setShowPrefsModal(false);
        if (showIdentityModal) setShowIdentityModal(false);
        return;
      }

      if (e.code === 'Space' && session && !showPrefsModal && !showIdentityModal && !isMutating) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
          return;
        }
        e.preventDefault();
        if (session.status === 'active') {
          void runSessionControl('SESSION_PAUSED', apiClient.pauseSession, false);
        } else if (session.status === 'paused') {
          void runSessionControl('SESSION_RESUMED', apiClient.resumeSession, false);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session, showPrefsModal, showIdentityModal, isMutating, runSessionControl]);

  const handleSyncState = async () => {
    if (!deviceId) {
      return;
    }
    setIsMutating(true);
    setBannerError(null);

    try {
      const flushed = await flushSyncQueue(deviceId);
      if (!flushed) {
        await pullFullState(deviceId);
      }
    } catch (err) {
      setBannerError(formatError(err));
    } finally {
      setIsMutating(false);
    }
  };

  // --- Phase 6.0 Server-Side Task Filter/Sort Handler ---

  const handleTaskQueryChange = async (nextQuery: TaskQueryParams) => {
    setTaskQuery(nextQuery);
    if (!deviceId) {
      return;
    }

    try {
      const res = await apiClient.getTasks(deviceId, nextQuery);
      applyServerTime(res.serverTimeMs);
      setServerOnline(true);
      setTasks(res.tasks);
      setTaskCounts(res.counts);
      setFilteredCount(hasActiveTaskQuery(nextQuery) ? res.filteredCount : undefined);

      if (!hasActiveTaskQuery(nextQuery)) {
        await persistSnapshot(deviceId, session, preferences, res.tasks, res.counts, res.serverTimeMs);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) {
        setServerOnline(false);
        const cached = await syncStore.loadSnapshot(deviceId);
        if (cached) {
          const filtered = filterTasksLocally(cached.tasks, nextQuery, serverNowMs);
          setTasks(filtered);
          setFilteredCount(hasActiveTaskQuery(nextQuery) ? filtered.length : undefined);
        }
      } else {
        setBannerError(formatError(err));
      }
    }
  };

  // --- Tasks CRUD Handlers (Phase 5 + 6.0) ---

  const handleCreateTask = async (input: {
    title: string;
    description: string | null;
    userPriority: UserTaskPriority;
    tags: string[];
    dueAt: number | null;
  }) => {
    if (!deviceId) {
      return;
    }
    setBannerError(null);
    const taskId = generateUuid();
    const eventId = generateUuid();
    const now = Date.now();

    const optimisticTask: Task = {
      id: taskId,
      userId: deviceId,
      title: input.title,
      description: input.description,
      completed: false,
      completedAt: null,
      userPriority: input.userPriority,
      aiPriority: null,
      effectivePriority: input.userPriority,
      priorityScore: 0,
      priorityReason: null,
      priorityComputedAt: null,
      priorityDismissedUntil: null,
      priorityDismissCount: 0,
      tags: input.tags,
      dueAt: input.dueAt,
      createdAt: now,
      updatedAt: now,
    };

    const prevTasksSnapshot = tasksRef.current;
    const optimisticTasksSnapshot = [optimisticTask, ...prevTasksSnapshot];
    setTasks((current) => [optimisticTask, ...current]);
    setTaskCounts(computeCounts(optimisticTasksSnapshot));

    try {
      const res = await apiClient.createTask(
        deviceId,
        {
          id: taskId,
          title: input.title,
          description: input.description,
          userPriority: input.userPriority,
          tags: input.tags,
          dueAt: input.dueAt,
        },
        eventId
      );
      applyServerTime(res.serverTimeMs);
      setServerOnline(true);

      if (hasActiveTaskQuery(taskQueryRef.current)) {
        await handleTaskQueryChange(taskQueryRef.current);
      } else {
        let latestTasks: Task[] = [];
        setTasks((current) => {
          latestTasks = [
            res.task,
            ...current.filter((t) => t.id !== res.task.id && t.id !== taskId),
          ];
          return latestTasks;
        });
        setTaskCounts(res.counts);
        await persistSnapshot(
          deviceId,
          session,
          preferences,
          latestTasks,
          res.counts,
          res.serverTimeMs
        );
      }
      void refreshTaskTags(deviceId);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) {
        setServerOnline(false);
        const queued = await syncStore.enqueueEvent(deviceId, {
          eventId,
          entityType: 'task',
          entityId: taskId,
          eventType: 'TASK_CREATED',
          clientTimestamp: now,
          payload: {
            title: input.title,
            userPriority: input.userPriority,
            tags: input.tags,
            ...(input.description !== null ? { description: input.description } : {}),
            ...(input.dueAt !== null ? { dueAt: input.dueAt } : {}),
          },
        });
        setPendingQueue(queued);
        await persistSnapshot(
          deviceId,
          session,
          preferences,
          tasksRef.current,
          taskCountsRef.current,
          serverNowMs
        );
      } else {
        setTasks((current) => {
          const rolledBack = current.filter((t) => t.id !== taskId);
          setTaskCounts(computeCounts(rolledBack));
          return rolledBack;
        });
        setBannerError(formatError(err));
      }
    }
  };

  const handleToggleTaskComplete = async (task: Task) => {
    if (!deviceId) {
      return;
    }
    setBannerError(null);
    const eventId = generateUuid();
    const nextCompleted = !task.completed;
    const now = Date.now();

    setTasks((current) => {
      const updated = current.map((item) =>
        item.id === task.id
          ? { ...item, completed: nextCompleted, completedAt: nextCompleted ? now : null }
          : item
      );
      setTaskCounts(computeCounts(updated));
      return updated;
    });

    try {
      const res = await apiClient.updateTask(
        deviceId,
        task.id,
        { completed: nextCompleted },
        eventId
      );
      applyServerTime(res.serverTimeMs);
      setServerOnline(true);

      if (hasActiveTaskQuery(taskQueryRef.current)) {
        await handleTaskQueryChange(taskQueryRef.current);
      } else {
        let latestTasks: Task[] = [];
        setTasks((current) => {
          latestTasks = current.map((item) => (item.id === res.task.id ? res.task : item));
          return latestTasks;
        });
        setTaskCounts(res.counts);
        await persistSnapshot(deviceId, session, preferences, latestTasks, res.counts, res.serverTimeMs);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) {
        setServerOnline(false);
        const queued = await syncStore.enqueueEvent(deviceId, {
          eventId,
          entityType: 'task',
          entityId: task.id,
          eventType: 'TASK_UPDATED',
          clientTimestamp: now,
          payload: { completed: nextCompleted },
        });
        setPendingQueue(queued);
        await persistSnapshot(
          deviceId,
          session,
          preferences,
          tasksRef.current,
          taskCountsRef.current,
          serverNowMs
        );
      } else {
        setTasks((current) => {
          const rolledBack = current.map((item) =>
            item.id === task.id
              ? { ...item, completed: task.completed, completedAt: task.completedAt }
              : item
          );
          setTaskCounts(computeCounts(rolledBack));
          return rolledBack;
        });
        setBannerError(formatError(err));
      }
    }
  };

  const handleUpdateTask = async (
    taskId: string,
    patch: {
      title: string;
      description: string | null;
      userPriority: UserTaskPriority;
      tags: string[];
      dueAt: number | null;
    }
  ) => {
    if (!deviceId) {
      return;
    }
    setBannerError(null);
    const eventId = generateUuid();
    const now = Date.now();
    const previousTask = tasksRef.current.find((item) => item.id === taskId) ?? null;

    setTasks((current) =>
      current.map((item) =>
        item.id === taskId
          ? {
              ...item,
              title: patch.title,
              description: patch.description,
              userPriority: patch.userPriority,
              effectivePriority:
                item.effectivePriority === 'CRITICAL' ? 'CRITICAL' : patch.userPriority,
              tags: patch.tags,
              dueAt: patch.dueAt,
            }
          : item
      )
    );

    try {
      const res = await apiClient.updateTask(deviceId, taskId, patch, eventId);
      applyServerTime(res.serverTimeMs);
      setServerOnline(true);

      if (hasActiveTaskQuery(taskQueryRef.current)) {
        await handleTaskQueryChange(taskQueryRef.current);
      } else {
        let latestTasks: Task[] = [];
        setTasks((current) => {
          latestTasks = current.map((item) => (item.id === res.task.id ? res.task : item));
          return latestTasks;
        });
        setTaskCounts(res.counts);
        await persistSnapshot(deviceId, session, preferences, latestTasks, res.counts, res.serverTimeMs);
      }
      void refreshTaskTags(deviceId);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) {
        setServerOnline(false);
        const queued = await syncStore.enqueueEvent(deviceId, {
          eventId,
          entityType: 'task',
          entityId: taskId,
          eventType: 'TASK_UPDATED',
          clientTimestamp: now,
          payload: patch,
        });
        setPendingQueue(queued);
        await persistSnapshot(
          deviceId,
          session,
          preferences,
          tasksRef.current,
          taskCountsRef.current,
          serverNowMs
        );
      } else {
        if (previousTask) {
          setTasks((current) =>
            current.map((item) => (item.id === taskId ? previousTask : item))
          );
        }
        setBannerError(formatError(err));
      }
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!deviceId) {
      return;
    }
    setBannerError(null);
    const eventId = generateUuid();
    const now = Date.now();
    const deletedTask = tasksRef.current.find((item) => item.id === taskId) ?? null;

    setTasks((current) => {
      const filtered = current.filter((item) => item.id !== taskId);
      setTaskCounts(computeCounts(filtered));
      return filtered;
    });

    try {
      const res = await apiClient.deleteTask(deviceId, taskId, eventId);
      applyServerTime(res.serverTimeMs);
      setServerOnline(true);
      setTaskCounts(res.counts);
      if (!hasActiveTaskQuery(taskQueryRef.current)) {
        await persistSnapshot(
          deviceId,
          session,
          preferences,
          tasksRef.current,
          res.counts,
          res.serverTimeMs
        );
      }
      void refreshTaskTags(deviceId);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) {
        setServerOnline(false);
        const queued = await syncStore.enqueueEvent(deviceId, {
          eventId,
          entityType: 'task',
          entityId: taskId,
          eventType: 'TASK_DELETED',
          clientTimestamp: now,
          payload: {},
        });
        setPendingQueue(queued);
        await persistSnapshot(
          deviceId,
          session,
          preferences,
          tasksRef.current,
          taskCountsRef.current,
          serverNowMs
        );
      } else {
        if (deletedTask) {
          setTasks((current) => {
            const restored = current.some((t) => t.id === taskId)
              ? current
              : [deletedTask, ...current];
            setTaskCounts(computeCounts(restored));
            return restored;
          });
        }
        setBannerError(formatError(err));
      }
    }
  };

  // --- Phase 7: Mini Buscador Handlers ---

  const handleSearch = async (input: {
    q: string;
    engine: SearchEngine;
    lang: string;
    limit: number;
    saveHistory: boolean;
  }) => {
    if (!deviceId) {
      return;
    }
    setIsSearching(true);
    setSearchError(null);

    try {
      const res = await apiClient.searchWeb(deviceId, input);
      applyServerTime(res.serverTimeMs);
      setLastSearchResponse(res);
      if (res.historyEntry) {
        setSearchHistory((prev) => [
          res.historyEntry!,
          ...prev.filter((item) => item.id !== res.historyEntry!.id),
        ]);
      }
    } catch (err) {
      setSearchError(formatError(err));
    } finally {
      setIsSearching(false);
    }
  };

  const handleDeleteSearchHistoryEntry = async (entryId: string) => {
    if (!deviceId) {
      return;
    }
    try {
      await apiClient.deleteSearchHistoryEntry(deviceId, entryId);
      setSearchHistory((prev) => prev.filter((item) => item.id !== entryId));
    } catch (err) {
      setSearchError(formatError(err));
    }
  };

  const handleClearSearchHistory = async (engine?: SearchEngine) => {
    if (!deviceId) {
      return;
    }
    try {
      await apiClient.clearSearchHistory(deviceId, engine);
      setSearchHistory((prev) => (engine ? prev.filter((item) => item.engine !== engine) : []));
    } catch (err) {
      setSearchError(formatError(err));
    }
  };

  const handleSavePreferences = async (patch: {
    focusDurationMin: number;
    cyclesBeforeLongBreak: number;
    volumeFocus: number;
    volumeBreak: number;
    notificationsEnabled: boolean;
    theme: ThemePreference;
  }) => {
    if (!deviceId) {
      return;
    }
    setIsMutating(true);
    setBannerError(null);

    try {
      const res = await apiClient.updatePreferences(deviceId, patch);
      if (res.serverTimeMs) {
        applyServerTime(res.serverTimeMs);
      }
      if (res.preferences) {
        setPreferences(res.preferences);
        await persistSnapshot(
          deviceId,
          session,
          res.preferences,
          tasksRef.current,
          taskCountsRef.current,
          res.serverTimeMs ?? serverNowMs
        );
      }
      const policyRes = await apiClient.getAudioPolicy(deviceId);
      setVolumePolicy(policyRes.volumePolicy);
      setShowPrefsModal(false);
    } catch (err) {
      setBannerError(formatError(err));
    } finally {
      setIsMutating(false);
    }
  };

  const applyLocalTheme = useCallback((nextTheme: AppTheme) => {
    safeStorage.setThemePalette(nextTheme);
    setAppTheme(nextTheme);
  }, []);

  const handleSelectTheme = async (nextTheme: AppTheme) => {
    applyLocalTheme(nextTheme);

    const backendTheme = toBackendTheme(nextTheme);
    if (!deviceId || !preferences || preferences.theme === backendTheme) {
      return;
    }

    const optimisticPrefs: Preference = { ...preferences, theme: backendTheme };
    setPreferences(optimisticPrefs);

    try {
      const res = await apiClient.updatePreferences(deviceId, { theme: backendTheme });
      if (res.serverTimeMs) {
        applyServerTime(res.serverTimeMs);
      }
      if (res.preferences) {
        setPreferences(res.preferences);
        await persistSnapshot(
          deviceId,
          session,
          res.preferences,
          tasksRef.current,
          taskCountsRef.current,
          res.serverTimeMs ?? serverNowMs
        );
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 0) {
        setServerOnline(false);
        const queued = await syncStore.enqueueEvent(deviceId, {
          eventId: generateUuid(),
          entityType: 'preference',
          entityId: deviceId,
          eventType: 'PREFERENCES_UPDATED',
          clientTimestamp: Date.now(),
          payload: { theme: backendTheme },
        });
        setPendingQueue(queued);
        await persistSnapshot(
          deviceId,
          session,
          optimisticPrefs,
          tasksRef.current,
          taskCountsRef.current,
          serverNowMs
        );
      } else {
        setPreferences(preferences);
        setBannerError(formatError(err));
      }
    }
  };

  const handleRecoverDevice = async (uuid: string) => {
    setShowIdentityModal(false);
    clearInMemoryUserState();
    safeStorage.setDeviceId(uuid);
    await bootstrapForDevice(uuid);
  };

  const handleResetNewDevice = async () => {
    setShowIdentityModal(false);
    safeStorage.clearDeviceId();
    clearInMemoryUserState();
    await bootstrapForDevice();
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <HeaderBar
        serverOnline={serverOnline}
        clockOffsetMs={clockOffsetMs}
        pendingSyncCount={pendingQueue.length}
        deviceId={deviceId}
        theme={appTheme}
        onSelectTheme={(next) => void handleSelectTheme(next)}
        onOpenIdentity={() => setShowIdentityModal(true)}
        onOpenPreferences={() => setShowPrefsModal(true)}
        onRefreshSync={() => void bootstrapForDevice(deviceId ?? undefined)}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-7 pb-12">
        {bannerError && (
          <div
            className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-danger bg-danger-bg px-4 py-3 text-sm font-medium text-danger"
            role="alert"
          >
            <span>{bannerError}</span>
            <button
              type="button"
              className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold hover:bg-black/10"
              onClick={() => setBannerError(null)}
            >
              Ocultar
            </button>
          </div>
        )}

        {lastCompletedSummary && (
          <div
            className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-success bg-success-bg px-4 py-3 text-sm font-medium text-success"
            role="status"
          >
            <span>{lastCompletedSummary}</span>
            <button
              type="button"
              className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-semibold hover:bg-black/10"
              onClick={() => setLastCompletedSummary(null)}
            >
              Cerrar
            </button>
          </div>
        )}

        {isBootstrapping ? (
          <section
            className="rounded-2xl border border-edge bg-surface px-6 py-12 text-center shadow-sm"
            aria-busy="true"
          >
            <p className="text-sm text-muted">
              Conectando identidad de dispositivo y reloj autoritativo...
            </p>
          </section>
        ) : (
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.45fr_1fr]">
            <div className="flex flex-col gap-5">
              {session && snapshot ? (
                <>
                  <TimerDisplay
                    session={session}
                    snapshot={snapshot}
                    isBusy={isMutating}
                    onPause={() =>
                      runSessionControl('SESSION_PAUSED', apiClient.pauseSession, false)
                    }
                    onResume={() =>
                      runSessionControl('SESSION_RESUMED', apiClient.resumeSession, false)
                    }
                    onSkip={() =>
                      runSessionControl(
                        'PHASE_SKIPPED',
                        apiClient.skipPhase,
                        true,
                        'Última fase saltada; sesión completada.'
                      )
                    }
                    onEnd={() =>
                      runSessionControl(
                        'SESSION_ENDED',
                        apiClient.endSession,
                        true,
                        'Sesión finalizada y guardada en estadísticas.'
                      )
                    }
                    onReset={() =>
                      runSessionControl(
                        'SESSION_RESET',
                        apiClient.resetSession,
                        true,
                        'Sesión reiniciada.'
                      )
                    }
                    onSyncState={handleSyncState}
                  />
                  <PhaseTimeline plan={session.plan} effectiveIndex={snapshot.effectiveIndex} />
                </>
              ) : (
                <SessionSetup
                  defaultFocusMin={preferences?.focusDurationMin ?? 25}
                  defaultCycles={preferences?.cyclesBeforeLongBreak ?? 4}
                  cyclesBeforeLongBreak={preferences?.cyclesBeforeLongBreak ?? 4}
                  isSubmitting={isMutating}
                  onStartSession={handleStartSession}
                />
              )}

              <TasksPanel
                tasks={tasks}
                counts={taskCounts}
                filteredCount={filteredCount}
                availableTags={availableTags}
                query={taskQuery}
                isBusy={isMutating}
                onQueryChange={(next) => void handleTaskQueryChange(next)}
                onCreateTask={handleCreateTask}
                onToggleComplete={handleToggleTaskComplete}
                onUpdateTask={handleUpdateTask}
                onDeleteTask={handleDeleteTask}
              />
            </div>

            <aside className="flex flex-col gap-5">
              <AudioPlayer
                tracks={tracks}
                selectedTrackId={ambientAudio.selectedTrackId}
                isPlaying={ambientAudio.isPlaying}
                isMuted={ambientAudio.isMuted}
                localScale={ambientAudio.localScale}
                policyVolume={ambientAudio.policyVolume}
                effectiveTargetVolume={ambientAudio.effectiveTargetVolume}
                volumePolicy={volumePolicy}
                activePhaseType={activePhaseType}
                audioError={ambientAudio.audioError}
                onSelectTrack={ambientAudio.selectTrack}
                onTogglePlay={ambientAudio.togglePlay}
                onToggleMute={ambientAudio.toggleMute}
                onChangeLocalScale={ambientAudio.setLocalVolumeScale}
              />

              <MiniSearchPanel
                engines={searchEngines}
                history={searchHistory}
                lastResponse={lastSearchResponse}
                isSearching={isSearching}
                searchError={searchError}
                onSearch={handleSearch}
                onDeleteHistoryEntry={handleDeleteSearchHistoryEntry}
                onClearHistory={handleClearSearchHistory}
              />

              <section
                className="rounded-2xl border border-edge bg-surface p-6 shadow-sm"
                aria-labelledby="security-status-heading"
              >
                <h2 id="security-status-heading" className="text-base font-bold text-heading">
                  Seguridad activa
                </h2>
                <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs text-muted">
                  <li>Validación estricta Zod en entradas, caché offline y respuestas</li>
                  <li>Sanitización anti-XSS, anti-traversal y anti-prototype pollution</li>
                  <li>Enlaces externos restringidos a http/https con noopener noreferrer</li>
                  <li>CSP estricta en build sin scripts ni estilos inline</li>
                </ul>
              </section>
            </aside>
          </div>
        )}
      </main>

      {showPrefsModal && preferences && (
        <PreferencesModal
          preferences={preferences}
          currentTheme={appTheme}
          isSaving={isMutating}
          onClose={() => setShowPrefsModal(false)}
          onSelectTheme={applyLocalTheme}
          onSave={handleSavePreferences}
          onRequestNotificationPermission={requestNotificationPermission}
        />
      )}

      {showIdentityModal && (
        <DeviceIdentityModal
          deviceId={deviceId}
          isSubmitting={isBootstrapping}
          onClose={() => setShowIdentityModal(false)}
          onRecoverDevice={handleRecoverDevice}
          onResetNewDevice={handleResetNewDevice}
        />
      )}
    </div>
  );
}

export default App;
