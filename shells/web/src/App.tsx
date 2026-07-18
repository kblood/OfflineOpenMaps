import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegionManifest, ReverseResult, SearchResult, RouteResult } from '@openmaps/core';
import { MapView, type MapViewHandle } from './MapView.js';
import { SearchBar } from './SearchBar.js';
import { RoutePanel } from './RoutePanel.js';
import { MapStylePanel } from './MapStylePanel.js';
import {
  api,
  loadPackFromDirectory,
  loadPackFromUrl,
  fetchAvailablePacks,
  getPackStorageEstimate,
  type RemotePackEntry,
  type RemotePackCollection,
  type PackDownloadProgress,
} from './openmapsApi.js';
import { DEFAULT_LAYER_TOGGLES, type LayerToggles, type MapTheme } from './buildMapStyle.js';

/**
 * Web shell App. Two ways to load a pack:
 *   1. Download a pre-built pack from the same server (./packs/packs.json
 *      lists what's available).
 *   2. Pick a local folder containing manifest.json + tiles.mbtiles +
 *      geocode.sqlite (useful when you've just built one with the
 *      Electron shell or the CLI and want to test it).
 *
 * No in-app pack builder — Overpass and Geofabrik are CORS-blocked from
 * the browser. Build with the Electron app, then either point this
 * shell at the local folder or republish to the cloud.
 */
