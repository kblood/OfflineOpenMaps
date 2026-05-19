import { useEffect, useRef, useState } from 'react';
import type { RegionManifest, RouteResult } from '@openmaps/core';
import { MapView, type MapViewHandle } from './MapView.js';
import { SearchBar } from './SearchBar.js';
import { RoutePanel } from './RoutePanel.js';
import { SelfTestPanel } from './SelfTestPanel.js';
import { PackPicker } from './PackPicker.js';
import { MapStylePanel } from './MapStylePanel.js';
import { AddRegionModal } from './AddRegionModal.js';
import { DEFAULT_LAYER_TOGGLES } from './buildMapStyle.js';
import type { LayerToggles, MapTheme } from './buildMapStyle.js';
import { api } from './openmapsApi.js';
import type { PackBuildProgress, StartBuildRequest } from './openmapsApi.js';

const THEME_STORAGE_KEY = 'openmaps:mapTheme';
const TOGGLES_STORAGE_KEY = 'openmaps:layerToggles';
const TERMINAL_BUILD_PHASES = new Set<PackBuildProgress['phase']>([
  'done',
  'cancelled',
  'failed',
]);

function loadTheme(): MapTheme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'default' || v === 'dark' || v === 'mono') return v;
  } catch {
    // localStorage can throw under file:// in some sandboxes; ignore.
  }
  return 'default';
}

