# OpenMaps v1 — Audit of what actually failed

This is the evidence behind v2's design choices. It's based on reading the
v1 source at `C:\LLM\OpenMaps\src\` and `C:\LLM\OpenMaps\backend\src\`.

## TL;DR

> The v1 project was built as a thin wrapper around cloud APIs (Nominatim,
> OSM tile servers, OSRM) with aspirational offline features bolted on as
> separate code paths that were never integrated or tested. When the design
> called for "offline," the team added IndexedDB storage and mathematical
> routing, but never wired them into the primary flows.

## Four concrete failures

### 1. "Offline tiles" was IndexedDB caching of *online* fetches

- `src/services/offlineTileLayer.ts:86-91, 115-116` claims tiles try offline
  first, but there's no mechanism to pre-populate the cache. Users have to
  browse online first and *hope* tiles got cached.
- `backend/data/mbtiles/` is an empty directory. `mbtilesService.ts:31` points
  at it. The "regional pack" infrastructure never produced a single file.
- When a tile isn't cached, `offlineTileLayer.ts:224` renders a gray "Offline
  Tile not available" placeholder.

**Lesson for v2:** Offline data must be a downloadable, verifiable, immutable
artifact (the region pack). Never rely on opportunistic caching.

### 2. "Offline routing" was Haversine + random jitter

From `src/services/offlineRouting.ts:89-139`:

- Lines 52-66: Haversine distance between A and B.
- Lines 99-139: Generates "waypoints" by adding random ±0.001° (~100m) offsets
  to a straight line.
- Line 455: `console.log('📐 Using improved mathematical fallback routing');`

This is the *only* routing path that runs when offline, because:
- BRouter integration (`brouter.ts:165-169`) fails silently when its JAR
  doesn't exist.
- Frontend skips the BRouter call entirely when the status check fails
  (`offlineRouting.ts:175`).

So "offline routing" is a straight line with random kinks. The user got a
shape that *looks* like a route but follows no actual roads.

**Lesson for v2:** A real road graph must be in the pack. Routing without a
graph is not routing. No "mathematical fallback" — better to show an honest
error than fake a route.

### 3. Search hardcodes Nominatim, no fallback

`src/services/geocoding.ts:3, 55-57`:

```js
const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
const response = await fetch(`${NOMINATIM_BASE_URL}/search?...`);
```

The frontend skips its own backend and goes straight to the public Nominatim.
When offline, `fetch` rejects, the function returns `[]`, search appears
"empty." There is no local index.

**Lesson for v2:** Search must read from a local index that ships with the
pack. The renderer must have *zero* external URLs at runtime.

### 4. The "17 passing tests" never disconnected the network

`backend/tests/simple-test.ts` is endpoint smoke tests: did the server return
200 with the right JSON shape? They pass *because* the internet is on and
OSM, ArcGIS, Nominatim, and OSRM are reachable.

Not one test:
- Disables `fetch` and verifies tiles still render
- Verifies pre-cached data survives a cold restart
- Confirms routing works without internet
- Tests search with network down

**Lesson for v2:** Tests must run with `setOffline(true)` and assert real
behavior, not endpoint status codes.

## Five rules v2 enforces in response

1. **Offline-first, not online-with-fallbacks.** All four user-visible
   features must work with the radio off.
2. **No hardcoded external URLs in app runtime code.** Caught by ESLint custom rule.
3. **No "math fallback" routing.** Either the pack has a real graph, or
   routing is unavailable.
4. **The pack is the only contract.** A pack file declares what works; the
   app validates it before saying "ready."
5. **The self-test panel is part of the product, not a debug afterthought.**
   It runs the four offline guarantees and shows green/red. CI runs it under
   Playwright on every PR.

## Files in v1 that informed v2's anti-patterns

These are the files that exemplify what v2 must not do:

- `src/services/geocoding.ts` — hardcoded Nominatim URL
- `src/services/offlineRouting.ts:89-139` — fake routing math
- `src/services/offlineTileLayer.ts:224` — gray placeholder where data should be
- `backend/tests/simple-test.ts` — endpoint tests masquerading as offline tests
- `backend/data/mbtiles/` — empty directory the system depended on
