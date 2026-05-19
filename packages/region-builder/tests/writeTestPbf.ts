/**
 * Tiny PBF writer used ONLY by tests. We re-use the proto definitions that
 * ship with osm-pbf-parser-node (codegen'd from the official OSM .proto), so
 * the bytes we emit are guaranteed round-trip-compatible with the parser.
 *
 * What we generate:
 *   - One HeaderBlock blob (OsmSchema-V0.6 + DenseNodes required features)
 *   - One PrimitiveBlock blob containing:
 *       - A StringTable
 *       - A PrimitiveGroup with DenseNodes (all nodes, delta-encoded)
 *       - The same PrimitiveGroup also carries the Way[] entries
 *
 * This is the minimum subset that lets us prove our PBF adapter works
 * end-to-end without depending on a downloaded Geofabrik file.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import Pbf from 'pbf';
import { Blob, BlobHeader } from 'osm-pbf-parser-node/proto/fileformat.js';
import { HeaderBlock, PrimitiveBlock } from 'osm-pbf-parser-node/proto/osmformat.js';
import type { RawOsm } from '../src/osmTypes.js';

const GRANULARITY = 100; // 100 nanodegrees per unit (OSM default)
const NANODEGREES_PER_DEG = 1e9;

export function writeTestPbf(path: string, raw: RawOsm): void {
  const chunks: Buffer[] = [];

  // 1. Header blob — OSMHeader accepts uncompressed `raw` payload.
  chunks.push(encodeBlob('OSMHeader', encodeHeaderBlock(raw), false));

  // 2. Data blob — the parser REQUIRES zlib_data for OSMData specifically.
  chunks.push(encodeBlob('OSMData', encodePrimitiveBlock(raw), true));

  writeFileSync(path, Buffer.concat(chunks));
}

function encodeHeaderBlock(raw: RawOsm): Buffer {
  // bbox from raw nodes (or a dummy if empty)
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const n of raw.nodes) {
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lon < minLon) minLon = n.lon;
    if (n.lon > maxLon) maxLon = n.lon;
  }
  if (raw.nodes.length === 0) {
    minLat = 0; maxLat = 0; minLon = 0; maxLon = 0;
  }
  const pbf = new Pbf();
  HeaderBlock.write(
    {
      // HeaderBBox uses nanodegrees, with left=lon_min, right=lon_max,
      // top=lat_max, bottom=lat_min.
      bbox: {
        left: Math.round(minLon * NANODEGREES_PER_DEG),
        right: Math.round(maxLon * NANODEGREES_PER_DEG),
        top: Math.round(maxLat * NANODEGREES_PER_DEG),
        bottom: Math.round(minLat * NANODEGREES_PER_DEG),
      },
      required_features: ['OsmSchema-V0.6', 'DenseNodes'],
      optional_features: [],
      writingprogram: 'openmaps-v2-test-pbf',
      source: 'fixture',
    },
    pbf,
  );
  return Buffer.from(pbf.finish());
}

function encodePrimitiveBlock(raw: RawOsm): Buffer {
  // Build the string table. Index 0 is conventionally the empty string.
  const strings: string[] = [''];
  const stringIndex = new Map<string, number>();
  stringIndex.set('', 0);
  function intern(s: string): number {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  }

  // DenseNodes: delta-encoded ids, lats, lons, plus interleaved keys_vals.
  const nodes = [...raw.nodes].sort((a, b) => a.id - b.id);
  const ids: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const keysVals: number[] = [];
  let prevId = 0;
  let prevLat = 0;
  let prevLon = 0;
  for (const n of nodes) {
    const lat = Math.round((n.lat * NANODEGREES_PER_DEG) / GRANULARITY);
    const lon = Math.round((n.lon * NANODEGREES_PER_DEG) / GRANULARITY);
    ids.push(n.id - prevId);
    lats.push(lat - prevLat);
    lons.push(lon - prevLon);
    prevId = n.id;
    prevLat = lat;
    prevLon = lon;
    for (const [k, v] of n.tags) {
      keysVals.push(intern(k), intern(v));
    }
    keysVals.push(0); // 0 = end-of-tags marker for this node
  }

  // Ways: each has id + refs (delta-encoded) + parallel keys[] + vals[].
  const ways = raw.ways.map((w) => {
    const refs: number[] = [];
    let prevRef = 0;
    for (const r of w.nodeRefs) {
      refs.push(r - prevRef);
      prevRef = r;
    }
    const keys: number[] = [];
    const vals: number[] = [];
    for (const [k, v] of w.tags) {
      keys.push(intern(k));
      vals.push(intern(v));
    }
    return { id: w.id, refs, keys, vals };
  });

  // Stringtable's `s` field is a list of bytes (each entry is the UTF-8
  // bytes of the string).
  const stringtableBytes = strings.map((s) => new Uint8Array(Buffer.from(s, 'utf8')));

  const blockPbf = new Pbf();
  PrimitiveBlock.write(
    {
      stringtable: { s: stringtableBytes },
      primitivegroup: [
        { dense: { id: ids, lat: lats, lon: lons, keys_vals: keysVals } },
        { ways },
      ],
      granularity: GRANULARITY,
      lat_offset: 0,
      lon_offset: 0,
      date_granularity: 1000,
    },
    blockPbf,
  );
  return Buffer.from(blockPbf.finish());
}

function encodeBlob(
  type: 'OSMHeader' | 'OSMData',
  payload: Buffer,
  compress: boolean,
): Buffer {
  // `raw_size` is the size of the UNCOMPRESSED payload regardless of which
  // representation we send. When compress=true we send `zlib_data` and the
  // parser inflates it back to that size.
  const blobPbf = new Pbf();
  if (compress) {
    const compressed = deflateSync(payload);
    Blob.write(
      { zlib_data: new Uint8Array(compressed), raw_size: payload.length },
      blobPbf,
    );
  } else {
    Blob.write({ raw: new Uint8Array(payload), raw_size: payload.length }, blobPbf);
  }
  const blobBytes = Buffer.from(blobPbf.finish());

  const headerPbf = new Pbf();
  BlobHeader.write({ type, datasize: blobBytes.length }, headerPbf);
  const headerBytes = Buffer.from(headerPbf.finish());

  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([lenBuf, headerBytes, blobBytes]);
}
