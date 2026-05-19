// Typed accessor for the contextBridge-exposed API. The renderer talks to
// the main process only through `window.openmaps.*`. We never import Node
// modules in the renderer.
import type {
  RegionManifest,
  SearchResult,
  ReverseResult,
  RouteResult,
  SelfTestReport,
  Profile,
  SearchOptions,
  ReverseOptions,
} from '@openmaps/core';

/**
 * Mirror of the main-process types from packBuilder.ts. Kept in sync by
 * hand because TypeScript project-references across the IPC boundary
 * gets messy fast (the main process is a separate tsconfig). If this
 * drifts the IPC payload will still work — the types just won't catch
 * a contract change at compile time.
 */
export type PackBuilderPhase =
  | 'starting'
  | 'downloading'
  | 'parsing'
  | 'building-tiles'
  | 'building-graph'
  | 'building-geocode'
  | 'writing-manifest'
  | 'installing'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface PackBuildProgress {
  buildId: string;
  phase: PackBuilderPhase;
  message: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
  manifestId?: string;
  error?: string;
}

export interface GeofabrikCountryDTO {
  id: string;
  name: string;
  continent: 'Europe' | 'North America' | 'South America' | 'Asia' | 'Africa' | 'Oceania';
  iso: string;
  url: string;
  approxMb: number;
  bbox: readonly [number, number, number, number];
}

export type StartBuildRequest =
  | {
      kind: 'overpass';
      packId: string;
      packName: string;
      country: string;
      bbox: readonly [number, number, number, number];
    }
  | {
      kind: 'geofabrik';
      countryId: string;
    };

interface OpenMapsApi {
  packs: {
    list(): Promise<RegionManifest[]>;
    verify(packId: string): Promise<{ ok: true } | { ok: false; problem: string }>;
    open(packId: string): Promise<RegionManifest>;
    close(): Promise<void>;
    current(): Promise<RegionManifest | null>;
    installFromDir(opts?: { overwrite?: boolean }): Promise<
      { installed: false } | { installed: true; manifest: RegionManifest }
    >;
    uninstall(packId: string): Promise<void>;
  };
  packBuilder: {
    countries(): Promise<GeofabrikCountryDTO[]>;
    start(req: StartBuildRequest): Promise<{ buildId: string }>;
    cancel(buildId: string): Promise<{ cancelled: boolean; reason?: string }>;
    onProgress(listener: (p: PackBuildProgress) => void): () => void;
  };
  tiles: {
    get(z: number, x: number, y: number): Promise<{
      bytes: Uint8Array;
      contentType: string;
      contentEncoding: 'gzip' | 'none';
    } | null>;
  };
  geocode: {
    search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
    reverse(lat: number, lon: number, opts?: ReverseOptions): Promise<ReverseResult | null>;
  };
  route: {
    compute(
      waypoints: ReadonlyArray<{ lat: number; lon: number }>,
      profile: Profile,
    ): Promise<RouteResult>;
  };
  offline: {
    set(offline: boolean): Promise<boolean>;
    get(): Promise<boolean>;
  };
  selftest: {
    run(): Promise<SelfTestReport>;
  };
}

declare global {
  interface Window {
    openmaps: OpenMapsApi;
  }
}

export const api: OpenMapsApi = window.openmaps;
