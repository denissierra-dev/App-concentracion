import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiClient,
  ApiClientError,
  generateUuid,
  type AuthCredential,
  type ControlOptions,
} from './api/client';
import { AccountModal } from './components/AccountModal';
import { ActiveSessionRunner } from './components/ActiveSessionRunner';
import { AudioPlayer } from './components/AudioPlayer';
import { GlassModal } from './components/GlassModal';
import { HeaderBar } from './components/HeaderBar';
import { MiniSearchPanel } from './components/MiniSearchPanel';
import { MobileDock } from './components/MobileDock';
import { PhaseTimeline } from './components/PhaseTimeline';
import { PreferencesModal } from './components/PreferencesModal';
import { SessionSetup } from './components/SessionSetup';
import { StatsModal } from './components/StatsModal';
import { TasksPanel } from './components/TasksPanel';
import { ToastStack, type ToastItem, type ToastTone } from './components/ToastStack';
import { applyOfflineSessionControl, deriveTimerSnapshot, getPhaseLabel } from './domain/sessionClock';
import { toBackendTheme } from './domain/themes';
import type {
  AppTheme,
  AudioTrack,
  AuthProvidersResponse,
  AuthSessionEntry,
  PhaseType,
  Preference,
  PriorityLevel,
  PublicUser,
  QueuedSyncEvent,
  SearchEngine,
  SearchEngineInfo,
  SearchHistoryEntry,
  SearchResponse,
  Session,
  StatsDashboardResponse,
  StatsExportFormat,
  Task,
  TaskCounts,
  TaskQueryParams,
  ThemePreference,
  UserTaskPriority,
  VolumePolicy,
} from './domain/types';
import { useAmbientAudio } from './hooks/useAmbientAudio';
import { useLocalChime } from './hooks/useLocalChime';
import { getGoogleRedirectUri, startGoogleOAuthRedirect } from './security/pkce';
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

const PRIORITY_WEIGHT: Record<PriorityLevel, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

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

