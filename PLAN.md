# OpenMaps v2 — Offline-First Mapping

A clean-room rebuild. The v1 project tried to be everything (worldwide dynamic
explorer, polygon editor, custom packs, multi-engine routing) and ended up being
an online app with offline labels: search hit Nominatim directly, the "offline
router" was Haversine + random jitter, and `backend/data/mbtiles/` was empty.
v2 is opinionated, narrow, and verifiably offline.

## Non-negotiable guarantees

1. With the network fully disconnected after a region pack is installed, the
   app must:
   - Render map tiles (pan/zoom)
   - Search by name ("Aarhus", "Netto", "Vesterbrogade 12")
   - Reverse-geocode a tap (lat,lon → road / nearest address)
   - Compute a turn-by-turn route (car / bike / foot)
2. There are **zero hardcoded external URLs** in app runtime code. Every byte
   read at runtime comes from the local pack file(s) or local sidecar.
3. There is a one-click **"Go Offline & Self-Test"** button that severs all
   network access (Electron `session.enableNetworkEmulation({ offline: true })`)
   and runs the four checks above, producing a pass/fail report.
4. CI runs the same self-test under Playwright with `context.setOffline(true)`.

If a feature can't pass guarantee 3, it isn't shipped.

## Stack

| Concern              | Choice                                       | Why                                                                  |
| -------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Map tiles            | **PMTiles + MapLibre GL JS**                 | Single-file, HTTP-Range or file:// readable, vector, small.          |
| Geocoding (fwd+rev)  | **SQLite FTS5 + R*Tree per region**          | Same DB serves both queries; works in Electron *and* future browser. |
| Routing engine       | **BRouter (Java sidecar)** with adapter API  | Proven on Windows, ~5MB JAR, small per-country `.rd5` files.         |
| Region pack format   | `{region}.pmtiles` + `.sqlite` + `.rd5/`     | Three plain files in one folder. No magic.                           |
| Region pack source   | **Protomaps daily PMTiles** + **Geofabrik PBF** preprocessed | Standardized, dated, reproducible.                       |
| Desktop shell        | Electron (current Windows target)            | Existing build infra, native binary spawn for BRouter.               |
| Renderer / UI        | React 18 + Vite 5 + TypeScript               | Familiar; not a research project.                                    |
| Storage              | Filesystem (Electron) / OPFS (future PWA)    | Pack files are ~100-500 MB; IndexedDB is too slow.                   |

PWA shell is scaffolded but not a v1 shipping target. The shared core is
written so that swapping the filesystem layer for OPFS later doesn't change
business logic.

## Monorepo layout

```
openmaps-v2/
├── package.json                    # npm workspaces root
├── PLAN.md                         # this file
├── OLD_BUILD_AUDIT.md              # what failed in v1, evidence
├── README.md                       # how to run, where data lives
│
├── packages/
│   ├── core/                       # Pure TS, no DOM, no Node, no Electron
│   │   ├── src/
│   │   │   ├── pack/               # RegionPack interface, manifest schema, validation
│   │   │   ├── tiles/              # PMTiles reader interface (transport-agnostic)
│   │   │   ├── geocode/            # FTS5 queries, R*Tree nearest-neighbor (SQL strings)
│   │   │   ├── route/              # Routing-engine adapter interface, profile types
│   │   │   └── selftest/           # The four offline guarantees, reusable
│   │   └── tests/                  # Vitest unit tests
│   │
│   ├── platform-node/              # Node/Electron implementations of core interfaces
│   │   └── src/
│   │       ├── PackStorageFs.ts    # File-system pack reader
│   │       ├── SqliteAdapter.ts    # better-sqlite3
│   │       ├── PmtilesNodeSource.ts # File-backed PMTiles source
│   │       └── BrouterSidecar.ts   # Spawns java -jar brouter.jar, HTTP client
│   │
│   ├── platform-browser/           # (Stub for v2) OPFS + wa-sqlite + fetch PMTiles
│   │
│   ├── ui/                         # React components, framework-agnostic
│   │   └── src/
│   │       ├── MapView.tsx         # MapLibre wrapper, accepts a PMTiles source
│   │       ├── SearchBar.tsx       # Hits core/geocode, no fetch()
│   │       ├── RoutePanel.tsx      # Hits core/route adapter, no fetch()
│   │       ├── PackManager.tsx     # Install/uninstall regions
│   │       └── SelfTestPanel.tsx   # "Go Offline & Self-Test" button + results
│   │
│   └── region-builder/             # CLI: build a pack from a Geofabrik PBF
│       └── src/
│           ├── build-tiles.ts      # pmtiles extract from Protomaps daily
│           ├── build-geocode.ts    # Parse PBF → SQLite FTS5 + R*Tree
│           ├── build-route.ts      # Generate BRouter .rd5 segments
│           └── verify-pack.ts      # Self-check a built pack before publish
│
└── shells/
    ├── electron/                   # Electron app — the only v1 shipping target
    │   ├── main/
    │   │   ├── main.ts             # BrowserWindow + IPC + lifecycle
    │   │   ├── ipc.ts              # Pack management, offline toggle, sidecar control
    │   │   └── offlineMode.ts      # session.enableNetworkEmulation
    │   └── renderer/
    │       ├── index.html
    │       └── App.tsx             # Wires UI to platform-node implementations
    │
    └── pwa/                        # Scaffolded only, not shipped in v1
        └── README.md               # "Why this is a v2 stretch goal"
```

