import { describe, expect, it } from 'vitest';
import { chooseAnchors } from '../src/chooseAnchors.js';
import type { RoadEdge, SyntheticData } from '../src/synthetic.js';

const edge = (fromNode: number, toNode: number, allowsCar = true): RoadEdge => ({
  fromNode,
  toNode,
  roadName: 'Test road',
  highway: 'residential',
  maxSpeedKmh: 50,
  allowsCar,
  allowsBike: true,
  allowsFoot: true,
  wayId: 1,
});

describe('chooseAnchors', () => {
  it('chooses a reachable route endpoint far enough to avoid a same-node snap', () => {
    const data: SyntheticData = {
      bbox: [-1, -1, 1, 1],
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.0001 }, // a very short initial OSM edge
        { id: 3, lat: 0, lon: 0.003 },
      ],
      edges: [edge(1, 2), edge(2, 1), edge(2, 3), edge(3, 2)],
      places: [],
    };

    const [start, end] = chooseAnchors(data).routeWaypoints;
    expect(start).toEqual({ lat: 0, lon: 0 });
    expect(end).toEqual({ lat: 0, lon: 0.003 });
  });

  it('does not select a walking-only edge for the car-route self-test', () => {
    const data: SyntheticData = {
      bbox: [-1, -1, 1, 1],
      nodes: [
        { id: 1, lat: 0, lon: 0 },
        { id: 2, lat: 0, lon: 0.0001 },
        { id: 3, lat: 0.01, lon: 0 },
        { id: 4, lat: 0.01, lon: 0.003 },
      ],
      edges: [edge(1, 2, false), edge(2, 1, false), edge(3, 4), edge(4, 3)],
      places: [],
    };

    const [start, end] = chooseAnchors(data).routeWaypoints;
    expect(start).toEqual({ lat: 0.01, lon: 0 });
    expect(end).toEqual({ lat: 0.01, lon: 0.003 });
  });
});
