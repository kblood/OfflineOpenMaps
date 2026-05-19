import { BrowserWindow, ipcMain } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  readOsmXml,
  readOsmPbf,
  osmToPack,
  writeMbtiles,
  writeGeocodeDb,
  writeManifest,
  chooseAnchors,
} from '@openmaps/region-builder';
import { GEOFABRIK_COUNTRIES, type GeofabrikCountry } from './geofabrikCountries.js';

/**
 * In-app pack builder. Downloads OSM data and runs the region-builder
 * pipeline in the main process, then installs the resulting pack into
 * the packs/ directory so it appears in the PackPicker on next refresh.
 *
 * Network policy: this is the ONE part of the app that talks to the
 * internet by design. The startBuild handler refuses to run when offline
 * mode is enabled, so the user gets a clear error rather than a silent
 * stall. We use the same `fetch` global that the renderer uses, so a
 * future test could intercept it.
 *
 * Build IDs: each in-flight build has a unique id used for cancel +
 * progress correlation. Multiple builds can run concurrently (though the
 * UI restricts the user to one at a time).
 */

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
  /** Free-form human-readable status; shown directly in the UI. */
  message: string;
  /** Bytes downloaded so far (only set during the `downloading` phase). */
  bytesDownloaded?: number;
  /** Total expected bytes (only set when the server provides Content-Length). */
  bytesTotal?: number;
  /** Final manifest, only set on phase=done. */
  manifestId?: string;
  /** Error message, only set on phase=failed. */
  error?: string;
}

export type StartBuildRequest =
  | {
      kind: 'overpass';
      packId: string;
      packName: string;
      country: string;
      /** [minLon, minLat, maxLon, maxLat]. */
      bbox: readonly [number, number, number, number];
    }
  | {
      kind: 'geofabrik';
      countryId: string;
    };

interface ActiveBuild {
  controller: AbortController;
  workDir: string;
}

const activeBuilds = new Map<string, ActiveBuild>();
let isOfflineRef = { value: false };

export function setIsOfflineRef(ref: { value: boolean }): void {
  isOfflineRef = ref;
}

export function initPackBuilder(packsDir: string): void {
  ipcMain.handle('packBuilder:countries', async () => GEOFABRIK_COUNTRIES);

  ipcMain.handle('packBuilder:start', async (e, req: StartBuildRequest) => {
    if (isOfflineRef.value) {
      throw new Error(
        'Offline mode is enabled. Turn it off in the Self Test panel before downloading a pack.',
      );
    }
    const buildId = randomBytes(8).toString('hex');
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const emit = (p: Omit<PackBuildProgress, 'buildId'>): void => {
      win?.webContents.send('packBuilder:progress', { buildId, ...p });
    };
    // Run the build asynchronously so the IPC call returns immediately with the id.
    void runBuild(buildId, req, packsDir, emit);
    return { buildId };
  });

  ipcMain.handle('packBuilder:cancel', async (_e, buildId: string) => {
    const a = activeBuilds.get(buildId);
    if (!a) return { cancelled: false as const, reason: 'unknown buildId' };
    a.controller.abort();
    return { cancelled: true as const };
  });
}