## Region pack format

A region is a folder named `{regionId}/` containing exactly:

```
denmark/
├── manifest.json          # version, bounds, layers, sizes, checksums, builder commit
├── tiles.pmtiles          # MapLibre vector tiles, z0-z14, Protomaps schema
├── geocode.sqlite         # FTS5 places + R*Tree roads + R*Tree pois
└── routing/
    ├── E5_N55.rd5         # BRouter segment file(s)
    └── ...
```

`manifest.json` is the single source of truth — version, bbox, file sizes,
SHA-256 of every file. `verify-pack` rejects packs with mismatched checksums.

## How offline is enforced in code

- `packages/core` has **no `fetch` and no `XMLHttpRequest`**. ESLint custom
  rule blocks them at lint time.
- `packages/ui` may only call back into platform-injected adapter interfaces.
  No direct `fetch`.
- Electron `main.ts` runs the renderer with a **strict Content-Security-Policy**
  that has no remote origins. Adding an http(s) origin to CSP is a code-review
  red flag.
- The renderer has no `<script src="https://...">`, no Google Fonts, no CDN.
  Everything is bundled.
- One single intentional network call is allowed: the pack downloader in
  `PackManager.tsx`, which calls a clearly-named `downloadPack(url)` API.
  This is the only place the word `fetch` appears in renderer code.

## The self-test harness (the heart of "verifiably offline")

`packages/core/selftest` exports `runSelfTest(adapters)`. It runs:

1. **TILES** — request tiles z=8 over the pack's bbox center, assert non-empty
   bytes returned within 50ms and that the bytes parse as a valid MVT pbf.
2. **SEARCH** — query for a known anchor name (`manifest.json` ships a list
   like `["Aarhus", "København", "Netto"]`) and assert at least one result
   with coords inside bbox.
3. **REVERSE** — pick the bbox center, assert returns a road or POI with name.
4. **ROUTE** — two known waypoints from the manifest, assert a non-degenerate
   polyline (length within ±30% of crow-fly × 1.4) and non-zero ETA.

Each check has a hard 5-second timeout. Results: `{check, status, ms, details}`.

Two execution modes:
- **In-app**: `SelfTestPanel.tsx` calls `runSelfTest` after toggling Electron
  into offline mode via IPC. Shows a results table. This is the user-facing
  "is offline working?" proof.
- **CI**: A Playwright test launches Electron, installs a fixture pack
  (small bundled `andorra` pack ~12 MB), toggles `setOffline(true)`, opens
  the panel, asserts all four are green. Runs on every PR.

## Build pipeline for region packs

`region-builder` is a CLI run on a build server (or the user's beefier
machine) — not on first-launch of the app, because building takes minutes.

```bash
pnpm region-builder build denmark \
  --pbf https://download.geofabrik.de/europe/denmark-latest.osm.pbf \
  --pmtiles-source https://build.protomaps.com/20260518.pmtiles \
  --out ./packs/denmark
```

This:
1. Downloads / streams the PBF.
2. Runs `pmtiles extract` against the Protomaps daily for the bbox.
3. Walks the PBF, writes `geocode.sqlite` with FTS5 + R*Tree.
4. Runs BRouter's segment generator to produce `.rd5` files.
5. Hashes everything, writes `manifest.json`, runs `verify-pack`.

The Electron pack downloader fetches a built pack from a static URL the user
configures (the app ships pointed at a default index, but it's just a URL —
no lock-in).

## Implementation phases

| Phase | Scope | Verification |
| ----- | ----- | ------------ |
| **0** | Scaffold workspaces, core interfaces, ESLint no-fetch rule, fixture pack | `pnpm test` green |
| **1** | Tiles end-to-end: PMTiles reader, MapLibre view, electron shell with one bundled pack | Self-test TILES check passes offline |
| **2** | Geocoding end-to-end: region-builder generates SQLite, SearchBar wired | Self-test SEARCH + REVERSE pass offline |
| **3** | Routing end-to-end: BRouter sidecar bundled, RoutePanel wired | Self-test ROUTE passes offline |
| **4** | PackManager: install/uninstall, switching regions, signed manifest verification | Two packs installed, switch between them, both self-test green |
| **5** | Playwright + CI self-test, signing/notarization for Win build | CI green, .exe installs and runs offline first-launch |

Phases are merged sequentially. Each phase ends with the self-test panel
showing **green for everything implemented so far** before the next phase begins.

## What v2 is explicitly NOT doing

- **No worldwide dynamic explorer.** Regions are picked from a manifest; no
  recursive admin-boundary loading.
- **No polygon editor for custom packs.** Packs come from `region-builder`,
  not drawn in the UI.
- **No multi-engine routing UI.** One engine (BRouter) behind an adapter.
- **No Redis, no Postgres, no Docker.** The runtime is one Electron process
  plus one sidecar Java process. That's it.
- **No backend HTTP API surface for runtime tile reads.** Tiles are read from
  the local file system through the MapLibre PMTiles protocol handler.

These were the v1 features that ate the schedule and never reached "actually
works offline."

## Open decisions (will resolve during implementation)

- **Bundled JRE vs system Java**: ship a slim 40MB JRE in the installer or
  detect system Java? Default plan: bundle for guaranteed first-launch.
- **PMTiles source for daily builds**: Protomaps' build.protomaps.com is the
  obvious choice but we may want to cache a snapshot to avoid breakage.
- **Map style**: start with Protomaps basemap default, expose theme switch later.
