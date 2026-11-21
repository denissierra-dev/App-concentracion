import fs from 'node:fs';
import path from 'node:path';

export interface AudioTrackDefinition {
  id: string;
  title: string;
  category: 'ambient' | 'noise' | 'drone';
  filename: string;
  mimeType: string;
}

export interface AudioTrackMetadata {
  id: string;
  title: string;
  category: 'ambient' | 'noise' | 'drone';
  mimeType: string;
  sizeBytes: number;
  streamUrl: string;
}

export interface ResolvedAudioTrack {
  track: AudioTrackMetadata;
  filePath: string;
}

const TRACK_ID_PATTERN = /^[a-z0-9-]+$/;

const CURATED_TRACKS: readonly AudioTrackDefinition[] = [
  {
    id: 'rain-ambient',
    title: 'Soft Rain',
    category: 'ambient',
    filename: 'rain-ambient.wav',
    mimeType: 'audio/wav',
  },
  {
    id: 'brown-noise',
    title: 'Deep Brown Noise',
    category: 'noise',
    filename: 'brown-noise.wav',
    mimeType: 'audio/wav',
  },
  {
    id: 'focus-drone',
    title: 'Warm Focus Drone',
    category: 'drone',
    filename: 'focus-drone.wav',
    mimeType: 'audio/wav',
  },
];

function resolveTrackFromDisk(
  resolvedBase: string,
  def: AudioTrackDefinition
): ResolvedAudioTrack | null {
  try {
    const candidate = path.resolve(resolvedBase, def.filename);
    if (!candidate.startsWith(resolvedBase + path.sep)) {
      return null;
    }
    const realTarget = fs.realpathSync(candidate);
    if (!realTarget.startsWith(resolvedBase + path.sep)) {
      return null;
    }
    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) {
      return null;
    }

    return {
      filePath: realTarget,
      track: {
        id: def.id,
        title: def.title,
        category: def.category,
        mimeType: def.mimeType,
        sizeBytes: stat.size,
        streamUrl: `/api/v1/audio/tracks/${def.id}/stream`,
      },
    };
  } catch {
    return null;
  }
}

interface CachedAudioCatalog {
  tracks: AudioTrackMetadata[];
  byId: Map<string, ResolvedAudioTrack>;
}

const audioCatalogCache = new Map<string, CachedAudioCatalog>();

function getOrLoadCatalog(audioDir: string): CachedAudioCatalog {
  const cacheKey = path.resolve(audioDir);
  const cached = audioCatalogCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const tracks: AudioTrackMetadata[] = [];
  const byId = new Map<string, ResolvedAudioTrack>();

  let resolvedBase: string | null = null;
  try {
    resolvedBase = fs.realpathSync(cacheKey);
  } catch {
    resolvedBase = null;
  }

  if (resolvedBase) {
    for (const def of CURATED_TRACKS) {
      const resolved = resolveTrackFromDisk(resolvedBase, def);
      if (resolved) {
        tracks.push(resolved.track);
        byId.set(def.id, resolved);
      }
    }
  }

  const entry: CachedAudioCatalog = { tracks, byId };
  audioCatalogCache.set(cacheKey, entry);
  return entry;
}

export function clearAudioCatalogCache(): void {
  audioCatalogCache.clear();
}

export function listAudioTracks(audioDir: string): AudioTrackMetadata[] {
  return getOrLoadCatalog(audioDir).tracks;
}

export function resolveAudioTrack(audioDir: string, trackId: string): ResolvedAudioTrack | null {
  if (!TRACK_ID_PATTERN.test(trackId)) {
    return null;
  }

  return getOrLoadCatalog(audioDir).byId.get(trackId) ?? null;
}