async function runBuild(
  buildId: string,
  req: StartBuildRequest,
  packsDir: string,
  emit: (p: Omit<PackBuildProgress, 'buildId'>) => void,
): Promise<void> {
  const controller = new AbortController();
  const workDir = join(tmpdir(), `openmaps-build-${buildId}`);
  activeBuilds.set(buildId, { controller, workDir });
  try {
    await mkdir(workDir, { recursive: true });
    emit({ phase: 'starting', message: 'Preparing build…' });

    let raw: Awaited<ReturnType<typeof readOsmXml>>;
    let packId: string;
    let packName: string;
    let country: string;
    let clipBbox: readonly [number, number, number, number] | undefined;
    let attribution: string;

    if (req.kind === 'overpass') {
      packId = req.packId;
      packName = req.packName;
      country = req.country;
      clipBbox = req.bbox;
      attribution = '© OpenStreetMap contributors (ODbL)';
      const osmPath = join(workDir, 'source.osm');
      await fetchOverpass(req.bbox, osmPath, controller.signal, emit);
      if (controller.signal.aborted) throw new BuildCancelled();
      emit({ phase: 'parsing', message: 'Parsing OSM XML…' });
      raw = await readOsmXml(osmPath);
    } else {
      const country_ = GEOFABRIK_COUNTRIES.find((c) => c.id === req.countryId);
      if (!country_) throw new Error(`unknown country '${req.countryId}'`);
      packId = country_.id;
      packName = country_.name;
      country = country_.iso;
      clipBbox = country_.bbox;
      attribution = '© OpenStreetMap contributors (ODbL) — via Geofabrik';
      const pbfPath = join(workDir, 'source.osm.pbf');
      await streamDownload(country_.url, pbfPath, controller.signal, emit, country_);
      if (controller.signal.aborted) throw new BuildCancelled();
      emit({ phase: 'parsing', message: `Parsing ${country_.name} PBF…` });
      raw = await readOsmPbf(pbfPath, {
        progressInterval: 500_000,
        onProgress: ({ nodes, ways }) => {
          emit({
            phase: 'parsing',
            message: `Parsing PBF — ${nodes.toLocaleString()} nodes, ${ways.toLocaleString()} ways`,
          });
        },
      });
    }

    if (controller.signal.aborted) throw new BuildCancelled();
    emit({
      phase: 'building-graph',
      message: `Building routing graph (${raw.nodes.length.toLocaleString()} nodes, ${raw.ways.length.toLocaleString()} ways)…`,
    });
    const data = osmToPack(
      raw,
      clipBbox ? { clipBbox: [clipBbox[0], clipBbox[1], clipBbox[2], clipBbox[3]] } : {},
    );
    if (data.nodes.length === 0 || data.edges.length === 0) {
      throw new Error('No routable roads in this area. Pick a larger or more populated region.');
    }
    if (controller.signal.aborted) throw new BuildCancelled();

    // Write into a staging dir, then move to the final packs dir on
    // success. That way a cancelled or failed build never leaves a
    // half-written pack behind.
    const stagingDir = join(workDir, 'pack');
    await mkdir(stagingDir, { recursive: true });

    emit({ phase: 'building-tiles', message: 'Building vector tiles…' });
    writeMbtiles(join(stagingDir, 'tiles.mbtiles'), data, {
      name: packId,
      attribution,
    });
    if (controller.signal.aborted) throw new BuildCancelled();

    emit({ phase: 'building-geocode', message: 'Building search + routing index…' });
    writeGeocodeDb(join(stagingDir, 'geocode.sqlite'), data);
    if (controller.signal.aborted) throw new BuildCancelled();

    emit({ phase: 'writing-manifest', message: 'Writing manifest…' });
    const [minLon, minLat, maxLon, maxLat] = data.bbox;
    const cx = (minLon + maxLon) / 2;
    const cy = (minLat + maxLat) / 2;
    const z = 10;
    const n = 1 << z;
    const tx = Math.floor(((cx + 180) / 360) * n);
    const r = (cy * Math.PI) / 180;
    const ty = Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
    );
    await writeManifest({
      packDir: stagingDir,
      id: packId,
      name: packName,
      country,
      data,
      builderCommit: 'in-app',
      tileSample: { z, x: tx, y: ty },
      anchors: chooseAnchors(data),
    });

    emit({ phase: 'installing', message: 'Installing pack…' });
    const finalDir = resolve(packsDir, packId);
    await rm(finalDir, { recursive: true, force: true });
    await mkdir(packsDir, { recursive: true });
    // cpSync is fine for staging→final since they're both on the same
    // filesystem; using rename would collide if the temp dir is on a
    // different mount.
    const { cpSync } = await import('node:fs');
    cpSync(stagingDir, finalDir, { recursive: true });

    emit({
      phase: 'done',
      message: `Installed ${packName}.`,
      manifestId: packId,
    });
  } catch (err) {
    if (err instanceof BuildCancelled || controller.signal.aborted) {
      emit({ phase: 'cancelled', message: 'Build cancelled.' });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[packBuilder] build failed', err);
      emit({ phase: 'failed', message: `Build failed: ${msg}`, error: msg });
    }
  } finally {
    activeBuilds.delete(buildId);
    // Best-effort cleanup of the work directory. Errors here are not
    // user-facing — at worst we leak a temp folder until the OS cleans it.
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

class BuildCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'BuildCancelled';
  }
}

