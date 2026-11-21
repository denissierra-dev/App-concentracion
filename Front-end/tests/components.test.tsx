import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { apiClient } from '../src/api/client';
import { AccountModal } from '../src/components/AccountModal';
import { ActiveSessionRunner } from '../src/components/ActiveSessionRunner';
import { GlassModal } from '../src/components/GlassModal';
import { HeaderBar } from '../src/components/HeaderBar';
import { MiniSearchPanel } from '../src/components/MiniSearchPanel';
import { MobileDock } from '../src/components/MobileDock';
import { PreferencesModal } from '../src/components/PreferencesModal';
import { SessionSetup } from '../src/components/SessionSetup';
import { StatsModal } from '../src/components/StatsModal';
import { TasksPanel } from '../src/components/TasksPanel';
import { TOAST_AUTO_DISMISS_MS, ToastStack } from '../src/components/ToastStack';
import { APP_THEMES } from '../src/domain/themes';
import { useAmbientAudio } from '../src/hooks/useAmbientAudio';
import { safeStorage } from '../src/security/safeStorage';

describe('UI Components Security & Input Validation', () => {
  it('blocks invalid focus duration in SessionSetup before submitting', async () => {
    const onStartSession = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <SessionSetup
        defaultFocusMin={25}
        defaultCycles={4}
        cyclesBeforeLongBreak={4}
        isSubmitting={false}
        onStartSession={onStartSession}
      />
    );

    const focusInput = screen.getByLabelText(/Duración personalizada/i);
    fireEvent.change(focusInput, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Iniciar sesión/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Mínimo 5 minutos/i);
    expect(onStartSession).not.toHaveBeenCalled();

    // Ensure zero inline style attributes are rendered (strict CSP style-src-attr 'none')
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('rejects XSS and non-UUID payloads in AccountModal guest device recovery tab', async () => {
    const onRecoverDevice = vi.fn().mockResolvedValue(undefined);
    const onResetNewDevice = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    const { container } = render(
      <AccountModal
        user={null}
        deviceId="11111111-1111-4111-8111-111111111111"
        providers={{
          password: { enabled: true },
          google: { enabled: false, codeFlowEnabled: false, clientId: null },
          device: { enabled: true },
        }}
        authSessions={[]}
        isLoadingSessions={false}
        isSubmitting={false}
        onClose={onClose}
        onLogin={vi.fn().mockResolvedValue(undefined)}
        onRegister={vi.fn().mockResolvedValue(undefined)}
        onGoogleLogin={vi.fn().mockResolvedValue(undefined)}
        onLinkGoogle={vi.fn().mockResolvedValue(undefined)}
        onLogout={vi.fn().mockResolvedValue(undefined)}
        onLogoutAll={vi.fn().mockResolvedValue(undefined)}
        onRevokeSession={vi.fn().mockResolvedValue(undefined)}
        onRecoverDevice={onRecoverDevice}
        onResetNewDevice={onResetNewDevice}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Modo invitado/i }));

    const input = screen.getByLabelText(/Recuperar sesión de invitado/i);
    fireEvent.change(input, { target: { value: '<script>alert(1)</script>' } });
    fireEvent.click(screen.getByRole('button', { name: /Recuperar UUID/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Caracteres no permitidos/i);
    expect(onRecoverDevice).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } });
    fireEvent.click(screen.getByRole('button', { name: /Recuperar UUID/i }));

    await waitFor(() => {
      expect(onRecoverDevice).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    });

    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('blocks XSS in TasksPanel and submits valid tasks cleanly', async () => {
    const onCreateTask = vi.fn().mockResolvedValue(undefined);
    const onToggleComplete = vi.fn().mockResolvedValue(undefined);
    const onUpdateTask = vi.fn().mockResolvedValue(undefined);
    const onDeleteTask = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <TasksPanel
        tasks={[]}
        counts={{ total: 0, pending: 0, completed: 0 }}
        availableTags={['api']}
        query={{ status: 'all', sortBy: 'default' }}
        isBusy={false}
        onQueryChange={vi.fn()}
        onCreateTask={onCreateTask}
        onToggleComplete={onToggleComplete}
        onUpdateTask={onUpdateTask}
        onDeleteTask={onDeleteTask}
      />
    );

    const titleInput = screen.getByLabelText(/Título de nueva tarea/i);
    fireEvent.change(titleInput, { target: { value: '<img src=x onerror=alert(1)>' } });
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/No se permiten los caracteres < o >/i);
    expect(onCreateTask).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Prioridad de nueva tarea/i), {
      target: { value: 'HIGH' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Detalles/i }));
    fireEvent.change(screen.getByLabelText(/Etiquetas/i), {
      target: { value: 'api, foco' },
    });
    fireEvent.change(titleInput, { target: { value: 'Revisar contrato API' } });
    fireEvent.click(screen.getByRole('button', { name: /Agregar/i }));

    await waitFor(() => {
      expect(onCreateTask).toHaveBeenCalledWith({
        title: 'Revisar contrato API',
        description: null,
        userPriority: 'HIGH',
        tags: ['api', 'foco'],
        dueAt: null,
      });
    });

    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('blocks XSS in MiniSearchPanel and renders external links with safe rel attributes', async () => {
    const onSearch = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <MiniSearchPanel
        engines={[
          { id: 'wikipedia', name: 'Wikipedia', configured: true, requiresApiKey: false },
          { id: 'stackoverflow', name: 'Stack Overflow', configured: true, requiresApiKey: false },
        ]}
        history={[]}
        lastResponse={{
          engine: 'wikipedia',
          query: 'pomodoro',
          lang: 'es',
          configured: true,
          externalUrl: 'https://es.wikipedia.org/wiki/Pomodoro',
          results: [
            {
              title: 'Técnica Pomodoro',
              url: 'https://es.wikipedia.org/?curid=42100',
              snippet: 'Método de gestión del tiempo.',
              displayUrl: 'es.wikipedia.org',
              engine: 'wikipedia',
            },
          ],
          totalResults: 1,
          notice: null,
          historyEntry: null,
          serverTimeMs: 1700000000000,
        }}
        isSearching={false}
        searchError={null}
        onSearch={onSearch}
        onDeleteHistoryEntry={vi.fn().mockResolvedValue(undefined)}
        onClearHistory={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const link = screen.getByRole('link', { name: /Técnica Pomodoro/i });
    expect(link).toHaveAttribute('href', 'https://es.wikipedia.org/?curid=42100');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');

    const input = screen.getByLabelText(/Consulta de búsqueda rápida/i);
    fireEvent.change(input, { target: { value: '<script>alert(1)</script>' } });
    fireEvent.click(screen.getByRole('button', { name: /^Buscar$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/No se permiten los caracteres < o >/i);
    expect(onSearch).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'deep work' } });
    fireEvent.click(screen.getByRole('button', { name: /^Buscar$/i }));

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledWith({
        q: 'deep work',
        engine: 'wikipedia',
        lang: 'es',
        limit: 10,
        saveHistory: true,
      });
    });

    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('syncs SessionSetup inputs when preference props update', () => {
    const onStartSession = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SessionSetup
        defaultFocusMin={25}
        defaultCycles={4}
        cyclesBeforeLongBreak={4}
        isSubmitting={false}
        onStartSession={onStartSession}
      />
    );

    const focusInput = screen.getByLabelText(/Duración personalizada/i) as HTMLInputElement;
    const cyclesInput = screen.getByLabelText(/Ciclos totales/i) as HTMLInputElement;
    expect(focusInput.value).toBe('25');
    expect(cyclesInput.value).toBe('4');

    rerender(
      <SessionSetup
        defaultFocusMin={50}
        defaultCycles={6}
        cyclesBeforeLongBreak={4}
        isSubmitting={false}
        onStartSession={onStartSession}
      />
    );

    expect(focusInput.value).toBe('50');
    expect(cyclesInput.value).toBe('6');
  });

  it('displays custom shortBreakMin and longBreakMin in SessionSetup preview', () => {
    render(
      <SessionSetup
        defaultFocusMin={25}
        defaultShortBreakMin={8}
        defaultLongBreakMin={25}
        defaultCycles={4}
        cyclesBeforeLongBreak={4}
        isSubmitting={false}
        onStartSession={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText(/8 min/i)).toBeInTheDocument();
    expect(screen.getByText(/Descanso largo:/i)).toHaveTextContent(/25 min/i);
    expect(screen.getByText(/preferencia personalizada/i)).toBeInTheDocument();
  });

  it('edits and submits shortBreakMin and longBreakMin in PreferencesModal', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <PreferencesModal
        preferences={{
          userId: '11111111-1111-4111-8111-111111111111',
          focusDurationMin: 25,
          shortBreakMin: 5,
          longBreakMin: 20,
          cyclesBeforeLongBreak: 4,
          volumeFocus: 0.7,
          volumeBreak: 0.3,
          notificationsEnabled: true,
          theme: 'system',
          updatedAt: 1700000000000,
        }}
        isSaving={false}
        onClose={vi.fn()}
        onSave={onSave}
        onRequestNotificationPermission={vi.fn().mockResolvedValue('granted')}
      />
    );

    fireEvent.change(screen.getByLabelText(/Enfoque predeterminado/i), {
      target: { value: '45' },
    });
    fireEvent.change(screen.getByLabelText(/Descanso corto base/i), {
      target: { value: '8' },
    });
    fireEvent.change(screen.getByLabelText(/Descanso largo \(min\)/i), {
      target: { value: '25' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Guardar preferencias/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        focusDurationMin: 45,
        shortBreakMin: 8,
        longBreakMin: 25,
        cyclesBeforeLongBreak: 4,
        volumeFocus: 0.7,
        volumeBreak: 0.3,
        notificationsEnabled: true,
        theme: 'system',
      });
    });
  });

  it('does not restart playback when switching tracks during fade-out in useAmbientAudio', async () => {
    const playSpy = vi.fn().mockResolvedValue(undefined);
    const pauseSpy = vi.fn();
    const loadSpy = vi.fn();

    const OriginalAudio = window.Audio;
    class MockAudio {
      preload = 'auto';
      loop = false;
      volume = 0;
      src = '';
      play = playSpy;
      pause = pauseSpy;
      load = loadSpy;
      removeAttribute = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }
    Object.defineProperty(window, 'Audio', { configurable: true, value: MockAudio });

    try {
      const tracks = [
        {
          id: 'rain-ambient',
          title: 'Soft Rain',
          category: 'ambient' as const,
          mimeType: 'audio/wav' as const,
          sizeBytes: 1000,
          streamUrl: '/api/v1/audio/tracks/rain-ambient/stream',
        },
        {
          id: 'brown-noise',
          title: 'Deep Brown Noise',
          category: 'noise' as const,
          mimeType: 'audio/wav' as const,
          sizeBytes: 1000,
          streamUrl: '/api/v1/audio/tracks/brown-noise/stream',
        },
      ];

      const { result } = renderHook(() =>
        useAmbientAudio({
          tracks,
          volumePolicy: { focus: 0.7, short_break: 0.3, long_break: 0.3 },
          activePhaseType: 'focus',
        })
      );

      await act(async () => {
        await result.current.togglePlay();
      });
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(result.current.isPlaying).toBe(true);

      // Stop playback (starts fade-out) and immediately switch track
      await act(async () => {
        await result.current.togglePlay();
        result.current.selectTrack('brown-noise');
      });

      expect(result.current.isPlaying).toBe(false);
      // Should NOT have called play() a second time on the new track
      expect(playSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'Audio', { configurable: true, value: OriginalAudio });
    }
  });

  it('lists and selects all color palettes in HeaderBar without inline styles', () => {
    const onSelectTheme = vi.fn();

    const { container } = render(
      <HeaderBar
        serverOnline={true}
        clockOffsetMs={0}
        pendingSyncCount={0}
        deviceId="11111111-1111-4111-8111-111111111111"
        theme="system"
        onSelectTheme={onSelectTheme}
        onOpenIdentity={vi.fn()}
        onOpenPreferences={vi.fn()}
        onRefreshSync={vi.fn()}
      />
    );

    const trigger = screen.getByRole('button', { name: /Seleccionar tema/i });
    fireEvent.click(trigger);

    for (const option of APP_THEMES) {
      expect(
        screen.getByRole('menuitemradio', { name: new RegExp(`^${option.label}\\b`, 'i') })
      ).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Morado\b/i }));
    expect(onSelectTheme).toHaveBeenCalledWith('purple');
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('selects custom color palettes in PreferencesModal while keeping backend theme valid', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onSelectTheme = vi.fn();

    const { container } = render(
      <PreferencesModal
        preferences={{
          userId: '11111111-1111-4111-8111-111111111111',
          focusDurationMin: 25,
          shortBreakMin: 5,
          longBreakMin: 20,
          cyclesBeforeLongBreak: 4,
          volumeFocus: 0.7,
          volumeBreak: 0.3,
          notificationsEnabled: true,
          theme: 'system',
          updatedAt: 1700000000000,
        }}
        currentTheme="system"
        isSaving={false}
        onClose={vi.fn()}
        onSelectTheme={onSelectTheme}
        onSave={onSave}
        onRequestNotificationPermission={vi.fn().mockResolvedValue('granted')}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Verde/i }));
    fireEvent.click(screen.getByRole('button', { name: /Guardar preferencias/i }));

    await waitFor(() => {
      expect(onSelectTheme).toHaveBeenCalledWith('green');
      expect(onSave).toHaveBeenCalledWith({
        focusDurationMin: 25,
        shortBreakMin: 5,
        longBreakMin: 20,
        cyclesBeforeLongBreak: 4,
        volumeFocus: 0.7,
        volumeBreak: 0.3,
        notificationsEnabled: true,
        theme: 'light',
      });
    });

    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('validates and persists theme palettes in safeStorage', () => {
    window.localStorage.clear();
    expect(safeStorage.getThemePalette()).toBeNull();

    expect(safeStorage.setThemePalette('orange')).toBe(true);
    expect(safeStorage.getThemePalette()).toBe('orange');

    window.localStorage.setItem('deepwork:v1:themePalette', JSON.stringify('invalid-theme'));
    expect(safeStorage.getThemePalette()).toBeNull();
  });

  it('ticks ActiveSessionRunner locally every 250ms without requiring parent re-renders', () => {
    vi.useFakeTimers();
    const baseTime = 1_700_000_000_000;
    vi.setSystemTime(baseTime);

    try {
      const onPhaseTransition = vi.fn();
      const onPlanCompleted = vi.fn();
      const noop = vi.fn().mockResolvedValue(undefined);

      render(
        <ActiveSessionRunner
          session={{
            id: '11111111-1111-4111-8111-111111111111',
            userId: '22222222-2222-4222-8222-222222222222',
            status: 'active',
            currentIndex: 0,
            startedAt: baseTime,
            accumulatedPauseMs: 0,
            pausedAt: null,
            endedAt: null,
            version: 1,
            createdAt: baseTime,
            updatedAt: baseTime,
            plan: [
              {
                index: 0,
                cycleNumber: 1,
                phaseType: 'focus',
                durationMs: 60_000,
                startsAt: baseTime,
                endsAt: baseTime + 60_000,
              },
            ],
          }}
          clockOffsetMs={0}
          isBusy={false}
          onPause={noop}
          onResume={noop}
          onSkip={noop}
          onEnd={noop}
          onReset={noop}
          onSyncState={noop}
          onPhaseTransition={onPhaseTransition}
          onPlanCompleted={onPlanCompleted}
        />
      );

      expect(screen.getByText('01:00')).toBeInTheDocument();
      expect(onPhaseTransition).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(screen.getByText('00:58')).toBeInTheDocument();
      // Phase did not change during the 2-second tick, so parent was NOT notified again
      expect(onPhaseTransition).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders StatsModal KPIs, charts, and triggers export/window controls without inline styles', () => {
    const onChangeDays = vi.fn();
    const onRefresh = vi.fn();
    const onExport = vi.fn();
    const onClose = vi.fn();

    const { container } = render(
      <StatsModal
        stats={{
          today: {
            date: '2026-11-20',
            sessionsCompleted: 2,
            focusMs: 3_000_000,
            focusMinutes: 50,
            tasksCompleted: 3,
          },
          totals: {
            sessionsCompleted: 12,
            focusMs: 18_000_000,
            focusMinutes: 300,
            cyclesCompleted: 24,
            tasksCompleted: 18,
            tasksPending: 4,
          },
          streaks: {
            currentDays: 5,
            longestDays: 9,
            lastActiveDate: '2026-11-20',
          },
          primordial: {
            completedBeforeDeadline: 8,
            ignored: 2,
            activePending: 1,
            completionRate: 0.8,
          },
          productivity: {
            windowDays: 30,
            byDay: [
              {
                date: '2026-11-20',
                sessionsCompleted: 2,
                focusMs: 3_000_000,
                focusMinutes: 50,
                tasksCompleted: 3,
                primordialCompleted: 2,
                primordialIgnored: 0,
              },
            ],
            byWeekday: [
              { weekday: 0, label: 'Sun', sessionsCompleted: 0, focusMs: 0, tasksCompleted: 0 },
              { weekday: 5, label: 'Fri', sessionsCompleted: 2, focusMs: 3_000_000, tasksCompleted: 3 },
            ],
            byHour: Array.from({ length: 24 }, (_, hour) => ({
              hour,
              focusCycles: hour === 14 ? 2 : 0,
              focusMs: hour === 14 ? 3_000_000 : 0,
              tasksCompleted: hour === 14 ? 3 : 0,
            })),
            peakHour: { hour: 14, focusMs: 3_000_000, tasksCompleted: 3 },
          },
          serverTimeMs: 1_795_140_000_000,
        }}
        days={30}
        isLoading={false}
        isExporting={false}
        error={null}
        onChangeDays={onChangeDays}
        onRefresh={onRefresh}
        onExport={onExport}
        onClose={onClose}
      />
    );

    expect(screen.getAllByText('50 min').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('300 min')).toBeInTheDocument();
    expect(screen.getByText('5 días')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText(/Pico: 14:00 UTC/i)).toBeInTheDocument();
    expect(screen.getByText('2026-11-20')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Ventana de días/i), { target: { value: '7' } });
    expect(onChangeDays).toHaveBeenCalledWith(7);

    fireEvent.click(screen.getByRole('button', { name: /Exportar JSON/i }));
    expect(onExport).toHaveBeenCalledWith('json');

    fireEvent.click(screen.getByRole('button', { name: /Exportar CSV/i }));
    expect(onExport).toHaveBeenCalledWith('csv');

    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('fetches /stats and exports JSON/CSV via apiClient with strict contract validation', async () => {
    const sampleStats = {
      today: {
        date: '2026-11-20',
        sessionsCompleted: 1,
        focusMs: 1_500_000,
        focusMinutes: 25,
        tasksCompleted: 1,
      },
      totals: {
        sessionsCompleted: 1,
        focusMs: 1_500_000,
        focusMinutes: 25,
        cyclesCompleted: 1,
        tasksCompleted: 1,
        tasksPending: 0,
      },
      streaks: { currentDays: 1, longestDays: 1, lastActiveDate: '2026-11-20' },
      primordial: { completedBeforeDeadline: 0, ignored: 0, activePending: 0, completionRate: null },
      productivity: {
        windowDays: 14,
        byDay: [],
        byWeekday: [],
        byHour: [],
        peakHour: null,
      },
      serverTimeMs: 1_795_140_000_000,
    };

    const fetchSpy = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sampleStats), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          'date,sessions_completed,focus_ms,focus_minutes,tasks_completed,primordial_completed,primordial_ignored\n2026-11-20,1,1500000,25,1,0,0\n',
          {
            status: 200,
            headers: { 'content-type': 'text/csv; charset=utf-8' },
          }
        )
      );

    try {
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const stats = await apiClient.getStats(deviceId, 14);
      expect(stats.productivity.windowDays).toBe(14);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        '/api/v1/stats?days=14',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'x-device-id': deviceId }),
        })
      );

      const exported = await apiClient.exportStats(deviceId, { format: 'csv', days: 14 });
      expect(exported.filename).toBe('deep-work-stats-14d.csv');
      expect(exported.format).toBe('csv');
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        '/api/v1/stats/export?format=csv&days=14',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'x-device-id': deviceId }),
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps TasksPanel filters collapsed by default and opens them on demand', () => {
    const onQueryChange = vi.fn();

    render(
      <TasksPanel
        tasks={[]}
        counts={{ total: 2, pending: 1, completed: 1 }}
        availableTags={['foco']}
        query={{ status: 'all', sortBy: 'default' }}
        isBusy={false}
        onQueryChange={onQueryChange}
        onCreateTask={vi.fn().mockResolvedValue(undefined)}
        onToggleComplete={vi.fn().mockResolvedValue(undefined)}
        onUpdateTask={vi.fn().mockResolvedValue(undefined)}
        onDeleteTask={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.queryByRole('tab', { name: /Todas/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Filtros$/i }));
    expect(screen.getByRole('tab', { name: /Todas \(2\)/i })).toBeInTheDocument();
  });

  it('renders HeaderBar without technical clutter when online and triggers secondary tools', () => {
    const onOpenAudio = vi.fn();
    const onOpenSearch = vi.fn();
    const onOpenStats = vi.fn();

    const { container } = render(
      <HeaderBar
        serverOnline={true}
        clockOffsetMs={42}
        pendingSyncCount={0}
        deviceId="11111111-1111-4111-8111-111111111111"
        theme="blue"
        isAudioPlaying={true}
        hasActiveSession={true}
        onSelectTheme={vi.fn()}
        onOpenAudio={onOpenAudio}
        onOpenTimeline={vi.fn()}
        onOpenSearch={onOpenSearch}
        onOpenStats={onOpenStats}
        onOpenPreferences={vi.fn()}
        onRefreshSync={vi.fn()}
      />
    );

    expect(screen.queryByText(/Servidor en línea/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\+42ms/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sonido/i }));
    fireEvent.click(screen.getByRole('button', { name: /Buscador/i }));
    fireEvent.click(screen.getByRole('button', { name: /Estadísticas/i }));

    expect(onOpenAudio).toHaveBeenCalledTimes(1);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(onOpenStats).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('closes GlassModal on Escape, supports top-center placement, and renders zero inline style attributes', () => {
    const onClose = vi.fn();
    const { container } = render(
      <GlassModal
        titleId="test-glass-modal"
        title="Buscador de enfoque"
        placement="top-center"
        onClose={onClose}
      >
        <p>Contenido de prueba</p>
      </GlassModal>
    );

    const dialog = screen.getByRole('dialog', { name: /Buscador de enfoque/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog.className).toContain('items-start');
    expect(dialog.className).toContain('pt-12');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('validates login/register inputs in AccountModal and supports authenticated session management without inline styles', async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onRegister = vi.fn().mockResolvedValue(undefined);
    const onGoogleLogin = vi.fn().mockResolvedValue(undefined);
    const onLogout = vi.fn().mockResolvedValue(undefined);
    const onRevokeSession = vi.fn().mockResolvedValue(undefined);

    const { container, rerender } = render(
      <AccountModal
        user={null}
        deviceId="11111111-1111-4111-8111-111111111111"
        providers={{
          password: { enabled: true },
          google: { enabled: true, codeFlowEnabled: true, clientId: 'google-client-id' },
          device: { enabled: true },
        }}
        authSessions={[]}
        isLoadingSessions={false}
        isSubmitting={false}
        onClose={vi.fn()}
        onLogin={onLogin}
        onRegister={onRegister}
        onGoogleLogin={onGoogleLogin}
        onLinkGoogle={vi.fn().mockResolvedValue(undefined)}
        onLogout={onLogout}
        onLogoutAll={vi.fn().mockResolvedValue(undefined)}
        onRevokeSession={onRevokeSession}
        onRecoverDevice={vi.fn().mockResolvedValue(undefined)}
        onResetNewDevice={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.change(screen.getByLabelText(/Usuario o correo electrónico/i), {
      target: { value: '<script>alert(1)</script>' },
    });
    fireEvent.change(screen.getByLabelText(/Contraseña/i), {
      target: { value: 'Secret1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Iniciar sesión$/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onLogin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Continuar con Google/i }));
    expect(onGoogleLogin).toHaveBeenCalledWith(true);

    expect(container.querySelectorAll('[style]').length).toBe(0);

    // Authenticated view
    rerender(
      <AccountModal
        user={{
          id: '11111111-1111-4111-8111-111111111111',
          authProvider: 'password',
          username: 'denis_focus',
          email: 'denis@example.com',
          displayName: 'Denis Focus',
          avatarUrl: null,
          hasPassword: true,
          hasGoogleLinked: false,
          createdAt: 1700000000000,
        }}
        deviceId={null}
        providers={{
          password: { enabled: true },
          google: { enabled: true, codeFlowEnabled: true, clientId: 'google-client-id' },
          device: { enabled: true },
        }}
        authSessions={[
          {
            id: '22222222-2222-4222-8222-222222222222',
            userId: '11111111-1111-4111-8111-111111111111',
            provider: 'password',
            deviceLabel: 'Linux Desktop',
            persistent: true,
            isCurrent: true,
            createdAt: 1700000000000,
            lastUsedAt: 1700000100000,
            expiresAt: 1702592000000,
            revokedAt: null,
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            userId: '11111111-1111-4111-8111-111111111111',
            provider: 'google',
            deviceLabel: 'Chrome Android',
            persistent: true,
            isCurrent: false,
            createdAt: 1700000000000,
            lastUsedAt: 1700000050000,
            expiresAt: 1702592000000,
            revokedAt: null,
          },
        ]}
        isLoadingSessions={false}
        isSubmitting={false}
        onClose={vi.fn()}
        onLogin={onLogin}
        onRegister={onRegister}
        onGoogleLogin={onGoogleLogin}
        onLinkGoogle={vi.fn().mockResolvedValue(undefined)}
        onLogout={onLogout}
        onLogoutAll={vi.fn().mockResolvedValue(undefined)}
        onRevokeSession={onRevokeSession}
        onRecoverDevice={vi.fn().mockResolvedValue(undefined)}
        onResetNewDevice={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('Denis Focus')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Vincular cuenta de Google/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Revocar/i }));
    expect(onRevokeSession).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');

    fireEvent.click(screen.getByRole('button', { name: /^Cerrar sesión$/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('shows authenticated user name and offline pill cleanly in HeaderBar without backend jargon', () => {
    render(
      <HeaderBar
        serverOnline={false}
        user={{
          id: '11111111-1111-4111-8111-111111111111',
          authProvider: 'password',
          username: 'denis_focus',
          email: null,
          displayName: 'Denis Focus',
          avatarUrl: null,
          hasPassword: true,
          hasGoogleLinked: false,
          createdAt: 1700000000000,
        }}
        theme="system"
        onSelectTheme={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenPreferences={vi.fn()}
      />
    );

    expect(screen.getByText('Sin conexión')).toBeInTheDocument();
    expect(screen.getByText('Denis Focus')).toBeInTheDocument();
    expect(screen.queryByText(/Servidor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dispositivo:/i)).not.toBeInTheDocument();
  });

  it('renders floating ToastStack notifications and auto-dismisses them after 5 seconds without inline styles', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const { container } = render(
        <ToastStack
          toasts={[
            { id: 'toast-1', message: 'Preferencias guardadas.', tone: 'success' },
            { id: 'toast-2', message: 'Sesión iniciada.', tone: 'info' },
          ]}
          onDismiss={onDismiss}
        />
      );

      expect(screen.getByText('Preferencias guardadas.')).toBeInTheDocument();
      expect(screen.getByText('Sesión iniciada.')).toBeInTheDocument();
      expect(container.querySelectorAll('[style]').length).toBe(0);

      act(() => {
        vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(onDismiss).toHaveBeenCalledWith('toast-1');
      expect(onDismiss).toHaveBeenCalledWith('toast-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses solid opaque aligned dropdown and collapsible secondary panel in HeaderBar', () => {
    const onOpenPreferences = vi.fn();

    const { container } = render(
      <HeaderBar
        serverOnline={true}
        user={null}
        theme="blue"
        onSelectTheme={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenPreferences={onOpenPreferences}
      />
    );

    // Primary header always visible; secondary accordion collapsed by default
    const toggle = screen.getByRole('button', { name: /Opciones adicionales/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panel = document.getElementById('header-secondary-panel');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('data-open', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');

    // Theme dropdown is 100% solid, z-50, right-aligned and constrained to mobile viewport
    fireEvent.click(screen.getByRole('button', { name: /Seleccionar tema/i }));
    const menu = screen.getByRole('menu', { name: /Paletas de temas/i });
    expect(menu.className).toContain('liquid-menu-solid');
    expect(menu.className).toContain('z-50');
    expect(menu.className).toContain('right-0');
    expect(menu.className).toContain('left-auto');
    expect(menu.className).toContain('max-w-[calc(100vw-32px)]');

    // Expand secondary collapsible accordion (includes Cuenta y sesiones) and closes on outside click
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveAttribute('data-open', 'true');
    expect(panel).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByRole('button', { name: /Cuenta y sesiones/i })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('data-open', 'false');
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('keeps MobileDock centered within viewport width without horizontal overflow or inline styles', () => {
    const { container } = render(
      <MobileDock
        isAudioPlaying={false}
        hasActiveSession={true}
        onOpenAudio={vi.fn()}
        onOpenTimeline={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenStats={vi.fn()}
        onOpenPreferences={vi.fn()}
      />
    );

    const nav = screen.getByRole('navigation', { name: /Accesos rápidos/i });
    expect(nav.className).toContain('w-[calc(100%-24px)]');
    expect(nav.className).toContain('left-1/2');
    expect(nav.className).toContain('-translate-x-1/2');
    expect(nav.className).toContain('box-border');
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('closes only the topmost modal on Escape when multiple dialogs are stacked', () => {
    const onCloseBottom = vi.fn();
    const onCloseTop = vi.fn();

    render(
      <>
        <PreferencesModal
          preferences={{
            userId: '11111111-1111-4111-8111-111111111111',
            focusDurationMin: 25,
            shortBreakMin: 5,
            longBreakMin: 20,
            cyclesBeforeLongBreak: 4,
            volumeFocus: 0.7,
            volumeBreak: 0.3,
            notificationsEnabled: true,
            theme: 'system',
            updatedAt: 1700000000000,
          }}
          isSaving={false}
          onClose={onCloseBottom}
          onSave={vi.fn().mockResolvedValue(undefined)}
          onRequestNotificationPermission={vi.fn().mockResolvedValue('granted')}
        />
        <GlassModal titleId="top-dialog" title="Modal superior" onClose={onCloseTop}>
          <p>Encima</p>
        </GlassModal>
      </>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCloseTop).toHaveBeenCalledTimes(1);
    expect(onCloseBottom).not.toHaveBeenCalled();
  });

  it('keeps at most one active modal open and blocks Space shortcut while any modal is open', async () => {
    const baseTime = Date.now();
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    const sessionId = '33333333-3333-4333-8333-333333333333';

    const activeSession = {
      id: sessionId,
      userId,
      status: 'active' as const,
      currentIndex: 0,
      startedAt: baseTime,
      accumulatedPauseMs: 0,
      pausedAt: null,
      endedAt: null,
      version: 1,
      createdAt: baseTime,
      updatedAt: baseTime,
      plan: [
        {
          index: 0,
          cycleNumber: 1,
          phaseType: 'focus' as const,
          durationMs: 1_500_000,
          startsAt: baseTime,
          endsAt: baseTime + 1_500_000,
        },
      ],
    };

    const preferences = {
      userId,
      focusDurationMin: 25,
      shortBreakMin: 5,
      longBreakMin: 20,
      cyclesBeforeLongBreak: 4,
      volumeFocus: 0.7,
      volumeBreak: 0.3,
      notificationsEnabled: true,
      theme: 'system' as const,
      updatedAt: baseTime,
    };

    const spies = [
      vi.spyOn(apiClient, 'checkHealth').mockResolvedValue({ status: 'ok', timestamp: baseTime }),
      vi
        .spyOn(apiClient, 'getServerTime')
        .mockResolvedValue({ serverTimeMs: baseTime, iso: '2026-11-21T00:00:00.000Z' }),
      vi.spyOn(apiClient, 'getAuthProviders').mockResolvedValue({
        providers: {
          password: { enabled: true },
          google: { enabled: false, codeFlowEnabled: false, clientId: null },
          device: { enabled: true },
        },
        serverTimeMs: baseTime,
      }),
      vi.spyOn(apiClient, 'getMe').mockResolvedValue({
        provider: 'device',
        user: {
          id: userId,
          authProvider: 'device',
          username: null,
          email: null,
          displayName: null,
          avatarUrl: null,
          hasPassword: false,
          hasGoogleLinked: false,
          deviceId,
          createdAt: baseTime,
        },
        preferences,
        session: null,
      }),
      vi.spyOn(apiClient, 'registerDevice').mockResolvedValue({
        deviceId,
        created: false,
        user: {
          id: userId,
          authProvider: 'device',
          createdAt: baseTime,
        },
        preferences,
      }),
      vi.spyOn(apiClient, 'getSyncState').mockResolvedValue({
        activeSession,
        currentPhase: activeSession.plan[0] ?? null,
        preferences,
        tasks: [],
        taskCounts: { total: 0, pending: 0, completed: 0 },
        serverTimeMs: baseTime,
      }),
      vi.spyOn(apiClient, 'getTaskTags').mockResolvedValue({ tags: [], serverTimeMs: baseTime }),
      vi.spyOn(apiClient, 'getAudioTracks').mockResolvedValue({
        tracks: [],
        volumePolicy: { focus: 0.7, short_break: 0.3, long_break: 0.3 },
      }),
      vi.spyOn(apiClient, 'getSearchEngines').mockResolvedValue({
        engines: [],
        serverTimeMs: baseTime,
      }),
      vi.spyOn(apiClient, 'getSearchHistory').mockResolvedValue({
        history: [],
        total: 0,
        serverTimeMs: baseTime,
      }),
      vi.spyOn(apiClient, 'getStats').mockResolvedValue({
        today: {
          date: '2026-11-21',
          sessionsCompleted: 0,
          focusMs: 0,
          focusMinutes: 0,
          tasksCompleted: 0,
        },
        totals: {
          sessionsCompleted: 0,
          focusMs: 0,
          focusMinutes: 0,
          cyclesCompleted: 0,
          tasksCompleted: 0,
          tasksPending: 0,
        },
        streaks: { currentDays: 0, longestDays: 0, lastActiveDate: null },
        primordial: { completedBeforeDeadline: 0, ignored: 0, activePending: 0, completionRate: null },
        productivity: { windowDays: 30, byDay: [], byWeekday: [], byHour: [], peakHour: null },
        serverTimeMs: baseTime,
      }),
    ];
    const pauseSpy = vi.spyOn(apiClient, 'pauseSession').mockResolvedValue({
      idempotent: false,
      session: { ...activeSession, status: 'paused', pausedAt: baseTime + 1000, version: 2 },
      serverTimeMs: baseTime + 1000,
    });

    try {
      window.localStorage.clear();
      render(<App />);

      // Wait until the active session timer is rendered
      expect(await screen.findByRole('button', { name: /^Pausar$/i })).toBeInTheDocument();

      // Open Preferencias, then click Cuenta y sesiones inside it -> replaces modal (never 2 dialogs)
      fireEvent.click(screen.getByRole('button', { name: /^Preferencias$/i }));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(screen.getByRole('heading', { name: /^Preferencias$/i })).toBeInTheDocument();

      const modal = screen.getByRole('dialog');
      const accountInsidePrefs = modal.querySelector('button[type="button"]')
        ? Array.from(modal.querySelectorAll('button')).find((b) =>
            /Cuenta y sesiones/i.test(b.textContent ?? '')
          )
        : undefined;
      expect(accountInsidePrefs).toBeDefined();
      fireEvent.click(accountInsidePrefs!);

      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(screen.getByRole('heading', { name: /^Cuenta$/i })).toBeInTheDocument();

      // Close AccountModal via Escape
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Open Sonido / Buscador / Estadísticas and ensure Space does NOT pause session behind modal
      fireEvent.click(screen.getAllByRole('button', { name: /^Sonido$/i })[0]!);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      fireEvent.keyDown(window, { code: 'Space' });
      expect(pauseSpy).not.toHaveBeenCalled();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.click(screen.getAllByRole('button', { name: /^Estadísticas$/i })[0]!);
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      fireEvent.keyDown(window, { code: 'Space' });
      expect(pauseSpy).not.toHaveBeenCalled();

      // Close StatsModal and press Space on canvas -> pauses active session
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      fireEvent.keyDown(window, { code: 'Space' });
      await waitFor(() => {
        expect(pauseSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      pauseSpy.mockRestore();
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it('collapses task details on mobile by default, expands on tap, and collapses on outside touch', () => {
    const sampleTask = {
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      title: 'Revisar arquitectura',
      description: 'Validar límites y animaciones',
      completed: false,
      completedAt: null,
      userPriority: 'HIGH' as const,
      aiPriority: null,
      effectivePriority: 'HIGH' as const,
      priorityScore: 80,
      priorityReason: 'Alta prioridad manual',
      priorityComputedAt: null,
      priorityDismissedUntil: null,
      priorityDismissCount: 0,
      tags: ['ui'],
      dueAt: 1_800_000_000_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };

    const { container } = render(
      <TasksPanel
        tasks={[sampleTask]}
        counts={{ total: 1, pending: 1, completed: 0 }}
        availableTags={['ui']}
        query={{ status: 'all', sortBy: 'default' }}
        isBusy={false}
        onQueryChange={vi.fn()}
        onCreateTask={vi.fn().mockResolvedValue(undefined)}
        onToggleComplete={vi.fn().mockResolvedValue(undefined)}
        onUpdateTask={vi.fn().mockResolvedValue(undefined)}
        onDeleteTask={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const trigger = screen.getByRole('button', { name: /Revisar arquitectura/i });
    const extra = document.getElementById(`task-extra-${sampleTask.id}`);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(extra).toHaveAttribute('data-open', 'false');
    expect(extra?.className).toContain('task-mobile-accordion');

    // Tap task row to expand extra details
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(extra).toHaveAttribute('data-open', 'true');

    // Tap outside task collapses extra details
    fireEvent.touchStart(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(extra).toHaveAttribute('data-open', 'false');
    expect(container.querySelectorAll('[style]').length).toBe(0);
  });

  it('allows longBreakMin up to 120 in PreferencesModal and shows 2x short break notice', () => {
    render(
      <PreferencesModal
        preferences={{
          userId: '11111111-1111-4111-8111-111111111111',
          focusDurationMin: 25,
          shortBreakMin: 30,
          longBreakMin: 40,
          cyclesBeforeLongBreak: 4,
          volumeFocus: 0.7,
          volumeBreak: 0.3,
          notificationsEnabled: true,
          theme: 'system',
          updatedAt: 1700000000000,
        }}
        isSaving={false}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onRequestNotificationPermission={vi.fn().mockResolvedValue('granted')}
      />
    );

    const longBreakInput = screen.getByLabelText(/Descanso largo \(min\)/i) as HTMLInputElement;
    expect(longBreakInput.max).toBe('120');
    expect(screen.getByText(/60 min/i)).toBeInTheDocument();
    expect(screen.getByText(/mínimo 2× el descanso corto/i)).toBeInTheDocument();
  });
});
