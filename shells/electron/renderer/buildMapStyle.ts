import type maplibregl from 'maplibre-gl';
import type { RegionManifest } from '@openmaps/core';

/**
 * Build the MapLibre style spec for a given pack manifest. Extracted as a
 * pure function so it can be unit-tested with `validateStyleMin` from
 * `@maplibre/maplibre-gl-style-spec`. Without this seam, MapLibre's
 * style-validation errors only surface at runtime when the renderer
 * mounts the map — and a validation failure produces a silent gray
 * canvas (the user reported "white background, just a marker"), which
 * is much harder to catch than a unit-test failure.
 *
 * Rules of thumb for keeping this validatable:
 *   - Any `symbol` layer with `text-field` REQUIRES a top-level `glyphs`
 *     URL. Without glyphs, the entire style is rejected and nothing
 *     renders, not even the `background` layer.
 *   - Any `symbol` layer with `icon-image` REQUIRES a `sprite` URL.
 *   - `source-layer` values must match what the MVT actually contains
 *     (we emit `water`, `buildings`, `roads`, and `places`).
 *
 * The associated unit test guarantees these rules at build time.
 */
/**
 * The fontstack the renderer ships PBFs for. Must match the folder name
 * under `renderer/public/fonts/` exactly — the literal comma is part of
 * the fontstack and shows up in both the URL and the on-disk path.
 * `scripts/fetch-fonts.mjs` writes the PBFs to that folder.
 */
const FONTSTACK = ['Open Sans Regular', 'Arial Unicode MS Regular'];

/**
 * Visual theme identifiers. Same vector data, different paint properties.
 * Add a new theme by extending THEMES below and adding its id here.
 */
export type MapTheme = 'default' | 'dark' | 'mono';

export const MAP_THEMES: ReadonlyArray<{ id: MapTheme; label: string; description: string }> = [
  { id: 'default', label: 'Default', description: 'Light, colour-coded base map' },
  { id: 'dark', label: 'Dark', description: 'Low-glare night theme' },
  { id: 'mono', label: 'Mono', description: 'High-contrast monochrome' },
];

interface Palette {
  bg: string;
  water: string;
  /** Building footprint fill — a touch darker than the bg. */
  buildingFill: string;
  /** Building footprint outline — darker still, for rectangle definition. */
  buildingStroke: string;
  roadCasing: string;
  road: string;
  /** Trunk/primary road fill — usually amber/yellow on real maps. */
  roadMajor: string;
  /** Motorway fill — same major shade or slightly different for emphasis. */
  motorway: string;
  /** Cycleway fill colour (used for `cycleway` + bike-friendly `path`). */
  cycle: string;
  /** Footway / pedestrian / steps / path fill colour. */
  foot: string;
  textColor: string;
  textHalo: string;
  placeFill: string;
  placeStroke: string;
}

const PALETTES: Record<MapTheme, Palette> = {
  default: {
    bg: '#f6f5ef',
    water: '#a9d3f2',
    buildingFill: '#e6e2d3',
    buildingStroke: '#b9b3a0',
    roadCasing: '#cfcfcf',
    road: '#ffffff',
    roadMajor: '#ffe680',
    motorway: '#f7b955',
    cycle: '#1e9eb3',
    foot: '#c97894',
    textColor: '#222',
    textHalo: '#fff',
    placeFill: '#2566e6',
    placeStroke: '#fff',
  },
  dark: {
    bg: '#1f242b',
    water: '#16324a',
    buildingFill: '#2b313a',
    buildingStroke: '#444c58',
    roadCasing: '#3a4250',
    road: '#5a6474',
    roadMajor: '#a08146',
    motorway: '#b67c2c',
    cycle: '#1c7d8e',
    foot: '#a36275',
    textColor: '#e8e9eb',
    textHalo: '#1f242b',
    placeFill: '#ffb74d',
    placeStroke: '#1f242b',
  },
  mono: {
    bg: '#ffffff',
    water: '#dddddd',
    buildingFill: '#ffffff',
    buildingStroke: '#000000',
    roadCasing: '#000000',
    road: '#ffffff',
    roadMajor: '#aaaaaa',
    motorway: '#777777',
    cycle: '#444444',
    foot: '#666666',
    textColor: '#000',
    textHalo: '#fff',
    placeFill: '#000',
    placeStroke: '#fff',
  },
};

