import type { RegionManifest } from '@openmaps/core';

export interface StoredPack {
  manifest: RegionManifest;
  /** Present for schema v1 split packs. */
  tiles?: ArrayBuffer;
  /** Present for schema v1 split packs. */
  geocode?: ArrayBuffer;
  /** Present for small schema v2 packs on the in-memory fallback. */
  database?: ArrayBuffer;
  /** Absolute sqlite-wasm OPFS path for worker-backed schema v2 packs. */
  databaseOpfsPath?: string;
  installedAt: string;
}

interface StoredPackIndex {
  manifest: RegionManifest;
  installedAt: string;
  backend: 'opfs' | 'indexeddb';
  /** Content-addressed directory. Older entries implicitly use manifest.id. */
  opfsDir?: string;
  tiles?: ArrayBuffer;
  geocode?: ArrayBuffer;
  database?: ArrayBuffer;
}

export interface OpfsInstallProgress {
  bytesReceived: number;
  bytesTotal: number;
}

export interface StoredRoutingSource {
  id: string;
  country: string;
  bbox: [number, number, number, number];
  path: string;
}

type InstallerRequest =
  | { id: number; operation: 'install-url'; directory: string; path: string; url: string; bytes: number; sha256: string }
  | { id: number; operation: 'install-file'; directory: string; path: string; file: File; bytes: number; sha256: string }
  | { id: number; operation: 'verify'; directory: string; path: string; bytes: number; sha256: string };

type InstallerCommand =
  | { operation: 'install-url'; directory: string; path: string; url: string; bytes: number; sha256: string }
  | { operation: 'install-file'; directory: string; path: string; file: File; bytes: number; sha256: string }
  | { operation: 'verify'; directory: string; path: string; bytes: number; sha256: string };

type InstallerResponse =
  | { id: number; type: 'progress'; bytesReceived: number; bytesTotal: number }
  | { id: number; type: 'result'; ok: true }
  | { id: number; type: 'result'; ok: false; error: string; errorName?: string };

const DB_NAME = 'openmaps-v2';
const STORE_NAME = 'packs';
export const OPFS_PACKS_DIR = 'openmaps-v2-packs';

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

async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

export function supportsOpfsSqliteRuntime(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function'
    && typeof Worker !== 'undefined'
    && typeof SharedArrayBuffer !== 'undefined'
    && globalThis.crossOriginIsolated === true;
}

