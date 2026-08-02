import type { GeocodeIndex, ReverseOptions, ReverseResult, SearchOptions, SearchResult } from '../geocode/index.js';
import type { PackStorage, RegionManifest, RegionPack } from '../pack/index.js';
import type { RouteRequest, RouteResult } from '../route/index.js';
import { runSelfTest, type SelfTestReport } from '../selftest/index.js';
import type { TileBytes } from '../tiles/index.js';

export type OpenMapsClientEvent =
  | { readonly type: 'pack-opening'; readonly packId: string }
  | { readonly type: 'pack-opened'; readonly manifest: RegionManifest }
  | { readonly type: 'pack-closed'; readonly packId: string }
  | { readonly type: 'error'; readonly operation: string; readonly error: unknown };

export type OpenMapsClientListener = (event: OpenMapsClientEvent) => void;

/**
 * Stable, UI-agnostic facade for embedding OpenMaps in another application.
 *
 * The client owns the currently open RegionPack and serialises pack changes,
 * while reads keep using the small core interfaces. A host can therefore use
 * the same integration code with filesystem, OPFS, mobile, or test adapters.
 */
export class OpenMapsClient {
  private activePack: RegionPack | null = null;
  private readonly listeners = new Set<OpenMapsClientListener>();
  private transition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(readonly storage: PackStorage) {}

  /** The open pack, exposed for advanced adapter-specific integrations. */
  get current(): RegionPack | null { return this.activePack; }

  get manifest(): RegionManifest | null { return this.activePack?.manifest ?? null; }

  subscribe(listener: OpenMapsClientListener): () => void {
    this.assertAvailable();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listPacks(): Promise<RegionManifest[]> {
    this.assertAvailable();
    return this.storage.listInstalled();
  }

  verifyPack(packId: string): Promise<{ ok: true } | { ok: false; problem: string }> {
    this.assertAvailable();
    return this.storage.verify(packId);
  }

  openPack(packId: string): Promise<RegionManifest> {
    return this.enqueue(async () => {
      this.emit({ type: 'pack-opening', packId });
      try {
        const next = await this.storage.open(packId);
        const previous = this.activePack;
        this.activePack = next;
        if (previous) {
          try {
            await previous.close();
            this.emit({ type: 'pack-closed', packId: previous.manifest.id });
          } catch (error) {
            this.emit({ type: 'error', operation: `close:${previous.manifest.id}`, error });
          }
        }
        this.emit({ type: 'pack-opened', manifest: next.manifest });
        return next.manifest;
      } catch (error) {
        this.emit({ type: 'error', operation: `open:${packId}`, error });
        throw error;
      }
    });
  }

  closePack(): Promise<void> {
    return this.enqueue(async () => {
      const pack = this.activePack;
      if (!pack) return;
      this.activePack = null;
      try {
        await pack.close();
        this.emit({ type: 'pack-closed', packId: pack.manifest.id });
      } catch (error) {
        this.emit({ type: 'error', operation: `close:${pack.manifest.id}`, error });
        throw error;
      }
    });
  }

  async uninstallPack(packId: string): Promise<void> {
    this.assertAvailable();
    if (this.activePack?.manifest.id === packId) await this.closePack();
    await this.storage.uninstall(packId);
  }

  getTile(z: number, x: number, y: number): Promise<TileBytes | null> {
    return this.requirePack().tiles.getTile(z, x, y);
  }

  search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return this.requirePack().geocode.search(query, options);
  }

  reverse(lat: number, lon: number, options?: ReverseOptions): Promise<ReverseResult | null> {
    return this.requirePack().geocode.reverse(lat, lon, options);
  }

  getParcel(parcelId: string): ReturnType<GeocodeIndex['getParcel']> {
    return this.requirePack().geocode.getParcel(parcelId);
  }

  route(request: RouteRequest): Promise<RouteResult> {
    return this.requirePack().router.route(request);
  }

  selfTest(): Promise<SelfTestReport> {
    return runSelfTest(this.requirePack());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.closePack();
    this.disposed = true;
    this.listeners.clear();
  }

  private requirePack(): RegionPack {
    this.assertAvailable();
    if (!this.activePack) throw new OpenMapsClientError('no-pack', 'No OpenMaps pack is open');
    return this.activePack;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new OpenMapsClientError('disposed', 'OpenMaps client has been disposed');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAvailable();
    const result = this.transition.then(operation, operation);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }

  private emit(event: OpenMapsClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class OpenMapsClientError extends Error {
  constructor(readonly code: 'no-pack' | 'disposed', message: string) {
    super(message);
    this.name = 'OpenMapsClientError';
  }
}
