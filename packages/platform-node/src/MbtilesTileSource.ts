import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { TileSource, TileBytes, TileSourceMeta } from '@openmaps/core';

/**
 * Reads MBTiles (https://github.com/mapbox/mbtiles-spec). MBTiles is SQLite
 * with a `tiles(zoom_level, tile_column, tile_row, tile_data BLOB)` table
 * using TMS y-coordinates (flipped from XYZ).
 *
 * We use MBTiles in v1 of v2 because writing it from Node is trivial (just
 * SQLite) and we're Electron-only so HTTP Range isn't needed. A PMTiles
 * source can be added later as another TileSource implementation.
 */
export class MbtilesTileSource implements TileSource {
  private readonly db: DatabaseSync;
  private readonly getStmt: StatementSync;
  readonly meta: TileSourceMeta;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath, { readOnly: true });
    this.db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    this.getStmt = this.db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
    );

    const metaRows = this.db.prepare('SELECT name, value FROM metadata').all() as unknown as ReadonlyArray<{
      name: string;
      value: string;
    }>;
    const metaMap = new Map(metaRows.map((r) => [r.name, r.value]));

    const format = (metaMap.get('format') ?? 'pbf').toLowerCase();
    const supported: ReadonlyArray<TileSourceMeta['format']> = ['mvt', 'png', 'jpg', 'webp'];
    // mbtiles uses "pbf" for vector tiles; map to "mvt"
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
    const row = this.getStmt.get(z, x, tmsY) as unknown as { tile_data: Uint8Array } | undefined;
    if (!row || row.tile_data.length === 0) return null;
    const bytes = row.tile_data;

    if (this.meta.format === 'mvt') {
      const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
      return {
        bytes,
        contentType: 'application/vnd.mapbox-vector-tile',
        contentEncoding: isGzip ? 'gzip' : 'none',
      };
    }
    const contentType =
      this.meta.format === 'png' ? 'image/png' : this.meta.format === 'jpg' ? 'image/jpeg' : 'image/webp';
    return { bytes, contentType, contentEncoding: 'none' };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
