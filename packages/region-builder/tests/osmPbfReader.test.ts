/**
 * Tests for osmPbfReader. We generate tiny PBF fixtures on-the-fly with
 * writeTestPbf (which uses the same proto definitions as the parser, so
 * round-trip is guaranteed compatible), then read them back and assert
 * on the resulting RawOsm.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOsmPbf } from '../src/osmPbfReader.js';
import { writeTestPbf } from './writeTestPbf.js';
import type { RawOsm } from '../src/osmTypes.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osm-pbf-test-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function rawOsm(opts: {
  nodes: Array<{ id: number; lat: number; lon: number; tags?: Record<string, string> }>;
  ways: Array<{ id: number; refs: number[]; tags: Record<string, string> }>;
}): RawOsm {
  return {
    nodes: opts.nodes.map((n) => ({
      id: n.id,
      lat: n.lat,
      lon: n.lon,
      tags: new Map(Object.entries(n.tags ?? {})),
    })),
    ways: opts.ways.map((w) => ({
      id: w.id,
      nodeRefs: w.refs,
      tags: new Map(Object.entries(w.tags)),
    })),
  };
}

describe('readOsmPbf', () => {
  it('round-trips nodes and ways with tags through writeTestPbf', async () => {
    const original = rawOsm({
      nodes: [
        { id: 100, lat: 55.6, lon: 12.5, tags: { amenity: 'cafe', name: 'A' } },
        { id: 101, lat: 55.601, lon: 12.501 },
        { id: 102, lat: 55.602, lon: 12.502 },
      ],
      ways: [
        { id: 200, refs: [100, 101, 102], tags: { highway: 'residential', name: 'Test Way' } },
      ],
    });
    const path = join(dir, 'roundtrip.osm.pbf');
    writeTestPbf(path, original);

    const parsed = await readOsmPbf(path);
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.ways).toHaveLength(1);

    // Node 100 with tags should come through with both tags preserved.
    const n100 = parsed.nodes.find((n) => n.id === 100);
    expect(n100).toBeDefined();
    expect(n100!.lat).toBeCloseTo(55.6, 5);
    expect(n100!.lon).toBeCloseTo(12.5, 5);
    expect(n100!.tags.get('amenity')).toBe('cafe');
    expect(n100!.tags.get('name')).toBe('A');

    // Untagged nodes come through with empty tag map.
    const n101 = parsed.nodes.find((n) => n.id === 101);
    expect(n101!.tags.size).toBe(0);

    // Way with refs preserved.
    const w200 = parsed.ways.find((w) => w.id === 200);
    expect(w200).toBeDefined();
    expect(w200!.nodeRefs).toEqual([100, 101, 102]);
    expect(w200!.tags.get('highway')).toBe('residential');
    expect(w200!.tags.get('name')).toBe('Test Way');
  });

  it('preserves OSM-scale ids (>2^31) without precision loss', async () => {
    const original = rawOsm({
      nodes: [
        { id: 12_345_678_901, lat: 0, lon: 0 },
        { id: 12_345_678_902, lat: 0, lon: 0.001 },
      ],
      ways: [{ id: 99_999_999_999, refs: [12_345_678_901, 12_345_678_902], tags: { highway: 'residential' } }],
    });
    const path = join(dir, 'big-ids.osm.pbf');
    writeTestPbf(path, original);

    const parsed = await readOsmPbf(path);
    expect(parsed.nodes.map((n) => n.id).sort()).toEqual([12_345_678_901, 12_345_678_902]);
    expect(parsed.ways[0]!.id).toBe(99_999_999_999);
    expect(parsed.ways[0]!.nodeRefs).toEqual([12_345_678_901, 12_345_678_902]);
  });

  it('clipBbox drops nodes outside the bbox at parse time', async () => {
    const original = rawOsm({
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.001 },
        { id: 3, lat: 10, lon: 10 }, // far outside
      ],
      ways: [
        { id: 100, refs: [1, 2], tags: { highway: 'residential' } },
        { id: 101, refs: [1, 3], tags: { highway: 'residential' } }, // partially outside
        { id: 102, refs: [3], tags: { highway: 'residential' } }, // entirely outside
      ],
    });
    const path = join(dir, 'clip.osm.pbf');
    writeTestPbf(path, original);

    const parsed = await readOsmPbf(path, { clipBbox: [-0.01, -0.01, 0.01, 0.01] });
    expect(parsed.nodes.map((n) => n.id).sort()).toEqual([1, 2]);
    // Way 102 references only the dropped node, so we filter it out at
    // parse-time. Way 101 touches a kept node, so we keep it (osmToPack
    // will then skip the segment to node 3).
    const ids = parsed.ways.map((w) => w.id).sort();
    expect(ids).toEqual([100, 101]);
  });

  it('returns empty lists for a PBF with no nodes/ways', async () => {
    const original: RawOsm = { nodes: [], ways: [] };
    const path = join(dir, 'empty.osm.pbf');
    writeTestPbf(path, original);
    const parsed = await readOsmPbf(path);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.ways).toEqual([]);
  });

  it('fires progress callback periodically and at end', async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      lat: 0,
      lon: i * 0.0001,
    }));
    const original = rawOsm({ nodes, ways: [] });
    const path = join(dir, 'progress.osm.pbf');
    writeTestPbf(path, original);

    const reports: Array<{ nodes: number; ways: number }> = [];
    await readOsmPbf(path, {
      progressInterval: 10, // every 10 nodes
      onProgress: (c) => reports.push({ ...c }),
    });
    // At minimum: one mid-stream report and the final end-of-stream one.
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[reports.length - 1]!.nodes).toBe(25);
  });
});
