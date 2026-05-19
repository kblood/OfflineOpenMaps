# OpenMaps v2 — verifiably offline

A clean-room rebuild of OpenMaps designed so the offline guarantees are
**provable**, not just claimed. Read [PLAN.md](./PLAN.md) for the
architecture rationale and [OLD_BUILD_AUDIT.md](./OLD_BUILD_AUDIT.md) for
what failed in v1 (Haversine-jitter "routing," hardcoded Nominatim URLs,
empty `mbtiles/` directory the runtime depended on).

## Status

| Milestone | State | Evidence |
| --------- | ----- | -------- |
| M0 — Workspace, core, lint enforcement | done | `packages/core` builds; 19 vitest pass; ESLint rule blocks `fetch`/http literals |
| M1 — Tiles offline | done | MapLibre vector tiles via `omap://` custom protocol, served from MBTiles |
| M2 — Geocoding offline | done | SQLite FTS5 forward, R*Tree reverse, both queried with no network |
| M3 — Routing offline | done | `InternalRouter`: real Dijkstra over OSM-style road graph in SQLite |
| M4 — Pack manager | done | open/close/switch + install-from-folder + uninstall, all wired in UI |
| M5 — Playwright CI | done | 3 Electron e2e tests, all assert `setOffline(true)` works |
| M6 — OSM XML ingestion | done | `build-osm --in <file.osm>` produces a full pack; 5 OSM-pipeline tests pass |
| M7 — Perpendicular reverse geocode | done | Reverse uses point-to-segment distance, not bbox center |
| M8 — Geofabrik PBF ingestion | done | `build-pbf --pbf <file.osm.pbf> [--bbox …]` produces a full pack; 5 PBF-pipeline tests pass |

**Total tests passing: 90 (19 core + 33 platform-node + 31 region-builder + 7 Playwright e2e).**

## The proof: 4/4 offline self-test passing under `setOffline(true)`

```
{
  "id": "tiles",   "status": "pass", "ms": 0, "summary": "1234 bytes (application/vnd.mapbox-vector-tile)"
  "id": "search",  "status": "pass", "ms": 0, "summary": "\"Faketown\" → 3 results, top: Faketown"
  "id": "reverse", "status": "pass", "ms": 0, "summary": "Public Library (poi, 0m)"
  "id": "route",   "status": "pass", "ms": 1, "summary": "11.6 km, 14 min (internal-dijkstra)"
}
allPassed: true
```

This is captured live from the Playwright e2e test
(`e2e/tests/offline-electron.spec.ts`) while the Electron session is
network-severed.

## Tech stack (final)

| Concern | Choice | Why |
| ------- | ------ | --- |
| Tile format | **MBTiles (SQLite + tiles BLOBs)** | Trivially writeable from Node, single file, Electron file:// happy |
| Tile renderer | **MapLibre GL JS** with custom `omap://` protocol | Standard vector renderer; protocol handler routes tile reads through IPC |
| Geocoding | **SQLite FTS5 + R*Tree, one DB per region** | Same DB serves forward (FTS5) and reverse (R*Tree) |
| Routing engine | **InternalRouter — JS Dijkstra over OSM road graph in SQLite** | Real graph-based; same DB shared with geocoder; no native deps |
| SQLite binding | **`node:sqlite`** (built into Node 22.5+ / Electron 42+) | Zero native compile, ships FTS5 + R*Tree by default |
| Desktop shell | Electron 42 with strict CSP and `contextIsolation` | Bundled Node 22.22 has node:sqlite |
| UI | React 18 + Vite 5 + MapLibre GL JS 4 | Boring; not a research project |

Routing engine is behind a `Router` interface; BRouter (Java sidecar) or
Valhalla can drop in later without UI changes.

## Repo layout

