# Integrating OpenMaps

OpenMaps is split into a UI-independent runtime and replaceable platform
adapters. Applications should integrate through `OpenMapsClient` instead of
importing an Electron or web-shell singleton.

```
host UI / MapLibre / service
            |
      OpenMapsClient
            |
 PackStorage -> RegionPack -> tiles + geocode + routing
```

The facade owns pack switching and cleanup, while the existing interfaces keep
storage portable. Filesystem, OPFS, mobile, and test adapters can all implement
the same `PackStorage` contract.

## Node or Electron main process

Build the workspace packages, then depend on `@openmaps/core` and
`@openmaps/platform-node` from your workspace or packaged application.

```ts
import { createNodeOpenMaps } from '@openmaps/platform-node';

const maps = createNodeOpenMaps({ packsDirectory: './packs' });

maps.subscribe((event) => {
  if (event.type === 'pack-opened') {
    console.log(`Using ${event.manifest.name}`);
  }
});

const [first] = await maps.listPacks();
if (!first) throw new Error('Install an OpenMaps pack first');
await maps.openPack(first.id);

const places = await maps.search('Aarhus', { limit: 5 });
const route = await maps.route({
  profile: 'bike',
  waypoints: [
    { lat: 56.1629, lon: 10.2039 },
    { lat: 56.1535, lon: 10.2131 },
  ],
});

await maps.dispose();
```

In Electron, keep the client in the main process and expose only the methods
your renderer needs through a context-isolated preload bridge. Do not expose the
filesystem-backed object itself to untrusted renderer code.

## Custom storage or browser runtimes

Only `PackStorage` is required. This makes the host responsible for where packs
live without changing search, routing, or tile-consuming code.

```ts
import { OpenMapsClient, type PackStorage } from '@openmaps/core';

const storage: PackStorage = createYourOpfsOrMobileStorage();
const maps = new OpenMapsClient(storage);
await maps.openPack('denmark-capital');
```

The browser shell's sqlite-wasm/OPFS implementation is still application-owned;
its next extraction target is a separate `@openmaps/platform-browser` package.
Until then, browser hosts can either supply their own `PackStorage` adapter or
embed the hosted shell. The core client deliberately contains no DOM, network,
React, MapLibre, Electron, or Node dependency.

## Map renderers

`getTile(z, x, y)` returns the original bytes plus content type and encoding.
For a MapLibre custom protocol, gunzip tiles whose `contentEncoding` is `gzip`
before returning them to MapLibre. Other renderers can consume the same bytes
without depending on an OpenMaps UI.

## Lifecycle rules

- Call `openPack()` before tile, search, reverse-geocode, parcel, or route calls.
- Pack transitions are serialized; competing UI actions cannot leave two packs
  selected.
- `openPack()` closes the previous pack after the replacement is ready.
- Call `dispose()` when the host view or service shuts down.
- Subscribe to `pack-opening`, `pack-opened`, `pack-closed`, and `error` for UI
  state and telemetry.
- Run `selfTest()` if the host needs executable evidence that all four offline
  capabilities work.

## Building packages

```bash
npm install
npm run build -w @openmaps/core
npm run build -w @openmaps/platform-node
```

The generated JavaScript, declarations, source maps, and declaration maps live
in each package's `dist/` directory.

