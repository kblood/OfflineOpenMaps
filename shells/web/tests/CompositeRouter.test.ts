import { describe, expect, it } from 'vitest';
import { RoutingUnavailableError } from '@openmaps/core';
import { CompositeRouter } from '../src/lib/CompositeRouter.js';
import type { Stmt, WebDb } from '../src/lib/sqlite.js';

interface NodeRow { id: number; lat: number; lon: number }
interface EdgeRow { from: number; to: number }

function fakeDb(nodes: readonly NodeRow[], edges: readonly EdgeRow[]): WebDb {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rowsFrom = (id: number) => edges
    .filter((edge) => edge.from === id)
    .map((edge) => {
      const to = nodeById.get(edge.to)!;
      return {
        from_node: edge.from,
        to_node: edge.to,
        length_m: 6200,
        max_speed_kmh: 50,
        allows_car: 1,
        allows_bike: 1,
        allows_foot: 1,
        road_name: 'Boundary Road',
        to_lat: to.lat,
        to_lon: to.lon,
      };
    });
  const prepare = (sql: string): Stmt => ({
    all: (...args) => {
      if (sql.includes('WHERE e.from_node = ?')) return rowsFrom(Number(args[0]));
      if (sql.includes('FROM nodes_rtree')) {
        const [minLat, maxLat, minLon, maxLon] = args.map(Number);
        return nodes.filter((node) => node.lat >= minLat! && node.lat <= maxLat!
          && node.lon >= minLon! && node.lon <= maxLon!
          && edges.some((edge) => edge.from === node.id));
      }
      return [];
    },
    get: (...args) => {
      if (!sql.includes('SELECT lat, lon FROM nodes')) return undefined;
      return nodeById.get(Number(args[0]));
    },
    finalize: () => {},
  });
  return { prepare } as unknown as WebDb;
}

describe('web CompositeRouter', () => {
  it('joins two regional databases only through their shared OSM node', async () => {
    const router = new CompositeRouter([
      {
        id: 'west',
        bbox: [10, 56, 10.1, 56],
        db: fakeDb(
          [{ id: 1, lat: 56, lon: 10 }, { id: 2, lat: 56, lon: 10.1 }],
          [{ from: 1, to: 2 }, { from: 2, to: 1 }],
        ),
      },
      {
        id: 'east',
        bbox: [10.1, 56, 10.2, 56],
        db: fakeDb(
          [{ id: 2, lat: 56, lon: 10.1 }, { id: 3, lat: 56, lon: 10.2 }],
          [{ from: 2, to: 3 }, { from: 3, to: 2 }],
        ),
      },
    ]);
    const result = await router.route({
      waypoints: [{ lat: 56, lon: 10 }, { lat: 56, lon: 10.2 }],
      profile: 'bike',
    });
    expect(result.engine).toBe('web-composite-a-star');
    expect(result.geometry).toEqual([[10, 56], [10.1, 56], [10.2, 56]]);
  });

  it('rejects disconnected downloaded regions', async () => {
    const router = new CompositeRouter([
      {
        id: 'west',
        bbox: [10, 56, 10.1, 56],
        db: fakeDb(
          [{ id: 1, lat: 56, lon: 10 }, { id: 2, lat: 56, lon: 10.1 }],
          [{ from: 1, to: 2 }, { from: 2, to: 1 }],
        ),
      },
      {
        id: 'east-island',
        bbox: [10.3, 56, 10.4, 56],
        db: fakeDb(
          [{ id: 4, lat: 56, lon: 10.3 }, { id: 5, lat: 56, lon: 10.4 }],
          [{ from: 4, to: 5 }, { from: 5, to: 4 }],
        ),
      },
    ]);
    await expect(router.route({
      waypoints: [{ lat: 56, lon: 10 }, { lat: 56, lon: 10.4 }],
      profile: 'car',
    })).rejects.toBeInstanceOf(RoutingUnavailableError);
  });
});
