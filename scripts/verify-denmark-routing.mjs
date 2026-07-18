#!/usr/bin/env node
/** Verify that the national routing companion can cross regional pack borders. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InternalRouter } from '../packages/platform-node/dist/index.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dbPath = resolve(root, process.argv[2] ?? 'routing/denmark-routing.sqlite');
if (!existsSync(dbPath)) throw new Error(`routing companion not found: ${dbPath}`);

const router = new InternalRouter(dbPath);
try {
  // These cover both Storebælt crossings and the Jutland north/south axis.
  // Together they prove the companion is one graph across regional seams,
  // rather than a larger-named regional router.
  const checks = [
    ['Copenhagen → Aarhus', { lat: 55.6761, lon: 12.5683 }, { lat: 56.1629, lon: 10.2039 }, 100_000],
    ['Odense → Copenhagen', { lat: 55.4038, lon: 10.4024 }, { lat: 55.6761, lon: 12.5683 }, 80_000],
    ['Aalborg → Esbjerg', { lat: 57.0488, lon: 9.9217 }, { lat: 55.4765, lon: 8.4594 }, 150_000],
  ];
  for (const [name, from, to, minDistanceM] of checks) {
    const route = await router.route({ profile: 'car', waypoints: [from, to] });
    if (route.geometry.length < 2 || route.distanceM < minDistanceM) {
      throw new Error(`${name} is implausible: ${route.geometry.length} points, ${route.distanceM} m`);
    }
    console.log(`PASS ${name}: ${(route.distanceM / 1000).toFixed(1)} km, ${Math.round(route.durationS / 60)} min`);
  }
} finally {
  await router.close();
}
