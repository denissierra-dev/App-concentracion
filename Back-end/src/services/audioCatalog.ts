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

function safeResolveInDir(baseDir: string, filename: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, filename);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

export function listAudioTracks(audioDir: string): AudioTrackMetadata[] {
  const tracks: AudioTrackMetadata[] = [];

  for (const def of CURATED_TRACKS) {
    const resolved = resolveAudioTrack(audioDir, def.id);
    if (resolved) {
      tracks.push(resolved.track);
    }
  }

  return tracks;
}

export function resolveAudioTrack(audioDir: string, trackId: string): ResolvedAudioTrack | null {
  if (!TRACK_ID_PATTERN.test(trackId)) {
    return null;
  }

  const def = CURATED_TRACKS.find((item) => item.id === trackId);
  if (!def) {
    return null;
  }

  const filePath = safeResolveInDir(audioDir, def.filename);
  if (!filePath) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  return {
    filePath,
    track: {
      id: def.id,
      title: def.title,
      category: def.category,
      mimeType: def.mimeType,
      sizeBytes: stat.size,
      streamUrl: `/api/v1/audio/tracks/${def.id}/stream`,
    },
  };
}
