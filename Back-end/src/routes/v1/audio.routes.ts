import fs from 'node:fs';
import { Router, type RequestHandler } from 'express';
import type { PhaseType } from '../../domain/types.js';
import { AppError } from '../../errors/AppError.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import { listAudioTracks, resolveAudioTrack } from '../../services/audioCatalog.js';

export type VolumePolicy = Record<PhaseType, number>;

export interface AudioRouterDeps {
  audioDir: string;
  userRepo: UserRepository;
  authenticate: RequestHandler;
}

function buildVolumePolicy(userRepo: UserRepository, userId: string): VolumePolicy {
  const prefs = userRepo.getPreferencesByUserId(userId);
  const volumeFocus = prefs?.volumeFocus ?? 0.7;
  const volumeBreak = prefs?.volumeBreak ?? 0.3;

  return {
    focus: volumeFocus,
    short_break: volumeBreak,
    long_break: volumeBreak,
  };
}

interface ByteRange {
  start: number;
  end: number;
}

function parseByteRange(rangeHeader: string, totalSize: number): ByteRange | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return 'invalid';
  }

  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';

  if (startStr === '' && endStr === '') {
    return 'invalid';
  }

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix byte range: bytes=-500 (last 500 bytes)
    const suffixLength = Number(endStr);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return 'invalid';
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? totalSize - 1 : Math.min(Number(endStr), totalSize - 1);
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= totalSize ||
    end < start
  ) {
    return 'invalid';
  }

  return { start, end };
}

export function createAudioRouter({
  audioDir,
  userRepo,
  authenticate,
}: AudioRouterDeps): Router {
  const router = Router();

  /**
   * Returns the authoritative per-phase volume policy from user preferences.
   */
  router.get('/policy', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }

      res.json({
        volumePolicy: buildVolumePolicy(userRepo, req.auth.user.id),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Lists available audio tracks along with the authenticated user's volume policy.
   */
  router.get('/tracks', authenticate, (req, res, next) => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication context missing');
      }

      res.json({
        tracks: listAudioTracks(audioDir),
        volumePolicy: buildVolumePolicy(userRepo, req.auth.user.id),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Streams an audio track with HTTP Range (206 Partial Content) support
   * and cache headers suitable for <audio> tags and Service Worker preloading.
   */
  router.get('/tracks/:id/stream', (req, res, next) => {
    try {
      const trackId = req.params.id ?? '';
      const resolved = resolveAudioTrack(audioDir, trackId);
      if (!resolved) {
        throw new AppError(404, 'AUDIO_TRACK_NOT_FOUND', 'Audio track not found');
      }

      const { track, filePath } = resolved;
      const totalSize = track.sizeBytes;
      const rangeHeader = req.header('range');

      res.setHeader('Content-Type', track.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      if (!rangeHeader) {
        res.status(200);
        res.setHeader('Content-Length', totalSize);
        const stream = fs.createReadStream(filePath);
        stream.on('error', next);
        stream.pipe(res);
        return;
      }

      const parsedRange = parseByteRange(rangeHeader, totalSize);
      if (parsedRange === 'invalid') {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.status(416).json({
          error: {
            code: 'RANGE_NOT_SATISFIABLE',
            message: 'Requested byte range cannot be satisfied',
          },
        });
        return;
      }

      const chunkSize = parsedRange.end - parsedRange.start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalSize}`);
      res.setHeader('Content-Length', chunkSize);

      const stream = fs.createReadStream(filePath, {
        start: parsedRange.start,
        end: parsedRange.end,
      });
      stream.on('error', next);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
