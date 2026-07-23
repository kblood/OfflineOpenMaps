import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoutingUnavailableError } from '@openmaps/core';
import { CompositeRouter, InternalRouter } from '../src/index.js';

let workDir: string;
let westPath: string;
let eastPath: string;
let disconnectedPath: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'openmaps-composite-'));
  westPath = join(workDir, 'west.sqlite');
  eastPath = join(workDir, 'east.sqlite');
  disconnectedPath = join(workDir, 'disconnected.sqlite');

  writeGraph(westPath, [
    { id: 1, lat: 56, lon: 10 },
    { id: 2, lat: 56, lon: 10.1 },
  ], [[1, 2]]);
  // Node 2 is deliberately repeated. Its global OSM id is the portal that
  // joins the two independently stored graphs.
  writeGraph(eastPath, [
    { id: 2, lat: 56, lon: 10.1 },
    { id: 3, lat: 56, lon: 10.2 },
  ], [[2, 3]]);
  writeGraph(disconnectedPath, [
    { id: 4, lat: 56, lon: 10.3 },
    { id: 5, lat: 56, lon: 10.4 },
  ], [[4, 5]]);
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('CompositeRouter', () => {
  it('crosses a regional boundary through a shared OSM node id', async () => {
    const router = new CompositeRouter([
      { id: 'west', filePath: westPath, bbox: [10, 56, 10.1, 56] },
      { id: 'east', filePath: eastPath, bbox: [10.1, 56, 10.2, 56] },
    ]);
    try {
      const result = await router.route({
        waypoints: [{ lat: 56, lon: 10 }, { lat: 56, lon: 10.2 }],
        profile: 'car',
      });
      expect(result.engine).toBe('internal-composite-a-star');
      expect(result.geometry).toEqual([
        [10, 56],
        [10.1, 56],
        [10.2, 56],
      ]);
      expect(result.distanceM).toBe(12_400);
      expect(result.steps.at(-1)?.maneuver).toBe('arrive');
    } finally {
      await router.close();
    }
  });

  it('does not invent a connection between disjoint downloaded regions', async () => {
    const router = new CompositeRouter([
      { id: 'west', filePath: westPath, bbox: [10, 56, 10.1, 56] },
      { id: 'disconnected', filePath: disconnectedPath, bbox: [10.3, 56, 10.4, 56] },
    ]);
    try {
      await expect(router.route({
        waypoints: [{ lat: 56, lon: 10 }, { lat: 56, lon: 10.4 }],
        profile: 'car',
      })).rejects.toMatchObject({
        name: 'RoutingUnavailableError',
        reason: 'no-route',
      } satisfies Partial<RoutingUnavailableError>);
    } finally {
      await router.close();
    }
  });

  it('shows why the two files are needed: either file alone cannot span the route', async () => {
    const router = new InternalRouter(westPath);
    try {
      await expect(router.route({
        waypoints: [{ lat: 56, lon: 10 }, { lat: 56, lon: 10.2 }],
        profile: 'car',
      })).rejects.toBeInstanceOf(RoutingUnavailableError);
    } finally {
      await router.close();
    }
  });
});

interface NodeRow { id: number; lat: number; lon: number }

function writeGraph(
  path: string,
  nodes: readonly NodeRow[],
  links: ReadonlyArray<readonly [number, number]>,
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
      CREATE VIRTUAL TABLE nodes_rtree USING rtree(id, min_lat, max_lat, min_lon, max_lon);
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY,
        from_node INTEGER NOT NULL,
        to_node INTEGER NOT NULL,
        length_m REAL NOT NULL,
        max_speed_kmh REAL NOT NULL,
        allows_car INTEGER NOT NULL,
        allows_bike INTEGER NOT NULL,
        allows_foot INTEGER NOT NULL,
        road_name TEXT,
        way_id INTEGER
      );
      CREATE INDEX edges_from ON edges(from_node);
    `);
    const insertNode = db.prepare('INSERT INTO nodes VALUES (?, ?, ?)');
    const insertRtree = db.prepare('INSERT INTO nodes_rtree VALUES (?, ?, ?, ?, ?)');
    for (const node of nodes) {
      insertNode.run(node.id, node.lat, node.lon);
      insertRtree.run(node.id, node.lat, node.lat, node.lon, node.lon);
    }
    const insertEdge = db.prepare(`
      INSERT INTO edges
        (from_node, to_node, length_m, max_speed_kmh, allows_car, allows_bike, allows_foot, road_name, way_id)
      VALUES (?, ?, 6200, 50, 1, 1, 1, 'Boundary Road', 1)
    `);
    for (const [from, to] of links) {
      insertEdge.run(from, to);
      insertEdge.run(to, from);
    }
  } finally {
    db.close();
  }
}
