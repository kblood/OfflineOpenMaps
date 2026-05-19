// Canonical schema for a region pack manifest. This is the contract between
// the region-builder (offline build step) and the app runtime. If the manifest
// doesn't validate, the pack is rejected — no "partial" packs.

export interface RegionManifest {
  /** Schema version of the manifest itself. Bump when the shape changes. */
  schemaVersion: 1;

  /** Stable, lowercase, hyphenated. e.g. "denmark", "us-california". */
  id: string;

  /** Human display name. e.g. "Denmark". */
  name: string;

  /** ISO 3166-1 alpha-2 country code, or "XX" for multi-country / sub-country. */
  country: string;

  /** [minLon, minLat, maxLon, maxLat] in WGS84. */
  bbox: [number, number, number, number];

  /** ISO 8601 timestamp of when the source data was snapshotted. */
  builtAt: string;

  /** Git commit of the region-builder that produced this pack. */
  builderCommit: string;

  /** Files in the pack, relative to the pack directory. */
  files: {
    tiles: PackFile;
    geocode: PackFile;
    routing: PackFile;
  };

  /** Anchors used by the self-test harness to verify the pack works offline. */
  selfTestAnchors: SelfTestAnchors;
}

export interface PackFile {
  /** Path relative to the pack root, forward slashes. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** Lowercase hex SHA-256. */
  sha256: string;
}

export interface SelfTestAnchors {
  /** Place names guaranteed to return at least one result from forward search. */
  searchTerms: string[];

  /** A point inside the region for reverse geocoding to return a road. */
  reversePoint: { lat: number; lon: number };

  /** Two points inside the region for routing to find a valid route between. */
  routeWaypoints: [{ lat: number; lon: number }, { lat: number; lon: number }];

  /** A zoom/x/y tile that exists in the pmtiles (used to verify tile reads). */
  tileSample: { z: number; x: number; y: number };
}

export class ManifestValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/**
 * Validate a parsed manifest object. Throws ManifestValidationError on first
 * problem found. Returns the typed manifest on success.
 *
 * This is deliberately strict: an invalid manifest means we'd silently fail
 * later when actually reading the pack. Fail loud and early.
 */
export function validateManifest(raw: unknown): RegionManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestValidationError('manifest is not an object');
  }
  const m = raw as Record<string, unknown>;

  if (m.schemaVersion !== 1) {
    throw new ManifestValidationError(
      `unsupported schemaVersion ${String(m.schemaVersion)} (expected 1)`,
      'schemaVersion',
    );
  }

  requireString(m, 'id', /^[a-z][a-z0-9-]*$/);
  requireString(m, 'name');
  requireString(m, 'country', /^[A-Z]{2}$/);
  requireString(m, 'builtAt');
  requireString(m, 'builderCommit', /^[0-9a-f]{7,40}$/);

  const bbox = m.bbox;
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw new ManifestValidationError('bbox must be [minLon,minLat,maxLon,maxLat] of finite numbers', 'bbox');
  }
  const [minLon, minLat, maxLon, maxLat] = bbox as [number, number, number, number];
  if (minLon >= maxLon || minLat >= maxLat) {
    throw new ManifestValidationError('bbox min must be < max', 'bbox');
  }
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) {
    throw new ManifestValidationError('bbox out of WGS84 range', 'bbox');
  }

  const files = m.files as Record<string, unknown> | undefined;
  if (!files || typeof files !== 'object') {
    throw new ManifestValidationError('files missing', 'files');
  }
  validatePackFile(files.tiles, 'files.tiles');
  validatePackFile(files.geocode, 'files.geocode');
  validatePackFile(files.routing, 'files.routing');

  const anchors = m.selfTestAnchors as Record<string, unknown> | undefined;
  if (!anchors || typeof anchors !== 'object') {
    throw new ManifestValidationError('selfTestAnchors missing', 'selfTestAnchors');
  }
  validateAnchors(anchors);

  return raw as RegionManifest;
}

function requireString(obj: Record<string, unknown>, key: string, pattern?: RegExp): void {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ManifestValidationError(`${key} must be a non-empty string`, key);
  }
  if (pattern && !pattern.test(v)) {
    throw new ManifestValidationError(`${key} does not match ${pattern.source}`, key);
  }
}

function validatePackFile(raw: unknown, field: string): void {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestValidationError(`${field} must be an object`, field);
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.path !== 'string' || f.path.length === 0) {
    throw new ManifestValidationError(`${field}.path missing`, field);
  }
  if (typeof f.bytes !== 'number' || !Number.isInteger(f.bytes) || f.bytes < 0) {
    throw new ManifestValidationError(`${field}.bytes must be non-negative integer`, field);
  }
  if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) {
    throw new ManifestValidationError(`${field}.sha256 must be 64 lowercase hex chars`, field);
  }
}

function validateAnchors(raw: Record<string, unknown>): void {
  const terms = raw.searchTerms;
  if (!Array.isArray(terms) || terms.length === 0 || !terms.every((t) => typeof t === 'string')) {
    throw new ManifestValidationError('searchTerms must be non-empty string array', 'selfTestAnchors.searchTerms');
  }
  validateLatLon(raw.reversePoint, 'selfTestAnchors.reversePoint');
  const wp = raw.routeWaypoints;
  if (!Array.isArray(wp) || wp.length !== 2) {
    throw new ManifestValidationError('routeWaypoints must be exactly 2 points', 'selfTestAnchors.routeWaypoints');
  }
  validateLatLon(wp[0], 'selfTestAnchors.routeWaypoints[0]');
  validateLatLon(wp[1], 'selfTestAnchors.routeWaypoints[1]');
  const ts = raw.tileSample as Record<string, unknown> | undefined;
  if (!ts) throw new ManifestValidationError('tileSample missing', 'selfTestAnchors.tileSample');
  for (const k of ['z', 'x', 'y'] as const) {
    if (typeof ts[k] !== 'number' || !Number.isInteger(ts[k])) {
      throw new ManifestValidationError(`tileSample.${k} must be integer`, `selfTestAnchors.tileSample.${k}`);
    }
  }
}

function validateLatLon(raw: unknown, field: string): void {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestValidationError(`${field} must be {lat, lon}`, field);
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.lat !== 'number' || p.lat < -90 || p.lat > 90) {
    throw new ManifestValidationError(`${field}.lat out of range`, field);
  }
  if (typeof p.lon !== 'number' || p.lon < -180 || p.lon > 180) {
    throw new ManifestValidationError(`${field}.lon out of range`, field);
  }
}