export function App(): JSX.Element {
  const [manifest, setManifest] = useState<RegionManifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remotePacks, setRemotePacks] = useState<RemotePackEntry[]>([]);
  const [remoteCollections, setRemoteCollections] = useState<RemotePackCollection[]>([]);
  const [installedPacks, setInstalledPacks] = useState<RegionManifest[]>([]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState<PackDownloadProgress | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [theme, setTheme] = useState<MapTheme>('default');
  const [toggles, setToggles] = useState<LayerToggles>(DEFAULT_LAYER_TOGGLES);
  const [start, setStart] = useState<{ lat: number; lon: number } | null>(null);
  const [end, setEnd] = useState<{ lat: number; lon: number } | null>(null);
  const [startAddress, setStartAddress] = useState<string | null>(null);
  const [endAddress, setEndAddress] = useState<string | null>(null);
  const [picking, setPicking] = useState<'start' | 'end' | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const mapRef = useRef<MapViewHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshInstalledPacks = useCallback(async () => {
    const [packs, estimate] = await Promise.all([api.packs.list(), getPackStorageEstimate()]);
    setInstalledPacks(packs);
    setStorage(estimate);
  }, []);

  // Fetch the catalog once on mount. Empty list (or 404) is treated as
  // "no remote packs hosted yet" — the local folder loader still works.
  useEffect(() => {
    void fetchAvailablePacks()
      .then((catalog) => {
        setRemotePacks(catalog.packs);
        setRemoteCollections(catalog.collections);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('[openmaps] pack catalog fetch failed:', e);
      });
    void refreshInstalledPacks();
  }, [refreshInstalledPacks]);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  const downloadPack = useCallback(async (entry: RemotePackEntry) => {
    setLoadError(null);
    setDownloading(entry.id);
    setProgress(null);
    try {
      // The base URL in packs.json is relative to ./packs/.
      const m = await loadPackFromUrl(`./packs/${entry.baseUrl}`, (p) => setProgress(p));
      setManifest(m);
      setStart(null);
      setEnd(null);
      setStartAddress(null);
      setEndAddress(null);
      setPicking(null);
      await refreshInstalledPacks();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
      setProgress(null);
    }
  }, [refreshInstalledPacks]);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoadError(null);
    setLoadingLocal(true);
    try {
      const m = await loadPackFromDirectory(files);
      setManifest(m);
      setStart(null);
      setEnd(null);
      setStartAddress(null);
      setEndAddress(null);
      setPicking(null);
      await refreshInstalledPacks();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingLocal(false);
    }
  }, [refreshInstalledPacks]);

  // Resolve start/end to display addresses whenever the coordinates change.
  // Effect-ignored stale results: if the user double-picks rapidly we may
  // get reverse responses out of order — the latest setter call wins, but
  // the second-to-last response could land after it. We guard with a
  // `cancelled` flag so a stale response can't overwrite the live one.
  useEffect(() => {
    if (!start) {
      setStartAddress(null);
      return;
    }
    let cancelled = false;
    setStartAddress(null);
    // preferRoads=false → favour house numbers over the nearest street.
    // 150 m radius because DAWA addresses sit at the road-entry adgangspunkt,
    // which can be ~30 m from where a user actually tapped on the building.
    void api.geocode
      .reverse(start.lat, start.lon, { maxRadiusM: 150, preferRoads: false })
      .then((r) => {
        if (cancelled) return;
        setStartAddress(r ? r.displayName : 'no nearby address');
      });
    return () => {
      cancelled = true;
    };
  }, [start]);
  useEffect(() => {
    if (!end) {
      setEndAddress(null);
      return;
    }
    let cancelled = false;
    setEndAddress(null);
    void api.geocode
      .reverse(end.lat, end.lon, { maxRadiusM: 150, preferRoads: false })
      .then((r) => {
        if (cancelled) return;
        setEndAddress(r ? r.displayName : 'no nearby address');
      });
    return () => {
      cancelled = true;
    };
  }, [end]);

  // Click waypoints from the map. Click → reverse-geocode → popup +
  // store lat/lon, then disarm.
  useEffect(() => {
    if (!mapRef.current) return;
    if (!picking) {
      mapRef.current.setClickHandler(null);
      return;
    }
    mapRef.current.setClickHandler(({ lat, lon }) => {
      if (picking === 'start') setStart({ lat, lon });
      else setEnd({ lat, lon });
      setPicking(null);
      void api.geocode.reverse(lat, lon, { maxRadiusM: 80 }).then((r: ReverseResult | null) => {
        if (!r) return;
        mapRef.current?.showReverseInfo({
          lat,
          lon,
          displayName: r.displayName,
          kind: r.kind,
          distanceM: r.distanceM,
        });
      });
    });
  }, [picking, manifest]);

  const onSearchSelect = useCallback((result: SearchResult) => {
    // Close the drawer on mobile so the user can see the result on the map.
    // No-op on desktop where the sidebar isn't an overlay.
    setSidebarOpen(false);
    mapRef.current?.centerOn(result.lat, result.lon, 17);
    mapRef.current?.setMarker(result.displayName, result.lat, result.lon);
    // Address result with a DAWA parcel reference → fetch + highlight the
    // matrikel polygon so the user can see whether the pin is on the right
    // plot. Other result kinds clear any previous parcel highlight.
    if (result.parcelId) {
      void api.geocode.getParcel(result.parcelId).then((parcel) => {
        if (parcel) mapRef.current?.setParcel(parcel.rings);
        else mapRef.current?.setParcel(null);
      });
    } else {
      mapRef.current?.setParcel(null);
    }
  }, []);

  const onRouteComputed = useCallback((r: RouteResult | null) => {
    mapRef.current?.setRoute(r);
  }, []);

  return (
    <div className={`app theme-${theme}${sidebarOpen ? ' sidebar-open' : ''}`}>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={sidebarOpen}
        onClick={() => setSidebarOpen((v) => !v)}
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>
      <div
        className="sidebar-backdrop"
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside className="sidebar">
        <div className="sidebar-header">
          <strong>OpenMaps v2</strong>
          <span className="badge">web</span>
          <span className={`connection-status ${online ? 'online' : 'offline'}`}>
            {online ? 'online' : 'offline'}
          </span>
        </div>

        <div className="panel">
          <h3>Pack</h3>
          {manifest ? (
            <>
              <div style={{ fontSize: 13 }}>
                <strong>{manifest.name}</strong>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {manifest.id} · {manifest.country}
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  onClick={() => mapRef.current?.fitBbox(manifest.bbox)}
                  title="Zoom to pack bounds"
                >
                  Fit
                </button>
                <button
                  onClick={() => {
                    void api.packs.close().then(() => setManifest(null));
                  }}
                >
                  Close
                </button>
              </div>
            </>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0 }}>
              Pick a pack to load. Either download one from the catalog
              below or open a local pack folder you built yourself.
            </p>
          )}

          {remoteCollections.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                Country coverage
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {remoteCollections.map((collection) => {
                  const members = collection.members
                    .map((id) => remotePacks.find((pack) => pack.id === id))
                    .filter((pack): pack is RemotePackEntry => Boolean(pack));
                  return (
                    <div key={collection.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 7 }}>
                      <strong style={{ fontSize: 13 }}>{collection.name}</strong>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                        {collection.description}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
                        Choose a region to download. Search and routing work inside the open region; neighbouring regions overlap at their edges.
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                        {members.map((pack) => (
                          <button
                            key={pack.id}
                            onClick={() => void downloadPack(pack)}
                            disabled={downloading !== null}
                            style={{ textAlign: 'left' }}
                            title={`${pack.country} · bbox ${pack.bbox.map((n) => n.toFixed(3)).join(', ')}`}
                          >
                            {pack.name} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({formatBytes(pack.totalBytes)})</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {remotePacks.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                {manifest ? 'Switch to another pack' : 'Download a pack'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {remotePacks.filter((p) => !remoteCollections.some((c) => c.members.includes(p.id))).map((p) => {
                  const isThis = downloading === p.id;
                  const pct =
                    isThis && progress && progress.bytesTotal > 0
                      ? Math.min(
                          100,
                          Math.round((progress.bytesReceived / progress.bytesTotal) * 100),
                        )
                      : null;
                  return (
                    <button
                      key={p.id}
                      onClick={() => void downloadPack(p)}
                      disabled={downloading !== null}
                      style={{ textAlign: 'left' }}
                      title={`${p.country} · bbox ${p.bbox.map((n) => n.toFixed(3)).join(', ')}`}
                    >
                      <div>
                        {p.name}{' '}
                        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                          ({formatBytes(p.totalBytes)})
                        </span>
                      </div>
                      {isThis ? (
                        <div style={{ marginTop: 6 }}>
                          <div className="progress">
                            <div
                              className="progress-bar"
                              style={{ width: pct != null ? `${pct}%` : '40%' }}
                            />
                          </div>
                          <div
                            style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}
                          >
                            {progress
                              ? `${progress.step}: ${formatBytes(progress.bytesReceived)}${
                                  progress.bytesTotal > 0
                                    ? ' / ' + formatBytes(progress.bytesTotal)
                                    : ''
                                }`
                              : 'starting…'}
                          </div>
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {installedPacks.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                Installed packs{storage ? ` · ${formatBytes(storage.usage)} used` : ''}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {installedPacks.map((pack) => (
                  <div key={pack.id} style={{ display: 'flex', gap: 4 }}>
                    <button
                      style={{ textAlign: 'left', flex: 1 }}
                      onClick={() => {
                        void api.packs.open(pack.id).then((opened) => {
                          setManifest(opened);
                          setLoadError(null);
                          setSidebarOpen(false);
                        }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
                      }}
                    >
                      {pack.name} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({pack.country})</span>
                    </button>
                    <button
                      aria-label={`Remove ${pack.name}`}
                      title={`Remove ${pack.name}`}
                      onClick={() => {
                        if (!window.confirm(`Remove downloaded pack '${pack.name}'?`)) return;
                        void api.packs.uninstall(pack.id).then(() => {
                          if (manifest?.id === pack.id) setManifest(null);
                          return refreshInstalledPacks();
                        }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
              {manifest ? 'Or load a different local pack folder' : 'Or open a local pack folder'}
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loadingLocal || downloading !== null}
            >
              {loadingLocal ? 'Loading pack…' : 'Choose pack folder…'}
            </button>
          </div>

          {loadError ? (
            <div style={{ marginTop: 8, fontSize: 12, color: '#d8443a' }}>{loadError}</div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            // @ts-expect-error — webkitdirectory is a non-standard but widely supported attribute
            webkitdirectory=""
            directory=""
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {manifest ? (
          <>
            <SearchBar onSelect={onSearchSelect} />
            <RoutePanel
              start={start}
              end={end}
              startAddress={startAddress}
              endAddress={endAddress}
              picking={picking}
              onRoute={onRouteComputed}
              onPickWaypoint={(which) =>
                setPicking((cur) => {
                  const next = cur === which ? null : which;
                  // Arming a pick → close the drawer so the user can tap the map.
                  if (next !== null) setSidebarOpen(false);
                  return next;
                })
              }
            />
            <MapStylePanel
              theme={theme}
              onThemeChange={setTheme}
              toggles={toggles}
              onTogglesChange={setToggles}
            />
          </>
        ) : null}

        <div className="footer">
          Downloaded packs persist in this browser and are checksum-verified
          before opening. The app shell is available after an offline reload.
        </div>
      </aside>
      <main className={`map-pane${picking ? ' crosshair' : ''}`}>
        {manifest ? (
          <MapView ref={mapRef} manifest={manifest} theme={theme} toggles={toggles} />
        ) : (
          <div className="empty-state">
            <h2>Welcome to OpenMaps v2 — Web</h2>
            <p>Pick a pack from the sidebar to load the map.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
