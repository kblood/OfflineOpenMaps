import type { RegionManifest } from './manifest.js';
import type { TileSource } from '../tiles/TileSource.js';
import type { GeocodeIndex } from '../geocode/GeocodeIndex.js';
import type { Router } from '../route/Router.js';

/**
 * A RegionPack bundles the three runtime adapters needed for one region.
 *
 * The renderer doesn't know whether tiles come from a file:// URL or OPFS,
 * whether the geocode DB is better-sqlite3 or wa-sqlite, or whether routing
 * is BRouter or Valhalla. It only knows it has these three interfaces.
 *
 * Lifetime: open() returns a RegionPack; the caller must close() when done.
 * Multiple packs can be open at once if needed (e.g. cross-border routing).
 */
export interface RegionPack {
  readonly manifest: RegionManifest;
  readonly tiles: TileSource;
  readonly geocode: GeocodeIndex;
  readonly router: Router;
  close(): Promise<void>;
}

/**
 * A PackStorage knows where packs live on disk (or OPFS, in a browser shell)
 * and how to open them. This is the only point in core that touches "real"
 * storage; everything else flows through RegionPack.
 *
 * Implementations:
 *   platform-node:   FsPackStorage         — reads from the local filesystem
 *   platform-browser:OpfsPackStorage       — reads from the Origin Private File System (future)
 */
export interface PackStorage {
  /** List all installed packs (just manifests, doesn't open them). */
  listInstalled(): Promise<RegionManifest[]>;

  /** Open one pack. Fails loudly if files are missing or checksums mismatch. */
  open(packId: string): Promise<RegionPack>;

  /** Verify a pack's files match its manifest checksums. Returns the offending file or null. */
  verify(packId: string): Promise<{ ok: true } | { ok: false; problem: string }>;

  /** Remove an installed pack entirely. */
  uninstall(packId: string): Promise<void>;
}