function deriveUniqueTags(tasks: Task[]): string[] {
  const seen = new Map<string, string>();
  for (const task of tasks) {
    for (const tag of task.tags) {
      const normalized = tag.trim().toLowerCase();
      if (normalized && !seen.has(normalized)) {
        seen.set(normalized, tag.trim());
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, 'es'));
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function filterAndSortTasksLocally(
  tasks: Task[],
  query: TaskQueryParams,
  nowMs: number
): Task[] {
  const filtered = tasks.filter((task) => {
    if (query.status === 'pending' && task.completed) return false;
    if (query.status === 'completed' && !task.completed) return false;
    if (query.priority && task.effectivePriority !== query.priority) return false;
    if (query.tag && !task.tags.some((t) => t.toLowerCase() === query.tag!.toLowerCase())) {
      return false;
    }
    if (query.overdue === true && (!task.dueAt || task.dueAt >= nowMs || task.completed)) {
      return false;
    }
    if (query.overdue === false && task.dueAt && task.dueAt < nowMs && !task.completed) {
      return false;
    }
    if (query.hasDueDate === true && task.dueAt === null) return false;
    if (query.hasDueDate === false && task.dueAt !== null) return false;
    if (query.search) {
      const q = query.search.toLowerCase();
      const inTitle = task.title.toLowerCase().includes(q);
      const inDesc = (task.description ?? '').toLowerCase().includes(q);
      if (!inTitle && !inDesc) return false;
    }
    return true;
  });

  const sortBy = query.sortBy ?? 'default';
  const dir = query.sortOrder === 'asc' ? 1 : -1;

  return [...filtered].sort((a, b) => {
    if (sortBy === 'priority') {
      return (PRIORITY_WEIGHT[a.effectivePriority] - PRIORITY_WEIGHT[b.effectivePriority]) * dir;
    }
    if (sortBy === 'dueAt') {
      if (a.dueAt === null && b.dueAt === null) return 0;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return (a.dueAt - b.dueAt) * dir;
    }
    if (sortBy === 'createdAt') {
      return (a.createdAt - b.createdAt) * dir;
    }
    if (sortBy === 'updatedAt') {
      return (a.updatedAt - b.updatedAt) * dir;
    }
    // Default server ordering: pending first -> priority DESC -> dueAt ASC nulls last -> createdAt DESC
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const prioDiff = PRIORITY_WEIGHT[b.effectivePriority] - PRIORITY_WEIGHT[a.effectivePriority];
    if (prioDiff !== 0) return prioDiff;
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt - b.dueAt;
    }
    return b.createdAt - a.createdAt;
  });
}

export function App() {
  const [authToken, setAuthToken] = useState<string | null>(() => safeStorage.getAuthToken());
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [authProviders, setAuthProviders] = useState<AuthProvidersResponse['providers'] | null>(
    null
  );
  const [authSessions, setAuthSessions] = useState<AuthSessionEntry[]>([]);
  const [isLoadingAuthSessions, setIsLoadingAuthSessions] = useState<boolean>(false);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState<boolean>(false);
  const [accountModalError, setAccountModalError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(() => safeStorage.getDeviceId());
  const [appTheme, setAppTheme] = useState<AppTheme>(() => safeStorage.getThemePalette() ?? 'system');
  const [preferences, setPreferences] = useState<Preference | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [activePhaseType, setActivePhaseType] = useState<PhaseType | null>(null);
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
  const [serverOnline, setServerOnline] = useState<boolean>(false);
  const [isBootstrapping, setIsBootstrapping] = useState<boolean>(true);
  const [isMutating, setIsMutating] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

type ActiveModal = 'prefs' | 'identity' | 'audio' | 'timeline' | 'search' | 'stats' | null;

  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [statsData, setStatsData] = useState<StatsDashboardResponse | null>(null);
  const [statsDays, setStatsDays] = useState<number>(30);
  const [isLoadingStats, setIsLoadingStats] = useState<boolean>(false);
  const [isExportingStats, setIsExportingStats] = useState<boolean>(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [isStageCrossfading, setIsStageCrossfading] = useState<boolean>(false);

  const { playTransitionChime, notifyLocal, requestNotificationPermission } = useLocalChime();
  const completedReconcileInFlightRef = useRef<string | null>(null);
  const flushingQueueRef = useRef<boolean>(false);
  const authEpochRef = useRef<number>(0);
  const clockOffsetMsRef = useRef<number>(0);
  const prevHasSessionRef = useRef<boolean | null>(null);

  const authTokenRef = useRef<string | null>(authToken);
  authTokenRef.current = authToken;
  const currentUserRef = useRef<PublicUser | null>(currentUser);
  currentUserRef.current = currentUser;
  const authProvidersRef = useRef<AuthProvidersResponse['providers'] | null>(authProviders);
  authProvidersRef.current = authProviders;
  const statsDaysRef = useRef<number>(statsDays);
  statsDaysRef.current = statsDays;
  const activeDeviceIdRef = useRef<string | null>(deviceId);
  activeDeviceIdRef.current = deviceId;
  const sessionRef = useRef<Session | null>(session);
  sessionRef.current = session;
  const preferencesRef = useRef<Preference | null>(preferences);
  preferencesRef.current = preferences;
  const taskQueryRef = useRef<TaskQueryParams>(taskQuery);
  taskQueryRef.current = taskQuery;
  const tasksRef = useRef<Task[]>(tasks);
  tasksRef.current = tasks;
  const taskCountsRef = useRef<TaskCounts>(taskCounts);
  taskCountsRef.current = taskCounts;

  const getAuthCredential = useCallback((): AuthCredential => {
    const token = authTokenRef.current;
    const devId = activeDeviceIdRef.current;
    if (!token && !devId) {
      return null;
    }
    return { token, deviceId: devId };
  }, []);

  const getStorageKey = useCallback((): string | null => {
    return currentUserRef.current?.id ?? activeDeviceIdRef.current;
  }, []);

  const getServerNowMs = useCallback(() => Date.now() + clockOffsetMsRef.current, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback((message: string, tone: ToastTone = 'info') => {
    const safeMsg = sanitizePlainText(message, 220);
    if (!safeMsg) {
      return;
    }
    setToasts((prev) => {
      const deduped = prev.filter((item) => item.message !== safeMsg);
      return [...deduped.slice(-3), { id: generateUuid(), message: safeMsg, tone }];
    });
  }, []);

  const setBannerError = useCallback(
    (message: string | null) => {
      if (message) {
        pushToast(message, 'error');
      }
    },
    [pushToast]
  );

  const setLastCompletedSummary = useCallback(
    (message: string | null) => {
      if (message) {
        pushToast(message, 'success');
      }
    },
    [pushToast]
  );

  const clearInMemoryUserState = useCallback(() => {
    authEpochRef.current += 1;
    activeDeviceIdRef.current = null;
    currentUserRef.current = null;
    setCurrentUser(null);
    setAuthSessions([]);
    setAccountModalError(null);
    setDeviceId(null);
    setSession(null);
    setActivePhaseType(null);
    setPreferences(null);
    setTasks([]);
    setTaskCounts(EMPTY_COUNTS);
    setFilteredCount(undefined);
    setAvailableTags([]);
    setPendingQueue([]);
    setSearchHistory([]);
    setLastSearchResponse(null);
    setLastCompletedSummary(null);
    setStatsData(null);
    setStatsError(null);
    setActiveModal(null);
  }, []);

  const applyServerTime = useCallback((serverTimeMs: number) => {
    const offset = serverTimeMs - Date.now();
    clockOffsetMsRef.current = offset;
    setClockOffsetMs(offset);
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

  const refreshTaskTags = useCallback(async (auth: AuthCredential) => {
    try {
      const tagsRes = await apiClient.getTaskTags(auth);
      setAvailableTags(tagsRes.tags);
    } catch {
      // Non-critical if offline
    }
  }, []);

  const pullFullState = useCallback(
    async (auth: AuthCredential, storageKey: string) => {
      const syncState = await apiClient.getSyncState(auth);
      if (getStorageKey() && getStorageKey() !== storageKey) {
        return syncState;
      }
      applyServerTime(syncState.serverTimeMs);
      setSession(syncState.activeSession);
      if (!syncState.activeSession) {
        setActivePhaseType(null);
      }
      setPreferences(syncState.preferences);
      if (!safeStorage.getThemePalette() && syncState.preferences) {
        setAppTheme(syncState.preferences.theme);
      }
      setTaskCounts(syncState.taskCounts);
      setAvailableTags(deriveUniqueTags(syncState.tasks));
      setServerOnline(true);

      await persistSnapshot(
        storageKey,
        syncState.activeSession,
        syncState.preferences,
        syncState.tasks,
        syncState.taskCounts,
        syncState.serverTimeMs
      );

      if (hasActiveTaskQuery(taskQueryRef.current)) {
        const filtered = filterAndSortTasksLocally(
          syncState.tasks,
          taskQueryRef.current,
          syncState.serverTimeMs
        );
        setTasks(filtered);
        setFilteredCount(filtered.length);
      } else {
        setTasks(syncState.tasks);
        setFilteredCount(undefined);
      }

      return syncState;
    },
    [applyServerTime, getStorageKey, persistSnapshot]
  );

  const flushSyncQueue = useCallback(
    async (auth: AuthCredential, storageKey: string): Promise<boolean> => {
      if (flushingQueueRef.current) {
        return false;
      }

      const epoch = authEpochRef.current;
      const queued = await syncStore.loadQueue(storageKey);
      if (authEpochRef.current !== epoch || queued.length === 0) {
        if (authEpochRef.current === epoch) {
          setPendingQueue([]);
        }
        return false;
      }

      flushingQueueRef.current = true;
      try {
        const batch = queued.slice(0, 100);
        const res = await apiClient.postSyncBatch(auth, batch);
        if (authEpochRef.current !== epoch) {
          return false;
        }
        const remaining = queued.slice(batch.length);
        await syncStore.saveQueue(storageKey, remaining);
        if (authEpochRef.current !== epoch) {
          return false;
        }
        setPendingQueue(remaining);

        applyServerTime(res.snapshot.serverTimeMs);
        setServerOnline(true);

        const hasConflict = res.results.some((r) => r.status === 'conflict');
        if (hasConflict) {
          setBannerError('Tu sesión cambió en otro dispositivo; se actualizó el estado.');
        }

        await pullFullState(auth, storageKey);
        return true;
      } catch (err) {
        if (authEpochRef.current === epoch && err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
        }
        return false;
      } finally {
        flushingQueueRef.current = false;
      }
    },
    [applyServerTime, pullFullState]
  );

  const loadWorkspaceData = useCallback(
    async (auth: AuthCredential, storageKey: string, epoch: number) => {
      const flushed = await flushSyncQueue(auth, storageKey);
      if (authEpochRef.current !== epoch) {
        return;
      }
      if (!flushed) {
        await pullFullState(auth, storageKey);
      }

      const [audioRes, enginesRes, historyRes] = await Promise.all([
        apiClient.getAudioTracks(auth),
        apiClient.getSearchEngines(auth),
        apiClient.getSearchHistory(auth, { limit: 20 }),
      ]);
      if (authEpochRef.current !== epoch) {
        return;
      }
      setTracks(audioRes.tracks);
      setVolumePolicy(audioRes.volumePolicy);
      setSearchEngines(enginesRes.engines);
      setSearchHistory(historyRes.history);
    },
    [flushSyncQueue, pullFullState]
  );

  const bootstrapForDevice = useCallback(
    async (candidateDeviceId?: string) => {
      const epoch = ++authEpochRef.current;
      setIsBootstrapping(true);
      setBannerError(null);

      const storedId = candidateDeviceId ?? safeStorage.getDeviceId();
      const storedToken = candidateDeviceId ? null : safeStorage.getAuthToken();
      if (candidateDeviceId) {
        safeStorage.clearAuthToken();
        setAuthToken(null);
        setCurrentUser(null);
      }

      if (storedId) {
        activeDeviceIdRef.current = storedId;
        const [cached, queued] = await Promise.all([
          syncStore.loadSnapshot(storedId),
          syncStore.loadQueue(storedId),
        ]);
        if (authEpochRef.current !== epoch) {
          return;
        }
        setPendingQueue(queued);
        if (cached) {
          setSession(cached.activeSession);
          setPreferences(cached.preferences);
          setTasks(cached.tasks);
          setTaskCounts(cached.taskCounts);
          setAvailableTags(deriveUniqueTags(cached.tasks));
        } else {
          setSession(null);
          setActivePhaseType(null);
          setPreferences(null);
          setTasks([]);
          setTaskCounts(EMPTY_COUNTS);
          setFilteredCount(undefined);
          setAvailableTags([]);
        }
      }

      try {
        const [, timeRes, providersRes] = await Promise.all([
          apiClient.checkHealth(),
          apiClient.getServerTime(),
          apiClient.getAuthProviders().catch(() => null),
        ]);
        if (authEpochRef.current !== epoch) {
          return;
        }
        applyServerTime(timeRes.serverTimeMs);
        setServerOnline(true);
        if (providersRes) {
          setAuthProviders(providersRes.providers);
        }

        // Check for Google OAuth2 Authorization Code + PKCE callback
        let resolvedUser: PublicUser | null = null;
        let activeToken = storedToken;
        let resolvedDeviceId = storedId;

        const currentUrl = new URL(window.location.href);
        const oauthCode = currentUrl.searchParams.get('code');
        const oauthState = currentUrl.searchParams.get('state');
        const oauthError = currentUrl.searchParams.get('error');

        if (currentUrl.pathname === '/auth/callback' || oauthCode || oauthError) {
          window.history.replaceState({}, '', '/');
          const pendingPkce = safeStorage.getGooglePkce();
          safeStorage.clearGooglePkce();

          if (oauthError) {
            setBannerError('Inicio de sesión con Google cancelado.');
          } else if (oauthCode && oauthState && pendingPkce && pendingPkce.state === oauthState) {
            if (pendingPkce.mode === 'link') {
              const linkRes = await apiClient.linkGoogle(
                { token: activeToken, deviceId: resolvedDeviceId },
                {
                  code: oauthCode,
                  codeVerifier: pendingPkce.codeVerifier,
                  redirectUri: getGoogleRedirectUri(),
                }
              );
              resolvedUser = linkRes.user;
              pushToast('Cuenta de Google vinculada.', 'success');
            } else {
              const googleRes = await apiClient.googleAuth({
                code: oauthCode,
                codeVerifier: pendingPkce.codeVerifier,
                redirectUri: getGoogleRedirectUri(),
                rememberMe: pendingPkce.rememberMe,
              });
              activeToken = googleRes.token;
              safeStorage.setAuthToken(googleRes.token, pendingPkce.rememberMe);
              setAuthToken(googleRes.token);
              resolvedUser = googleRes.user;
              pushToast('Sesión iniciada con Google.', 'success');
            }
          } else if (oauthCode || oauthState) {
            setBannerError('La verificación de Google expiró. Intenta nuevamente.');
          }
        }

        if (!resolvedUser) {
          try {
            const me = await apiClient.getMe({
              token: activeToken,
              deviceId: resolvedDeviceId,
            });
            resolvedUser = me.user;
          } catch (err) {
            if (err instanceof ApiClientError && err.status === 401) {
              if (activeToken) {
                safeStorage.clearAuthToken();
                activeToken = null;
                setAuthToken(null);
              }
              const registered = await apiClient.registerDevice(resolvedDeviceId ?? undefined);
              resolvedDeviceId = registered.deviceId;
              const meAfterGuest = await apiClient.getMe({ deviceId: resolvedDeviceId });
              resolvedUser = meAfterGuest.user;
            } else {
              throw err;
            }
          }
        }

        if (authEpochRef.current !== epoch) {
          return;
        }

        currentUserRef.current = resolvedUser;
        setCurrentUser(resolvedUser);
        if (resolvedUser.deviceId) {
          resolvedDeviceId = resolvedUser.deviceId;
          activeDeviceIdRef.current = resolvedDeviceId;
          safeStorage.setDeviceId(resolvedDeviceId);
          setDeviceId(resolvedDeviceId);
        } else {
          activeDeviceIdRef.current = resolvedDeviceId;
        }

        const storageKey = resolvedUser.id ?? resolvedDeviceId;
        if (storageKey) {
          const authCred: AuthCredential = {
            token: activeToken,
            deviceId: resolvedDeviceId,
          };
          await loadWorkspaceData(authCred, storageKey, epoch);
        }
      } catch (err) {
        if (authEpochRef.current !== epoch) {
          return;
        }
        setServerOnline(false);
        setBannerError(formatError(err));
      } finally {
        if (authEpochRef.current === epoch) {
          setIsBootstrapping(false);
        }
      }
    },
    [applyServerTime, formatError, loadWorkspaceData]
  );

  useEffect(() => {
    void bootstrapForDevice();
  }, [bootstrapForDevice]);

  // Apply theme attribute to root HTML element (zero inline styles)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', appTheme);
  }, [appTheme]);

  // Flush pending offline queue on reconnect, visibilitychange, and hourly backup
  useEffect(() => {
    const scopeKey = currentUser?.id ?? deviceId;
    if (!scopeKey) {
      return;
    }

    const handleOnline = () => {
      const auth = getAuthCredential();
      if (auth) {
        void flushSyncQueue(auth, scopeKey);
      }
    };

    const handleVisibility = () => {
      const auth = getAuthCredential();
      if (!auth) {
        return;
      }
      void flushSyncQueue(auth, scopeKey).then((didFlush) => {
        const currentSession = sessionRef.current;
        if (
          !didFlush &&
          document.visibilityState === 'visible' &&
          currentSession?.status === 'active'
        ) {
          void apiClient
            .getSessionState(auth, currentSession.id)
            .then((res) => {
              applyServerTime(res.serverTimeMs);
              if (res.session?.status === 'completed' || res.session?.status === 'reset') {
                setSession(null);
                setActivePhaseType(null);
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
      const auth = getAuthCredential();
      if (auth) {
        void flushSyncQueue(auth, scopeKey);
      }
    }, HOURLY_BACKUP_SYNC_MS);

    return () => {
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(hourlyId);
    };
  }, [currentUser?.id, deviceId, flushSyncQueue, getAuthCredential, applyServerTime]);

  const ambientAudio = useAmbientAudio({
    tracks,
    volumePolicy,
    activePhaseType,
  });

  const handlePhaseTransition = useCallback(
    (event: {
      phaseType: PhaseType | null;
      isTransition: boolean;
      isPlanCompleted: boolean;
      cycleNumber: number | null;
    }) => {
      setActivePhaseType(event.phaseType);
      if (!event.isTransition) {
        return;
      }

      const notificationsOn = preferencesRef.current?.notificationsEnabled ?? true;
      if (event.isPlanCompleted) {
        playTransitionChime('completed');
        notifyLocal(
          'Sesión completada',
          'Terminaste todos los ciclos planificados.',
          notificationsOn
        );
      } else if (event.phaseType) {
        playTransitionChime(event.phaseType);
        const label = getPhaseLabel(event.phaseType);
        notifyLocal(
          `Fase: ${label}`,
          `Ciclo ${event.cycleNumber ?? 1} iniciado.`,
          notificationsOn
        );
      }
    },
    [playTransitionChime, notifyLocal]
  );

  const handlePlanCompleted = useCallback(
    (completedSessionId: string) => {
      const auth = getAuthCredential();
      if (!auth || completedReconcileInFlightRef.current === completedSessionId) {
        return;
      }

      const epoch = authEpochRef.current;
      completedReconcileInFlightRef.current = completedSessionId;
      void apiClient
        .getSessionState(auth, completedSessionId)
        .then((res) => {
          if (authEpochRef.current !== epoch) {
            return;
          }
          applyServerTime(res.serverTimeMs);
          if (res.session && (res.session.status === 'completed' || res.session.status === 'reset')) {
            setSession(null);
            setActivePhaseType(null);
            setLastCompletedSummary('¡Sesión completada!');
          } else {
            setSession(res.session);
          }
        })
        .catch(() => {
          // Keep local state if offline; user retains control
        })
        .finally(() => {
          completedReconcileInFlightRef.current = null;
        });
    },
    [applyServerTime, getAuthCredential]
  );

  const handleStartSession = useCallback(
    async (focusDurationMin: number, totalCycles: number) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
        return;
      }
      setIsMutating(true);
      setBannerError(null);
      setLastCompletedSummary(null);

      try {
        const res = await apiClient.createSession(auth, {
          focusDurationMin,
          totalCycles,
        });
        applyServerTime(res.serverTimeMs);
        setSession(res.session);
        setServerOnline(true);
        await persistSnapshot(
          storageKey,
          res.session,
          preferencesRef.current,
          tasksRef.current,
          taskCountsRef.current,
          res.serverTimeMs
        );
      } catch (err) {
        if (err instanceof ApiClientError && err.code === 'ACTIVE_SESSION_EXISTS') {
          await pullFullState(auth, storageKey);
        }
        setBannerError(formatError(err));
      } finally {
        setIsMutating(false);
      }
    },
    [applyServerTime, formatError, getAuthCredential, getStorageKey, persistSnapshot, pullFullState]
  );

  const runSessionControl = useCallback(
    async (
      eventType:
        | 'SESSION_PAUSED'
        | 'SESSION_RESUMED'
        | 'PHASE_SKIPPED'
        | 'SESSION_RESET'
        | 'SESSION_ENDED',
      action: (
        auth: AuthCredential,
        sId: string,
        opts: ControlOptions
      ) => Promise<{ session: Session; serverTimeMs: number }>,
      closeOnTerminal: boolean,
      terminalMessage?: string
    ) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      const currentSession = sessionRef.current;
      if (!auth || !storageKey || !currentSession) {
        return;
      }
      setIsMutating(true);
      setBannerError(null);

      const eventId = generateUuid();
      const expectedVersion = currentSession.version;

      try {
        const res = await action(auth, currentSession.id, { eventId, expectedVersion });
        applyServerTime(res.serverTimeMs);
        setServerOnline(true);

        const isTerminal =
          closeOnTerminal &&
          (res.session.status === 'completed' || res.session.status === 'reset');
        const nextSession = isTerminal ? null : res.session;
        setSession(nextSession);
        if (!nextSession) {
          setActivePhaseType(null);
        }
        if (isTerminal && terminalMessage) {
          setLastCompletedSummary(terminalMessage);
        }
        await persistSnapshot(
          storageKey,
          nextSession,
          preferencesRef.current,
          tasksRef.current,
          taskCountsRef.current,
          res.serverTimeMs
        );
      } catch (err) {
        if (err instanceof ApiClientError && err.code === 'VERSION_CONFLICT') {
          await pullFullState(auth, storageKey);
          setBannerError('La sesión cambió en otro dispositivo; se actualizó el estado.');
        } else if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const nowMs = getServerNowMs();
          const queued = await syncStore.enqueueEvent(storageKey, {
            eventId,
            entityType: 'session',
            entityId: currentSession.id,
            eventType,
            expectedVersion,
            clientTimestamp: Date.now(),
            payload: {},
          });
          setPendingQueue(queued);

          const nextOfflineSession = applyOfflineSessionControl(currentSession, eventType, nowMs);
          setSession(nextOfflineSession);
          if (!nextOfflineSession) {
            setActivePhaseType(null);
          }
          await persistSnapshot(
            storageKey,
            nextOfflineSession,
            preferencesRef.current,
            tasksRef.current,
            taskCountsRef.current,
            nowMs
          );
        } else {
          setBannerError(formatError(err));
        }
      } finally {
        setIsMutating(false);
      }
    },
    [
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      persistSnapshot,
      pullFullState,
    ]
  );

  const handlePauseSession = useCallback(
    () => runSessionControl('SESSION_PAUSED', apiClient.pauseSession, false),
    [runSessionControl]
  );

  const handleResumeSession = useCallback(
    () => runSessionControl('SESSION_RESUMED', apiClient.resumeSession, false),
    [runSessionControl]
  );

  const handleSkipPhase = useCallback(
    () =>
      runSessionControl(
        'PHASE_SKIPPED',
        apiClient.skipPhase,
        true,
        'Última fase saltada; sesión completada.'
      ),
    [runSessionControl]
  );

  const handleEndSession = useCallback(
    () =>
      runSessionControl('SESSION_ENDED', apiClient.endSession, true, 'Sesión finalizada.'),
    [runSessionControl]
  );

  const handleResetSession = useCallback(
    () =>
      runSessionControl(
        'SESSION_RESET',
        apiClient.resetSession,
        true,
        'Sesión reiniciada.'
      ),
    [runSessionControl]
  );

  // Keyboard shortcuts (Phase 9 UX polish): stable listener (no 250ms re-registration)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const currentSession = sessionRef.current;
      if (e.code === 'Space' && currentSession && activeModal === null && !isMutating) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          tag === 'button' ||
          tag === 'a' ||
          target?.isContentEditable ||
          document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')
        ) {
          return;
        }
        e.preventDefault();
        if (currentSession.status === 'active') {
          void handlePauseSession();
        } else if (currentSession.status === 'paused') {
          void handleResumeSession();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, isMutating, handlePauseSession, handleResumeSession]);

  useEffect(() => {
    if (!session && activeModal === 'timeline') {
      setActiveModal(null);
    }
  }, [session, activeModal]);

  const handleSyncState = useCallback(async () => {
    const auth = getAuthCredential();
    const storageKey = getStorageKey();
    if (!auth || !storageKey) {
      return;
    }
    setIsMutating(true);
    setBannerError(null);

    try {
      const flushed = await flushSyncQueue(auth, storageKey);
      if (!flushed) {
        await pullFullState(auth, storageKey);
      }
    } catch (err) {
      setBannerError(formatError(err));
    } finally {
      setIsMutating(false);
    }
  }, [flushSyncQueue, formatError, getAuthCredential, getStorageKey, pullFullState]);

  const handleRefreshSync = useCallback(() => {
    if (getStorageKey()) {
      void handleSyncState();
    } else {
      void bootstrapForDevice();
    }
  }, [bootstrapForDevice, getStorageKey, handleSyncState]);

  // --- Phase 6.0 Server-Side Task Filter/Sort Handler ---

  const handleTaskQueryChange = useCallback(
    async (nextQuery: TaskQueryParams) => {
      setTaskQuery(nextQuery);
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
        return;
      }

      try {
        const res = await apiClient.getTasks(auth, nextQuery);
        applyServerTime(res.serverTimeMs);
        setServerOnline(true);
        setTasks(res.tasks);
        setTaskCounts(res.counts);
        setFilteredCount(hasActiveTaskQuery(nextQuery) ? res.filteredCount : undefined);

        if (!hasActiveTaskQuery(nextQuery)) {
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            res.tasks,
            res.counts,
            res.serverTimeMs
          );
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const cached = await syncStore.loadSnapshot(storageKey);
          if (cached) {
            const filtered = filterAndSortTasksLocally(
              cached.tasks,
              nextQuery,
              getServerNowMs()
            );
            setTasks(filtered);
            setFilteredCount(hasActiveTaskQuery(nextQuery) ? filtered.length : undefined);
          }
        } else {
          setBannerError(formatError(err));
        }
      }
    },
    [applyServerTime, formatError, getAuthCredential, getServerNowMs, getStorageKey, persistSnapshot]
  );

  // --- Tasks CRUD Handlers (Phase 5 + 6.0) ---

  const handleCreateTask = useCallback(
    async (input: {
      title: string;
      description: string | null;
      userPriority: UserTaskPriority;
      tags: string[];
      dueAt: number | null;
    }) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
        return;
      }
      setBannerError(null);
      const taskId = generateUuid();
      const eventId = generateUuid();
      const now = Date.now();

      const optimisticTask: Task = {
        id: taskId,
        userId: storageKey,
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
          auth,
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
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            latestTasks,
            res.counts,
            res.serverTimeMs
          );
        }
        if (res.task.tags.length > 0) {
          void refreshTaskTags(auth);
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const queued = await syncStore.enqueueEvent(storageKey, {
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
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            tasksRef.current,
            taskCountsRef.current,
            getServerNowMs()
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
    },
    [
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      handleTaskQueryChange,
      persistSnapshot,
      refreshTaskTags,
    ]
  );

  const handleToggleTaskComplete = useCallback(
    async (task: Task) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
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
          auth,
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
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            latestTasks,
            res.counts,
            res.serverTimeMs
          );
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const queued = await syncStore.enqueueEvent(storageKey, {
            eventId,
            entityType: 'task',
            entityId: task.id,
            eventType: 'TASK_UPDATED',
            clientTimestamp: now,
            payload: { completed: nextCompleted },
          });
          setPendingQueue(queued);
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            tasksRef.current,
            taskCountsRef.current,
            getServerNowMs()
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
    },
    [
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      handleTaskQueryChange,
      persistSnapshot,
    ]
  );

  const handleUpdateTask = useCallback(
    async (
      taskId: string,
      patch: {
        title: string;
        description: string | null;
        userPriority: UserTaskPriority;
        tags: string[];
        dueAt: number | null;
      }
    ) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
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
        const res = await apiClient.updateTask(auth, taskId, patch, eventId);
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
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            latestTasks,
            res.counts,
            res.serverTimeMs
          );
        }
        if (!tagsEqual(previousTask?.tags ?? [], res.task.tags)) {
          void refreshTaskTags(auth);
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const queued = await syncStore.enqueueEvent(storageKey, {
            eventId,
            entityType: 'task',
            entityId: taskId,
            eventType: 'TASK_UPDATED',
            clientTimestamp: now,
            payload: patch,
          });
          setPendingQueue(queued);
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            tasksRef.current,
            taskCountsRef.current,
            getServerNowMs()
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
    },
    [
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      handleTaskQueryChange,
      persistSnapshot,
      refreshTaskTags,
    ]
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
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
        const res = await apiClient.deleteTask(auth, taskId, eventId);
        applyServerTime(res.serverTimeMs);
        setServerOnline(true);
        setTaskCounts(res.counts);
        if (!hasActiveTaskQuery(taskQueryRef.current)) {
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            tasksRef.current,
            res.counts,
            res.serverTimeMs
          );
        }
        if ((deletedTask?.tags.length ?? 0) > 0) {
          void refreshTaskTags(auth);
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const queued = await syncStore.enqueueEvent(storageKey, {
            eventId,
            entityType: 'task',
            entityId: taskId,
            eventType: 'TASK_DELETED',
            clientTimestamp: now,
            payload: {},
          });
          setPendingQueue(queued);
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            preferencesRef.current,
            tasksRef.current,
            taskCountsRef.current,
            getServerNowMs()
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
    },
    [
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      persistSnapshot,
      refreshTaskTags,
    ]
  );

  // --- Phase 7: Mini Buscador Handlers ---

  const handleSearch = useCallback(
    async (input: {
      q: string;
      engine: SearchEngine;
      lang: string;
      limit: number;
      saveHistory: boolean;
    }) => {
      const auth = getAuthCredential();
      if (!auth) {
        return;
      }
      const epoch = authEpochRef.current;
      setIsSearching(true);
      setSearchError(null);

      try {
        const res = await apiClient.searchWeb(auth, input);
        if (authEpochRef.current !== epoch) {
          return;
        }
        applyServerTime(res.serverTimeMs);
        setLastSearchResponse(res);
        if (res.historyEntry) {
          setSearchHistory((prev) => [
            res.historyEntry!,
            ...prev.filter((item) => item.id !== res.historyEntry!.id),
          ]);
        }
      } catch (err) {
        if (authEpochRef.current === epoch) {
          setSearchError(formatError(err));
        }
      } finally {
        if (authEpochRef.current === epoch) {
          setIsSearching(false);
        }
      }
    },
    [applyServerTime, formatError, getAuthCredential]
  );

  const handleDeleteSearchHistoryEntry = useCallback(
    async (entryId: string) => {
      const auth = getAuthCredential();
      if (!auth) {
        return;
      }
      try {
        await apiClient.deleteSearchHistoryEntry(auth, entryId);
        setSearchHistory((prev) => prev.filter((item) => item.id !== entryId));
      } catch (err) {
        setSearchError(formatError(err));
      }
    },
    [formatError, getAuthCredential]
  );

  const handleClearSearchHistory = useCallback(
    async (engine?: SearchEngine) => {
      const auth = getAuthCredential();
      if (!auth) {
        return;
      }
      try {
        await apiClient.clearSearchHistory(auth, engine);
        setSearchHistory((prev) => (engine ? prev.filter((item) => item.engine !== engine) : []));
      } catch (err) {
        setSearchError(formatError(err));
      }
    },
    [formatError, getAuthCredential]
  );

  const handleSavePreferences = useCallback(
    async (patch: {
      focusDurationMin: number;
      shortBreakMin: number;
      longBreakMin: number;
      cyclesBeforeLongBreak: number;
      volumeFocus: number;
      volumeBreak: number;
      notificationsEnabled: boolean;
      theme: ThemePreference;
    }) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
        return;
      }
      setIsMutating(true);
      setBannerError(null);

      try {
        const res = await apiClient.updatePreferences(auth, patch);
        if (res.serverTimeMs) {
          applyServerTime(res.serverTimeMs);
        }
        if (res.preferences) {
          setPreferences(res.preferences);
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            res.preferences,
            tasksRef.current,
            taskCountsRef.current,
            res.serverTimeMs ?? getServerNowMs()
          );
        }
        const policyRes = await apiClient.getAudioPolicy(auth);
        setVolumePolicy(policyRes.volumePolicy);
        setActiveModal((prev) => (prev === 'prefs' ? null : prev));
        pushToast('Preferencias guardadas.', 'success');
      } catch (err) {
        setBannerError(formatError(err));
      } finally {
        setIsMutating(false);
      }
    },
    [
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      persistSnapshot,
      pushToast,
      setBannerError,
    ]
  );

  const applyLocalTheme = useCallback((nextTheme: AppTheme) => {
    safeStorage.setThemePalette(nextTheme);
    setAppTheme(nextTheme);
  }, []);

  const handleSelectTheme = useCallback(
    async (nextTheme: AppTheme) => {
      applyLocalTheme(nextTheme);

      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      const currentPrefs = preferencesRef.current;
      const backendTheme = toBackendTheme(nextTheme);
      if (!auth || !storageKey || !currentPrefs || currentPrefs.theme === backendTheme) {
        return;
      }

      const optimisticPrefs: Preference = { ...currentPrefs, theme: backendTheme };
      setPreferences(optimisticPrefs);

      try {
        const res = await apiClient.updatePreferences(auth, { theme: backendTheme });
        if (res.serverTimeMs) {
          applyServerTime(res.serverTimeMs);
        }
        if (res.preferences) {
          setPreferences(res.preferences);
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            res.preferences,
            tasksRef.current,
            taskCountsRef.current,
            res.serverTimeMs ?? getServerNowMs()
          );
        }
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
          const queued = await syncStore.enqueueEvent(storageKey, {
            eventId: generateUuid(),
            entityType: 'preference',
            entityId: storageKey,
            eventType: 'PREFERENCES_UPDATED',
            clientTimestamp: Date.now(),
            payload: { theme: backendTheme },
          });
          setPendingQueue(queued);
          await persistSnapshot(
            storageKey,
            sessionRef.current,
            optimisticPrefs,
            tasksRef.current,
            taskCountsRef.current,
            getServerNowMs()
          );
        } else {
          setPreferences(currentPrefs);
          setBannerError(formatError(err));
        }
      }
    },
    [
      applyLocalTheme,
      applyServerTime,
      formatError,
      getAuthCredential,
      getServerNowMs,
      getStorageKey,
      persistSnapshot,
    ]
  );

  const handleSelectThemeTrigger = useCallback(
    (next: AppTheme) => {
      void handleSelectTheme(next);
    },
    [handleSelectTheme]
  );

  const refreshAuthSessions = useCallback(async (auth: AuthCredential) => {
    const epoch = authEpochRef.current;
    setIsLoadingAuthSessions(true);
    try {
      const res = await apiClient.getAuthSessions(auth);
      if (authEpochRef.current !== epoch) {
        return;
      }
      setAuthSessions(res.sessions);
    } catch {
      if (authEpochRef.current === epoch) {
        setAuthSessions([]);
      }
    } finally {
      if (authEpochRef.current === epoch) {
        setIsLoadingAuthSessions(false);
      }
    }
  }, []);

  const handleOpenIdentity = useCallback(() => {
    setAccountModalError(null);
    setActiveModal('identity');
    const user = currentUserRef.current;
    const auth = getAuthCredential();
    if (user && user.authProvider !== 'device' && auth) {
      void refreshAuthSessions(auth);
    }
  }, [getAuthCredential, refreshAuthSessions]);

  const handleOpenPreferences = useCallback(() => setActiveModal('prefs'), []);
  const handleOpenAudio = useCallback(() => setActiveModal('audio'), []);
  const handleOpenTimeline = useCallback(() => setActiveModal('timeline'), []);
  const handleOpenSearch = useCallback(() => setActiveModal('search'), []);
  const handleCloseModal = useCallback(() => setActiveModal(null), []);

  useEffect(() => {
    if (isBootstrapping) {
      return;
    }
    const hasSession = Boolean(session);
    if (prevHasSessionRef.current !== null && prevHasSessionRef.current !== hasSession) {
      setIsStageCrossfading(true);
      const timerId = window.setTimeout(() => {
        setIsStageCrossfading(false);
      }, 480);
      prevHasSessionRef.current = hasSession;
      return () => window.clearTimeout(timerId);
    }
    prevHasSessionRef.current = hasSession;
    return undefined;
  }, [session, isBootstrapping]);

  const loadStats = useCallback(
    async (targetDays: number) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
        return;
      }
      const epoch = authEpochRef.current;
      setIsLoadingStats(true);
      setStatsError(null);

      try {
        const res = await apiClient.getStats(auth, targetDays);
        if (authEpochRef.current !== epoch || getStorageKey() !== storageKey) {
          return;
        }
        applyServerTime(res.serverTimeMs);
        setServerOnline(true);
        setStatsData(res);
      } catch (err) {
        if (authEpochRef.current !== epoch || getStorageKey() !== storageKey) {
          return;
        }
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
        }
        setStatsError(formatError(err));
      } finally {
        if (authEpochRef.current === epoch) {
          setIsLoadingStats(false);
        }
      }
    },
    [applyServerTime, formatError, getAuthCredential, getStorageKey]
  );

  const handleOpenStats = useCallback(() => {
    setActiveModal('stats');
    void loadStats(statsDaysRef.current);
  }, [loadStats]);

  const handleChangeStatsDays = useCallback(
    (nextDays: number) => {
      statsDaysRef.current = nextDays;
      setStatsDays(nextDays);
      void loadStats(nextDays);
    },
    [loadStats]
  );

  const handleRefreshStats = useCallback(() => {
    void loadStats(statsDaysRef.current);
  }, [loadStats]);

  const handleExportStats = useCallback(
    async (format: StatsExportFormat) => {
      const auth = getAuthCredential();
      const storageKey = getStorageKey();
      if (!auth || !storageKey) {
        return;
      }
      const epoch = authEpochRef.current;
      setIsExportingStats(true);
      setStatsError(null);

      try {
        const result = await apiClient.exportStats(auth, { format, days: statsDaysRef.current });
        if (authEpochRef.current !== epoch || getStorageKey() !== storageKey) {
          return;
        }
        const objectUrl = URL.createObjectURL(result.blob);
        try {
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = result.filename;
          anchor.rel = 'noopener noreferrer';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      } catch (err) {
        if (authEpochRef.current !== epoch || getStorageKey() !== storageKey) {
          return;
        }
        if (err instanceof ApiClientError && err.status === 0) {
          setServerOnline(false);
        }
        setStatsError(formatError(err));
      } finally {
        if (authEpochRef.current === epoch) {
          setIsExportingStats(false);
        }
      }
    },
    [formatError, getAuthCredential, getStorageKey]
  );

  const applyAuthenticatedUser = useCallback(
    async (user: PublicUser, token: string, rememberMe: boolean) => {
      safeStorage.setAuthToken(token, rememberMe);
      setAuthToken(token);
      authTokenRef.current = token;
      clearInMemoryUserState();
      const epoch = authEpochRef.current;
      currentUserRef.current = user;
      setCurrentUser(user);
      if (user.deviceId) {
        activeDeviceIdRef.current = user.deviceId;
        safeStorage.setDeviceId(user.deviceId);
        setDeviceId(user.deviceId);
      }
      setActiveModal((prev) => (prev === 'identity' ? null : prev));
      await loadWorkspaceData(
        { token, deviceId: user.deviceId ?? activeDeviceIdRef.current },
        user.id,
        epoch
      );
    },
    [clearInMemoryUserState, loadWorkspaceData]
  );

  const handleLogin = useCallback(
    async (input: { identifier: string; password: string; rememberMe: boolean }) => {
      setIsAuthSubmitting(true);
      setAccountModalError(null);
      try {
        const res = await apiClient.login(input);
        await applyAuthenticatedUser(res.user, res.token, input.rememberMe);
        pushToast('Sesión iniciada.', 'success');
      } catch (err) {
        setAccountModalError(formatError(err));
      } finally {
        setIsAuthSubmitting(false);
      }
    },
    [applyAuthenticatedUser, formatError, pushToast]
  );

  const handleRegister = useCallback(
    async (input: {
      username: string;
      password: string;
      email?: string | null;
      displayName?: string | null;
      rememberMe: boolean;
    }) => {
      setIsAuthSubmitting(true);
      setAccountModalError(null);
      try {
        const res = await apiClient.register(input);
        await applyAuthenticatedUser(res.user, res.token, input.rememberMe);
        pushToast('Cuenta creada e iniciada.', 'success');
      } catch (err) {
        setAccountModalError(formatError(err));
      } finally {
        setIsAuthSubmitting(false);
      }
    },
    [applyAuthenticatedUser, formatError, pushToast]
  );

  const handleGoogleLogin = useCallback(async (rememberMe: boolean) => {
    const clientId = authProvidersRef.current?.google.clientId;
    if (!clientId) {
      setAccountModalError('Google Sign-In no está configurado.');
      return;
    }
    setAccountModalError(null);
    await startGoogleOAuthRedirect({
      clientId,
      mode: 'login',
      rememberMe,
    });
  }, []);

  const handleLinkGoogle = useCallback(async () => {
    const clientId = authProvidersRef.current?.google.clientId;
    if (!clientId) {
      setAccountModalError('Google Sign-In no está configurado.');
      return;
    }
    setAccountModalError(null);
    await startGoogleOAuthRedirect({
      clientId,
      mode: 'link',
      rememberMe: true,
    });
  }, []);

  const handleLogout = useCallback(async () => {
    const auth = getAuthCredential();
    setIsAuthSubmitting(true);
    setAccountModalError(null);
    try {
      if (auth) {
        await apiClient.logout(auth).catch(() => undefined);
      }
      safeStorage.clearAuthToken();
      setAuthToken(null);
      authTokenRef.current = null;
      clearInMemoryUserState();
      setActiveModal(null);
      pushToast('Sesión cerrada.', 'info');
      await bootstrapForDevice();
    } catch (err) {
      setAccountModalError(formatError(err));
    } finally {
      setIsAuthSubmitting(false);
    }
  }, [bootstrapForDevice, clearInMemoryUserState, formatError, getAuthCredential, pushToast]);

  const handleLogoutAll = useCallback(async () => {
    const auth = getAuthCredential();
    setIsAuthSubmitting(true);
    setAccountModalError(null);
    try {
      if (auth) {
        await apiClient.logoutAll(auth);
      }
      safeStorage.clearAuthToken();
      setAuthToken(null);
      authTokenRef.current = null;
      clearInMemoryUserState();
      setActiveModal(null);
      pushToast('Se cerraron todas las sesiones.', 'info');
      await bootstrapForDevice();
    } catch (err) {
      setAccountModalError(formatError(err));
    } finally {
      setIsAuthSubmitting(false);
    }
  }, [bootstrapForDevice, clearInMemoryUserState, formatError, getAuthCredential, pushToast]);

  const handleRevokeAuthSession = useCallback(
    async (sessionId: string) => {
      const auth = getAuthCredential();
      if (!auth) {
        return;
      }
      setIsAuthSubmitting(true);
      setAccountModalError(null);
      try {
        await apiClient.revokeAuthSession(auth, sessionId);
        setAuthSessions((prev) => prev.filter((item) => item.id !== sessionId));
      } catch (err) {
        setAccountModalError(formatError(err));
      } finally {
        setIsAuthSubmitting(false);
      }
    },
    [formatError, getAuthCredential]
  );

  const handleCloseIdentity = useCallback(
    () => setActiveModal((prev) => (prev === 'identity' ? null : prev)),
    []
  );

  const handleRecoverDevice = useCallback(
    async (uuid: string) => {
      setActiveModal(null);
      clearInMemoryUserState();
      safeStorage.clearAuthToken();
      setAuthToken(null);
      safeStorage.setDeviceId(uuid);
      await bootstrapForDevice(uuid);
    },
    [bootstrapForDevice, clearInMemoryUserState]
  );

  const handleResetNewDevice = useCallback(async () => {
    setActiveModal(null);
    safeStorage.clearAuthToken();
    setAuthToken(null);
    safeStorage.clearDeviceId();
    clearInMemoryUserState();
    await bootstrapForDevice();
  }, [bootstrapForDevice, clearInMemoryUserState]);

  const timelineEffectiveIndex =
    activeModal === 'timeline' && session
      ? (deriveTimerSnapshot(session, getServerNowMs())?.effectiveIndex ?? session.currentIndex)
      : 0;

  return (
    <div className="liquid-canvas flex min-h-screen flex-col text-ink">
      <HeaderBar
        serverOnline={serverOnline}
        clockOffsetMs={clockOffsetMs}
        pendingSyncCount={pendingQueue.length}
        deviceId={deviceId}
        user={currentUser}
        theme={appTheme}
        isAudioPlaying={ambientAudio.isPlaying}
        hasActiveSession={Boolean(session)}
        onSelectTheme={handleSelectThemeTrigger}
        onOpenAudio={handleOpenAudio}
        onOpenTimeline={handleOpenTimeline}
        onOpenSearch={handleOpenSearch}
        onOpenStats={handleOpenStats}
        onOpenAccount={handleOpenIdentity}
        onOpenPreferences={handleOpenPreferences}
        onRefreshSync={handleRefreshSync}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-5 pb-28 sm:px-6 sm:pt-7 md:pb-12">
        {isBootstrapping ? (
          <section
            className="liquid-glass rounded-3xl px-6 py-14 text-center"
            aria-busy="true"
          >
            <p className="text-sm font-medium text-muted">
              Preparando tu espacio de concentración...
            </p>
          </section>
        ) : (
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="grid grid-cols-1 items-start">
              {isStageCrossfading && (
                <div
                  aria-hidden="true"
                  className="liquid-glass liquid-stage-exit pointer-events-none col-start-1 row-start-1 min-h-[28rem] rounded-3xl"
                />
              )}
              <div className="col-start-1 row-start-1 flex flex-col gap-5">
                {session ? (
                  <ActiveSessionRunner
                    session={session}
                    clockOffsetMs={clockOffsetMs}
                    isBusy={isMutating}
                    onPause={handlePauseSession}
                    onResume={handleResumeSession}
                    onSkip={handleSkipPhase}
                    onEnd={handleEndSession}
                    onReset={handleResetSession}
                    onSyncState={handleSyncState}
                    onPhaseTransition={handlePhaseTransition}
                    onPlanCompleted={handlePlanCompleted}
                    onOpenTimeline={handleOpenTimeline}
                  />
                ) : (
                  <SessionSetup
                    defaultFocusMin={preferences?.focusDurationMin ?? 25}
                    defaultShortBreakMin={preferences?.shortBreakMin}
                    defaultLongBreakMin={preferences?.longBreakMin}
                    defaultCycles={preferences?.cyclesBeforeLongBreak ?? 4}
                    cyclesBeforeLongBreak={preferences?.cyclesBeforeLongBreak ?? 4}
                    isSubmitting={isMutating}
                    onStartSession={handleStartSession}
                  />
                )}
              </div>
            </div>

            <div className="flex flex-col gap-5">
              <TasksPanel
                tasks={tasks}
                counts={taskCounts}
                filteredCount={filteredCount}
                availableTags={availableTags}
                query={taskQuery}
                isBusy={isMutating}
                onQueryChange={handleTaskQueryChange}
                onCreateTask={handleCreateTask}
                onToggleComplete={handleToggleTaskComplete}
                onUpdateTask={handleUpdateTask}
                onDeleteTask={handleDeleteTask}
              />
            </div>
          </div>
        )}
      </main>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <MobileDock
        isAudioPlaying={ambientAudio.isPlaying}
        hasActiveSession={Boolean(session)}
        onOpenAudio={handleOpenAudio}
        onOpenTimeline={handleOpenTimeline}
        onOpenSearch={handleOpenSearch}
        onOpenStats={handleOpenStats}
        onOpenPreferences={handleOpenPreferences}
      />

      {activeModal === 'audio' && (
        <GlassModal
          titleId="audio-modal-title"
          title="Sonido ambiental"
          subtitle="Audio de fondo adaptado a tu fase actual"
          onClose={handleCloseModal}
        >
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
            embedded
            onSelectTrack={ambientAudio.selectTrack}
            onTogglePlay={ambientAudio.togglePlay}
            onToggleMute={ambientAudio.toggleMute}
            onChangeLocalScale={ambientAudio.setLocalVolumeScale}
          />
        </GlassModal>
      )}

      {activeModal === 'timeline' && session && (
        <GlassModal
          titleId="timeline-modal-title"
          title="Planificación de la sesión"
          subtitle="Bloques de enfoque y descanso programados"
          maxWidthClass="max-w-2xl"
          onClose={handleCloseModal}
        >
          <PhaseTimeline plan={session.plan} effectiveIndex={timelineEffectiveIndex} />
        </GlassModal>
      )}

      {activeModal === 'search' && (
        <GlassModal
          titleId="search-modal-title"
          title="Buscador de enfoque"
          maxWidthClass="max-w-2xl"
          placement="top-center"
          onClose={handleCloseModal}
        >
          <MiniSearchPanel
            engines={searchEngines}
            history={searchHistory}
            lastResponse={lastSearchResponse}
            isSearching={isSearching}
            searchError={searchError}
            embedded
            onSearch={handleSearch}
            onDeleteHistoryEntry={handleDeleteSearchHistoryEntry}
            onClearHistory={handleClearSearchHistory}
          />
        </GlassModal>
      )}

      {activeModal === 'prefs' && preferences && (
        <PreferencesModal
          preferences={preferences}
          currentTheme={appTheme}
          isSaving={isMutating}
          onClose={handleCloseModal}
          onSelectTheme={applyLocalTheme}
          onOpenIdentity={handleOpenIdentity}
          onSave={handleSavePreferences}
          onRequestNotificationPermission={requestNotificationPermission}
        />
      )}

      {activeModal === 'identity' && (
        <AccountModal
          user={currentUser}
          deviceId={deviceId}
          providers={authProviders}
          authSessions={authSessions}
          isLoadingSessions={isLoadingAuthSessions}
          isSubmitting={isAuthSubmitting || isBootstrapping}
          externalError={accountModalError}
          onClose={handleCloseIdentity}
          onLogin={handleLogin}
          onRegister={handleRegister}
          onGoogleLogin={handleGoogleLogin}
          onLinkGoogle={handleLinkGoogle}
          onLogout={handleLogout}
          onLogoutAll={handleLogoutAll}
          onRevokeSession={handleRevokeAuthSession}
          onRecoverDevice={handleRecoverDevice}
          onResetNewDevice={handleResetNewDevice}
        />
      )}

      {activeModal === 'stats' && (
        <StatsModal
          stats={statsData}
          days={statsDays}
          isLoading={isLoadingStats}
          isExporting={isExportingStats}
          error={statsError}
          onChangeDays={handleChangeStatsDays}
          onRefresh={handleRefreshStats}
          onExport={(format) => void handleExportStats(format)}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}

export default App;
