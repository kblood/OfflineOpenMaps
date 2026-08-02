import type { Profile, RouteRequest, RouteResult, Router } from '@openmaps/core';
import { RoutingUnavailableError } from '@openmaps/core';

export interface OpfsRoutingSource {
  readonly id: string;
  readonly path: string;
  readonly bbox: [number, number, number, number];
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  name?: string;
  reason?: 'no-graph' | 'engine-down' | 'no-route' | 'profile-unsupported';
}

export async function openOpfsCompositeRouter(sources: readonly OpfsRoutingSource[]): Promise<Router> {
  const worker = new Worker(new URL('./opfsCompositeRouter.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let closed = false;

  const failAll = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.ok) request.resolve(response.value);
    else if (response.name === 'RoutingUnavailableError' && response.reason) {
      request.reject(new RoutingUnavailableError(response.error ?? 'routing unavailable', response.reason));
    } else request.reject(new Error(response.error ?? 'composite router worker request failed'));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'composite router worker failed');
    worker.terminate();
    closed = true;
    failAll(error);
  };

  const request = <T>(operation: string, args?: unknown): Promise<T> => {
    if (closed) return Promise.reject(new Error('composite router is closed'));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, operation, args });
    });
  };

  try {
    await request<{ supportedProfiles: readonly Profile[] }>('open', sources);
  } catch (error) {
    worker.terminate();
    closed = true;
    failAll(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  return {
    supportedProfiles: ['car', 'bike', 'foot'],
    route: (routeRequest: RouteRequest) => request<RouteResult>('route', [routeRequest.waypoints, routeRequest.profile]),
    async close() {
      if (closed) return;
      try { await request<void>('close'); }
      finally {
        closed = true;
        worker.terminate();
        failAll(new Error('composite router closed'));
      }
    },
  };
}
