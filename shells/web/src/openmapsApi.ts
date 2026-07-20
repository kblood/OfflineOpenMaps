// Browser-side equivalent of shells/electron/renderer/openmapsApi.ts.
//
// In Electron, the renderer talks to the main process over IPC via a
// `window.openmaps.*` bridge. In the browser, every adapter (tile source,
// geocode index, router) runs in-process against sqlite-wasm, so we
// expose the same `api` object as a plain module-level singleton.
//
// MVP scope:
//   - pack files are loaded from a user-selected directory (webkitdirectory),
//     not OPFS — `packs.list()` returns at most one entry, the currently
//     loaded pack.
//   - in-app pack builder (Geofabrik / Overpass) is NOT available because
//     both endpoints CORS-block browsers.
//   - `offline.set` is a no-op; a service worker enforcement step is a
//     future task (`shells/web/sw.ts`).
//   - selftest works, but uses the same loaded pack — it's a smoke test,
//     not a verifiable-offline proof like the Electron shell.

import type {
  Parcel,
  RegionManifest,
  RegionPack,
  SearchOptions,
  ReverseOptions,
  SearchResult,
  ReverseResult,
  RouteResult,
  Profile,
  TileBytes,
  SelfTestReport,
} from '@openmaps/core';
import { validateManifest, runSelfTest } from '@openmaps/core';
import { openSqliteFromBytes, type WebDb } from './lib/sqlite.js';
import { MbtilesTileSource } from './lib/MbtilesTileSource.js';
import { WebGeocodeIndex } from './lib/GeocodeIndex.js';
import { InternalRouter } from './lib/InternalRouter.js';
import { packStorage, type StoredPack } from './packStorage.js';
import { routingStorage } from './routingStorage.js';

// ---------------------------------------------------------------------------
// Pack types mirrored from the electron preload for UI compatibility. The
// web shell doesn't run a real packBuilder yet but the type lives here so
// any shared component that imports it doesn't fail to compile.
// ---------------------------------------------------------------------------

