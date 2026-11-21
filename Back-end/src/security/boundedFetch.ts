import { AppError } from '../errors/AppError.js';
import { safeJsonReviver } from './validators.js';

export interface ReadBoundedResponseOptions {
  maxBytes: number;
  signal: AbortSignal;
  onTooLarge: () => AppError;
}

function createAbortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return false;
}

/**
 * Reads an HTTP response body incrementally up to `maxBytes` while honoring `signal`
 * throughout body streaming (not just until headers arrive). Cancels the underlying
 * stream immediately if the size limit is exceeded or the timeout aborts.
 */
export async function readBoundedResponseText(
  response: Response,
  options: ReadBoundedResponseOptions
): Promise<string> {
  const { maxBytes, signal, onTooLarge } = options;

  if (signal.aborted) {
    await response.body?.cancel().catch(() => {});
    throw createAbortError();
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== '') {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw onTooLarge();
    }
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(createAbortError());
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    abortPromise.catch(() => {});

    try {
      const textPromise = response.text();
      textPromise.catch(() => {});
      const rawText = await Promise.race([textPromise, abortPromise]);
      if (Buffer.byteLength(rawText, 'utf8') > maxBytes) {
        throw onTooLarge();
      }
      return rawText;
    } finally {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const abortErr = createAbortError();
      void reader.cancel(abortErr).catch(() => {});
      reject(abortErr);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  abortPromise.catch(() => {});

  try {
    while (true) {
      const readPromise = reader.read();
      readPromise.catch(() => {});
      const { done, value } = await Promise.race([readPromise, abortPromise]);
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw onTooLarge();
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released or closed
    }
  }
}

export async function readBoundedResponseJson(
  response: Response,
  options: ReadBoundedResponseOptions
): Promise<unknown> {
  const rawText = await readBoundedResponseText(response, options);
  return JSON.parse(rawText, safeJsonReviver);
}
