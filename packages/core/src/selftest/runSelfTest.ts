import type { RegionPack } from '../pack/index.js';
import { RoutingUnavailableError } from '../route/index.js';

/**
 * The four offline guarantees from PLAN.md, as executable checks.
 * runSelfTest is the canonical answer to "is offline working?". It's:
 *  - called from the in-app debug panel after toggling Electron to offline mode
 *  - called from Playwright CI tests with the browser context offline
 *  - called from the region-builder's verify-pack step
 *
 * No check makes a network call. Every input comes from the manifest's
 * selfTestAnchors. Every check has a hard 5s timeout.
 */

export type CheckId = 'tiles' | 'search' | 'reverse' | 'route';
export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: CheckId;
  readonly status: CheckStatus;
  readonly ms: number;
  /** Short human-readable summary, shown in the UI. */
  readonly summary: string;
  /** Engine-level detail for debug, optional. */
  readonly detail?: unknown;
}

export interface SelfTestReport {
  readonly packId: string;
  readonly ranAt: string;
  readonly results: readonly CheckResult[];
  readonly allPassed: boolean;
}

const CHECK_TIMEOUT_MS = 5000;

export async function runSelfTest(pack: RegionPack): Promise<SelfTestReport> {
  const results: CheckResult[] = [];
  results.push(await runCheck('tiles', () => checkTiles(pack)));
  results.push(await runCheck('search', () => checkSearch(pack)));
  results.push(await runCheck('reverse', () => checkReverse(pack)));
  results.push(await runCheck('route', () => checkRoute(pack)));
  return {
    packId: pack.manifest.id,
    ranAt: new Date().toISOString(),
    results,
    allPassed: results.every((r) => r.status === 'pass'),
  };
}

async function runCheck(
  id: CheckId,
  fn: () => Promise<{ summary: string; detail?: unknown }>,
): Promise<CheckResult> {
  const t0 = performance.now();
  try {
    const out = await withTimeout(fn(), CHECK_TIMEOUT_MS, `${id} timed out after ${CHECK_TIMEOUT_MS}ms`);
    return {
      id,
      status: 'pass',
      ms: Math.round(performance.now() - t0),
      summary: out.summary,
      ...(out.detail !== undefined ? { detail: out.detail } : {}),
    };
  } catch (err) {
    return {
      id,
      status: 'fail',
      ms: Math.round(performance.now() - t0),
      summary: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkTiles(pack: RegionPack): Promise<{ summary: string; detail?: unknown }> {
  const { tileSample } = pack.manifest.selfTestAnchors;
  const tile = await pack.tiles.getTile(tileSample.z, tileSample.x, tileSample.y);
  if (!tile) {
    throw new Error(`tile z=${tileSample.z} x=${tileSample.x} y=${tileSample.y} returned null`);
  }
  if (tile.bytes.length === 0) {
    throw new Error('tile bytes empty');
  }
  // MVT tiles compressed with gzip start with 0x1f 0x8b. PNG starts with 0x89 0x50.
  // Either is fine — we just need real bytes, not a placeholder.
  return {
    summary: `${tile.bytes.length} bytes (${tile.contentType})`,
    detail: { firstBytes: Array.from(tile.bytes.slice(0, 4)) },
  };
}

async function checkSearch(pack: RegionPack): Promise<{ summary: string; detail?: unknown }> {
  const terms = pack.manifest.selfTestAnchors.searchTerms;
  const term = terms[0];
  if (term === undefined) throw new Error('manifest has no searchTerms');
  const results = await pack.geocode.search(term, { limit: 5 });
  if (results.length === 0) {
    throw new Error(`search for "${term}" returned 0 results`);
  }
  const r = results[0]!;
  const [minLon, minLat, maxLon, maxLat] = pack.manifest.bbox;
  if (r.lon < minLon || r.lon > maxLon || r.lat < minLat || r.lat > maxLat) {
    throw new Error(`top result for "${term}" is outside the pack bbox`);
  }
  return {
    summary: `"${term}" → ${results.length} results, top: ${r.displayName}`,
    detail: { topResult: r, allCount: results.length },
  };
}

async function checkReverse(pack: RegionPack): Promise<{ summary: string; detail?: unknown }> {
  const { reversePoint } = pack.manifest.selfTestAnchors;
  const result = await pack.geocode.reverse(reversePoint.lat, reversePoint.lon, { maxRadiusM: 500 });
  if (!result) {
    throw new Error(`reverse at ${reversePoint.lat},${reversePoint.lon} returned null`);
  }
  return {
    summary: `${result.displayName} (${result.kind}, ${Math.round(result.distanceM)}m)`,
    detail: result,
  };
}

async function checkRoute(pack: RegionPack): Promise<{ summary: string; detail?: unknown }> {
  const [a, b] = pack.manifest.selfTestAnchors.routeWaypoints;
  try {
    const route = await pack.router.route({
      waypoints: [a, b],
      profile: 'car',
    });
    if (route.geometry.length < 2) {
      throw new Error(`route geometry has only ${route.geometry.length} points`);
    }
    if (route.distanceM <= 0) {
      throw new Error(`route distance is ${route.distanceM}m`);
    }
    // Sanity: route distance should be at least the crow-fly distance.
    const crow = crowFlyMeters(a, b);
    if (route.distanceM < crow * 0.8) {
      throw new Error(`route ${route.distanceM}m is implausibly shorter than crow-fly ${crow}m`);
    }
    // And not absurdly longer (5x crow-fly suggests we routed via the wrong continent).
    if (route.distanceM > crow * 5) {
      throw new Error(`route ${route.distanceM}m is >5x crow-fly ${crow}m`);
    }
    return {
      summary: `${(route.distanceM / 1000).toFixed(1)} km, ${Math.round(route.durationS / 60)} min (${route.engine})`,
      detail: {
        engine: route.engine,
        distanceM: route.distanceM,
        durationS: route.durationS,
        steps: route.steps.length,
      },
    };
  } catch (err) {
    if (err instanceof RoutingUnavailableError) {
      throw new Error(`router unavailable: ${err.reason} — ${err.message}`);
    }
    throw err;
  }
}

function crowFlyMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