function bboxAreaSqKm(bbox: readonly [number, number, number, number]): number {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  // Quick equirectangular approximation — good enough for an at-a-glance
  // sanity hint, no need for haversine.
  const midLat = (minLat + maxLat) / 2;
  const widthKm = (maxLon - minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
  const heightKm = (maxLat - minLat) * 111;
  return Math.max(0, widthKm * heightKm);
}

function formatArea(sqKm: number): string {
  if (sqKm < 10) return `${sqKm.toFixed(1)} km²`;
  if (sqKm < 1000) return `${Math.round(sqKm)} km²`;
  return `${(sqKm / 1000).toFixed(1)}k km²`;
}

function loadToggles(): LayerToggles {
  try {
    const raw = localStorage.getItem(TOGGLES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayerToggles>;
      return { ...DEFAULT_LAYER_TOGGLES, ...parsed };
    }
  } catch {
    // bad JSON or storage unavailable — fall through.
  }
  return DEFAULT_LAYER_TOGGLES;
}

export function App(): JSX.Element {
  const [manifest, setManifest] = useState<RegionManifest | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [start, setStart] = useState<{ lat: number; lon: number } | null>(null);
  const [end, setEnd] = useState<{ lat: number; lon: number } | null>(null);
  const [picking, setPicking] = useState<'start' | 'end' | null>(null);
  const [theme, setTheme] = useState<MapTheme>(loadTheme);
  const [toggles, setToggles] = useState<LayerToggles>(loadToggles);
  const [showAddRegion, setShowAddRegion] = useState(false);
  // While the user is drawing a bbox we hide the modal but keep its
  // state. The promise's resolver lives here so the MapView can deliver
  // the result asynchronously.
  const drawResolverRef = useRef<((b: [number, number, number, number] | null) => void) | null>(null);
  // Cleanup function returned by MapView.startBboxDraw — call it to
  // re-enable map gestures and remove the overlay rectangle.
  const drawCleanupRef = useRef<(() => void) | null>(null);
  const [drawingBbox, setDrawingBbox] = useState(false);
  // The bbox the user has drawn but not yet confirmed. While set, the
  // rectangle is visible on the map and the banner shows confirm/redraw
  // buttons. `null` means "still expecting an initial drag."
  const [pendingBbox, setPendingBbox] = useState<[number, number, number, number] | null>(null);
  // Sidebar can collapse to give the map full width. Settings (Map style
  // + Self-test) is its own disclosure inside the sidebar so the user
  // can keep the primary panels visible without scrolling past chrome
  // they rarely touch.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [justInstalledId, setJustInstalledId] = useState<string | null>(null);
  // Active in-app build state lives here so the modal can be closed
  // without dropping the IPC subscription. The build itself runs in the
  // main process and doesn't care about the modal's mount state — this
  // just keeps the renderer's view of progress alive.
  const [buildId, setBuildId] = useState<string | null>(null);
  const [buildProgress, setBuildProgress] = useState<PackBuildProgress | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const mapRef = useRef<MapViewHandle>(null);

  // Persist theme + toggles so the user's choice survives across launches.
  useEffect(() => {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* storage off */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem(TOGGLES_STORAGE_KEY, JSON.stringify(toggles)); } catch { /* storage off */ }
  }, [toggles]);

  // Poll offline state so the banner stays in sync if it's flipped from the
  // self-test panel.
  useEffect(() => {
    const id = setInterval(() => {
      void api.offline.get().then(setIsOffline);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  // ESC during a bbox draw cancels and resolves the request with null.
  // Kept as a useEffect so it auto-cleans when drawingBbox flips false,
  // regardless of which exit path the user took (Use this area / Cancel
  // button / ESC). Without the effect cleanup, banner-driven exits would
  // leak the listener.
  useEffect(() => {
    if (!drawingBbox) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      drawCleanupRef.current?.();
      drawCleanupRef.current = null;
      const r = drawResolverRef.current;
      drawResolverRef.current = null;
      setDrawingBbox(false);
      setPendingBbox(null);
      r?.(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawingBbox]);

  // Subscribe to pack-build progress at the App level so the modal can be
  // unmounted without losing the connection. Filter by the currently
  // tracked buildId; the main process may emit for stale builds in theory
  // but in practice only ours is live.
  useEffect(() => {
    const off = api.packBuilder.onProgress((p) => {
      if (p.buildId !== buildId) return;
      setBuildProgress(p);
      if (p.phase === 'done' && p.manifestId) {
        setJustInstalledId(p.manifestId);
      } else if (p.phase === 'failed') {
        setBuildError(p.error ?? p.message);
      }
    });
    return off;
  }, [buildId]);

  async function startBuild(req: StartBuildRequest): Promise<void> {
    setBuildError(null);
    try {
      const { buildId: bId } = await api.packBuilder.start(req);
      setBuildId(bId);
      setBuildProgress({ buildId: bId, phase: 'starting', message: 'Starting…' });
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  }

  async function cancelBuild(): Promise<void> {
    if (!buildId) return;
    await api.packBuilder.cancel(buildId);
  }

  function clearBuild(): void {
    setBuildId(null);
    setBuildProgress(null);
    setBuildError(null);
  }

  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setClickHandler(async ({ lat, lon }) => {
      if (picking === 'start') {
        setStart({ lat, lon });
        setPicking(null);
      } else if (picking === 'end') {
        setEnd({ lat, lon });
        setPicking(null);
      } else {
        // No picking active — show reverse-geocode info as a map popup
        // at the clicked location. The popup auto-closes on the next
        // map click (closeOnClick), and `null` clears any prior popup
        // when reverse returns nothing.
        const r = await api.geocode.reverse(lat, lon, { maxRadiusM: 500 });
        mapRef.current?.showReverseInfo(r ? { lat, lon, ...r } : null);
      }
    });
  }, [picking]);

  return (
    <div
      className={`app theme-${theme}${sidebarOpen ? '' : ' sidebar-collapsed'}`}
    >
      {sidebarOpen ? null : (
        <button
          className="sidebar-expand"
          onClick={() => setSidebarOpen(true)}
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          ›
        </button>
      )}
      <div className="sidebar" style={sidebarOpen ? {} : { display: 'none' }}>
        <div className="sidebar-header">
          <span style={{ fontSize: 13, fontWeight: 600 }}>OpenMaps</span>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(false)}
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            ‹
          </button>
        </div>
        {isOffline ? (
          <div className="banner offline">Network disabled. Verifying offline-only.</div>
        ) : null}
        <PackPicker
          current={manifest}
          onOpened={(m) => {
            setManifest(m);
            setStart(null);
            setEnd(null);
            mapRef.current?.showReverseInfo(null);
            // Fit the pack's bbox on open so the user sees the whole region.
            setTimeout(() => mapRef.current?.fitBbox(m.bbox), 100);
          }}
          onClosed={() => {
            setManifest(null);
            setStart(null);
            setEnd(null);
            mapRef.current?.showReverseInfo(null);
          }}
          onAddRegion={() => setShowAddRegion(true)}
          justInstalledId={justInstalledId}
          onJustInstalledHandled={() => setJustInstalledId(null)}
        />
        {manifest ? (
          <>
            <SearchBar
              onSelect={(r) => {
                mapRef.current?.centerOn(r.lat, r.lon, 13);
                mapRef.current?.setMarker(r.displayName, r.lat, r.lon);
              }}
            />
            <RoutePanel
              start={start}
              end={end}
              picking={picking}
              onPickWaypoint={(w) => setPicking(picking === w ? null : w)}
              onRoute={(r: RouteResult | null) => mapRef.current?.setRoute(r)}
            />
            <div className="panel" style={{ paddingBottom: 8 }}>
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                }}
                aria-expanded={settingsOpen}
              >
                <span
                  style={{
                    fontSize: 13,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontWeight: 600,
                  }}
                  className="settings-label"
                >
                  Settings
                </span>
                <span style={{ opacity: 0.7 }}>{settingsOpen ? '▾' : '▸'}</span>
              </button>
            </div>
            {settingsOpen ? (
              <>
                <MapStylePanel
                  theme={theme}
                  onThemeChange={setTheme}
                  toggles={toggles}
                  onTogglesChange={setToggles}
                />
                <SelfTestPanel />
              </>
            ) : null}
          </>
        ) : null}
      </div>
      <div className={`map-pane${picking || drawingBbox ? ' crosshair' : ''}`}>
        {picking ? (
          <div className="banner">Click on the map to set {picking === 'start' ? 'A' : 'B'}.</div>
        ) : null}
        {drawingBbox ? (
          pendingBbox ? (
            <div className="banner" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>
                Use this area ({formatArea(bboxAreaSqKm(pendingBbox))})? Drag again
                to redraw, or press ESC to cancel.
                {bboxAreaSqKm(pendingBbox) > 10000 ? (
                  <span style={{ color: '#a32f25', display: 'block', fontSize: 12 }}>
                    Large area — Overpass may time out. Consider a Country preset instead.
                  </span>
                ) : null}
              </span>
              <button
                className="primary"
                onClick={() => {
                  drawCleanupRef.current?.();
                  drawCleanupRef.current = null;
                  const r = drawResolverRef.current;
                  drawResolverRef.current = null;
                  setDrawingBbox(false);
                  const bbox = pendingBbox;
                  setPendingBbox(null);
                  r?.(bbox);
                }}
              >
                Use this area
              </button>
              <button
                onClick={() => {
                  drawCleanupRef.current?.();
                  drawCleanupRef.current = null;
                  const r = drawResolverRef.current;
                  drawResolverRef.current = null;
                  setDrawingBbox(false);
                  setPendingBbox(null);
                  r?.(null);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="banner">
              Click-and-drag on the map to draw a rectangle around the area you want offline.
            </div>
          )
        ) : null}
        <MapView ref={mapRef} manifest={manifest} theme={theme} toggles={toggles} />
        {manifest ? (
          <button
            className="fit-pack-btn"
            onClick={() => mapRef.current?.fitBbox(manifest.bbox)}
            title={`Fit to ${manifest.name}`}
            aria-label="Fit to pack"
          >
            ⤧
          </button>
        ) : null}
        {!manifest ? (
          <div className="empty-state">
            <div className="empty-state-card">
              <div style={{ fontSize: 28, marginBottom: 8 }}>🗺️</div>
              <h2 style={{ margin: '0 0 6px 0', fontSize: 18 }}>No region loaded</h2>
              <p style={{ margin: '0 0 12px 0', fontSize: 13, lineHeight: 1.4 }}>
                Pick a region from the sidebar to load offline tiles, search, and
                routing — or add a new one.
              </p>
              <button className="primary" onClick={() => setShowAddRegion(true)}>
                + Add region…
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {/* When the modal is closed, show a compact floating chip so the
          user can monitor and re-open the modal. Failures/cancellations
          persist with a dismiss button so closing the modal doesn't hide
          an error the user might miss. */}
      {!showAddRegion && buildProgress && buildProgress.phase !== 'done' ? (
        (() => {
          const phase = buildProgress.phase;
          const isFail = phase === 'failed';
          const isCancel = phase === 'cancelled';
          const isTerminal = isFail || isCancel;
          const variant = isFail ? 'fail' : isCancel ? 'cancel' : 'progress';
          const label = isFail
            ? 'Build failed'
            : isCancel
              ? 'Build cancelled'
              : `Building… ${phase}`;
          return (
            <div className={`build-chip build-chip-${variant}`}>
              <button
                className="build-chip-main"
                onClick={() => setShowAddRegion(true)}
                title="Open build status"
              >
                {label}
              </button>
              {isTerminal ? (
                <button
                  className="build-chip-dismiss"
                  onClick={clearBuild}
                  title="Dismiss"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              ) : null}
            </div>
          );
        })()
      ) : null}
      {showAddRegion && !drawingBbox ? (
        <AddRegionModal
          onClose={() => {
            setShowAddRegion(false);
            // If the build already finished (done/failed/cancelled), clear
            // it so the chip doesn't linger. Mid-build closes keep the chip.
            if (buildProgress && TERMINAL_BUILD_PHASES.has(buildProgress.phase)) {
              clearBuild();
            }
          }}
          progress={buildProgress}
          error={buildError}
          onClearError={() => setBuildError(null)}
          onReportError={setBuildError}
          onStart={startBuild}
          onCancel={cancelBuild}
          requestDrawBbox={() =>
            new Promise<[number, number, number, number] | null>((resolve) => {
              if (!mapRef.current) return resolve(null);
              setDrawingBbox(true);
              setPendingBbox(null);
              drawResolverRef.current = resolve;
              // The map fires onComplete on every mouseup; we just stage
              // the latest bbox. The user confirms via the banner button.
              const cleanup = mapRef.current.startBboxDraw((bbox) => {
                setPendingBbox(bbox);
              });
              drawCleanupRef.current = cleanup;
              // ESC handler is registered in a useEffect tied to
              // drawingBbox, so it can't leak past this draw session.
            })
          }
        />
      ) : null}
    </div>
  );
}