// Highway-class buckets used by style filters.
const MAJOR_CLASSES = ['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link'];
const MOTORWAY_CLASSES = ['motorway', 'motorway_link'];
const CYCLE_CLASSES = ['cycleway'];
const FOOT_CLASSES = ['footway', 'pedestrian', 'path', 'steps'];

/**
 * Toggles for individual layer groups. Defaults to all-on. The renderer
 * lifts these to a UI control so users can turn off e.g. road labels.
 *
 * Each toggle maps to a `layout.visibility = 'none'` on the relevant
 * layers — implemented as in-style metadata + a tiny post-processor at
 * the end of this function — rather than dynamically calling
 * `map.setLayoutProperty` from React, because the latter creates a sync
 * gap between style rebuild (theme change) and visibility (toggle state).
 */
export interface LayerToggles {
  water: boolean;
  /** Building footprints — only visible at z>=13 even when enabled. */
  buildings: boolean;
  roadLabels: boolean;
  places: boolean;
  /** Cycleways — rendered as dashed teal lines. */
  cyclePaths: boolean;
  /** Footways, pedestrian streets, paths, steps — rendered as dashed pink. */
  footPaths: boolean;
}

export const DEFAULT_LAYER_TOGGLES: LayerToggles = {
  water: true,
  buildings: true,
  roadLabels: true,
  places: true,
  cyclePaths: true,
  footPaths: true,
};

export interface BuildMapStyleOpts {
  theme?: MapTheme;
  toggles?: LayerToggles;
}

