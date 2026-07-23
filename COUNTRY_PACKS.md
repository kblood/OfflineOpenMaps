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

### Regional composite routing

The desktop and modern web runtimes can also route over the installed regional
packs without installing the unified country database. `CompositeRouter` opens
the routing SQLite file from every installed pack in the active pack's country
and exposes them as one logical graph. Regional packs built from the same OSM
source retain their global OSM node ids, so an id present in two overlapping
packs is the exact junction between them. Local `edges.id` values are never
treated as global identities.

The router does not connect regions by coordinate proximity. If the installed
packs do not contain a continuous chain of shared nodes, routing returns
`no-route`. The map and geocoder still use the actively selected pack. On the
web, the composite router runs in a worker and opens each regional database
directly through the OPFS VFS, so installing all 28 regions does not copy every
routing graph into the UI's JavaScript heap. A catalog-driven
`missing-regions` response remains follow-up work.

## Runtime and migration

Desktop opens `openmaps.sqlite` directly from disk. Existing schema-v1 split
packs remain valid and can coexist with schema-v2 packs.

The web installer streams schema-v2 databases into content-addressed OPFS
storage and hashes each chunk as it arrives. Hosted transfers resume with an
HTTP Range request after an interruption. Only a successfully size- and
SHA-256-verified file is registered as installed; the prior installed version
is retained until that point.

The browser opens the same database read-only through sqlite-wasm's OPFS VFS
inside a dedicated worker. Tile reads, search, reverse geocoding, parcel lookup,
and routing stay off the UI thread and the complete database is never copied
into the JavaScript heap. This path requires a secure, cross-origin-isolated
page plus OPFS, Web Workers, and `SharedArrayBuffer`. Browsers lacking those
features can still use small schema-v1 packs through the in-memory fallback,
but cannot combine several graphs. The Denmark catalog collection installs its
28 regional members serially, skips members already present, and opens the
composite graph when installation completes.
