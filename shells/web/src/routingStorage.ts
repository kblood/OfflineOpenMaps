/** Persistent storage for country routing companions. Kept separate from map
 * packs because a routing graph has no tiles or search index. */
export interface StoredRoutingBundle {
  id: string;
  bytes: ArrayBuffer;
  installedAt: string;
  bbox: [number, number, number, number];
}

interface StoredRoutingIndex {
  id: string;
  installedAt: string;
  backend: 'opfs' | 'indexeddb';
  bytes?: ArrayBuffer;
  bbox: [number, number, number, number];
}

const DB_NAME = 'openmaps-v2-routing';
const STORE = 'bundles';
const OPFS_DIR = 'openmaps-v2-routing';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open national routing storage'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('national routing storage operation failed'));
    });
  } finally { db.close(); }
}

async function supportsOpfs(): Promise<boolean> {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

export const routingStorage = {
  async list(): Promise<StoredRoutingIndex[]> { return transaction('readonly', (store) => store.getAll()); },
  async get(id: string): Promise<StoredRoutingBundle | undefined> {
    const entry = await transaction<StoredRoutingIndex | undefined>('readonly', (store) => store.get(id));
    if (!entry) return undefined;
    if (entry.backend === 'indexeddb') return entry.bytes ? { id, bytes: entry.bytes, installedAt: entry.installedAt, bbox: entry.bbox } : undefined;
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR);
      const file = await (await dir.getFileHandle(`${id}.sqlite`)).getFile();
      return { id, bytes: await file.arrayBuffer(), installedAt: entry.installedAt, bbox: entry.bbox };
    } catch { return undefined; }
  },
  async put(bundle: StoredRoutingBundle): Promise<void> {
    if (await supportsOpfs()) {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      const writable = await (await dir.getFileHandle(`${bundle.id}.sqlite`, { create: true })).createWritable();
      await writable.write(bundle.bytes);
      await writable.close();
      await transaction('readwrite', (store) => store.put({ id: bundle.id, installedAt: bundle.installedAt, bbox: bundle.bbox, backend: 'opfs' } satisfies StoredRoutingIndex));
      return;
    }
    await transaction('readwrite', (store) => store.put({ ...bundle, backend: 'indexeddb' } satisfies StoredRoutingIndex));
  },
  async remove(id: string): Promise<void> {
    await transaction('readwrite', (store) => store.delete(id));
    if (await supportsOpfs()) try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR);
      await dir.removeEntry(`${id}.sqlite`);
    } catch { /* already absent */ }
  },
};
