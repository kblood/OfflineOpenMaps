/**
 * Curated list of Geofabrik daily-extract URLs. The Geofabrik service has
 * been the canonical regional OSM mirror since 2008; their .osm.pbf
 * filenames are stable and lifelong (`/europe/denmark-latest.osm.pbf`),
 * so hardcoding them here is reasonable.
 *
 * Sizes are approximate as of 2026-05 and exist purely so the UI can
 * warn before a multi-hundred-MB download starts. They're not used for
 * progress maths; the actual byte total comes from the HTTP
 * Content-Length header at download time.
 *
 * The list is curated rather than exhaustive: we ship the European
 * countries an offline-map user is likely to want for hiking / cycling /
 * driving, in alphabetical order. To add a country, look up its slug at
 * https://download.geofabrik.de/ — every country has a daily extract.
 *
 * Selection bias: European-centric because OpenMaps v2 is a hobby
 * project by a Danish user; we'll widen the list when a real user asks.
 * Adding e.g. Asia/Africa is a one-liner; the downloader doesn't care
 * where the URL points.
 */
export type Continent =
  | 'Europe'
  | 'North America'
  | 'South America'
  | 'Asia'
  | 'Africa'
  | 'Oceania';

export interface GeofabrikCountry {
  /** Stable id used as the pack id (lowercase, ASCII-safe). */
  readonly id: string;
  /** Human-readable name shown in the picker. */
  readonly name: string;
  /** Continent for UI grouping. */
  readonly continent: Continent;
  /** ISO 3166-1 alpha-2 country code, stored in the pack manifest. */
  readonly iso: string;
  /** Full URL to the .osm.pbf file. */
  readonly url: string;
  /** Approximate download size in MB. Display-only. */
  readonly approxMb: number;
  /** Geographical bbox (minLon, minLat, maxLon, maxLat), display-only. */
  readonly bbox: readonly [number, number, number, number];
}