export const packStorage = {
  async list(): Promise<StoredPackIndex[]> {
    return transaction('readonly', (store) => store.getAll());
  },

  /** Routing-only OPFS descriptors; databases remain out of the UI heap. */
  async listRoutingSources(country: string): Promise<StoredRoutingSource[]> {
    if (!supportsOpfsSqliteRuntime()) return [];
    const installed = await transaction<StoredPackIndex[]>('readonly', (store) => store.getAll());
    const sources: StoredRoutingSource[] = [];
    for (const stored of installed) {
      if (stored.backend !== 'opfs' || stored.manifest.country !== country) continue;
      const manifest = stored.manifest;
      const routingFile = manifest.files.routing;
      const physicallyStored = manifest.schemaVersion === 2
        ? manifest.files.database!.path
        : manifest.files.geocode.path;
      if (routingFile.path !== physicallyStored) continue;
      const directory = stored.opfsDir ?? manifest.id;
      sources.push({
        id: manifest.id,
        country: manifest.country,
        bbox: [...manifest.bbox],
        path: `/${OPFS_PACKS_DIR}/${directory}/${routingFile.path}`,
      });
    }
    return sources;
  },

  async get(id: string): Promise<StoredPack | undefined> {
    const stored = await transaction<StoredPackIndex | undefined>('readonly', (store) => store.get(id));
    if (!stored) return undefined;
    if (stored.backend === 'opfs') {
      try {
        const directory = stored.opfsDir ?? id;
        const dir = await getOpfsPackDir(directory, false);
        if (stored.manifest.schemaVersion === 2) {
          const file = stored.manifest.files.database!;
          const actual = await (await dir.getFileHandle(file.path)).getFile();
          if (actual.size !== file.bytes) return undefined;
          return {
            manifest: stored.manifest,
            installedAt: stored.installedAt,
            databaseOpfsPath: `/${OPFS_PACKS_DIR}/${directory}/${file.path}`,
          };
        }
        return {
          manifest: stored.manifest,
          installedAt: stored.installedAt,
          tiles: await readOpfsFile(dir, stored.manifest.files.tiles.path),
          geocode: await readOpfsFile(dir, stored.manifest.files.geocode.path),
        };
      } catch {
        return undefined;
      }
    }
    if (stored.manifest.schemaVersion === 2) {
      return stored.database ? { manifest: stored.manifest, installedAt: stored.installedAt, database: stored.database } : undefined;
    }
    if (!stored.tiles || !stored.geocode) return undefined;
    return { manifest: stored.manifest, installedAt: stored.installedAt, tiles: stored.tiles, geocode: stored.geocode };
  },

  async put(pack: StoredPack): Promise<void> {
    const useOpfs = pack.manifest.schemaVersion === 2 ? supportsOpfsSqliteRuntime() : await supportsOpfs();
    if (useOpfs) {
      const directory = contentDirectory(pack.manifest);
      const dir = await getOpfsPackDir(directory, true);
      if (pack.manifest.schemaVersion === 2) {
        if (!pack.database) throw new Error('unified pack is missing its database bytes');
        await writeOpfsFile(dir, pack.manifest.files.database!.path, pack.database);
      } else {
        if (!pack.tiles || !pack.geocode) throw new Error('split pack is missing tiles or geocode bytes');
        await writeOpfsFile(dir, pack.manifest.files.tiles.path, pack.tiles);
        await writeOpfsFile(dir, pack.manifest.files.geocode.path, pack.geocode);
      }
      await writeOpfsFile(dir, 'manifest.json', JSON.stringify(pack.manifest));
      await registerOpfsPack(pack.manifest, directory, pack.installedAt);
      return;
    }
    await transaction('readwrite', (store) => store.put({ ...pack, backend: 'indexeddb' } satisfies StoredPackIndex));
  },

  async installUnifiedFromUrl(
    manifest: RegionManifest,
    url: string,
    onProgress?: (progress: OpfsInstallProgress) => void,
  ): Promise<StoredPack> {
    assertUnifiedOpfs(manifest);
    const directory = contentDirectory(manifest);
    const file = manifest.files.database!;
    await requestPersistentStorage();
    await runInstaller({ operation: 'install-url', directory, path: file.path, url, bytes: file.bytes, sha256: file.sha256 }, onProgress);
    const installedAt = new Date().toISOString();
    await writeManifest(directory, manifest);
    await registerOpfsPack(manifest, directory, installedAt);
    return { manifest, installedAt, databaseOpfsPath: `/${OPFS_PACKS_DIR}/${directory}/${file.path}` };
  },

  async installUnifiedFromFile(
    manifest: RegionManifest,
    fileSource: File,
    onProgress?: (progress: OpfsInstallProgress) => void,
  ): Promise<StoredPack> {
    assertUnifiedOpfs(manifest);
    const expected = manifest.files.database!;
    if (fileSource.size !== expected.bytes) {
      throw new Error(`database size mismatch: expected ${expected.bytes}, got ${fileSource.size}`);
    }
    const directory = contentDirectory(manifest);
    await requestPersistentStorage();
    await runInstaller({ operation: 'install-file', directory, path: expected.path, file: fileSource, bytes: expected.bytes, sha256: expected.sha256 }, onProgress);
    const installedAt = new Date().toISOString();
    await writeManifest(directory, manifest);
    await registerOpfsPack(manifest, directory, installedAt);
    return { manifest, installedAt, databaseOpfsPath: `/${OPFS_PACKS_DIR}/${directory}/${expected.path}` };
  },

  async verify(id: string): Promise<{ ok: true } | { ok: false; problem: string }> {
    const stored = await transaction<StoredPackIndex | undefined>('readonly', (store) => store.get(id));
    if (!stored) return { ok: false, problem: `pack '${id}' is not installed` };
    if (stored.backend !== 'opfs' || stored.manifest.schemaVersion !== 2) {
      return { ok: false, problem: 'streaming verification is only available for OPFS unified packs' };
    }
    const file = stored.manifest.files.database!;
    try {
      await runInstaller({ operation: 'verify', directory: stored.opfsDir ?? id, path: file.path, bytes: file.bytes, sha256: file.sha256 });
      return { ok: true };
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error) };
    }
  },

  async remove(id: string): Promise<void> {
    const stored = await transaction<StoredPackIndex | undefined>('readonly', (store) => store.get(id));
    await transaction('readwrite', (store) => store.delete(id));
    if (await supportsOpfs()) {
      try {
        const root = await navigator.storage.getDirectory();
        const packs = await root.getDirectoryHandle(OPFS_PACKS_DIR);
        await packs.removeEntry(stored?.opfsDir ?? id, { recursive: true });
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

function assertUnifiedOpfs(manifest: RegionManifest): void {
  if (manifest.schemaVersion !== 2) throw new Error('streaming OPFS install requires a schema v2 unified pack');
  if (!supportsOpfsSqliteRuntime()) {
    throw new Error('Large web maps require OPFS, Web Workers, SharedArrayBuffer, and cross-origin isolation. Use a current Chromium browser and serve OpenMaps with COOP/COEP headers.');
  }
}

function contentDirectory(manifest: RegionManifest): string {
  const digest = manifest.schemaVersion === 2 ? manifest.files.database!.sha256 : manifest.files.tiles.sha256;
  return `${manifest.id}-${digest.slice(0, 16)}`;
}

async function registerOpfsPack(manifest: RegionManifest, opfsDir: string, installedAt: string): Promise<void> {
  const previous = await transaction<StoredPackIndex | undefined>('readonly', (store) => store.get(manifest.id));
  await transaction('readwrite', (store) => store.put({ manifest, installedAt, backend: 'opfs', opfsDir } satisfies StoredPackIndex));
  const previousDirectory = previous?.backend === 'opfs' ? (previous.opfsDir ?? manifest.id) : null;
  if (previousDirectory && previousDirectory !== opfsDir) {
    try {
      const root = await navigator.storage.getDirectory();
      const packs = await root.getDirectoryHandle(OPFS_PACKS_DIR);
      await packs.removeEntry(previousDirectory, { recursive: true });
    } catch {
      // The newly registered version is valid; stale-version cleanup is best effort.
    }
  }
}

async function writeManifest(directory: string, manifest: RegionManifest): Promise<void> {
  await writeOpfsFile(await getOpfsPackDir(directory, true), 'manifest.json', JSON.stringify(manifest));
}

async function requestPersistentStorage(): Promise<void> {
  // Persistence protects a multi-gigabyte offline map from automatic eviction
  // and can expand the effective quota in some browsers. A denied request is
  // not fatal: quota estimates are volatile and some browsers grow storage or
  // prompt only when an actual OPFS write approaches the current allowance.
  try { await navigator.storage.persist?.(); } catch { /* continue best-effort */ }
}

async function runInstaller(
  request: InstallerCommand,
  onProgress?: (progress: OpfsInstallProgress) => void,
): Promise<void> {
  const worker = new Worker(new URL('./lib/opfsInstaller.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const cleanup = () => worker.terminate();
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'OPFS installer worker failed'));
    };
    worker.onmessage = (event: MessageEvent<InstallerResponse>) => {
      const message = event.data;
      if (message.id !== 1) return;
      if (message.type === 'progress') {
        onProgress?.({ bytesReceived: message.bytesReceived, bytesTotal: message.bytesTotal });
        return;
      }
      cleanup();
      if (message.ok) resolve();
      else if (message.errorName === 'QuotaExceededError') {
        reject(new Error(`${message.error} The completed part is saved; free browser/disk space and select Denmark again to resume.`));
      } else reject(new Error(message.error));
    };
    worker.postMessage({ ...request, id: 1 } as InstallerRequest);
  });
}

async function supportsOpfs(): Promise<boolean> {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function getOpfsPackDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const packs = await root.getDirectoryHandle(OPFS_PACKS_DIR, { create });
  return packs.getDirectoryHandle(id, { create });
}

async function writeOpfsFile(dir: FileSystemDirectoryHandle, name: string, data: ArrayBuffer | string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readOpfsFile(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer> {
  return (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
}
