import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeviceIdentityModal } from '../src/components/DeviceIdentityModal';
import { HeaderBar } from '../src/components/HeaderBar';
import { MiniSearchPanel } from '../src/components/MiniSearchPanel';
import { PreferencesModal } from '../src/components/PreferencesModal';
import { SessionSetup } from '../src/components/SessionSetup';
import { TasksPanel } from '../src/components/TasksPanel';
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

  it('rejects XSS and non-UUID payloads in DeviceIdentityModal', async () => {
    const onRecoverDevice = vi.fn().mockResolvedValue(undefined);
    const onResetNewDevice = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <DeviceIdentityModal
        deviceId="11111111-1111-4111-8111-111111111111"
        isSubmitting={false}
        onClose={onClose}
        onRecoverDevice={onRecoverDevice}
        onResetNewDevice={onResetNewDevice}
      />
    );

    const input = screen.getByLabelText(/Recuperar cuenta/i);
    fireEvent.change(input, { target: { value: '<script>alert(1)</script>' } });
    fireEvent.click(screen.getByRole('button', { name: /Recuperar UUID/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Caracteres no permitidos/i);
    expect(onRecoverDevice).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } });
    fireEvent.click(screen.getByRole('button', { name: /Recuperar UUID/i }));

    await waitFor(() => {
      expect(onRecoverDevice).toHaveBeenCalledWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    });
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

  it('omits unapplied break duration inputs in PreferencesModal and submits active fields', async () => {
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

    expect(screen.queryByLabelText(/Descanso corto base/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Descanso largo \(min\)/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Enfoque predeterminado/i), {
      target: { value: '45' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Guardar en servidor/i }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        focusDurationMin: 45,
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
    fireEvent.click(screen.getByRole('button', { name: /Guardar en servidor/i }));

    await waitFor(() => {
      expect(onSelectTheme).toHaveBeenCalledWith('green');
      expect(onSave).toHaveBeenCalledWith({
        focusDurationMin: 25,
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
});
