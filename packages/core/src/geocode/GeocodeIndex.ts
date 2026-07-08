/**
 * The local geocoder. Both forward search (name → places) and reverse
 * (point → nearest road / POI) come from the same SQLite index that ships
 * with the region pack. There is NO online fallback. If the index can't
 * answer, the result is empty — never "let me try Nominatim."
 *
 * The implementation will use FTS5 for forward search (good ranking,
 * bilingual where available via `name:` tags) and R*Tree for reverse
 * nearest-neighbor. See packages/region-builder/build-geocode.ts for the
 * schema.
 */
export interface GeocodeIndex {
  /**
   * Forward search. `viewport` is optional and used only for biasing —
   * results outside the viewport are still returned, just ranked lower.
   * Max ~25 results.
   */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;

  /**
   * Reverse geocode. Returns the nearest named feature within `maxRadiusM`
   * meters (default 100). Roads are preferred; POIs are second; admin areas
   * are last-resort.
   */
  reverse(lat: number, lon: number, opts?: ReverseOptions): Promise<ReverseResult | null>;

  /**
   * Look up a cadastral parcel by its id ("<ejerlavkode>/<matrikelnr>").
   * Returns null if the pack has no parcels table, or no row with that id.
   * Only DK packs built with DAWA augmentation ship parcel polygons; for
   * other packs this always resolves to null.
   */
  getParcel(parcelId: string): Promise<Parcel | null>;

  close(): Promise<void>;
}

export interface Parcel {
  readonly id: string;
  readonly label: string;
  readonly ejerlavkode: number | null;
  readonly ejerlavnavn: string | null;
  readonly matrikelnr: string | null;
  /** Outer ring(s) — supports MultiPolygon parcels. Each ring is [lon, lat][]. */
  readonly rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

export interface SearchOptions {
  /** Map viewport for ranking bias: [minLon, minLat, maxLon, maxLat]. */
  viewport?: [number, number, number, number];
  /** Max results to return. Default 10, capped at 25. */
  limit?: number;
  /** Restrict to a category. Falsy means "any". */
  kind?: PlaceKind | undefined;
}

export interface ReverseOptions {
  /** Max search radius in meters. Default 100. */
  maxRadiusM?: number;
  /** Whether to prefer roads (default true) or POIs first. */
  preferRoads?: boolean;
}

export type PlaceKind =
  | 'address'
  | 'street'
  | 'place' // city, town, village, hamlet
  | 'admin'
  | 'poi';

export interface SearchResult {
  readonly id: string;
  readonly displayName: string;
  readonly kind: PlaceKind;
  readonly lat: number;
  readonly lon: number;
  /** "DK", "FR", etc. */
  readonly country: string;
  /** Optional admin context for disambiguation, e.g. "Aarhus, Region Midtjylland". */
  readonly adminPath?: string;
  /** 0-1, higher is better. */
  readonly score: number;
  /**
   * For DK addresses from DAWA-augmented packs: the parcel id this address
   * sits on. Pass to `getParcel()` to fetch the polygon. Absent for other
   * kinds / non-DAWA packs.
   */
  readonly parcelId?: string;
}

export interface ReverseResult {
  readonly displayName: string;
  readonly kind: PlaceKind;
  readonly distanceM: number;
  readonly road?: string;
  readonly housenumber?: string;
  readonly city?: string;
  readonly postcode?: string;
}
