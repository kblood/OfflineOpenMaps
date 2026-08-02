/**
 * Regression test for the "gray map" class of bug.
 *
 * MapLibre's style validator catches things like:
 *   - `text-field` on a symbol layer without a top-level `glyphs` URL
 *   - `icon-image` on a symbol layer without a `sprite` URL
 *   - `source-layer` referencing a source that doesn't exist
 *   - Invalid color expressions, missing layer ids, etc.
 *
 * When validation fails at runtime the style is rejected and the map
 * renders a blank canvas — markers still position correctly, so the bug
 * looks data-shaped rather than render-shaped, which is what burned us
 * in conversation 55438edc. This test runs the same validator the
 * MapLibre runtime uses, so any future change to `buildMapStyle` that
 * would silently break the map fails the build first.
 */
import { describe, expect, it } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { RegionManifest } from '@openmaps/core';
import { buildMapStyle, MAP_THEMES } from '../renderer/buildMapStyle.js';

const fakeManifest: RegionManifest = {
  schemaVersion: 1,
  id: 'test',
  name: 'Test',
  country: 'XX',
  bbox: [9.79, 56.95, 10.09, 57.13],
  builtAt: new Date().toISOString(),
  builderCommit: 'test',
  files: {
    tiles: { path: 'tiles.mbtiles', bytes: 1, sha256: 'x' },
    geocode: { path: 'geocode.sqlite', bytes: 1, sha256: 'x' },
    routing: { path: 'geocode.sqlite', bytes: 1, sha256: 'x' },
  },
  selfTestAnchors: {
    searchTerms: ['a'],
    reversePoint: { lat: 57, lon: 10 },
    routeWaypoints: [
      { lat: 57.0, lon: 9.9 },
      { lat: 57.05, lon: 10.0 },
    ],
    tileSample: { z: 10, x: 540, y: 313 },
  },
};

describe('buildMapStyle', () => {
  it('produces a style that passes MapLibre validation', () => {
    const style = buildMapStyle(fakeManifest);
    const errors = validateStyleMin(style);
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error('Style validation errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toEqual([]);
  });

  it('declares `glyphs` whenever a symbol layer uses text-field', () => {
    const style = buildMapStyle(fakeManifest);
    const symbolLayersWithText = (style.layers ?? []).filter(
      (l) =>
        l.type === 'symbol' &&
        l.layout != null &&
        'text-field' in l.layout &&
        l.layout['text-field'] != null,
    );
    if (symbolLayersWithText.length > 0) {
      expect(
        style.glyphs,
        `style has ${symbolLayersWithText.length} symbol layer(s) with text-field ` +
          `but no \`glyphs\` URL. MapLibre will reject the entire style and the map will render as a gray canvas. ` +
          `Add a glyphs source (e.g. 'fonts/{fontstack}/{range}.pbf') or remove the text-field layers.`,
      ).toBeTruthy();
    }
  });

  it('declares `sprite` whenever a symbol layer uses icon-image', () => {
    const style = buildMapStyle(fakeManifest);
    const symbolLayersWithIcon = (style.layers ?? []).filter(
      (l) =>
        l.type === 'symbol' &&
        l.layout != null &&
        'icon-image' in l.layout &&
        l.layout['icon-image'] != null,
    );
    if (symbolLayersWithIcon.length > 0) {
      expect(style.sprite, 'style uses icon-image but no `sprite` URL is set').toBeTruthy();
    }
  });

  it('only references source-layers that exist in our MVT', () => {
    const style = buildMapStyle(fakeManifest);
    const validSourceLayers = new Set(['water', 'buildings', 'roads', 'places']);
    for (const l of style.layers ?? []) {
      if ('source-layer' in l && typeof l['source-layer'] === 'string') {
        expect(
          validSourceLayers.has(l['source-layer']),
          `layer '${l.id}' references source-layer '${l['source-layer']}' but our MVT only ` +
            `contains: ${[...validSourceLayers].join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it.each(MAP_THEMES.map((t) => t.id))('produces a valid style for theme=%s', (theme) => {
    const style = buildMapStyle(fakeManifest, { theme });
    const errors = validateStyleMin(style);
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`Style validation errors for theme ${theme}:`, JSON.stringify(errors, null, 2));
    }
    expect(errors).toEqual([]);
  });

  it('honours layer toggles by setting layout.visibility', () => {
    const style = buildMapStyle(fakeManifest, {
      toggles: { water: false, buildings: false, roadLabels: false, places: false, cyclePaths: false, footPaths: false },
    });
    const get = (id: string): string | undefined =>
      (style.layers?.find((l) => l.id === id) as { layout?: { visibility?: string } } | undefined)?.layout?.visibility;
    expect(get('water')).toBe('none');
    expect(get('buildings-fill')).toBe('none');
    expect(get('buildings-outline')).toBe('none');
    expect(get('road-labels')).toBe('none');
    expect(get('places')).toBe('none');
    expect(get('paths-cycle')).toBe('none');
    expect(get('paths-foot')).toBe('none');
  });

  it('emits distinct style layers for cycleways and footpaths', () => {
    const style = buildMapStyle(fakeManifest);
    const cycle = style.layers?.find((l) => l.id === 'paths-cycle');
    const foot = style.layers?.find((l) => l.id === 'paths-foot');
    expect(cycle).toBeDefined();
    expect(foot).toBeDefined();
    // Both should be dashed (visually distinct from car roads).
    expect((cycle as { paint?: Record<string, unknown> } | undefined)?.paint?.['line-dasharray']).toBeDefined();
    expect((foot as { paint?: Record<string, unknown> } | undefined)?.paint?.['line-dasharray']).toBeDefined();
  });
});
