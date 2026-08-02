/// <reference lib="webworker" />

import type { Profile } from '@openmaps/core';
import { CompositeRouter } from './CompositeRouter.js';
import { openSqliteFromOpfs, type WebDb } from './sqlite.js';

interface SourceDescriptor {
  id: string;
  path: string;
  bbox: [number, number, number, number];
}

type Request = {
  id: number;
  operation: 'open' | 'route' | 'close';
  args?: unknown;
};

const scope = self as DedicatedWorkerGlobalScope;
let databases: WebDb[] = [];
let router: CompositeRouter | null = null;

scope.onmessage = (event: MessageEvent<Request>) => {
  void dispatch(event.data).then(
    (value) => scope.postMessage({ id: event.data.id, ok: true, value }),
    (error: unknown) => scope.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : 'Error',
      reason: isReasonedError(error) ? error.reason : undefined,
    }),
  );
};

async function dispatch(request: Request): Promise<unknown> {
  switch (request.operation) {
    case 'open': {
      await closeRouter();
      const descriptors = request.args as SourceDescriptor[];
      if (descriptors.length < 2) throw new Error('composite routing needs at least two installed packs');
      try {
        const sources = [];
        for (const descriptor of descriptors) {
          const db = await openSqliteFromOpfs(descriptor.path);
          databases.push(db);
          sources.push({ id: descriptor.id, db, bbox: descriptor.bbox });
        }
        router = new CompositeRouter(sources);
        return { supportedProfiles: router.supportedProfiles };
      } catch (error) {
        await closeRouter();
        throw error;
      }
    }
    case 'route': {
      const [waypoints, profile] = request.args as [ReadonlyArray<{ lat: number; lon: number }>, Profile];
      if (!router) throw new Error('composite router is not open');
      return router.route({ waypoints, profile });
    }
    case 'close':
      await closeRouter();
      return undefined;
  }
}

async function closeRouter(): Promise<void> {
  if (router) await router.close();
  router = null;
  for (const db of databases) {
    try { db.close(); } catch { /* already closed */ }
  }
  databases = [];
}

function isReasonedError(error: unknown): error is Error & { reason: string } {
  return error instanceof Error && 'reason' in error && typeof (error as { reason?: unknown }).reason === 'string';
}

export {};
