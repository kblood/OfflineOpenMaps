# @openmaps/web-shell

Browser shell for OpenMaps v2. Runs the same offline mapping experience as the
Electron app but in a Chromium/Firefox/Safari tab, using **sqlite-wasm** for
the pack databases and **MapLibre GL** for rendering.

## Dev

```bash
npm install                      # at the repo root
npm run dev -w @openmaps/web-shell
# Vite serves on http://localhost:5174
```

## Build

```bash
npm run build -w @openmaps/web-shell
# Static site lands in shells/web/dist/
```

The deployed shell registers a service worker that caches the application
assets and fonts. Once it has been opened online once, the app can reload with
the network disconnected and reopen a previously installed pack. Pack database
files are deliberately not duplicated in Cache Storage; they remain in the
verified pack store.

## Loading a pack

The MVP loads a region pack from a **user-picked folder**:

1. Click **Choose pack folder…** in the sidebar.
2. Select either a legacy directory containing `manifest.json`,
   `tiles.mbtiles` and `geocode.sqlite`, or a schema-v2 country directory
   containing `manifest.json` and `openmaps.sqlite`.
3. The map renders once the required SQLite data has been deserialized.

After a successful checksum verification, the pack is installed in the
browser's persistent storage and can be reopened after a page reload. Modern
browsers store pack files in OPFS; browsers without OPFS use IndexedDB. The
SQLite runtime still deserializes an open pack into memory. A schema-v2 pack
shares one connection between map, search and routing, but a multi-gigabyte
country pack still needs the worker-based OPFS VFS migration described in
[COUNTRY_PACKS.md](../../COUNTRY_PACKS.md) before browser publication.

## Differences vs the Electron shell

| Feature                       | Electron        | Web (MVP)                       |
| ----------------------------- | --------------- | ------------------------------- |
| Offline-first                 | ✅ `session.setOffline` enforces it | ⚠️ Browser doesn't expose a `setOffline` toggle; a service worker that drops `fetch` events is a future task |
| Pack storage                  | Filesystem      | OPFS where available, IndexedDB fallback; in-memory while open |
| In-app pack builder (Overpass / Geofabrik) | ✅            | ❌ CORS blocks both endpoints from the browser; build packs with the CLI and load them here |
| Pack picker (multi-pack)      | ✅              | ❌ MVP loads one pack at a time |
| Self-test panel               | ✅              | ❌ Without a hard offline lock the panel would over-promise |
| Geocode search                | ✅              | ✅                              |
| Reverse geocoding             | ✅              | ✅                              |
| Internal Dijkstra router      | ✅              | ✅                              |

## Architecture

```
src/
  App.tsx                  React entry — pack picker + map
  openmapsApi.ts           Shape-compatible mirror of the Electron `api`
  lib/
    sqlite.ts              Thin compatibility layer over @sqlite.org/sqlite-wasm
    MbtilesTileSource.ts   Port of platform-node/MbtilesTileSource
    GeocodeIndex.ts        Port of platform-node/SqliteGeocodeIndex
    InternalRouter.ts      Port of platform-node/InternalRouter
  buildMapStyle.ts         Shared verbatim with the Electron renderer
  MapView.tsx              Shared verbatim with the Electron renderer
  SearchBar.tsx            Shared verbatim with the Electron renderer
  RoutePanel.tsx           Shared verbatim with the Electron renderer
  styles.css               Web-specific styling
public/
  fonts/                   MapLibre glyph PBFs (copied from the Electron shell)
```

The platform-node implementations use `node:sqlite`; the browser ports use
`@sqlite.org/sqlite-wasm` via `sqlite3_deserialize` against in-memory bytes.
`InternalRouter.ts` uses A* over the extracted OSM graph in both environments;
only the SQLite handle differs. This keeps regional routing responsive without
changing routing semantics.

For Denmark-wide driving, `scripts/build-denmark-routing.mjs` generates a
separate, merged car-routing companion from the 28 regional graphs. It uses
their shared OSM node IDs to cross pack boundaries as one graph, rather than
stitching separate route results. The companion is verified with Copenhagen →
Aarhus before publishing. It is intentionally separate from map packs because
the national graph is much larger than a regional map download. In the web
picker, choose **Enable Denmark-wide car routing** to download it separately;
car routes with Denmark-wide coordinates then automatically use that graph,
while the open regional pack continues to provide tiles, search, and detailed
bike/foot routing. Route coordinates can also be entered directly, which makes
cross-region trips possible without switching the map pack first.

## Roadmap

- **OPFS-backed SQLite** — open installed databases through SQLite's
  worker-based OPFS VFS rather than deserializing them into memory on every launch.
- **Service worker offline lock** — a SW that drops every `fetch()` except
  for `omap://` and same-origin static assets, exposing an `offline.set()`
  that matches Electron's guarantee semantics.
- **Web pack importer** — fetch built packs over HTTPS from a configured pack
  URL, then write into OPFS.
- **Code-split** — the main bundle is ~1.2 MB minified (~340 KB gzipped) and
  pulls in MapLibre + React. Dynamic-import the router so first paint doesn't
  wait on routing code.
