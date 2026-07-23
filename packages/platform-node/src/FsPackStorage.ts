import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PackStorage, RegionPack, RegionManifest } from '@openmaps/core';
import { validateManifest } from '@openmaps/core';
import { MbtilesTileSource } from './MbtilesTileSource.js';
import { SqliteGeocodeIndex } from './SqliteGeocodeIndex.js';
import { InternalRouter } from './InternalRouter.js';
import { CompositeRouter } from './CompositeRouter.js';

/**
 * Filesystem-backed pack storage. Each pack lives in `packsDir/<id>/` with
 * the files described by its manifest. Opening a pack validates the manifest
 * but does NOT re-hash files — that's verify()'s job (slow, opt-in).
 */
export class FsPackStorage implements PackStorage {
  constructor(private readonly packsDir: string) {}

  async listInstalled(): Promise<RegionManifest[]> {
    let entries;
    try {
      entries = await readdir(this.packsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const manifests: RegionManifest[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      try {
        const raw = await readFile(join(this.packsDir, ent.name, 'manifest.json'), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        const m = validateManifest(parsed);
        if (m.id !== ent.name) {
          // Skip silently; user can run verify to learn why.
          continue;
        }
        manifests.push(m);
      } catch {
        // Skip unreadable / invalid packs.
        continue;
      }
    }
    return manifests;
  }

  async open(packId: string): Promise<RegionPack> {
    const dir = join(this.packsDir, packId);
    const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    const manifest = validateManifest(JSON.parse(raw));
    if (manifest.id !== packId) {
      throw new Error(`pack id mismatch: dir=${packId} manifest=${manifest.id}`);
    }

    const tilesPath = join(dir, manifest.files.tiles.path);
    const geocodePath = join(dir, manifest.files.geocode.path);
    // Internal router shares the geocode SQLite; .routing path is reserved for
    // future engines that need their own files (BRouter .rd5, Valhalla tiles).
    const tiles = new MbtilesTileSource(tilesPath);
    const geocode = new SqliteGeocodeIndex(geocodePath);
    const router = new InternalRouter(geocodePath);

    return {
      manifest,
      tiles,
      geocode,
      router,
      async close() {
        await tiles.close();
        await geocode.close();
        await router.close();
      },
    };
  }

  /**
   * Open only the routing databases for a set of installed packs and expose
   * them as one graph. Shared OSM node ids form the joins between packs.
   */
  async openCompositeRouter(packIds: readonly string[]): Promise<CompositeRouter> {
    if (packIds.length === 0) throw new Error('cannot open a composite router without packs');
    const sources = await Promise.all(packIds.map(async (packId) => {
      const dir = join(this.packsDir, packId);
      const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
      const manifest = validateManifest(JSON.parse(raw));
      if (manifest.id !== packId) {
        throw new Error(`pack id mismatch: dir=${packId} manifest=${manifest.id}`);
      }
      return {
        id: manifest.id,
        filePath: join(dir, manifest.files.routing.path),
        bbox: manifest.bbox,
      };
    }));
    return new CompositeRouter(sources);
  }

  async verify(packId: string): Promise<{ ok: true } | { ok: false; problem: string }> {
    const dir = join(this.packsDir, packId);
    let manifest: RegionManifest;
    try {
      const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
      manifest = validateManifest(JSON.parse(raw));
    } catch (err) {
      return { ok: false, problem: `manifest invalid: ${(err as Error).message}` };
    }

    const verifiedPaths = new Map<string, { bytes: number; sha256: string }>();
    for (const [name, file] of Object.entries(manifest.files)) {
      const path = resolve(dir, file.path);
      const previous = verifiedPaths.get(path);
      if (previous) {
        if (previous.bytes !== file.bytes || previous.sha256 !== file.sha256) {
          return { ok: false, problem: `${name} conflicts with another manifest entry for ${file.path}` };
        }
        continue;
      }
      try {
        const st = await stat(path);
        if (st.isDirectory()) {
          // Directory-typed files (e.g. routing/) just need to exist for v1.
          continue;
        }
        if (st.size !== file.bytes) {
          return { ok: false, problem: `${name} size mismatch: expected ${file.bytes}, got ${st.size}` };
        }
        const actual = await sha256File(path);
        if (actual !== file.sha256) {
          return { ok: false, problem: `${name} sha256 mismatch` };
        }
        verifiedPaths.set(path, { bytes: file.bytes, sha256: file.sha256 });
      } catch (err) {
        return { ok: false, problem: `${name} unreadable: ${(err as Error).message}` };
      }
    }
    return { ok: true };
  }

  async uninstall(packId: string): Promise<void> {
    await rm(join(this.packsDir, packId), { recursive: true, force: true });
  }

  /**
   * Install a pack by copying it from `srcDir`. `srcDir` must already be a
   * valid pack directory (contain a manifest.json plus the files the manifest
   * references). The pack is installed to `packsDir/<manifest.id>/`.
   *
   * If a pack with that id already exists, installation fails unless
   * `overwrite: true` — the caller (UI) is responsible for confirming overwrite
   * with the user.
   *
   * After copying, we re-validate via `verify()` to guarantee the freshly-
   * installed pack passes its own checksums.
   */
  async installFromDir(
    srcDir: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<RegionManifest> {
    const src = resolve(srcDir);
    let manifest: RegionManifest;
    try {
      const raw = await readFile(join(src, 'manifest.json'), 'utf8');
      manifest = validateManifest(JSON.parse(raw));
    } catch (err) {
      throw new Error(`source is not a valid pack: ${(err as Error).message}`);
    }

    const dest = join(this.packsDir, manifest.id);
    try {
      const st = await stat(dest);
      if (st.isDirectory()) {
        if (!opts.overwrite) {
          throw new Error(`pack '${manifest.id}' is already installed`);
        }
        await rm(dest, { recursive: true, force: true });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    await mkdir(this.packsDir, { recursive: true });
    await cp(src, dest, { recursive: true, errorOnExist: false });

    const verification = await this.verify(manifest.id);
    if (!verification.ok) {
      // Roll back so we don't leave a corrupt pack visible to the user.
      await rm(dest, { recursive: true, force: true });
      throw new Error(`pack failed verification after install: ${verification.problem}`);
    }
    return manifest;
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve());
  });
  return h.digest('hex');
}