```
openmaps-v2/
├── PLAN.md                  Architecture rationale
├── OLD_BUILD_AUDIT.md       What failed in v1, with file:line evidence
├── README.md                You are here
├── eslint.config.js         Blocks `fetch` + http URLs in core/ui
│
├── packages/
│   ├── core/                Pure-TS interfaces + manifest validator + self-test runner
│   ├── platform-node/       Concrete adapters: MbtilesTileSource, SqliteGeocodeIndex,
│   │                        InternalRouter, FsPackStorage
│   └── region-builder/      CLI that produces a region pack (synthetic fixture mode works;
│                            real PBF parsing is the next milestone)
│
├── shells/electron/
│   ├── main/                Electron main: packBridge, offlineMode IPC, strict CSP
│   └── renderer/            React UI: MapView, SearchBar, RoutePanel, SelfTestPanel,
│                            PackPicker
│
├── e2e/                     Playwright tests — launch Electron, flip offline, assert 4/4
│
└── packs/                   Built region packs (gitignored)
```

## How to run

```bash
# One-time setup
npm install

# Build the fixture pack (~36 nodes, ~120 edges, 7 places — Andorra-sized rectangle)
cd packages/region-builder && npx tsc && cd ../..
node packages/region-builder/dist/cli.js build-synthetic --id fakeland --out ./packs

# Run the unit + integration tests
(cd packages/core && npx vitest run)
(cd packages/platform-node && npx vitest run)

# Build Electron shell
(cd packages/platform-node && npx tsc) && \
(cd shells/electron && npx tsc -p tsconfig.main.json && npx vite build)

# Run the Playwright offline-electron test
(cd e2e && npx playwright install chromium && npx playwright test)

# Launch the Electron app manually
OPENMAPS_PACKS_DIR=./packs npx electron shells/electron
```

The app opens, lists installed packs (just `fakeland` for now), and shows
the map. Click "Go offline & self-test" in the sidebar — the result table
should show four green dots and the message **"✓ Fully offline."**

## What v2 still needs

### Nice-to-haves

1. **Better road labelling at low zoom**, more map style polish.
2. **Optional URL-based pack install**. Today the UI has "Install from
   folder…"; a follow-up could add a "fetch by URL" path that downloads a
   zip and unpacks it (a one-shot online action; runtime stays offline).
3. **Multipolygon / turn-restriction relations**. Currently relations are
   ignored on ingest, so one-way nuances driven by `<relation type=restriction>`
   aren't honored. Adding them improves real-world routing quality.

### To make routing better

The `InternalRouter` is a real Dijkstra over real geometry, but it doesn't
model turn restrictions, one-ways nuances beyond reversed-edge symmetry, or
real-world traffic. For higher-quality routes the `Router` interface lets
BRouter or Valhalla drop in. The cost is bundling a JRE or native binary.

## What v2 does NOT do (vs. v1)

These were the v1 features that ate the schedule and never reached
"actually works offline":

- No worldwide dynamic admin explorer
- No in-UI polygon editor
- No multi-engine routing selector
- No Redis, no Postgres, no Docker for runtime
- No "math fallback" routing — packs without a graph just say so

## Why this design will hold up

The four offline guarantees are enforced at five different levels:

1. **Lint**: ESLint custom rule blocks `fetch`, `XMLHttpRequest`, and
   hardcoded `http(s)://` literals in `packages/core` and `packages/ui`.
2. **Runtime**: Electron CSP disallows remote origins; navigation handlers
   prevent external-URL loads.
3. **Test (unit)**: the self-test harness has a hard-coded sanity guard
   that fails any route where `distance < 0.8 × crow-fly` — this is the
   exact signature of the v1 Haversine-jitter fake.
4. **Test (network sabotage)**: `offline-routing.test.ts` replaces
   `globalThis.fetch`, `net.Socket`, `http.request`, `https.request`, and
   (where the runtime allows) `dns.lookup`/`dns.resolve` with tripwires that
   throw on use, then computes a route and asserts it succeeds. If the
   router ever accidentally reached out, the test would fail loudly with the
   exact call site.
5. **Test (e2e)**: Playwright launches Electron, calls
   `session.enableNetworkEmulation({ offline: true })`, and asserts the
   self-test panel reports 4/4 green. The route check specifically computes
   a real Dijkstra path between two waypoints while the session is severed.

Plus 10 dedicated offline-routing tests covering profile constraints (car
can't use footways, foot can't use motorways), multi-waypoint chains, the
no-route / no-graph / unsupported-profile failure modes, and route-structure
invariants (steps cover the geometry, depart/arrive maneuvers in place,
sum-of-step distances reconcile with total).

This is what "verifiably offline" means.
