import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import maplibregl from 'maplibre-gl';
import type { RegionManifest, RouteResult } from '@openmaps/core';
import { api } from './openmapsApi.js';
import { buildMapStyle, DEFAULT_LAYER_TOGGLES } from './buildMapStyle.js';
import type { LayerToggles, MapTheme } from './buildMapStyle.js';

/**
 * MapLibre wrapper that reads tiles via the omap:// custom protocol, which
 * is handled in JS (no HTTP) and routes through window.openmaps.tiles.get
 * → main process → MBTiles file. Zero network calls.
 */

export interface ReverseInfoPopup {
  lat: number;
  lon: number;
  displayName: string;
  kind: string;
  distanceM: number;
}

export interface MapViewHandle {
  centerOn(lat: number, lon: number, zoom?: number): void;
  fitBbox(bbox: readonly [number, number, number, number]): void;
  setRoute(route: RouteResult | null): void;
  setMarker(name: string, lat: number, lon: number): void;
  setClickHandler(handler: ((e: { lat: number; lon: number }) => void) | null): void;
  /** Show a popup with reverse-geocode info at the given location, or clear it. */
  showReverseInfo(info: ReverseInfoPopup | null): void;
  /**
   * Start interactive bbox selection. The map disables its drag-to-pan
   * behaviour and the next click+drag draws a rectangle; on mouse-up
   * the callback fires with the bbox in [minLon, minLat, maxLon, maxLat]
   * order. Cancelable via the returned function.
   */
  startBboxDraw(
    onComplete: (bbox: [number, number, number, number]) => void,
  ): () => void;
}

interface Props {
  manifest: RegionManifest | null;
  /** Visual theme; defaults to 'default' if not supplied. */
  theme?: MapTheme;
  /** Per-layer visibility toggles. */
  toggles?: LayerToggles;
}

// Register the protocol once per renderer. MapLibre maintains a global
// registry so this must happen before any map instance asks for tiles.
let protocolRegistered = false;

