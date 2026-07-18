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
  // Copenhagen → Aarhus crosses the Zealand/Jutland regional boundary and is
  // therefore a meaningful proof that this is one national graph, not a
  // regional router with a larger filename.
  const route = await router.route({
    profile: 'car',
    waypoints: [
      { lat: 55.6761, lon: 12.5683 },
      { lat: 56.1629, lon: 10.2039 },
    ],
  });
  if (route.geometry.length < 2 || route.distanceM < 100_000) {
    throw new Error(`cross-Denmark route is implausible: ${route.geometry.length} points, ${route.distanceM} m`);
  }
  console.log(`PASS Copenhagen → Aarhus: ${(route.distanceM / 1000).toFixed(1)} km, ${Math.round(route.durationS / 60)} min`);
} finally {
  await router.close();
}