export type PackBuilderPhase =
  | 'starting'
  | 'downloading'
  | 'parsing'
  | 'building-tiles'
  | 'building-graph'
  | 'building-geocode'
  | 'writing-manifest'
  | 'installing'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface PackBuildProgress {
  buildId: string;
  phase: PackBuilderPhase;
  message: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
  manifestId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let currentPack: RegionPack | null = null;
let currentPackId: string | null = null;
let nationalRouter: InternalRouter | null = null;
let nationalRoutingDb: WebDb | null = null;
let nationalRoutingId: string | null = null;
let nationalRoutingBbox: [number, number, number, number] | null = null;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function verifyStoredPack(pack: StoredPack): Promise<{ ok: true } | { ok: false; problem: string }> {
  if (pack.manifest.schemaVersion === 2) {
    const file = pack.manifest.files.database!;
    const bytes = pack.database;
    if (!bytes) return { ok: false, problem: 'unified pack is missing its database bytes' };
    if (bytes.byteLength !== file.bytes) {
      return { ok: false, problem: `database size mismatch: expected ${file.bytes}, got ${bytes.byteLength}` };
    }
    if ((await sha256(bytes)) !== file.sha256) return { ok: false, problem: 'database sha256 mismatch' };
    return { ok: true };
  }
  if (pack.manifest.files.routing.path !== pack.manifest.files.geocode.path) {
    return {
      ok: false,
      problem: 'web packs with a separate routing file are not supported yet',
    };
  }
  const files = [
    ['tiles', pack.manifest.files.tiles, pack.tiles],
    ['geocode', pack.manifest.files.geocode, pack.geocode],
  ] as const;
  for (const [name, file, bytes] of files) {
    if (!bytes) return { ok: false, problem: `${name} bytes missing` };
    if (bytes.byteLength !== file.bytes) {
      return { ok: false, problem: `${name} size mismatch: expected ${file.bytes}, got ${bytes.byteLength}` };
    }
    if ((await sha256(bytes)) !== file.sha256) return { ok: false, problem: `${name} sha256 mismatch` };
  }
  return { ok: true };
}

async function openStoredPack(stored: StoredPack): Promise<RegionManifest> {
  const verification = await verifyStoredPack(stored);
  if (!verification.ok) throw new Error(`pack '${stored.manifest.id}' failed verification: ${verification.problem}`);
  if (currentPack) await currentPack.close();

  if (stored.manifest.schemaVersion === 2) {
    if (!stored.database) throw new Error(`unified pack '${stored.manifest.id}' is missing its database bytes`);
    // One connection serves tiles, search and routing. This is the critical
    // difference from a split pack: do not deserialize a country database
    // twice merely because it has two logical consumers.
    const database = await openSqliteFromBytes(new Uint8Array(stored.database));
    const tiles = new MbtilesTileSource(database);
    const geocode = new WebGeocodeIndex(database);
    const router = new InternalRouter(database);
    currentPack = {
      manifest: stored.manifest,
      tiles,
      geocode,
      router,
      async close() { database.close(); },
    };
    currentPackId = stored.manifest.id;
    return stored.manifest;
  }
  if (!stored.tiles || !stored.geocode) throw new Error(`split pack '${stored.manifest.id}' is missing data bytes`);
  const tilesDb = await openSqliteFromBytes(new Uint8Array(stored.tiles));
  const geocodeDb = await openSqliteFromBytes(new Uint8Array(stored.geocode));
  const tiles = new MbtilesTileSource(tilesDb);
  const geocode = new WebGeocodeIndex(geocodeDb);
  const router = new InternalRouter(geocodeDb);
  currentPack = {
    manifest: stored.manifest,
    tiles,
    geocode,
    router,
    async close() {
      await tiles.close();
      try { geocodeDb.close(); } catch { /* already closed */ }
    },
  };
  currentPackId = stored.manifest.id;
  return stored.manifest;
}

function requirePack(): RegionPack {
  if (!currentPack) throw new Error('no pack open');
  return currentPack;
}

// ---------------------------------------------------------------------------
// Pack loading
// ---------------------------------------------------------------------------

/**
 * Open a pack from a user-picked directory. The browser hands us a
 * `FileList` from an `<input webkitdirectory>` element; we find the three
 * files we need by name (case-insensitively) and deserialize them into
 * in-memory SQLite databases.
 *
 * The geocode db is shared between the geocode index and the router — it
 * contains both the FTS5 places table and the road graph.
 */
export async function loadPackFromDirectory(files: FileList): Promise<RegionManifest> {
  const byName = new Map<string, File>();
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i]!;
    // `webkitRelativePath` is "<dirname>/<filename>"; we want just the leaf.
    const leaf = f.name.toLowerCase();
    byName.set(leaf, f);
  }

  const manifestFile = byName.get('manifest.json');
  const tilesFile = byName.get('tiles.mbtiles');
  const geocodeFile = byName.get('geocode.sqlite');
  const databaseFile = byName.get('openmaps.sqlite');

  if (!manifestFile) throw new Error('pack folder is missing manifest.json');
  const manifest = validateManifest(JSON.parse(await manifestFile.text()) as unknown);
  if (manifest.schemaVersion === 2 && !databaseFile) throw new Error('unified pack folder is missing openmaps.sqlite');
  if (manifest.schemaVersion === 1 && !tilesFile) throw new Error('pack folder is missing tiles.mbtiles');
  if (manifest.schemaVersion === 1 && !geocodeFile) throw new Error('pack folder is missing geocode.sqlite');

  const stored: StoredPack = manifest.schemaVersion === 2
    ? { manifest, database: await databaseFile!.arrayBuffer(), installedAt: new Date().toISOString() }
    : {
        manifest,
        tiles: await tilesFile!.arrayBuffer(),
        geocode: await geocodeFile!.arrayBuffer(),
        installedAt: new Date().toISOString(),
      };
  const verification = await verifyStoredPack(stored);
  if (!verification.ok) throw new Error(`pack failed verification: ${verification.problem}`);
  await packStorage.put(stored);
  return openStoredPack(stored);
}

