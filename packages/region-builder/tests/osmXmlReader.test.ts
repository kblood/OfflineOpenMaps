/**
 * Tests for osmXmlReader. Streaming SAX parser, so we mostly verify it builds
 * the right RawOsm given specific XML inputs — plus a few edge cases that
 * have bitten real-world readers (relations, broken tags, nodes with no tags).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOsmXml } from '../src/osmXmlReader.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osm-xml-test-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return path;
}

describe('readOsmXml', () => {
  it('parses a minimal node + way and preserves tag map', async () => {
    const path = await fixture(
      'minimal.osm',
      `<?xml version="1.0"?>
<osm version="0.6">
  <node id="1" lat="42.0" lon="1.0"><tag k="amenity" v="cafe"/></node>
  <node id="2" lat="42.001" lon="1.001"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/>
    <tag k="name" v="Test St"/>
  </way>
</osm>`,
    );
    const raw = await readOsmXml(path);
    expect(raw.nodes).toHaveLength(2);
    expect(raw.ways).toHaveLength(1);
    expect(raw.nodes[0]!.tags.get('amenity')).toBe('cafe');
    expect(raw.nodes[1]!.tags.size).toBe(0);
    expect(raw.ways[0]!.tags.get('highway')).toBe('residential');
    expect(raw.ways[0]!.tags.get('name')).toBe('Test St');
    expect(raw.ways[0]!.nodeRefs).toEqual([1, 2]);
  });

  it('preserves large OSM ids (>2^31) without losing precision', async () => {
    // Real Geofabrik node IDs hit ~12 billion. JS numbers stay exact up to
    // 2^53 — we just have to make sure we don't accidentally parse as int32.
    const path = await fixture(
      'big-ids.osm',
      `<?xml version="1.0"?>
<osm version="0.6">
  <node id="12345678901" lat="0.0" lon="0.0"/>
  <node id="12345678902" lat="0.0" lon="0.001"/>
  <way id="99999999999">
    <nd ref="12345678901"/><nd ref="12345678902"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>`,
    );
    const raw = await readOsmXml(path);
    expect(raw.nodes[0]!.id).toBe(12345678901);
    expect(raw.ways[0]!.id).toBe(99999999999);
    expect(raw.ways[0]!.nodeRefs).toEqual([12345678901, 12345678902]);
  });

  it('silently ignores relations and their members', async () => {
    const path = await fixture(
      'with-rel.osm',
      `<?xml version="1.0"?>
<osm version="0.6">
  <node id="1" lat="0" lon="0"/>
  <node id="2" lat="0" lon="0.001"/>
  <way id="100">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="residential"/>
  </way>
  <relation id="500">
    <member type="way" ref="100" role="from"/>
    <member type="node" ref="1" role="via"/>
    <tag k="type" v="restriction"/>
    <tag k="restriction" v="no_left_turn"/>
  </relation>
</osm>`,
    );
    const raw = await readOsmXml(path);
    expect(raw.nodes).toHaveLength(2);
    expect(raw.ways).toHaveLength(1);
    // Relation tags must NOT leak into the way that was the relation's member.
    expect(raw.ways[0]!.tags.has('restriction')).toBe(false);
    expect(raw.ways[0]!.tags.has('type')).toBe(false);
  });

  it('handles tags with special characters and Unicode', async () => {
    const path = await fixture(
      'unicode.osm',
      `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="55.7" lon="12.5">
    <tag k="name" v="København"/>
    <tag k="name:fr" v="Copenhague"/>
    <tag k="description" v="A &amp; B &lt;test&gt;"/>
  </node>
</osm>`,
    );
    const raw = await readOsmXml(path);
    expect(raw.nodes[0]!.tags.get('name')).toBe('København');
    expect(raw.nodes[0]!.tags.get('name:fr')).toBe('Copenhague');
    expect(raw.nodes[0]!.tags.get('description')).toBe('A & B <test>');
  });

  it('drops malformed nodes (non-numeric lat/lon) without crashing', async () => {
    const path = await fixture(
      'malformed.osm',
      `<?xml version="1.0"?>
<osm version="0.6">
  <node id="1" lat="abc" lon="0"/>
  <node id="2" lat="0" lon="0.001"/>
  <node id="bad" lat="0" lon="0"/>
</osm>`,
    );
    const raw = await readOsmXml(path);
    // Only node 2 is valid.
    expect(raw.nodes).toHaveLength(1);
    expect(raw.nodes[0]!.id).toBe(2);
  });

  it('rejects truly invalid XML with an error', async () => {
    const path = await fixture('broken.osm', '<osm><node id="1" lat="0" lon="0"></osm>');
    await expect(readOsmXml(path)).rejects.toThrow();
  });

  it('returns empty lists for an empty <osm/>', async () => {
    const path = await fixture('empty.osm', '<?xml version="1.0"?><osm version="0.6"/>');
    const raw = await readOsmXml(path);
    expect(raw.nodes).toEqual([]);
    expect(raw.ways).toEqual([]);
  });
});
