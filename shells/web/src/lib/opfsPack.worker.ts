/// <reference lib="webworker" />

import type { Profile, ReverseOptions, SearchOptions } from '@openmaps/core';
import { WebGeocodeIndex } from './GeocodeIndex.js';
import { InternalRouter } from './InternalRouter.js';
import { MbtilesTileSource } from './MbtilesTileSource.js';
import { openSqliteFromOpfs, type WebDb } from './sqlite.js';

type Request = {
  id: number;
  operation: 'open' | 'tile' | 'search' | 'reverse' | 'parcel' | 'route' | 'close';
  args?: unknown;
};

const scope = self as DedicatedWorkerGlobalScope;
let db: WebDb | null = null;
let tiles: MbtilesTileSource | null = null;
let geocode: WebGeocodeIndex | null = null;
let router: InternalRouter | null = null;

scope.onmessage = (event: MessageEvent<Request>) => {
  void dispatch(event.data).then(
    ({ value, transfers = [] }) => scope.postMessage({ id: event.data.id, ok: true, value }, transfers),
    (error: unknown) => scope.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Error',
      reason: isReasonedError(error) ? error.reason : undefined,
    }),
  );
};

async function dispatch(request: Request): Promise<{ value?: unknown; transfers?: Transferable[] }> {
  switch (request.operation) {
    case 'open': {
      await closeDatabase();
      db = await openSqliteFromOpfs(String(request.args));
      tiles = new MbtilesTileSource(db);
      geocode = new WebGeocodeIndex(db);
      router = new InternalRouter(db);
      return { value: { tileMeta: tiles.meta, supportedProfiles: router.supportedProfiles } };
    }
    case 'tile': {
      const [z, x, y] = request.args as [number, number, number];
      const tile = await requireTiles().getTile(z, x, y);
      if (!tile) return { value: null };
      const bytes = new Uint8Array(tile.bytes.byteLength);
      bytes.set(tile.bytes);
      return { value: { ...tile, bytes }, transfers: [bytes.buffer] };
    }
    case 'search': {
      const [query, opts] = request.args as [string, SearchOptions | undefined];
      return { value: await requireGeocode().search(query, opts) };
    }
    case 'reverse': {
      const [lat, lon, opts] = request.args as [number, number, ReverseOptions | undefined];
      return { value: await requireGeocode().reverse(lat, lon, opts) };
    }
    case 'parcel':
      return { value: await requireGeocode().getParcel(String(request.args)) };
    case 'route': {
      const [waypoints, profile] = request.args as [ReadonlyArray<{ lat: number; lon: number }>, Profile];
      return { value: await requireRouter().route({ waypoints, profile }) };
    }
    case 'close':
      await closeDatabase();
      return {};
  }
}

function requireTiles(): MbtilesTileSource {
  if (!tiles) throw new Error('OPFS pack is not open');
  return tiles;
}

function requireGeocode(): WebGeocodeIndex {
  if (!geocode) throw new Error('OPFS pack is not open');
  return geocode;
}

function requireRouter(): InternalRouter {
  if (!router) throw new Error('OPFS pack is not open');
  return router;
}

async function closeDatabase(): Promise<void> {
  tiles = null;
  geocode = null;
  router = null;
  if (db) {
    db.close();
    db = null;
  }
}

function isReasonedError(error: unknown): error is Error & { reason: string } {
  return error instanceof Error && 'reason' in error && typeof (error as { reason?: unknown }).reason === 'string';
}

export {};