export const GEOFABRIK_COUNTRIES: ReadonlyArray<GeofabrikCountry> = [
  // ─── Europe ─────────────────────────────────────────────────────────
  { id: 'austria',         name: 'Austria',         continent: 'Europe', iso: 'AT', approxMb: 740,  bbox: [9.5, 46.3, 17.2, 49.0],   url: 'https://download.geofabrik.de/europe/austria-latest.osm.pbf' },
  { id: 'belgium',         name: 'Belgium',         continent: 'Europe', iso: 'BE', approxMb: 530,  bbox: [2.5, 49.4, 6.5, 51.6],    url: 'https://download.geofabrik.de/europe/belgium-latest.osm.pbf' },
  { id: 'czech-republic',  name: 'Czech Republic',  continent: 'Europe', iso: 'CZ', approxMb: 880,  bbox: [12.0, 48.5, 18.9, 51.1],  url: 'https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf' },
  { id: 'denmark',         name: 'Denmark',         continent: 'Europe', iso: 'DK', approxMb: 460,  bbox: [8.0, 54.5, 15.5, 57.8],   url: 'https://download.geofabrik.de/europe/denmark-latest.osm.pbf' },
  { id: 'estonia',         name: 'Estonia',         continent: 'Europe', iso: 'EE', approxMb: 130,  bbox: [21.7, 57.5, 28.2, 59.7],  url: 'https://download.geofabrik.de/europe/estonia-latest.osm.pbf' },
  { id: 'finland',         name: 'Finland',         continent: 'Europe', iso: 'FI', approxMb: 770,  bbox: [19.0, 59.7, 31.6, 70.1],  url: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf' },
  { id: 'france',          name: 'France',          continent: 'Europe', iso: 'FR', approxMb: 4900, bbox: [-5.2, 41.3, 9.6, 51.1],   url: 'https://download.geofabrik.de/europe/france-latest.osm.pbf' },
  { id: 'germany',         name: 'Germany',         continent: 'Europe', iso: 'DE', approxMb: 4400, bbox: [5.8, 47.2, 15.1, 55.1],   url: 'https://download.geofabrik.de/europe/germany-latest.osm.pbf' },
  { id: 'great-britain',   name: 'Great Britain',   continent: 'Europe', iso: 'GB', approxMb: 1900, bbox: [-8.7, 49.8, 1.8, 60.9],   url: 'https://download.geofabrik.de/europe/great-britain-latest.osm.pbf' },
  { id: 'greece',          name: 'Greece',          continent: 'Europe', iso: 'GR', approxMb: 470,  bbox: [19.3, 34.7, 28.3, 41.8],  url: 'https://download.geofabrik.de/europe/greece-latest.osm.pbf' },
  { id: 'hungary',         name: 'Hungary',         continent: 'Europe', iso: 'HU', approxMb: 410,  bbox: [16.1, 45.7, 22.9, 48.6],  url: 'https://download.geofabrik.de/europe/hungary-latest.osm.pbf' },
  { id: 'iceland',         name: 'Iceland',         continent: 'Europe', iso: 'IS', approxMb: 110,  bbox: [-25.0, 63.2, -13.3, 67.0],url: 'https://download.geofabrik.de/europe/iceland-latest.osm.pbf' },
  { id: 'ireland-and-northern-ireland', name: 'Ireland', continent: 'Europe', iso: 'IE', approxMb: 220, bbox: [-10.6, 51.4, -5.4, 55.4], url: 'https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf' },
  { id: 'italy',           name: 'Italy',           continent: 'Europe', iso: 'IT', approxMb: 2400, bbox: [6.6, 35.5, 18.5, 47.1],   url: 'https://download.geofabrik.de/europe/italy-latest.osm.pbf' },
  { id: 'latvia',          name: 'Latvia',          continent: 'Europe', iso: 'LV', approxMb: 160,  bbox: [20.9, 55.7, 28.2, 58.1],  url: 'https://download.geofabrik.de/europe/latvia-latest.osm.pbf' },
  { id: 'lithuania',       name: 'Lithuania',       continent: 'Europe', iso: 'LT', approxMb: 230,  bbox: [20.9, 53.8, 26.9, 56.5],  url: 'https://download.geofabrik.de/europe/lithuania-latest.osm.pbf' },
  { id: 'netherlands',     name: 'Netherlands',     continent: 'Europe', iso: 'NL', approxMb: 1300, bbox: [3.3, 50.7, 7.2, 53.6],    url: 'https://download.geofabrik.de/europe/netherlands-latest.osm.pbf' },
  { id: 'norway',          name: 'Norway',          continent: 'Europe', iso: 'NO', approxMb: 1500, bbox: [4.6, 57.9, 31.3, 71.2],   url: 'https://download.geofabrik.de/europe/norway-latest.osm.pbf' },
  { id: 'poland',          name: 'Poland',          continent: 'Europe', iso: 'PL', approxMb: 1700, bbox: [14.1, 49.0, 24.2, 54.9],  url: 'https://download.geofabrik.de/europe/poland-latest.osm.pbf' },
  { id: 'portugal',        name: 'Portugal',        continent: 'Europe', iso: 'PT', approxMb: 360,  bbox: [-9.6, 36.9, -6.2, 42.2],  url: 'https://download.geofabrik.de/europe/portugal-latest.osm.pbf' },
  { id: 'romania',         name: 'Romania',         continent: 'Europe', iso: 'RO', approxMb: 730,  bbox: [20.2, 43.6, 29.7, 48.3],  url: 'https://download.geofabrik.de/europe/romania-latest.osm.pbf' },
  { id: 'slovakia',        name: 'Slovakia',        continent: 'Europe', iso: 'SK', approxMb: 350,  bbox: [16.8, 47.7, 22.6, 49.6],  url: 'https://download.geofabrik.de/europe/slovakia-latest.osm.pbf' },
  { id: 'slovenia',        name: 'Slovenia',        continent: 'Europe', iso: 'SI', approxMb: 220,  bbox: [13.4, 45.4, 16.7, 46.9],  url: 'https://download.geofabrik.de/europe/slovenia-latest.osm.pbf' },
  { id: 'spain',           name: 'Spain',           continent: 'Europe', iso: 'ES', approxMb: 1500, bbox: [-9.4, 35.9, 4.4, 43.8],   url: 'https://download.geofabrik.de/europe/spain-latest.osm.pbf' },
  { id: 'sweden',          name: 'Sweden',          continent: 'Europe', iso: 'SE', approxMb: 1400, bbox: [10.9, 55.3, 24.2, 69.1],  url: 'https://download.geofabrik.de/europe/sweden-latest.osm.pbf' },
  { id: 'switzerland',     name: 'Switzerland',     continent: 'Europe', iso: 'CH', approxMb: 530,  bbox: [5.9, 45.8, 10.5, 47.8],   url: 'https://download.geofabrik.de/europe/switzerland-latest.osm.pbf' },

  // ─── North America ──────────────────────────────────────────────────
  // The US is sub-divided in Geofabrik into state-level extracts because
  // a single US-wide PBF is ~15 GB; we expose individual states the way
  // Geofabrik does. The full list lives in the country sub-pages; here
  // we ship a representative selection and leave the rest as a future
  // expansion (this is data, not code).
  { id: 'canada',          name: 'Canada',          continent: 'North America', iso: 'CA', approxMb: 2400, bbox: [-141.0, 41.7, -52.6, 83.1], url: 'https://download.geofabrik.de/north-america/canada-latest.osm.pbf' },
  { id: 'mexico',          name: 'Mexico',          continent: 'North America', iso: 'MX', approxMb: 1100, bbox: [-118.4, 14.5, -86.7, 32.7], url: 'https://download.geofabrik.de/north-america/mexico-latest.osm.pbf' },
  { id: 'us-california',   name: 'US: California',  continent: 'North America', iso: 'US', approxMb: 1400, bbox: [-124.5, 32.5, -114.1, 42.0], url: 'https://download.geofabrik.de/north-america/us/california-latest.osm.pbf' },
  { id: 'us-new-york',     name: 'US: New York',    continent: 'North America', iso: 'US', approxMb: 580,  bbox: [-79.8, 40.4, -71.8, 45.0],   url: 'https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf' },
  { id: 'us-texas',        name: 'US: Texas',       continent: 'North America', iso: 'US', approxMb: 1100, bbox: [-106.7, 25.8, -93.5, 36.5],  url: 'https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf' },
  { id: 'us-washington',   name: 'US: Washington',  continent: 'North America', iso: 'US', approxMb: 320,  bbox: [-124.8, 45.5, -116.9, 49.0], url: 'https://download.geofabrik.de/north-america/us/washington-latest.osm.pbf' },

  // ─── South America ──────────────────────────────────────────────────
  { id: 'argentina',       name: 'Argentina',       continent: 'South America', iso: 'AR', approxMb: 480,  bbox: [-73.6, -55.1, -53.6, -21.8], url: 'https://download.geofabrik.de/south-america/argentina-latest.osm.pbf' },
  { id: 'brazil',          name: 'Brazil',          continent: 'South America', iso: 'BR', approxMb: 1700, bbox: [-74.0, -33.8, -34.7, 5.3],   url: 'https://download.geofabrik.de/south-america/brazil-latest.osm.pbf' },
  { id: 'chile',           name: 'Chile',           continent: 'South America', iso: 'CL', approxMb: 280,  bbox: [-76.0, -56.0, -66.4, -17.5], url: 'https://download.geofabrik.de/south-america/chile-latest.osm.pbf' },
  { id: 'colombia',        name: 'Colombia',        continent: 'South America', iso: 'CO', approxMb: 420,  bbox: [-82.0, -4.2, -66.9, 12.6],   url: 'https://download.geofabrik.de/south-america/colombia-latest.osm.pbf' },
  { id: 'peru',            name: 'Peru',            continent: 'South America', iso: 'PE', approxMb: 270,  bbox: [-81.4, -18.4, -68.7, -0.0],  url: 'https://download.geofabrik.de/south-america/peru-latest.osm.pbf' },

  // ─── Asia ───────────────────────────────────────────────────────────
  { id: 'china',           name: 'China',           continent: 'Asia', iso: 'CN', approxMb: 1900, bbox: [73.6, 18.2, 134.8, 53.6],  url: 'https://download.geofabrik.de/asia/china-latest.osm.pbf' },
  { id: 'india',           name: 'India',           continent: 'Asia', iso: 'IN', approxMb: 1000, bbox: [68.2, 6.7, 97.4, 35.5],    url: 'https://download.geofabrik.de/asia/india-latest.osm.pbf' },
  { id: 'indonesia',       name: 'Indonesia',       continent: 'Asia', iso: 'ID', approxMb: 670,  bbox: [95.0, -11.0, 141.0, 6.1],  url: 'https://download.geofabrik.de/asia/indonesia-latest.osm.pbf' },
  { id: 'israel-and-palestine', name: 'Israel & Palestine', continent: 'Asia', iso: 'IL', approxMb: 130, bbox: [34.2, 29.5, 35.9, 33.4], url: 'https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf' },
  { id: 'japan',           name: 'Japan',           continent: 'Asia', iso: 'JP', approxMb: 2100, bbox: [122.9, 24.0, 153.9, 45.5], url: 'https://download.geofabrik.de/asia/japan-latest.osm.pbf' },
  { id: 'philippines',     name: 'Philippines',     continent: 'Asia', iso: 'PH', approxMb: 410,  bbox: [116.9, 4.6, 126.6, 21.1],  url: 'https://download.geofabrik.de/asia/philippines-latest.osm.pbf' },
  { id: 'south-korea',     name: 'South Korea',     continent: 'Asia', iso: 'KR', approxMb: 470,  bbox: [124.5, 33.0, 131.9, 38.7], url: 'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf' },
  { id: 'thailand',        name: 'Thailand',        continent: 'Asia', iso: 'TH', approxMb: 470,  bbox: [97.3, 5.6, 105.7, 20.5],   url: 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf' },
  { id: 'turkey',          name: 'Turkey',          continent: 'Asia', iso: 'TR', approxMb: 750,  bbox: [25.7, 35.8, 44.8, 42.1],   url: 'https://download.geofabrik.de/asia/turkey-latest.osm.pbf' },
  { id: 'vietnam',         name: 'Vietnam',         continent: 'Asia', iso: 'VN', approxMb: 350,  bbox: [102.1, 8.6, 109.5, 23.4],  url: 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf' },

  // ─── Africa ─────────────────────────────────────────────────────────
  { id: 'egypt',           name: 'Egypt',           continent: 'Africa', iso: 'EG', approxMb: 140, bbox: [24.7, 21.7, 36.9, 31.7],  url: 'https://download.geofabrik.de/africa/egypt-latest.osm.pbf' },
  { id: 'kenya',           name: 'Kenya',           continent: 'Africa', iso: 'KE', approxMb: 220, bbox: [33.9, -4.7, 41.9, 5.1],   url: 'https://download.geofabrik.de/africa/kenya-latest.osm.pbf' },
  { id: 'morocco',         name: 'Morocco',         continent: 'Africa', iso: 'MA', approxMb: 200, bbox: [-17.2, 21.4, -1.0, 35.9], url: 'https://download.geofabrik.de/africa/morocco-latest.osm.pbf' },
  { id: 'nigeria',         name: 'Nigeria',         continent: 'Africa', iso: 'NG', approxMb: 280, bbox: [2.7, 4.3, 14.7, 13.9],    url: 'https://download.geofabrik.de/africa/nigeria-latest.osm.pbf' },
  { id: 'south-africa',    name: 'South Africa',    continent: 'Africa', iso: 'ZA', approxMb: 320, bbox: [16.5, -34.8, 32.9, -22.1],url: 'https://download.geofabrik.de/africa/south-africa-latest.osm.pbf' },
  { id: 'tanzania',        name: 'Tanzania',        continent: 'Africa', iso: 'TZ', approxMb: 190, bbox: [29.3, -11.8, 40.5, -0.9], url: 'https://download.geofabrik.de/africa/tanzania-latest.osm.pbf' },

  // ─── Oceania ────────────────────────────────────────────────────────
  { id: 'australia',       name: 'Australia',       continent: 'Oceania', iso: 'AU', approxMb: 1200, bbox: [112.9, -43.7, 153.6, -10.7], url: 'https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf' },
  { id: 'new-zealand',     name: 'New Zealand',     continent: 'Oceania', iso: 'NZ', approxMb: 280,  bbox: [166.4, -47.3, 178.6, -34.4], url: 'https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf' },
];