export async function closeCurrentPack(): Promise<void> {
  if (currentPack) {
    await currentPack.close();
    currentPack = null;
    currentPackId = null;
  }
}

export async function getPackStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  return packStorage.estimate();
}

// ---------------------------------------------------------------------------
// Remote pack download
//
// Packs hosted at `./packs/<id>/{manifest.json,tiles.mbtiles,geocode.sqlite}`
// can be downloaded and loaded into memory the same way as a folder-picked
// pack. `packs.json` at `./packs/packs.json` lists what's available.
// ---------------------------------------------------------------------------

export interface RemotePackEntry {
  id: string;
  name: string;
  country: string;
  bbox: [number, number, number, number];
  builtAt: string;
  /** Total bytes across manifest + tiles + geocode files. */
  totalBytes: number;
  /** Relative URL to the pack folder, e.g. "aalborg/". */
  baseUrl: string;
}

export interface RemotePackIndex {
  packs: RemotePackEntry[];
  collections?: RemotePackCollection[];
  routingBundles?: RemoteRoutingBundle[];
}

/** A separately downloadable country graph, never a map pack. */
export interface RemoteRoutingBundle {
  id: string;
  name: string;
  country: string;
  bbox: [number, number, number, number];
  baseUrl: string;
  file: { path: string; bytes: number; sha256: string };
  profiles: Profile[];
  description: string;
}

/** A country-sized download composed of independently usable regional packs. */
export interface RemotePackCollection {
  id: string;
  name: string;
  country: string;
  bbox: [number, number, number, number];
  description: string;
  members: string[];
}

export interface RemoteCatalog {
  packs: RemotePackEntry[];
  collections: RemotePackCollection[];
  routingBundles: RemoteRoutingBundle[];
}

export async function fetchAvailablePacks(
  indexUrl = './packs/packs.json',
): Promise<RemoteCatalog> {
  const res = await fetch(indexUrl, { cache: 'no-cache' });
  if (!res.ok) {
    // 404 just means no packs are hosted yet — return empty rather than
    // forcing every caller to handle the error.
    if (res.status === 404) return { packs: [], collections: [], routingBundles: [] };
    throw new Error(`pack index ${indexUrl} returned ${res.status}`);
  }
  const data = (await res.json()) as RemotePackIndex;
  return {
    packs: Array.isArray(data.packs) ? data.packs : [],
    collections: Array.isArray(data.collections) ? data.collections : [],
    routingBundles: Array.isArray(data.routingBundles) ? data.routingBundles : [],
  };
}

export interface RoutingDownloadProgress { bytesReceived: number; bytesTotal: number; }

async function openNationalRouting(id: string, bytes: ArrayBuffer, bbox?: [number, number, number, number]): Promise<void> {
  if (nationalRoutingDb) try { nationalRoutingDb.close(); } catch { /* already closed */ }
  nationalRoutingDb = await openSqliteFromBytes(new Uint8Array(bytes));
  nationalRouter = new InternalRouter(nationalRoutingDb);
  nationalRoutingId = id;
  nationalRoutingBbox = bbox ?? nationalRoutingBbox;
}

async function installNationalRouting(entry: RemoteRoutingBundle, onProgress?: (p: RoutingDownloadProgress) => void): Promise<void> {
  const bytes = await fetchWithProgress(`./packs/${entry.baseUrl}${entry.file.path}`, (bytesReceived, bytesTotal) => onProgress?.({ bytesReceived, bytesTotal }));
  const buffer = copyToArrayBuffer(bytes);
  if (buffer.byteLength !== entry.file.bytes) throw new Error(`national routing size mismatch: expected ${entry.file.bytes}, got ${buffer.byteLength}`);
  if ((await sha256(buffer)) !== entry.file.sha256) throw new Error('national routing sha256 mismatch');
  await routingStorage.put({ id: entry.id, bytes: buffer, installedAt: new Date().toISOString(), bbox: entry.bbox });
  await openNationalRouting(entry.id, buffer, entry.bbox);
}

