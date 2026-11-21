import type { z } from 'zod';
import type {
  appThemeSchema,
  audioTrackSchema,
  authProvidersResponseSchema,
  authProviderTypeSchema,
  authSessionEntrySchema,
  authSuccessResponseSchema,
  cachedSnapshotSchema,
  phaseTypeSchema,
  preferenceSchema,
  priorityLevelSchema,
  publicUserSchema,
  queuedSyncEventSchema,
  searchEngineInfoSchema,
  searchEngineSchema,
  searchHistoryEntrySchema,
  searchResponseSchema,
  searchResultItemSchema,
  sessionPlanPhaseSchema,
  sessionSchema,
  sessionStatusSchema,
  statsDashboardResponseSchema,
  statsExportFormatSchema,
  syncBatchResponseSchema,
  syncStateResponseSchema,
  taskCountsSchema,
  taskQuerySchema,
  taskSchema,
  themePreferenceSchema,
  userTaskPrioritySchema,
  volumePolicySchema,
} from '../security/validators';

export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type AppTheme = z.infer<typeof appThemeSchema>;
export type AuthProviderType = z.infer<typeof authProviderTypeSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
export type AuthSuccessResponse = z.infer<typeof authSuccessResponseSchema>;
export type AuthSessionEntry = z.infer<typeof authSessionEntrySchema>;
export type Preference = z.infer<typeof preferenceSchema>;
export type PhaseType = z.infer<typeof phaseTypeSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionPlanPhase = z.infer<typeof sessionPlanPhaseSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type VolumePolicy = z.infer<typeof volumePolicySchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type PriorityLevel = z.infer<typeof priorityLevelSchema>;
export type UserTaskPriority = z.infer<typeof userTaskPrioritySchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskCounts = z.infer<typeof taskCountsSchema>;
export type TaskQueryParams = z.infer<typeof taskQuerySchema>;
export type QueuedSyncEvent = z.infer<typeof queuedSyncEventSchema>;
export type SyncStateResponse = z.infer<typeof syncStateResponseSchema>;
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;
export type CachedSnapshot = z.infer<typeof cachedSnapshotSchema>;
export type SearchEngine = z.infer<typeof searchEngineSchema>;
export type SearchEngineInfo = z.infer<typeof searchEngineInfoSchema>;
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;
export type SearchHistoryEntry = z.infer<typeof searchHistoryEntrySchema>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type StatsDashboardResponse = z.infer<typeof statsDashboardResponseSchema>;
export type StatsExportFormat = z.infer<typeof statsExportFormatSchema>;
