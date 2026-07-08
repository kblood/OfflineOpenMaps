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

  if (!manifestFile) throw new Error('pack folder is missing manifest.json');
  if (!tilesFile) throw new Error('pack folder is missing tiles.mbtiles');
  if (!geocodeFile) throw new Error('pack folder is missing geocode.sqlite');

  const manifest = validateManifest(JSON.parse(await manifestFile.text()) as unknown);

  // Close any previously-open pack before loading the new one.
  if (currentPack) {
    await currentPack.close();
    currentPack = null;
    currentPackId = null;
  }

  const tilesBytes = new Uint8Array(await tilesFile.arrayBuffer());
  const geocodeBytes = new Uint8Array(await geocodeFile.arrayBuffer());

  const tilesDb = await openSqliteFromBytes(tilesBytes);
  const geocodeDb = await openSqliteFromBytes(geocodeBytes);

  const tiles = new MbtilesTileSource(tilesDb);
  const geocode = new WebGeocodeIndex(geocodeDb);
  const router = new InternalRouter(geocodeDb);

  const pack: RegionPack = {
    manifest,
    tiles,
    geocode,
    router,
    async close() {
      await tiles.close();
      // tiles.close() also closes the tiles db; geocode db is shared with
      // the router so we close it directly here.
      try {
        geocodeDb.close();
      } catch {
        // already closed
      }
    },
  };

  currentPack = pack;
  currentPackId = manifest.id;
  return manifest;
}

export async function closeCurrentPack(): Promise<void> {
  if (currentPack) {
    await currentPack.close();
    currentPack = null;
    currentPackId = null;
  }
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
}

export async function fetchAvailablePacks(
  indexUrl = './packs/packs.json',
): Promise<RemotePackEntry[]> {
  const res = await fetch(indexUrl, { cache: 'no-cache' });
  if (!res.ok) {
    // 404 just means no packs are hosted yet — return empty rather than
    // forcing every caller to handle the error.
    if (res.status === 404) return [];
    throw new Error(`pack index ${indexUrl} returned ${res.status}`);
  }
  const data = (await res.json()) as RemotePackIndex;
  return Array.isArray(data.packs) ? data.packs : [];
}

export interface PackDownloadProgress {
  step: 'manifest' | 'tiles' | 'geocode';
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

  const tilesBytes = await fetchWithProgress(`${base}tiles.mbtiles?v=${v}`, (received, total) => {
    onProgress?.({ step: 'tiles', bytesReceived: received, bytesTotal: total });
  });
  const geocodeBytes = await fetchWithProgress(`${base}geocode.sqlite?v=${v}`, (received, total) => {
    onProgress?.({ step: 'geocode', bytesReceived: received, bytesTotal: total });
  });

  if (currentPack) {
    await currentPack.close();
    currentPack = null;
    currentPackId = null;
  }

  const tilesDb = await openSqliteFromBytes(tilesBytes);
  const geocodeDb = await openSqliteFromBytes(geocodeBytes);

  const tiles = new MbtilesTileSource(tilesDb);
  const geocode = new WebGeocodeIndex(geocodeDb);
  const router = new InternalRouter(geocodeDb);

  const pack: RegionPack = {
    manifest,
    tiles,
    geocode,
    router,
    async close() {
      await tiles.close();
      try {
        geocodeDb.close();
      } catch {
        // already closed
      }
    },
  };

  currentPack = pack;
  currentPackId = manifest.id;
  return manifest;
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
      return currentPack ? [currentPack.manifest] : [];
    },
    async open(packId: string) {
      if (!currentPack || currentPackId !== packId) {
        throw new Error(`pack ${packId} is not loaded — pick its folder via the loader`);
      }
      return currentPack.manifest;
    },
    async close() {
      await closeCurrentPack();
    },
    async current() {
      return currentPack ? currentPack.manifest : null;
    },
    async verify() {
      // MVP: we don't keep the raw bytes around to re-hash. Trust the
      // pack the user just loaded; verification is a future step that
      // would happen at load time.
      return { ok: true };
    },
    async uninstall() {
      await closeCurrentPack();
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
      return requirePack().router.route({ waypoints, profile });
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
