import { describe, expect, it } from 'vitest';
import { ManifestValidationError, validateManifest } from '../src/pack/manifest.js';

const validManifest = {
  schemaVersion: 1,
  id: 'denmark',
  name: 'Denmark',
  country: 'DK',
  bbox: [8.0, 54.5, 15.2, 57.8],
  builtAt: '2026-05-18T00:00:00Z',
  builderCommit: 'abc1234',
  files: {
    tiles: { path: 'tiles.pmtiles', bytes: 200_000_000, sha256: 'a'.repeat(64) },
    geocode: { path: 'geocode.sqlite', bytes: 150_000_000, sha256: 'b'.repeat(64) },
    routing: { path: 'routing/', bytes: 50_000_000, sha256: 'c'.repeat(64) },
  },
  selfTestAnchors: {
    searchTerms: ['Aarhus', 'København'],
    reversePoint: { lat: 56.15, lon: 10.21 },
    routeWaypoints: [
      { lat: 56.15, lon: 10.21 },
      { lat: 55.68, lon: 12.57 },
    ],
    tileSample: { z: 8, x: 134, y: 79 },
  },
};

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    expect(() => validateManifest(validManifest)).not.toThrow();
  });

  it('rejects wrong schemaVersion', () => {
    expect(() => validateManifest({ ...validManifest, schemaVersion: 2 }))
      .toThrowError(ManifestValidationError);
  });

  it('rejects malformed id', () => {
    expect(() => validateManifest({ ...validManifest, id: 'Denmark' })).toThrow(ManifestValidationError);
    expect(() => validateManifest({ ...validManifest, id: '' })).toThrow(ManifestValidationError);
  });

  it('rejects bbox with min >= max', () => {
    expect(() =>
      validateManifest({ ...validManifest, bbox: [15.2, 54.5, 8.0, 57.8] }),
    ).toThrow(/min must be < max/);
  });

  it('rejects bbox out of WGS84 range', () => {
    expect(() =>
      validateManifest({ ...validManifest, bbox: [8.0, 54.5, 15.2, 99.0] }),
    ).toThrow(/WGS84/);
  });

  it('rejects checksum not 64 hex chars', () => {
    const bad = JSON.parse(JSON.stringify(validManifest));
    bad.files.tiles.sha256 = 'short';
    expect(() => validateManifest(bad)).toThrow(/sha256/);
  });

  it('rejects missing selfTestAnchors', () => {
    const bad = JSON.parse(JSON.stringify(validManifest));
    delete bad.selfTestAnchors;
    expect(() => validateManifest(bad)).toThrow(/selfTestAnchors/);
  });

  it('rejects empty searchTerms', () => {
    const bad = JSON.parse(JSON.stringify(validManifest));
    bad.selfTestAnchors.searchTerms = [];
    expect(() => validateManifest(bad)).toThrow(/searchTerms/);
  });

  it('rejects non-2 routeWaypoints', () => {
    const bad = JSON.parse(JSON.stringify(validManifest));
    bad.selfTestAnchors.routeWaypoints = [{ lat: 1, lon: 1 }];
    expect(() => validateManifest(bad)).toThrow(/routeWaypoints/);
  });

  it('rejects lat out of range', () => {
    const bad = JSON.parse(JSON.stringify(validManifest));
    bad.selfTestAnchors.reversePoint = { lat: 91, lon: 0 };
    expect(() => validateManifest(bad)).toThrow(/lat/);
  });
});
