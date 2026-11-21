export type AuthProviderType = 'device' | 'password' | 'google';

export interface User {
  id: string;
  authProvider: AuthProviderType;
  externalId: string;
  username: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  googleSub: string | null;
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSession {
  id: string;
  userId: string;
  provider: Exclude<AuthProviderType, 'device'>;
  persistent: boolean;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface Preference {
  userId: string;
  focusDurationMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  cyclesBeforeLongBreak: number;
  volumeFocus: number;
  volumeBreak: number;
  notificationsEnabled: boolean;
  theme: ThemePreference;
  updatedAt: number;
}

export type PhaseType = 'focus' | 'short_break' | 'long_break';

export interface SessionPlanPhase {
  index: number;
  cycleNumber: number;
  phaseType: PhaseType;
  durationMs: number;
  startsAt: number;
  endsAt: number;
  skipped?: boolean;
}

export type SessionStatus = 'active' | 'paused' | 'completed' | 'reset';

export interface Session {
  id: string;
  userId: string;
  status: SessionStatus;
  plan: SessionPlanPhase[];
  currentIndex: number;
  startedAt: number;
  accumulatedPauseMs: number;
  pausedAt: number | null;
  endedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface Cycle {
  id: string;
  sessionId: string;
  userId: string;
  cycleIndex: number;
  phaseType: PhaseType;
  plannedDurationMs: number;
  startedAt: number;
  endsAt: number;
  completedAt: number | null;
  skipped: boolean;
}

export type PriorityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Task {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  completed: boolean;
  completedAt: number | null;
  userPriority: PriorityLevel;
  aiPriority: PriorityLevel | null;
  effectivePriority: PriorityLevel;
  priorityScore: number;
  priorityReason: string | null;
  priorityComputedAt: number | null;
  priorityDismissedUntil: number | null;
  priorityDismissCount: number;
  tags: string[];
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DailyStats {
  id: string;
  userId: string;
  date: string; // YYYY-MM-DD
  sessionsCompleted: number;
  focusMs: number;
  tasksCompleted: number;
  primordialCompleted: number;
  primordialIgnored: number;
  updatedAt: number;
}

export type EventEntityType = 'user' | 'preference' | 'session' | 'cycle' | 'task' | 'search';

export type SearchEngine = 'google' | 'wikipedia' | 'stackoverflow';

export interface SearchResultMetadata {
  pageId?: number;
  questionId?: number;
  score?: number;
  answerCount?: number;
  isAnswered?: boolean;
  tags?: string[];
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string | null;
  engine: SearchEngine;
  metadata?: SearchResultMetadata;
}

export interface SearchHistoryEntry {
  id: string;
  userId: string;
  engine: SearchEngine;
  query: string;
  resultsCount: number;
  createdAt: number;
}

export interface EventLog {
  id: string;
  eventId: string;
  userId: string;
  entityType: EventEntityType;
  entityId: string;
  eventType: string;
  payload: Record<string, unknown>;
  clientTimestamp: number | null;
  serverTimestamp: number;
}
