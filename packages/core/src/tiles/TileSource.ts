/**
 * A TileSource produces raw tile bytes for (z, x, y). Vector tiles are MVT
 * (.pbf) gzip-compressed; raster tiles are PNG/JPEG. The TileSource itself
 * doesn't distinguish — bytes are bytes — but it exposes the content-type
 * so MapLibre's protocol handler knows what to do with them.
 *
 * Implementations:
 *   platform-node:    PmtilesFileSource   — mmaps a .pmtiles file
 *   platform-browser: PmtilesFetchSource  — HTTP Range over fetch (future)
 */
export interface TileSource {
  /** Metadata embedded in the source (zoom range, vector layers, etc.). */
  readonly meta: TileSourceMeta;

  /** Get one tile. Resolves to null if the tile is absent (e.g. ocean, out of bounds). */
  getTile(z: number, x: number, y: number): Promise<TileBytes | null>;

  /** Release any open handles. */
  close(): Promise<void>;
}

export interface TileSourceMeta {
  readonly minZoom: number;
  readonly maxZoom: number;
  /** [minLon, minLat, maxLon, maxLat]. */
  readonly bounds: [number, number, number, number];
  /** "mvt" for vector, "png" / "jpg" for raster. */
  readonly format: 'mvt' | 'png' | 'jpg' | 'webp';
  /** Free-form attribution string, displayed on the map. */
  readonly attribution: string;
}

export interface TileBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly contentEncoding: 'gzip' | 'none';
}
