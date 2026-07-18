#!/usr/bin/env node
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildFakelandData } from './synthetic.js';
import { writeGeocodeDb } from './writeGeocode.js';
import { writeMbtiles } from './writeMbtiles.js';
import { writeManifest } from './writeManifest.js';
import { readOsmXml } from './osmXmlReader.js';
import { readOsmPbf } from './osmPbfReader.js';
import { osmToPack } from './osmToPack.js';
import { chooseAnchors } from './chooseAnchors.js';
import { fetchDawa, applyDawa } from './dawaFetcher.js';
import { snapAddressesToBuildings } from './snapAddresses.js';
import type { SyntheticData } from './synthetic.js';

interface CliArgs {
  command: 'build-synthetic' | 'build-osm' | 'build-pbf' | 'help';
  packId?: string;
  packName?: string;
  country?: string;
  outDir?: string;
  pbfPath?: string;
  osmPath?: string;
  clipBbox?: [number, number, number, number];
  skipDawaParcels?: boolean;
  skipDawa?: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { command: 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === 'build-synthetic') args.command = 'build-synthetic';
    else if (a === 'build-osm') args.command = 'build-osm';
    else if (a === 'build-pbf') args.command = 'build-pbf';
    else if (a === '--id') {
      const v = argv[++i];
      if (v !== undefined) args.packId = v;
    } else if (a === '--name') {
      const v = argv[++i];
      if (v !== undefined) args.packName = v;
    } else if (a === '--country') {
      const v = argv[++i];
      if (v !== undefined) args.country = v;
    } else if (a === '--out') {
      const v = argv[++i];
      if (v !== undefined) args.outDir = v;
    } else if (a === '--pbf') {
      const v = argv[++i];
      if (v !== undefined) args.pbfPath = v;
    } else if (a === '--in') {
      const v = argv[++i];
      if (v !== undefined) args.osmPath = v;
    } else if (a === '--bbox') {
      // Format: minLon,minLat,maxLon,maxLat
      const v = argv[++i];
      if (v !== undefined) {
        const parts = v.split(',').map((p) => Number(p.trim()));
        if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
          args.clipBbox = parts as [number, number, number, number];
        } else {
          process.stderr.write(`--bbox expects "minLon,minLat,maxLon,maxLat" (got ${v})\n`);
          process.exit(2);
        }
      }
    } else if (a === '--skip-dawa-parcels') {
      args.skipDawaParcels = true;
    } else if (a === '--skip-dawa') {
      args.skipDawa = true;
    } else if (a === '--help' || a === '-h') args.command = 'help';
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    process.stdout.write(`
region-builder — produce an OpenMaps v2 region pack

Usage:
  region-builder build-synthetic --id <id> --out <dir>
      Build a synthetic fixture pack (deterministic Fakeland data,
      ~36 nodes, ~120 edges, 7 named features). For tests and demos.

  region-builder build-osm --in <file.osm> --id <id> --out <dir>
                           [--name <human-name>] [--country <XX>]
      Build a pack from an OSM XML extract (e.g. an Overpass export).
      Suitable for city-sized regions. For country-sized data, use
      build-pbf (coming soon).

  region-builder build-pbf --pbf <file.osm.pbf> --id <id> --out <dir>
                           [--name <human-name>] [--country <XX>]
                           [--bbox <minLon,minLat,maxLon,maxLat>]
                           [--skip-dawa-parcels]
                           [--skip-dawa]
      Build a pack from a Geofabrik .osm.pbf extract. For country-sized
      files you almost always want --bbox to clip down to a region of
      interest before the pack is written; otherwise expect multi-GB
      tile MBTiles output.

Examples:
  region-builder build-synthetic --id fakeland --out ./packs
  region-builder build-osm --in andorra.osm --id andorra --name Andorra --country AD --out ./packs
  region-builder build-pbf --pbf denmark.osm.pbf --bbox 12.4,55.6,12.7,55.75 \\
                           --id copenhagen --name Copenhagen --country DK --out ./packs
`);
    return;
  }

  if (!args.packId || !args.outDir) {
    process.stderr.write('Missing required arg (--id and --out). Run with --help.\n');
    process.exit(2);
  }

  const packDir = resolve(args.outDir, args.packId);
  await rm(packDir, { recursive: true, force: true });
  await mkdir(packDir, { recursive: true });

  let data: SyntheticData;
  let packName: string;
  let country: string;
  let useChosenAnchors = false;

  if (args.command === 'build-synthetic') {
    process.stdout.write(`Building synthetic pack '${args.packId}' at ${packDir}\n`);
    data = buildFakelandData();
    packName = args.packName ?? 'Fakeland';
    country = args.country ?? 'XX';
  } else if (args.command === 'build-osm') {
    if (!args.osmPath) {
      process.stderr.write('build-osm requires --in <file.osm>.\n');
      process.exit(2);
    }
    process.stdout.write(`Reading OSM XML from ${args.osmPath}\n`);
    const raw = await readOsmXml(args.osmPath);
    process.stdout.write(`  - raw: ${raw.nodes.length} nodes, ${raw.ways.length} ways\n`);
    data = osmToPack(raw, args.clipBbox ? { clipBbox: args.clipBbox } : {});
    packName = args.packName ?? args.packId;
    country = args.country ?? 'XX';
    useChosenAnchors = true;
  } else {
    // build-pbf
    if (!args.pbfPath) {
      process.stderr.write('build-pbf requires --pbf <file.osm.pbf>.\n');
      process.exit(2);
    }
    process.stdout.write(`Reading OSM PBF from ${args.pbfPath}\n`);
    if (args.clipBbox) {
      process.stdout.write(`  - clip bbox: ${args.clipBbox.join(', ')}\n`);
    } else {
      process.stdout.write(
        `  - WARN: no --bbox; reading the full file (this can be GB-scale)\n`,
      );
    }
    let lastReport = Date.now();
    const raw = await readOsmPbf(args.pbfPath, {
      ...(args.clipBbox ? { clipBbox: args.clipBbox } : {}),
      progressInterval: 250_000,
      onProgress: ({ nodes, ways }) => {
        const now = Date.now();
        if (now - lastReport >= 2000) {
          process.stdout.write(`  - parsed ${nodes} nodes, ${ways} ways...\n`);
          lastReport = now;
        }
      },
    });
    process.stdout.write(`  - raw: ${raw.nodes.length} nodes, ${raw.ways.length} ways\n`);
    data = osmToPack(raw, args.clipBbox ? { clipBbox: args.clipBbox } : {});
    packName = args.packName ?? args.packId;
    country = args.country ?? 'XX';
    useChosenAnchors = true;
  }

  process.stdout.write(`  - bbox: ${data.bbox.join(', ')}\n`);
  process.stdout.write(
    `  - ${data.nodes.length} nodes, ${data.edges.length} edges, ${data.places.length} places\n`,
  );
  if (data.nodes.length === 0 || data.edges.length === 0) {
    process.stderr.write('Refusing to build pack: empty graph (no routable roads found).\n');
    process.exit(3);
  }

  // DK packs swap their OSM-derived addresses for DAWA (the official Danish
  // address registry — full coverage, daily-updated, parcel polygons included).
  // Other countries keep OSM addresses; we can broaden this when another
  // country's authoritative registry is wired up.
  if (country === 'DK' && !args.skipDawa) {
    process.stdout.write('  - augmenting with DAWA (authoritative DK addresses)\n');
    try {
      const dawa = await fetchDawa({
        bbox: data.bbox,
        includeParcels: !args.skipDawaParcels,
        onProgress: (msg) => process.stdout.write(`    ${msg}\n`),
      });
      data = applyDawa(data, dawa);
      process.stdout.write(
        `  - DAWA: ${dawa.addresses.length} addresses, ${dawa.parcels.length} parcels\n`,
      );
    } catch (err) {
      process.stderr.write(
        `  - DAWA fetch failed (continuing with OSM addresses): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  } else if (country === 'DK') {
    process.stdout.write('  - skipping DAWA enrichment (OSM-only regional build)\n');
  }

  // Snap address pins to the centroid of their containing building footprint
  // when one exists. Runs for every pack with buildings — independent of
  // country / source — so it helps OSM-only packs too.
  {
    const { data: snappedData, snapped } = snapAddressesToBuildings(data);
    data = snappedData;
    if (snapped > 0) {
      process.stdout.write(`  - snapped ${snapped} address pins to building centroids\n`);
    }
  }

  process.stdout.write('  - writing tiles.mbtiles\n');
  writeMbtiles(join(packDir, 'tiles.mbtiles'), data, {
    name: args.packId,
    attribution:
      args.command === 'build-synthetic'
        ? '© OpenMaps v2 synthetic data'
        : args.command === 'build-pbf'
          ? '© OpenStreetMap contributors (ODbL) — built from PBF'
          : '© OpenStreetMap contributors (ODbL)',
  });

  process.stdout.write('  - writing geocode.sqlite\n');
  writeGeocodeDb(join(packDir, 'geocode.sqlite'), data);

  process.stdout.write('  - writing manifest.json\n');
  const [minLon, minLat, maxLon, maxLat] = data.bbox;
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;
  const z = 10;
  const n = 1 << z;
  const tx = Math.floor(((cx + 180) / 360) * n);
  const r = (cy * Math.PI) / 180;
  const ty = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);

  await writeManifest({
    packDir,
    id: args.packId,
    name: packName,
    country,
    data,
    builderCommit: process.env.GIT_COMMIT ?? '0000000',
    tileSample: { z, x: tx, y: ty },
    ...(useChosenAnchors ? { anchors: chooseAnchors(data) } : {}),
  });

  process.stdout.write(`Done. Pack ready at ${packDir}\n`);
}

main().catch((err) => {
  process.stderr.write(`region-builder failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
