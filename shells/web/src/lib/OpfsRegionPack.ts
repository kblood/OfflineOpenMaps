import type {
  GeocodeIndex,
  Parcel,
  Profile,
  RegionManifest,
  RegionPack,
  ReverseOptions,
  ReverseResult,
  Router,
  RouteRequest,
  RouteResult,
  SearchOptions,
  SearchResult,
  TileBytes,
  TileSource,
  TileSourceMeta,
} from '@openmaps/core';
import { RoutingUnavailableError } from '@openmaps/core';

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  name?: string;
  reason?: 'no-graph' | 'engine-down' | 'no-route' | 'profile-unsupported';
}

interface OpenResult {
  tileMeta: TileSourceMeta;
  supportedProfiles: readonly Profile[];
}

class PackWorkerClient {
  private readonly worker = new Worker(new URL('./opfsPack.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private closed = false;
  private failure: Error | null = null;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else if (message.name === 'RoutingUnavailableError' && message.reason) {
        pending.reject(new RoutingUnavailableError(message.error ?? 'routing unavailable', message.reason));
      } else pending.reject(new Error(message.error ?? 'pack worker request failed'));
    };
    this.worker.onerror = (event) => this.crash(new Error(event.message || 'pack worker failed'));
    this.worker.onmessageerror = () => this.crash(new Error('could not decode pack worker response'));
  }

  request<T>(operation: string, args?: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('pack worker is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, operation, args });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.failure) {
      this.closed = true;
      this.worker.terminate();
      return;
    }
    try {
      await this.request<void>('close');
    } finally {
      this.closed = true;
      this.worker.terminate();
      this.failAll(new Error('pack worker closed'));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private crash(error: Error): void {
    this.failure = error;
    this.worker.terminate();
    this.failAll(error);
  }
}

export async function openOpfsRegionPack(manifest: RegionManifest, databasePath: string): Promise<RegionPack> {
  const client = new PackWorkerClient();
  let opened: OpenResult;
  try {
    opened = await client.request<OpenResult>('open', databasePath);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  const tiles: TileSource = {
    meta: opened.tileMeta,
    getTile: (z, x, y) => client.request<TileBytes | null>('tile', [z, x, y]),
    close: async () => {},
  };
  const geocode: GeocodeIndex = {
    search: (query: string, opts?: SearchOptions) => client.request<SearchResult[]>('search', [query, opts]),
    reverse: (lat: number, lon: number, opts?: ReverseOptions) => client.request<ReverseResult | null>('reverse', [lat, lon, opts]),
    getParcel: (parcelId: string) => client.request<Parcel | null>('parcel', parcelId),
    close: async () => {},
  };
  const router: Router = {
    supportedProfiles: opened.supportedProfiles,
    route: (request: RouteRequest) => client.request<RouteResult>('route', [request.waypoints, request.profile]),
    close: async () => {},
  };
  return { manifest, tiles, geocode, router, close: () => client.close() };
}
