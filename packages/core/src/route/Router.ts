/**
 * The routing adapter. v1 implementation is BRouter (Java sidecar). The
 * interface is engine-agnostic so Valhalla can replace it later without
 * touching UI.
 *
 * Hard rule from PLAN.md: there is NO "mathematical fallback." If the
 * router can't compute a route (no graph for the area, waypoints in
 * different unreachable regions, etc.), it throws RoutingUnavailableError
 * or returns null. The UI shows an honest error rather than a fake straight
 * line.
 */
export interface Router {
  /** Which profiles this router supports. */
  readonly supportedProfiles: readonly Profile[];

  /** Compute a route. Throws RoutingUnavailableError on engine failure. */
  route(req: RouteRequest): Promise<RouteResult>;

  close(): Promise<void>;
}

export type Profile = 'car' | 'bike' | 'foot';

export interface RouteRequest {
  readonly waypoints: ReadonlyArray<{ lat: number; lon: number }>;
  readonly profile: Profile;
  /** Optional engine-specific options bag, ignored by routers that don't understand it. */
  readonly engineOptions?: Readonly<Record<string, unknown>>;
}

export interface RouteResult {
  /** Polyline of the route as [lon, lat] pairs (GeoJSON convention). */
  readonly geometry: ReadonlyArray<readonly [number, number]>;
  readonly distanceM: number;
  readonly durationS: number;
  readonly steps: readonly RouteStep[];
  /** Name of the engine that produced this result, for display in debug. */
  readonly engine: string;
}

export interface RouteStep {
  readonly instruction: string;
  readonly distanceM: number;
  readonly durationS: number;
  readonly maneuver: ManeuverType;
  /** Index into RouteResult.geometry where this step starts. */
  readonly geometryStart: number;
}

export type ManeuverType =
  | 'depart'
  | 'arrive'
  | 'straight'
  | 'turn-left'
  | 'turn-right'
  | 'turn-slight-left'
  | 'turn-slight-right'
  | 'turn-sharp-left'
  | 'turn-sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'merge';

export class RoutingUnavailableError extends Error {
  constructor(message: string, public readonly reason: 'no-graph' | 'engine-down' | 'no-route' | 'profile-unsupported') {
    super(message);
    this.name = 'RoutingUnavailableError';
  }
}