/**
 * Fetch an Overpass extract for a bbox. Same query shape as the script
 * version in scripts/fetch-aalborg.mjs, but parameterised. Overpass
 * responses are typically <50 MB for a city-sized bbox so buffering is
 * fine; the heavy streaming machinery is reserved for Geofabrik.
 */
async function fetchOverpass(
  bbox: readonly [number, number, number, number],
  outPath: string,
  signal: AbortSignal,
  emit: (p: Omit<PackBuildProgress, 'buildId'>) => void,
): Promise<void> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  // Overpass bbox order is (south, west, north, east).
  const south = minLat;
  const west = minLon;
  const north = maxLat;
  const east = maxLon;
  const query = `[out:xml][timeout:180];
(
  way["highway"](${south},${west},${north},${east});
  way["natural"="water"](${south},${west},${north},${east});
  way["waterway"="riverbank"](${south},${west},${north},${east});
  way["waterway"="dock"](${south},${west},${north},${east});
  way["landuse"="reservoir"](${south},${west},${north},${east});
  way["landuse"="basin"](${south},${west},${north},${east});
  node["place"](${south},${west},${north},${east});
  node["amenity"]["name"](${south},${west},${north},${east});
  node["shop"]["name"](${south},${west},${north},${east});
  node["tourism"]["name"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;
`;
  emit({ phase: 'downloading', message: 'Querying Overpass…' });
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Accept: 'application/xml, text/xml, */*',
      'User-Agent': 'openmaps-v2/0.1 (in-app builder)',
    },
    body: query,
    signal,
  });
  if (!res.ok) {
    throw new Error(`Overpass HTTP ${res.status} ${res.statusText}`);
  }
  // Content-Length is usually present; if not, we just don't show a percentage.
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : undefined;
  if (!res.body) throw new Error('Overpass returned no body');
  let downloaded = 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new BuildCancelled();
    }
    chunks.push(value);
    downloaded += value.length;
    emit({
      phase: 'downloading',
      message: total
        ? `Downloading from Overpass — ${formatBytes(downloaded)} / ${formatBytes(total)}`
        : `Downloading from Overpass — ${formatBytes(downloaded)}`,
      bytesDownloaded: downloaded,
      ...(total ? { bytesTotal: total } : {}),
    });
  }
  // Concatenate without copying via Buffer.concat (Node Buffer).
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await writeFile(outPath, buf);
}

/**
 * Stream-download a (potentially hundreds-of-MB) Geofabrik PBF to a
 * temp file with progress events. Buffering would OOM the renderer
 * easily for France/Germany; streaming pipes bytes directly to disk.
 */
async function streamDownload(
  url: string,
  outPath: string,
  signal: AbortSignal,
  emit: (p: Omit<PackBuildProgress, 'buildId'>) => void,
  country: GeofabrikCountry,
): Promise<void> {
  emit({
    phase: 'downloading',
    message: `Downloading ${country.name} (~${country.approxMb} MB) from Geofabrik…`,
  });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'openmaps-v2/0.1 (in-app builder)' },
    signal,
  });
  if (!res.ok) throw new Error(`Geofabrik HTTP ${res.status} ${res.statusText}`);
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : country.approxMb * 1_000_000;
  if (!res.body) throw new Error('Geofabrik returned no body');

  // Throttle progress events so we don't spam IPC for a long download.
  let lastEmit = 0;
  let downloaded = 0;
  // Node's Readable.fromWeb adapts a WHATWG ReadableStream to a Node
  // stream so we can pipe it. Available since Node 17. We add a Transform
  // stream in the pipeline that counts bytes and emits progress.
  const fileStream = createWriteStream(outPath);
  const sourceNode = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  sourceNode.on('data', (chunk: Buffer | Uint8Array) => {
    downloaded += chunk.length;
    const now = Date.now();
    // Emit at most ~5 events per second.
    if (now - lastEmit < 200) return;
    lastEmit = now;
    emit({
      phase: 'downloading',
      message: `Downloading ${country.name} — ${formatBytes(downloaded)} / ${formatBytes(total)}`,
      bytesDownloaded: downloaded,
      bytesTotal: total,
    });
  });
  // pipeline() handles back-pressure + abort propagation correctly.
  await pipeline(sourceNode, fileStream, { signal });
  emit({
    phase: 'downloading',
    message: `Download complete — ${formatBytes(downloaded)}`,
    bytesDownloaded: downloaded,
    bytesTotal: total,
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
