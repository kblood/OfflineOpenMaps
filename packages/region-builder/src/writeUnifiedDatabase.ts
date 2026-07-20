import { copyFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/**
 * Combines the builder's MBTiles and search/routing databases into one SQLite
 * file. MBTiles is SQLite already, so this preserves the existing tables,
 * FTS5 indexes and R*Tree indexes without a lossy conversion.
 */
export async function writeUnifiedDatabase(opts: {
  tilesPath: string;
  geocodePath: string;
  outPath: string;
}): Promise<void> {
  // Start with geocoding/routing so its virtual tables are copied intact,
  // then import the standard MBTiles metadata and tiles tables.
  await copyFile(opts.geocodePath, opts.outPath);
  const db = new DatabaseSync(opts.outPath);
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      ATTACH DATABASE ${quoteSqlString(opts.tilesPath)} AS tile_source;
      BEGIN IMMEDIATE;
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (
        zoom_level INTEGER,
        tile_column INTEGER,
        tile_row INTEGER,
        tile_data BLOB,
        PRIMARY KEY (zoom_level, tile_column, tile_row)
      );
      INSERT INTO metadata (name, value)
        SELECT name, value FROM tile_source.metadata;
      INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data)
        SELECT zoom_level, tile_column, tile_row, tile_data FROM tile_source.tiles;
      COMMIT;
      DETACH DATABASE tile_source;
      ANALYZE;
      VACUUM;
    `);
  } finally {
    db.close();
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
