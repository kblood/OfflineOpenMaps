#!/usr/bin/env node
/**
 * Builds Denmark as bounded, overlapping region packs. A country-scale PBF
 * expands far beyond the in-memory representation used by the v1 builder;
 * these regions keep each invocation bounded while retaining the normal
 * tiles/search/routing/self-test contract.
 *
 * Usage:
 *   node scripts/build-denmark-regions.mjs --pbf data/denmark-latest.osm.pbf
 *   node scripts/build-denmark-regions.mjs --pbf data/denmark-latest.osm.pbf --only denmark-bornholm
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const regions = [
  ['denmark-northwest-jutland', 'Denmark — Northwest Jutland', [8.0, 57.0, 9.2, 57.8]],
  ['denmark-north-central-jutland', 'Denmark — North Central Jutland', [9.1, 57.0, 10.1, 57.8]],
  ['denmark-northeast-jutland', 'Denmark — Northeast Jutland', [10.0, 57.0, 10.9, 57.8]],
  ['denmark-northwest-himmerland', 'Denmark — Northwest Himmerland', [8.0, 56.55, 9.2, 57.1]],
  ['denmark-north-central-himmerland', 'Denmark — North Central Himmerland', [9.1, 56.55, 10.1, 57.1]],
  ['denmark-northeast-himmerland', 'Denmark — Northeast Himmerland', [10.0, 56.55, 10.9, 57.1]],
  ['denmark-centralwest-jutland', 'Denmark — Central West Jutland', [8.0, 56.15, 9.2, 56.65]],
  ['denmark-central-jutland', 'Denmark — Central Jutland', [9.1, 56.15, 10.1, 56.65]],
  ['denmark-centraleast-jutland', 'Denmark — Central East Jutland', [10.0, 56.15, 10.9, 56.65]],
  ['denmark-centralwest-midjutland', 'Denmark — Central West Mid-Jutland', [8.0, 55.75, 9.2, 56.25]],
  ['denmark-central-midjutland', 'Denmark — Central Mid-Jutland', [9.1, 55.75, 10.1, 56.25]],
  ['denmark-centraleast-midjutland', 'Denmark — Central East Mid-Jutland', [10.0, 55.75, 10.9, 56.25]],
  ['denmark-southwest-jutland', 'Denmark — Southwest Jutland', [8.0, 55.1, 9.2, 55.85]],
  ['denmark-south-central-jutland', 'Denmark — South Central Jutland', [9.1, 55.1, 10.1, 55.85]],
  ['denmark-southeast-jutland', 'Denmark — Southeast Jutland', [10.0, 55.1, 10.9, 55.85]],
  ['denmark-southwest-southern-jutland', 'Denmark — Southwest Southern Jutland', [8.0, 54.5, 9.2, 55.2]],
  ['denmark-south-central-southern-jutland', 'Denmark — South Central Southern Jutland', [9.1, 54.5, 10.1, 55.2]],
  ['denmark-southeast-southern-jutland', 'Denmark — Southeast Southern Jutland', [10.0, 54.5, 10.9, 55.2]],
  ['denmark-funen-west', 'Denmark — West Funen', [9.75, 54.95, 10.75, 56.1]],
  ['denmark-funen-east', 'Denmark — East Funen', [10.65, 54.95, 11.65, 56.1]],
  ['denmark-zealand-west-north', 'Denmark — Northwest Zealand', [10.95, 55.6, 11.7, 56.2]],
  ['denmark-zealand-west-south', 'Denmark — Southwest Zealand', [10.95, 55.0, 11.7, 55.7]],
  ['denmark-zealand-central-north', 'Denmark — North Central Zealand', [11.6, 55.6, 12.25, 56.2]],
  ['denmark-zealand-central-south', 'Denmark — South Central Zealand', [11.6, 55.0, 12.25, 55.7]],
  ['denmark-copenhagen-north', 'Denmark — Copenhagen & North Zealand', [12.2, 55.65, 12.95, 56.2]],
  ['denmark-copenhagen-south', 'Denmark — Copenhagen & South Zealand', [12.1, 55.35, 12.95, 55.78]],
  ['denmark-lolland-falster', 'Denmark — Lolland-Falster', [10.55, 54.5, 12.35, 55.25]],
  ['denmark-bornholm', 'Denmark — Bornholm', [14.45, 54.9, 15.45, 55.4]],
];

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const pbf = value('--pbf');
const only = value('--only');
if (!pbf || !existsSync(pbf)) {
  throw new Error('Pass an existing Geofabrik extract: --pbf data/denmark-latest.osm.pbf');
}

const selected = only ? regions.filter(([id]) => id === only) : regions;
if (selected.length === 0) throw new Error(`Unknown Denmark region: ${only}`);

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = resolve(root, 'packages/region-builder/dist/cli.js');
for (const [id, name, bbox] of selected) {
  process.stdout.write(`\n=== Building ${name} (${id}) ===\n`);
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=8192', cli, 'build-pbf', '--pbf', resolve(pbf),
      '--bbox', bbox.join(','), '--id', id, '--name', name, '--country', 'DK', '--skip-dawa', '--out', resolve(root, 'packs'),
    ],
    { stdio: 'inherit', cwd: root },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