async function gunzipToUint8Array(bytes: Uint8Array): Promise<Uint8Array> {
  // DecompressionStream is supported in Chromium/Electron and is the
  // canonical way to gunzip in the renderer without bundling pako.
  const blob = new Blob([bytes as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Popup contents are interpolated via setHTML which does not sanitize,
// so anything user-controlled (display name, kind) must be escaped first.
// The MVT data is local and trusted, but a stray apostrophe or angle
// bracket could still break the markup.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureProtocolRegistered(): void {
  if (protocolRegistered) return;
  // maplibre-gl v4 expects the handler to return a Promise<{data: Uint8Array}>.
  // CRITICAL: MBTiles vector tiles are stored gzipped. Over HTTP, browsers
  // transparently decompress them via `Content-Encoding: gzip`. Custom
  // protocols bypass that machinery, so we MUST gunzip in JS before handing
  // the bytes to MapLibre's MVT parser — otherwise it silently fails to
  // parse the tile and the map renders as a gray background.
  maplibregl.addProtocol('omap', async (request) => {
    try {
      // URL form: omap://{z}/{x}/{y}.pbf
      const m = /^omap:\/\/(\d+)\/(\d+)\/(\d+)\.[a-z0-9]+$/i.exec(request.url);
      if (!m) {
        throw new Error(`bad omap url ${request.url}`);
      }
      const z = parseInt(m[1]!, 10);
      const x = parseInt(m[2]!, 10);
      const y = parseInt(m[3]!, 10);
      const tile = await api.tiles.get(z, x, y);
      if (!tile) return { data: new Uint8Array(0) };
      const data =
        tile.contentEncoding === 'gzip'
          ? await gunzipToUint8Array(tile.bytes)
          : tile.bytes;
      return { data };
    } catch (err) {
      // Silent failures here = gray map. Always surface them.
      // eslint-disable-next-line no-console
      console.error('[omap] handler failed', request.url, err);
      throw err;
    }
  });
  protocolRegistered = true;
}

export const MapView = forwardRef<MapViewHandle, Props>(function MapView(
  { manifest, theme = 'default', toggles = DEFAULT_LAYER_TOGGLES },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const reverseInfoPopupRef = useRef<maplibregl.Popup | null>(null);
  const clickHandlerRef = useRef<((e: { lat: number; lon: number }) => void) | null>(null);
  // Remembered route GeoJSON, so a theme switch (setStyle) doesn't clear
  // the visible route. setRoute writes here; ensureRouteLayer reads.
  const lastRouteGeoJsonRef = useRef<GeoJSON.GeoJSON | null>(null);

  // (Re)create the map when manifest changes (e.g. switching packs).
  useEffect(() => {
    if (!manifest || !containerRef.current) return;
    ensureProtocolRegistered();
    const [minLon, minLat, maxLon, maxLat] = manifest.bbox;
    const center: [number, number] = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];

    const style = buildMapStyle(manifest, { theme, toggles });

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center,
      zoom: 10,
      // OSM data is ODbL — attribution to OpenStreetMap contributors is
      // mandatory. The "offline" tag is informational; the OSM credit is legal.
      attributionControl: {
        compact: true,
        customAttribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · OpenMaps v2 (offline)',
      },
    });
    // +/- buttons + compass. Gives a fallback if the user's mouse wheel
    // misbehaves (some Logitech high-DPI wheels emit a burst of small
    // events per detent, which makes MapLibre's wheel-zoom feel jumpy
    // even though it's working correctly).
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    map.on('click', (e) => {
      if (clickHandlerRef.current) {
        clickHandlerRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
      }
    });

    // Route source/layer must be re-added every time the style changes
    // (initial load + each setStyle from theme switch). Idempotent via
    // getSource/getLayer guards. Also re-applies the last known route
    // geometry so a theme switch doesn't drop the active route.
    const ensureRouteLayer = (): void => {
      if (!map.getSource('current-route')) {
        map.addSource('current-route', {
          type: 'geojson',
          data: lastRouteGeoJsonRef.current ?? { type: 'FeatureCollection', features: [] },
        });
      }
      if (!map.getLayer('current-route-line')) {
        map.addLayer({
          id: 'current-route-line',
          type: 'line',
          source: 'current-route',
          paint: { 'line-color': '#d8443a', 'line-width': 4, 'line-opacity': 0.85 },
        });
      }
    };
    map.on('load', ensureRouteLayer);
    // `styledata` fires after every successful setStyle once the new
    // style's sources/layers are ready.
    map.on('styledata', ensureRouteLayer);

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current?.remove();
      markerRef.current = null;
      reverseInfoPopupRef.current?.remove();
      reverseInfoPopupRef.current = null;
    };
    // Theme/toggles intentionally excluded from deps — they're applied
    // via a separate effect using setStyle, which preserves user
    // pan/zoom and the active route instead of remounting the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  // Reactively swap the style when the theme or toggles change. setStyle
  // is much cheaper than a full map remount: it diffs paint props and
  // keeps existing tiles in cache.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !manifest) return;
    map.setStyle(buildMapStyle(manifest, { theme, toggles }));
  }, [theme, toggles, manifest]);

  useImperativeHandle(ref, () => ({
    centerOn(lat, lon, zoom = 13) {
      mapRef.current?.flyTo({ center: [lon, lat], zoom });
    },
    fitBbox(bbox) {
      const map = mapRef.current;
      if (!map) return;
      map.fitBounds(
        [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ],
        { padding: 40, duration: 600 },
      );
    },
    showReverseInfo(info) {
      const map = mapRef.current;
      if (!map) return;
      reverseInfoPopupRef.current?.remove();
      reverseInfoPopupRef.current = null;
      if (!info) return;
      const html = `
        <div style="font-size:13px;line-height:1.35;max-width:240px">
          <strong>${escapeHtml(info.displayName)}</strong>
          <div style="color:#666;font-size:11px;margin-top:2px">
            ${escapeHtml(info.kind)} · ${Math.round(info.distanceM)} m
          </div>
        </div>`;
      reverseInfoPopupRef.current = new maplibregl.Popup({ closeOnClick: true, maxWidth: '260px' })
        .setLngLat([info.lon, info.lat])
        .setHTML(html)
        .addTo(map);
    },
    setRoute(route) {
      const src = mapRef.current?.getSource('current-route') as maplibregl.GeoJSONSource | undefined;
      const data: GeoJSON.GeoJSON = !route
        ? { type: 'FeatureCollection', features: [] }
        : {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: route.geometry as Array<[number, number]> },
            properties: {},
          };
      lastRouteGeoJsonRef.current = data;
      if (src) src.setData(data);
      if (route) {
        const bounds = route.geometry.reduce(
          (b, [lon, lat]) => b.extend([lon, lat] as [number, number]),
          new maplibregl.LngLatBounds(),
        );
        mapRef.current?.fitBounds(bounds, { padding: 60, duration: 600 });
      }
    },
    setMarker(_name, lat, lon) {
      if (!mapRef.current) return;
      markerRef.current?.remove();
      markerRef.current = new maplibregl.Marker({ color: '#2566e6' })
        .setLngLat([lon, lat])
        .addTo(mapRef.current);
    },
    setClickHandler(handler) {
      clickHandlerRef.current = handler;
    },
    startBboxDraw(onComplete) {
      const map = mapRef.current;
      const container = containerRef.current;
      if (!map || !container) return () => {};
      // Disable map drag so our mousedown can claim the gesture.
      map.dragPan.disable();
      map.boxZoom.disable();
      map.scrollZoom.disable();
      map.doubleClickZoom.disable();
      container.style.cursor = 'crosshair';

      // Overlay element that draws the rubber-band rectangle. Positioned
      // absolutely over the map container; pointer-events:none so it
      // doesn't interfere with our event listeners attached to the
      // container.
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: absolute;
        pointer-events: none;
        border: 2px solid #2566e6;
        background: rgba(37, 102, 230, 0.15);
        display: none;
        z-index: 10;
      `;
      container.style.position = 'relative';
      container.appendChild(overlay);

      let startPx: { x: number; y: number } | null = null;
      let startLngLat: maplibregl.LngLat | null = null;

      const onMouseDown = (e: MouseEvent): void => {
        const rect = container.getBoundingClientRect();
        startPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        startLngLat = map.unproject([startPx.x, startPx.y]);
        overlay.style.display = 'block';
        overlay.style.left = `${startPx.x}px`;
        overlay.style.top = `${startPx.y}px`;
        overlay.style.width = '0px';
        overlay.style.height = '0px';
      };
      const onMouseMove = (e: MouseEvent): void => {
        if (!startPx) return;
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const left = Math.min(startPx.x, x);
        const top = Math.min(startPx.y, y);
        const width = Math.abs(x - startPx.x);
        const height = Math.abs(y - startPx.y);
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
      };
      const onMouseUp = (e: MouseEvent): void => {
        if (!startPx || !startLngLat) return;
        const rect = container.getBoundingClientRect();
        const endPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const endLngLat = map.unproject([endPx.x, endPx.y]);
        const minLon = Math.min(startLngLat.lng, endLngLat.lng);
        const maxLon = Math.max(startLngLat.lng, endLngLat.lng);
        const minLat = Math.min(startLngLat.lat, endLngLat.lat);
        const maxLat = Math.max(startLngLat.lat, endLngLat.lat);
        const screenDist = Math.hypot(endPx.x - startPx.x, endPx.y - startPx.y);
        // Reset start state but leave the overlay rectangle visible — the
        // caller will show a confirm/redraw banner. A new mousedown clears
        // and redraws. cleanup() runs only when the caller is done.
        startPx = null;
        startLngLat = null;
        if (screenDist < 8) {
          overlay.style.display = 'none';
          return;
        }
        onComplete([minLon, minLat, maxLon, maxLat]);
      };
      const cleanup = (): void => {
        container.removeEventListener('mousedown', onMouseDown);
        container.removeEventListener('mousemove', onMouseMove);
        container.removeEventListener('mouseup', onMouseUp);
        map.dragPan.enable();
        map.boxZoom.enable();
        map.scrollZoom.enable();
        map.doubleClickZoom.enable();
        container.style.cursor = '';
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      };
      container.addEventListener('mousedown', onMouseDown);
      container.addEventListener('mousemove', onMouseMove);
      container.addEventListener('mouseup', onMouseUp);
      return cleanup;
    },
  }));

  return <div ref={containerRef} className="map" />;
});