export interface PackDownloadProgress {
  step: 'manifest' | 'tiles' | 'geocode' | 'database';
  bytesReceived: number;
  /** 0 if Content-Length wasn't sent. */
  bytesTotal: number;
}

/**
 * Download a pack from a remote URL into memory and open it.
 *
 * `baseUrl` may be absolute or relative; the function appends each known
 * filename. Progress is reported per file. Aborting (page reload, browser
 * tab close) cancels the in-flight fetches naturally; we don't expose an
 * explicit AbortController in MVP since the loader UI doesn't have a
 * cancel button yet.
 */
export async function loadPackFromUrl(
  baseUrl: string,
  onProgress?: (p: PackDownloadProgress) => void,
): Promise<RegionManifest> {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';

  const manifestRes = await fetch(base + 'manifest.json', { cache: 'no-cache' });
  if (!manifestRes.ok) {
    throw new Error(`manifest.json: HTTP ${manifestRes.status}`);
  }
  onProgress?.({ step: 'manifest', bytesReceived: 0, bytesTotal: 0 });
  const manifestText = await manifestRes.text();
  const manifest = validateManifest(JSON.parse(manifestText) as unknown);
  onProgress?.({
    step: 'manifest',
    bytesReceived: manifestText.length,
    bytesTotal: manifestText.length,
  });

  // Cache-buster keyed on the manifest's builtAt timestamp. Different
  // build → different URL → guaranteed fresh fetch, even past any
  // sticky intermediate cache. `cache: 'no-cache'` only forces
  // revalidation, which is enough on a well-behaved server but can still
  // hand back a stale body via a misconfigured proxy or service worker.
  const v = encodeURIComponent(manifest.builtAt);

  if (manifest.schemaVersion === 2) {
    const databaseBytes = await fetchWithProgress(`${base}${manifest.files.database!.path}?v=${v}`, (received, total) => {
      onProgress?.({ step: 'database', bytesReceived: received, bytesTotal: total });
    });
    const stored: StoredPack = {
      manifest,
      database: copyToArrayBuffer(databaseBytes),
      installedAt: new Date().toISOString(),
    };
    const verification = await verifyStoredPack(stored);
    if (!verification.ok) throw new Error(`downloaded pack failed verification: ${verification.problem}`);
    await packStorage.put(stored);
    return openStoredPack(stored);
  }

  const tilesBytes = await fetchWithProgress(`${base}${manifest.files.tiles.path}?v=${v}`, (received, total) => {
    onProgress?.({ step: 'tiles', bytesReceived: received, bytesTotal: total });
  });
  const geocodeBytes = await fetchWithProgress(`${base}${manifest.files.geocode.path}?v=${v}`, (received, total) => {
    onProgress?.({ step: 'geocode', bytesReceived: received, bytesTotal: total });
  });

  const stored: StoredPack = {
    manifest,
    tiles: copyToArrayBuffer(tilesBytes),
    geocode: copyToArrayBuffer(geocodeBytes),
    installedAt: new Date().toISOString(),
  };
  const verification = await verifyStoredPack(stored);
  if (!verification.ok) throw new Error(`downloaded pack failed verification: ${verification.problem}`);
  await packStorage.put(stored);
  return openStoredPack(stored);
}

/**
 * Stream a binary fetch into a Uint8Array, reporting progress as bytes
 * arrive. Used for the two large pack files (tiles + geocode); the small
 * manifest doesn't need streaming.
 */
