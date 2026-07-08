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

## Loading a pack

The MVP loads a region pack from a **user-picked folder**:

1. Click **Choose pack folder…** in the sidebar.
2. Select the directory that contains:
   - `manifest.json`
   - `tiles.mbtiles`
   - `geocode.sqlite`
3. The map renders once the three files have been deserialized into in-memory
   SQLite databases.

The pack stays in memory until the page is reloaded — there is no persistence
in MVP. OPFS-backed persistence is on the roadmap.

## Differences vs the Electron shell

| Feature                       | Electron        | Web (MVP)                       |
| ----------------------------- | --------------- | ------------------------------- |
| Offline-first                 | ✅ `session.setOffline` enforces it | ⚠️ Browser doesn't expose a `setOffline` toggle; a service worker that drops `fetch` events is a future task |
| Pack storage                  | Filesystem      | In-memory (file picker)         |
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
The Dijkstra algorithm in `InternalRouter.ts` is unchanged from the Node
version — only the SQLite handle differs.

## Roadmap

- **OPFS persistence** — store deserialized SQLite files in OPFS so the pack
  survives reloads. The build is already COOP/COEP-isolated.
- **Service worker offline lock** — a SW that drops every `fetch()` except
  for `omap://` and same-origin static assets, exposing an `offline.set()`
  that matches Electron's guarantee semantics.
- **Web pack importer** — fetch built packs over HTTPS from a configured pack
  URL, then write into OPFS.
- **Code-split** — the main bundle is ~1.2 MB minified (~340 KB gzipped) and
  pulls in MapLibre + React. Dynamic-import the router so first paint doesn't
  wait on routing code.
