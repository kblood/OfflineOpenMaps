import type { TileSource, TileBytes, TileSourceMeta } from '@openmaps/core';
import type { WebDb, Stmt } from './sqlite.js';

/**
 * Browser MBTiles reader. Same schema and TMS-y flip as the platform-node
 * version (packages/platform-node/src/MbtilesTileSource.ts) — only the
 * SQLite handle differs (sqlite-wasm vs node:sqlite).
 */
export class MbtilesTileSource implements TileSource {
  private readonly db: WebDb;
  private readonly getStmt: Stmt;
  readonly meta: TileSourceMeta;

  constructor(db: WebDb) {
    this.db = db;
    this.getStmt = db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
    );

    const metaRows = db.prepare('SELECT name, value FROM metadata').all();
    const metaMap = new Map<string, string>();
    for (const r of metaRows) {
      const name = r['name'];
      const value = r['value'];
      if (typeof name === 'string' && typeof value === 'string') {
        metaMap.set(name, value);
      }
    }

    const format = (metaMap.get('format') ?? 'pbf').toLowerCase();
    const supported: ReadonlyArray<TileSourceMeta['format']> = ['mvt', 'png', 'jpg', 'webp'];
    const normalized: TileSourceMeta['format'] =
      format === 'pbf'
        ? 'mvt'
        : supported.includes(format as TileSourceMeta['format'])
          ? (format as TileSourceMeta['format'])
          : 'mvt';

    const boundsStr = metaMap.get('bounds') ?? '-180,-85,180,85';
    const bounds = boundsStr.split(',').map(Number) as [number, number, number, number];
    if (bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) {
      throw new Error(`MbtilesTileSource: invalid bounds metadata "${boundsStr}"`);
    }

    this.meta = {
      minZoom: parseInt(metaMap.get('minzoom') ?? '0', 10),
      maxZoom: parseInt(metaMap.get('maxzoom') ?? '14', 10),
      bounds,
      format: normalized,
      attribution: metaMap.get('attribution') ?? '© OpenStreetMap contributors',
    };
  }

  async getTile(z: number, x: number, y: number): Promise<TileBytes | null> {
    // MBTiles stores TMS y; XYZ y is flipped.
    const tmsY = (1 << z) - 1 - y;
    const row = this.getStmt.get(z, x, tmsY);
    if (!row) return null;
    const tileData = row['tile_data'];
    if (!(tileData instanceof Uint8Array) || tileData.length === 0) return null;

    if (this.meta.format === 'mvt') {
      const isGzip = tileData[0] === 0x1f && tileData[1] === 0x8b;
      return {
        bytes: tileData,
        contentType: 'application/vnd.mapbox-vector-tile',
        contentEncoding: isGzip ? 'gzip' : 'none',
      };
    }
    const contentType =
      this.meta.format === 'png'
        ? 'image/png'
        : this.meta.format === 'jpg'
          ? 'image/jpeg'
          : 'image/webp';
    return { bytes: tileData, contentType, contentEncoding: 'none' };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
