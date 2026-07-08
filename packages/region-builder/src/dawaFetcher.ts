// Fetches authoritative Danish address + parcel data from DAWA
// (Danmarks Adressers Web API, api.dataforsyningen.dk). For DK packs
// this replaces the OSM-derived addresses entirely — DAWA has every
// Danish address with daily updates and surveyed-grade coordinates,
// while OSM coverage is patchy and frequently stale.
//
// Output is in our internal pack types so callers can splice the
// result into SyntheticData before writeGeocodeDb runs.

import type { PlaceFeature, ParcelGeometry, SyntheticData } from './synthetic.js';

/**
 * Re-export under the historical name `ParcelPolygon` for the public
 * region-builder API. The canonical type lives in synthetic.ts so writers
 * don't have to import the fetcher.
 */
export type ParcelPolygon = ParcelGeometry;

/**
 * A DAWA address rendered as a PlaceFeature, with `parcelId` always set
 * (vs. PlaceFeature where it's optional). DAWA always has a jordstykke
 * reference for normal addresses; for the rare on-bridge / no-parcel
 * case `parcelId` is `null`.
 */
export interface DawaAddress extends PlaceFeature {
  parcelId: string | null;
}

export interface DawaFetchResult {
  addresses: DawaAddress[];
  parcels: ParcelGeometry[];
}

export interface DawaFetchOpts {
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  /** Override the base URL (e.g. for tests / mirror). */
  baseUrl?: string;
  /** Called once per logical step ("fetching addresses", "fetching parcels"). */
  onProgress?: (msg: string) => void;
  /** Custom fetch (for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.dataforsyningen.dk';

/**
 * Pull every DAWA address inside `bbox` (as a closed polygon query),
 * then pull every distinct parcel referenced by those addresses.
 * Both endpoints return full result sets in a single response when the
 * query is small enough; for large regions we'd want pagination, but
 * city-sized packs (50k addresses) are well inside that limit.
 */
export async function fetchDawa(opts: DawaFetchOpts): Promise<DawaFetchResult> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const f = opts.fetchImpl ?? fetch;
  const log = opts.onProgress ?? (() => {});
  const [minLon, minLat, maxLon, maxLat] = opts.bbox;

  // DAWA polygon param is a closed ring as JSON, encoded inline.
  const polygon = encodeURIComponent(
    JSON.stringify([
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ]),
  );

  log('Fetching DAWA addresses…');
  // `struktur=flad` is the flat field set — includes jordstykke_ejerlavkode +
  // jordstykke_matrikelnr that we need to link to parcel polygons. (`mini`
  // strips those out.)
  const addrUrl = `${baseUrl}/adgangsadresser?polygon=${polygon}&format=geojson&struktur=flad`;
  const addrRes = await f(addrUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!addrRes.ok) {
    throw new Error(`DAWA addresses returned HTTP ${addrRes.status} ${addrRes.statusText}`);
  }
  const addrJson = (await addrRes.json()) as DawaGeojsonResponse;
  if (!addrJson.features || !Array.isArray(addrJson.features)) {
    throw new Error(`DAWA addresses: unexpected response shape (no features)`);
  }
  log(`  - ${addrJson.features.length} addresses`);

  // Index addresses to PlaceFeature shape, capturing parcel id when present.
  const addresses: DawaAddress[] = [];
  const parcelIds = new Set<string>();
  for (const feat of addrJson.features) {
    const p = feat.properties;
    if (!p) continue;
    const coords = feat.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const housenr = (p.husnr ?? '').toString();
    const vejnavn = (p.vejnavn ?? '').toString();
    const postnr = (p.postnr ?? '').toString();
    const postnrnavn = (p.postnrnavn ?? '').toString();
    if (!vejnavn || !housenr) continue;
    const displayName = `${vejnavn} ${housenr}`;
    const adminPath = postnr && postnrnavn ? `${postnr} ${postnrnavn}` : null;
    // DAWA's authoritative id is a UUID; we keep it under our id namespace.
    const id = `dawa:${p.id ?? `${vejnavn}-${housenr}-${postnr}`}`;
    // Parcel reference (some addresses have no jordstykke — e.g. on bridges).
    let parcelId: string | null = null;
    if (p.jordstykke_ejerlavkode != null && p.jordstykke_matrikelnr) {
      parcelId = `${p.jordstykke_ejerlavkode}/${p.jordstykke_matrikelnr}`;
      parcelIds.add(parcelId);
    }
    addresses.push({
      id,
      displayName,
      kind: 'address',
      lat,
      lon,
      country: 'DK',
      adminPath,
      parcelId,
    });
  }

