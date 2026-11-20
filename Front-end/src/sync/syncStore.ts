import { z } from 'zod';
import type { CachedSnapshot, QueuedSyncEvent } from '../domain/types';
import {
  cachedSnapshotSchema,
  queuedSyncEventSchema,
  safeJsonParse,
  uuidSchema,
} from '../security/validators';

const DB_NAME = 'deep-work-cache-v1';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const SNAPSHOT_PREFIX = 'snapshot:';
const QUEUE_PREFIX = 'queue:';

const queueListSchema = z.array(queuedSyncEventSchema).max(200);

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withIdbStore<T>(
  mode: IDBTransactionMode,
  onUnavailable: () => T,
  run: (
    store: IDBObjectStore,
    setResult: (val: T) => void,
    defaultResult: T
  ) => void,
  defaultResult: T
): Promise<T> {
  const db = await openIdb();
  if (!db) {
    return onUnavailable();
  }

  return new Promise((resolve) => {
    let result = defaultResult;
    let settled = false;
    const finish = (value: T) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    try {
      const tx = db.transaction(STORE_NAME, mode);
      tx.oncomplete = () => {
        db.close();
        finish(result);
      };
      tx.onerror = () => {
        db.close();
        finish(defaultResult);
      };
      tx.onabort = () => {
        db.close();
        finish(defaultResult);
      };

      const store = tx.objectStore(STORE_NAME);
      run(
        store,
        (val) => {
          result = val;
        },
        defaultResult
      );
    } catch {
      db.close();
      finish(defaultResult);
    }
  });
}

async function idbGet(key: string): Promise<string | null> {
  return withIdbStore<string | null>(
    'readonly',
    () => {
      try {
        return window.localStorage.getItem(`deepwork:idb:${key}`);
      } catch {
        return null;
      }
    },
    (store, setResult) => {
      const req = store.get(key);
      req.onsuccess = () => {
        setResult(typeof req.result === 'string' ? req.result : null);
      };
    },
    null
  );
}

async function idbSet(key: string, serialized: string): Promise<void> {
  return withIdbStore<void>(
    'readwrite',
    () => {
      try {
        window.localStorage.setItem(`deepwork:idb:${key}`, serialized);
      } catch {
        // Ignore quota errors
      }
    },
    (store) => {
      store.put(serialized, key);
    },
    undefined
  );
}

async function idbDelete(key: string): Promise<void> {
  return withIdbStore<void>(
    'readwrite',
    () => {
      try {
        window.localStorage.removeItem(`deepwork:idb:${key}`);
      } catch {
        // Ignore
      }
    },
    (store) => {
      store.delete(key);
    },
    undefined
  );
}

export const syncStore = {
  async loadSnapshot(deviceId: string): Promise<CachedSnapshot | null> {
    const validId = uuidSchema.safeParse(deviceId);
    if (!validId.success) {
      return null;
    }

    const key = `${SNAPSHOT_PREFIX}${validId.data}`;
    const raw = await idbGet(key);
    if (!raw) {
      return null;
    }

    try {
      const parsed = safeJsonParse(raw);
      const validated = cachedSnapshotSchema.safeParse(parsed);
      if (!validated.success || validated.data.deviceId !== validId.data) {
        await idbDelete(key);
        return null;
      }
      return validated.data;
    } catch {
      await idbDelete(key);
      return null;
    }
  },

  async saveSnapshot(snapshot: CachedSnapshot): Promise<void> {
    const validated = cachedSnapshotSchema.safeParse(snapshot);
    if (!validated.success) {
      return;
    }
    const key = `${SNAPSHOT_PREFIX}${validated.data.deviceId}`;
    await idbSet(key, JSON.stringify(validated.data));
  },

  async loadQueue(deviceId: string): Promise<QueuedSyncEvent[]> {
    const validId = uuidSchema.safeParse(deviceId);
    if (!validId.success) {
      return [];
    }

    const key = `${QUEUE_PREFIX}${validId.data}`;
    const raw = await idbGet(key);
    if (!raw) {
      return [];
    }

    try {
      const parsed = safeJsonParse(raw);
      const validated = queueListSchema.safeParse(parsed);
      if (!validated.success) {
        await idbDelete(key);
        return [];
      }
      return validated.data;
    } catch {
      await idbDelete(key);
      return [];
    }
  },

  async saveQueue(deviceId: string, events: QueuedSyncEvent[]): Promise<void> {
    const validId = uuidSchema.safeParse(deviceId);
    if (!validId.success) {
      return;
    }

    const validated = queueListSchema.safeParse(events);
    if (!validated.success) {
      return;
    }
    const key = `${QUEUE_PREFIX}${validId.data}`;
    await idbSet(key, JSON.stringify(validated.data));
  },

  async enqueueEvent(deviceId: string, event: QueuedSyncEvent): Promise<QueuedSyncEvent[]> {
    const validEvent = queuedSyncEventSchema.parse(event);
    const current = await this.loadQueue(deviceId);
    if (current.some((item) => item.eventId === validEvent.eventId)) {
      return current;
    }
    const next = [...current, validEvent].slice(-200);
    await this.saveQueue(deviceId, next);
    return next;
  },
};
