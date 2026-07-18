import type { RegionManifest } from '@openmaps/core';

export interface StoredPack {
  manifest: RegionManifest;
  tiles: ArrayBuffer;
  geocode: ArrayBuffer;
  installedAt: string;
}

interface StoredPackIndex {
  manifest: RegionManifest;
  installedAt: string;
  backend: 'opfs' | 'indexeddb';
  /** Kept only for browsers without OPFS support. */
  tiles?: ArrayBuffer;
  /** Kept only for browsers without OPFS support. */
  geocode?: ArrayBuffer;
}

const DB_NAME = 'openmaps-v2';
const STORE_NAME = 'packs';
const OPFS_DIR = 'openmaps-v2-packs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'manifest.id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open browser storage'));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('browser storage operation failed'));
    });
  } finally {
    db.close();
  }
}

export const packStorage = {
  async list(): Promise<StoredPackIndex[]> {
    return transaction('readonly', (store) => store.getAll());
  },

  async get(id: string): Promise<StoredPack | undefined> {
    const stored = await transaction<StoredPackIndex | undefined>('readonly', (store) => store.get(id));
    if (!stored) return undefined;
    if (stored.backend === 'opfs') {
      try {
        const dir = await getOpfsPackDir(id, false);
        return {
          manifest: stored.manifest,
          installedAt: stored.installedAt,
          tiles: await readOpfsFile(dir, 'tiles.mbtiles'),
          geocode: await readOpfsFile(dir, 'geocode.sqlite'),
        };
      } catch {
        return undefined;
      }
    }
    if (!stored.tiles || !stored.geocode) return undefined;
    return {
      manifest: stored.manifest,
      installedAt: stored.installedAt,
      tiles: stored.tiles,
      geocode: stored.geocode,
    };
  },

  async put(pack: StoredPack): Promise<void> {
    if (await supportsOpfs()) {
      const dir = await getOpfsPackDir(pack.manifest.id, true);
      await writeOpfsFile(dir, 'tiles.mbtiles', pack.tiles);
      await writeOpfsFile(dir, 'geocode.sqlite', pack.geocode);
      await writeOpfsFile(dir, 'manifest.json', JSON.stringify(pack.manifest));
      await transaction('readwrite', (store) => store.put({
        manifest: pack.manifest,
        installedAt: pack.installedAt,
        backend: 'opfs',
      } satisfies StoredPackIndex));
      return;
    }
    await transaction('readwrite', (store) => store.put({
      ...pack,
      backend: 'indexeddb',
    } satisfies StoredPackIndex));
  },

  async remove(id: string): Promise<void> {
    await transaction('readwrite', (store) => store.delete(id));
    if (await supportsOpfs()) {
      try {
        const root = await navigator.storage.getDirectory();
        const packs = await root.getDirectoryHandle(OPFS_DIR);
        await packs.removeEntry(id, { recursive: true });
      } catch {
        // Missing OPFS files are equivalent to an already-removed pack.
      }
    }
  },

  async estimate(): Promise<{ usage: number; quota: number } | null> {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  },
};

async function supportsOpfs(): Promise<boolean> {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function getOpfsPackDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const packs = await root.getDirectoryHandle(OPFS_DIR, { create });
  return packs.getDirectoryHandle(id, { create });
}

async function writeOpfsFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readOpfsFile(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer> {
  return (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
}
