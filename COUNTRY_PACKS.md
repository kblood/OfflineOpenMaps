# Country packs: one SQLite database per country

OpenMaps now supports a schema-v2 *unified pack*. A unified pack is one
`openmaps.sqlite` file containing all offline runtime data:

- MBTiles-compatible `metadata` and `tiles` tables for MapLibre;
- FTS5 and R*Tree search/reverse-geocoding tables;
- `nodes`, `edges` and their indexes for the internal Dijkstra router.

The three logical manifest entries (`tiles`, `geocode`, `routing`) are exact
aliases of `files.database`. Keeping the aliases lets existing pack consumers
migrate without guessing which file serves which feature. A schema-v2 manifest
is rejected unless all four entries have the same path, byte count and SHA-256.

## Building Denmark

Build from the original country PBF, not by concatenating the 28 published
region files. The original OSM node IDs are then preserved throughout the
country graph, so roads crossing previous region boundaries are naturally the
same vertices.

```powershell
node packages/region-builder/dist/cli.js build-pbf `
  --pbf C:\data\denmark-latest.osm.pbf `
  --id denmark --name Denmark --country DK --out .\packs `
  --unified-database
node scripts/verify-pack.mjs denmark
```

The output folder contains only `manifest.json` and `openmaps.sqlite`.
`verify-pack` must pass tiles, search, reverse geocoding and routes before the
pack is published.

## Routing rules

The unified builder writes every OSM edge with its car, bicycle and foot
permissions. `InternalRouter` queries the same `nodes` and `edges` tables as
the regional packs, so all three profiles work across the full country. There
is no route stitching at regional boundaries and no separate national
"backbone" is required for a unified pack.

## Runtime and migration

Desktop opens `openmaps.sqlite` directly from disk and is the supported
runtime for a country-sized pack today. Existing schema-v1 split packs remain
valid and can coexist with schema-v2 packs.

The web installer recognises schema-v2 packs and opens one SQLite connection
shared by the map, search and router; it no longer deserializes the country
database twice. The current sqlite-wasm adapter still deserializes an opened
database into memory, so a multi-gigabyte Denmark pack must **not** be
published for browser installation until the next migration is complete:

1. download `openmaps.sqlite` directly into SQLite's worker-based OPFS VFS;
2. checksum it incrementally while streaming, rather than retaining chunks;
3. open the same OPFS-backed database from a worker, keeping map reads,
   search and routing off the UI thread.

This is a storage/runtime change only. The country database schema and the
manifest introduced here are deliberately the stable input to that migration.