  log(`Fetching ${parcelIds.size} parcel polygons from DAWA…`);
  const parcels = await fetchParcels(parcelIds, baseUrl, f, log);
  log(`  - ${parcels.length} parcel polygons received`);

  return { addresses, parcels };
}

/**
 * Fetch parcel polygons one at a time using the {ejerlavkode}/{matrikelnr}
 * path. DAWA does support bulk filtering but not by composite key list, so
 * we fan out — the requests are small and finish in seconds for city-sized
 * regions. Failures on individual parcels are swallowed: a missing parcel
 * just means that address won't show a polygon outline in the UI.
 */
async function fetchParcels(
  ids: Iterable<string>,
  baseUrl: string,
  f: typeof fetch,
  log: (msg: string) => void,
): Promise<ParcelPolygon[]> {
  const idList = Array.from(ids);
  const out: ParcelPolygon[] = [];
  const concurrency = 16;
  let cursor = 0;
  let lastReport = Date.now();

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= idList.length) return;
      const id = idList[i]!;
      const [ejerlavkode, matrikelnr] = id.split('/');
      if (!ejerlavkode || !matrikelnr) continue;
      const url = `${baseUrl}/jordstykker/${ejerlavkode}/${encodeURIComponent(matrikelnr)}?format=geojson&srid=4326`;
      try {
        const res = await f(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        const feat = (await res.json()) as DawaParcelGeojson | null;
        if (!feat || !feat.geometry || !feat.geometry.coordinates) continue;
        const rings = parcelRings(feat.geometry);
        if (rings.length === 0) continue;
        out.push({
          id,
          label: feat.properties?.betegnelse ?? id,
          ejerlavkode: Number(ejerlavkode),
          ejerlavnavn: feat.properties?.ejerlavnavn ?? '',
          matrikelnr,
          rings,
        });
      } catch {
        // network blip — skip this parcel
      }
      if (Date.now() - lastReport > 2000) {
        log(`  - parcels: ${out.length}/${idList.length} fetched`);
        lastReport = Date.now();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

/**
 * Splice a DAWA fetch result into a SyntheticData built from OSM:
 *   - All OSM-derived address-kind places are REPLACED with the DAWA set
 *     (DAWA has authoritative coverage; mixing the two would just produce
 *     duplicates and confuse search ranking).
 *   - Non-address places (streets, POIs, admin) are kept as-is — DAWA
 *     doesn't cover them.
 *   - Parcels are attached to the data so writeGeocodeDb persists them.
 *
 * Returns a new SyntheticData (input is not mutated).
 */
export function applyDawa(data: SyntheticData, dawa: DawaFetchResult): SyntheticData {
  const keptPlaces = data.places.filter((p) => p.kind !== 'address');
  return {
    ...data,
    places: [...keptPlaces, ...dawa.addresses],
    parcels: dawa.parcels,
  };
}

function parcelRings(geom: DawaGeojsonGeometry): Array<Array<[number, number]>> {
  if (geom.type === 'Polygon') {
    return [outerRing(geom.coordinates as number[][][])];
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates as number[][][][];
    return polys.map((p) => outerRing(p));
  }
  return [];
}

function outerRing(poly: number[][][]): Array<[number, number]> {
  const outer = poly[0];
  if (!outer) return [];
  return outer.map((pt) => [Number(pt[0]), Number(pt[1])] as [number, number]);
}

interface DawaGeojsonResponse {
  features?: ReadonlyArray<DawaGeojsonFeature>;
}
interface DawaGeojsonFeature {
  geometry?: { type: string; coordinates?: ReadonlyArray<number> };
  properties?: {
    id?: string;
    vejnavn?: string;
    husnr?: string;
    postnr?: string;
    postnrnavn?: string;
    jordstykke_ejerlavkode?: number;
    jordstykke_matrikelnr?: string;
  };
}
interface DawaGeojsonGeometry {
  type: string;
  coordinates: unknown;
}
interface DawaParcelGeojson {
  geometry?: DawaGeojsonGeometry;
  properties?: {
    betegnelse?: string;
    ejerlavnavn?: string;
  };
}