async function fetchWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? '0');
  // Apache + gzip can elide Content-Length when chunking, so we don't
  // require it — callers just see total=0 and render a spinner instead.
  if (!res.body) {
    // No streaming available — fall back to whole-body read.
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// api: shape-compatible with shells/electron/renderer/openmapsApi.ts so
// the same React components consume both.
// ---------------------------------------------------------------------------

interface OpenMapsApi {
  packs: {
    list(): Promise<RegionManifest[]>;
    open(packId: string): Promise<RegionManifest>;
    close(): Promise<void>;
    current(): Promise<RegionManifest | null>;
    verify(packId: string): Promise<{ ok: true } | { ok: false; problem: string }>;
    uninstall(packId: string): Promise<void>;
  };
  tiles: {
    get(z: number, x: number, y: number): Promise<TileBytes | null>;
  };
  geocode: {
    search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
    reverse(lat: number, lon: number, opts?: ReverseOptions): Promise<ReverseResult | null>;
    getParcel(parcelId: string): Promise<Parcel | null>;
  };
  route: {
    compute(
      waypoints: ReadonlyArray<{ lat: number; lon: number }>,
      profile: Profile,
    ): Promise<RouteResult>;
  };
  nationalRouting: {
    list(): Promise<Array<{ id: string; installedAt: string }>>;
    install(entry: RemoteRoutingBundle, onProgress?: (p: RoutingDownloadProgress) => void): Promise<void>;
    open(id: string): Promise<void>;
    current(): Promise<string | null>;
    uninstall(id: string): Promise<void>;
  };
  offline: {
    set(offline: boolean): Promise<boolean>;
    get(): Promise<boolean>;
  };
  selftest: {
    run(): Promise<SelfTestReport>;
  };
}

export const api: OpenMapsApi = {
  packs: {
    async list() {
      return (await packStorage.list()).map((pack) => pack.manifest);
    },
    async open(packId: string) {
      const stored = await packStorage.get(packId);
      if (!stored) throw new Error(`pack '${packId}' is not installed`);
      return openStoredPack(stored);
    },
    async close() {
      await closeCurrentPack();
    },
    async current() {
      return currentPack ? currentPack.manifest : null;
    },
    async verify(packId) {
      const stored = await packStorage.get(packId);
      if (!stored) return { ok: false, problem: `pack '${packId}' is not installed` };
      return verifyStoredPack(stored);
    },
    async uninstall(packId) {
      if (currentPackId === packId) await closeCurrentPack();
      await packStorage.remove(packId);
    },
  },
  tiles: {
    async get(z, x, y) {
      return requirePack().tiles.getTile(z, x, y);
    },
  },
  geocode: {
    async search(query, opts) {
      return requirePack().geocode.search(query, opts);
    },
    async reverse(lat, lon, opts) {
      return requirePack().geocode.reverse(lat, lon, opts);
    },
    async getParcel(parcelId) {
      return requirePack().geocode.getParcel(parcelId);
    },
  },
  route: {
    async compute(waypoints, profile) {
      const routingBbox = nationalRoutingBbox;
      if (profile === 'car' && nationalRouter && routingBbox && waypoints.every((p) => insideBbox(p, routingBbox))) {
        return nationalRouter.route({ waypoints, profile });
      }
      return requirePack().router.route({ waypoints, profile });
    },
  },
  nationalRouting: {
    async list() { return (await routingStorage.list()).map((entry) => ({ id: entry.id, installedAt: entry.installedAt })); },
    async install(entry, onProgress) { await installNationalRouting(entry, onProgress); },
    async open(id) {
      const stored = await routingStorage.get(id);
      if (!stored) throw new Error(`national routing '${id}' is not installed`);
      await openNationalRouting(id, stored.bytes, stored.bbox);
    },
    async current() { return nationalRoutingId; },
    async uninstall(id) {
      if (nationalRoutingId === id) {
        if (nationalRoutingDb) try { nationalRoutingDb.close(); } catch { /* already closed */ }
        nationalRoutingDb = null;
        nationalRouter = null;
        nationalRoutingId = null;
        nationalRoutingBbox = null;
      }
      await routingStorage.remove(id);
    },
  },
  offline: {
    async set() {
      // No-op in MVP. A service worker that drops network requests
      // is the planned path to a verifiable-offline guarantee.
      return false;
    },
    async get() {
      // The browser is always "online" from our perspective in MVP.
      return false;
    },
  },
  selftest: {
    async run() {
      return runSelfTest(requirePack());
    },
  },
};

function insideBbox(point: { lat: number; lon: number }, bbox: [number, number, number, number]): boolean {
  return point.lon >= bbox[0] && point.lon <= bbox[2] && point.lat >= bbox[1] && point.lat <= bbox[3];
}