export function buildMapStyle(
  manifest: RegionManifest,
  opts: BuildMapStyleOpts = {},
): maplibregl.StyleSpecification {
  const theme: MapTheme = opts.theme ?? 'default';
  const t = opts.toggles ?? DEFAULT_LAYER_TOGGLES;
  const p = PALETTES[theme];

  const hidden = (vis: boolean): 'visible' | 'none' => (vis ? 'visible' : 'none');

  return {
    version: 8,
    glyphs: 'fonts/{fontstack}/{range}.pbf',
    sources: {
      omap: {
        type: 'vector',
        tiles: ['omap://{z}/{x}/{y}.pbf'],
        minzoom: 8,
        maxzoom: 14,
        bounds: manifest.bbox,
        attribution: '© OpenMaps v2',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': p.bg } },
      {
        id: 'water',
        type: 'fill',
        source: 'omap',
        'source-layer': 'water',
        layout: { visibility: hidden(t.water) },
        paint: { 'fill-color': p.water, 'fill-antialias': true },
      },
      // ─── Building footprints ───────────────────────────────────────
      // Drawn between water and roads so the road network paints over
      // the corners where a residential street trims a building's
      // bounding box. Fill + thin outline. minzoom=13 mirrors what
      // writeMbtiles actually emits — at lower zooms individual
      // buildings would be sub-pixel and just smear the tile out.
      {
        id: 'buildings-fill',
        type: 'fill',
        source: 'omap',
        'source-layer': 'buildings',
        minzoom: 13,
        layout: { visibility: hidden(t.buildings) },
        paint: { 'fill-color': p.buildingFill, 'fill-antialias': true },
      },
      {
        id: 'buildings-outline',
        type: 'line',
        source: 'omap',
        'source-layer': 'buildings',
        minzoom: 14,
        layout: { visibility: hidden(t.buildings) },
        paint: {
          'line-color': p.buildingStroke,
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.4, 16, 1.0],
        },
      },
      // ─── Vehicle road network ─────────────────────────────────────
      // Casings (the darker outline rendered under the fills) — drawn
      // for all driveable classes. Z-ordered: minor below, major above.
      {
        id: 'roads-minor-casing',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        // "Everything not in a special class" — covers residential,
        // unclassified, service, living_street, tertiary, track.
        filter: ['!', ['in', ['get', 'highway'], ['literal', [...MAJOR_CLASSES, ...MOTORWAY_CLASSES, ...CYCLE_CLASSES, ...FOOT_CLASSES]]]],
        paint: {
          'line-color': p.roadCasing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 14, 5],
        },
      },
      {
        id: 'roads-major-casing',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', [...MAJOR_CLASSES, ...MOTORWAY_CLASSES]]],
        paint: {
          'line-color': p.roadCasing,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 9],
        },
      },
      // Fills, drawn in the same z-order so majors are on top.
      {
        id: 'roads-minor',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        filter: ['!', ['in', ['get', 'highway'], ['literal', [...MAJOR_CLASSES, ...MOTORWAY_CLASSES, ...CYCLE_CLASSES, ...FOOT_CLASSES]]]],
        paint: {
          'line-color': p.road,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 4],
        },
      },
      {
        id: 'roads-major',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', MAJOR_CLASSES]],
        paint: {
          'line-color': p.roadMajor,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 7],
        },
      },
      {
        id: 'roads-motorway',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', MOTORWAY_CLASSES]],
        paint: {
          'line-color': p.motorway,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 14, 8],
        },
      },
      // ─── Bike + foot paths ─────────────────────────────────────────
      // Drawn after the vehicle network so they overlay it at junctions.
      // Dashed strokes make the type recognisable without labels.
      {
        id: 'paths-cycle',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', CYCLE_CLASSES]],
        layout: { visibility: hidden(t.cyclePaths) },
        paint: {
          'line-color': p.cycle,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.0, 14, 2.5],
          'line-dasharray': [2, 1],
        },
      },
      {
        id: 'paths-foot',
        type: 'line',
        source: 'omap',
        'source-layer': 'roads',
        filter: ['in', ['get', 'highway'], ['literal', FOOT_CLASSES]],
        layout: { visibility: hidden(t.footPaths) },
        paint: {
          'line-color': p.foot,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 14, 2],
          'line-dasharray': [1.5, 1.5],
        },
      },
      {
        id: 'road-labels',
        type: 'symbol',
        source: 'omap',
        'source-layer': 'roads',
        minzoom: 12,
        // Only label ways that actually have a name or a ref — skip the
        // `(highway)` placeholder roadName the builder emits for unnamed
        // ways, since rendering "(footway)" across every alley is noise.
        filter: ['any', ['has', 'ref'], ['all', ['has', 'name'], ['!=', ['slice', ['get', 'name'], 0, 1], '(']]],
        layout: {
          visibility: hidden(t.roadLabels),
          'symbol-placement': 'line',
          // Prefer the route ref ("E45") when present; otherwise fall back
          // to the street name. MapLibre's `case` returns the first truthy
          // branch.
          'text-field': [
            'case',
            ['has', 'ref'],
            ['get', 'ref'],
            ['get', 'name'],
          ],
          'text-font': FONTSTACK,
          'text-size': 11,
        },
        paint: { 'text-color': p.textColor, 'text-halo-color': p.textHalo, 'text-halo-width': 1.5 },
      },
      {
        id: 'places',
        type: 'circle',
        source: 'omap',
        'source-layer': 'places',
        layout: { visibility: hidden(t.places) },
        paint: {
          'circle-radius': 4,
          'circle-color': p.placeFill,
          'circle-stroke-color': p.placeStroke,
          'circle-stroke-width': 1.5,
        },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: 'omap',
        'source-layer': 'places',
        minzoom: 10,
        layout: {
          visibility: hidden(t.places),
          'text-field': ['get', 'name'],
          'text-font': FONTSTACK,
          'text-anchor': 'top',
          'text-offset': [0, 0.8],
          'text-size': 12,
        },
        paint: { 'text-color': p.textColor, 'text-halo-color': p.textHalo, 'text-halo-width': 1.5 },
      },
    ],
  };
}
