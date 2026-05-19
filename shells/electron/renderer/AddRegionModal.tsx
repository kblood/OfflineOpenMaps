import { useEffect, useMemo, useState } from 'react';
import { api } from './openmapsApi.js';
import type {
  GeofabrikCountryDTO,
  PackBuildProgress,
  StartBuildRequest,
} from './openmapsApi.js';

interface Props {
  onClose(): void;
  /**
   * Called when the user wants to draw a bbox on the map. The parent
   * (App) is responsible for hiding the modal during the draw and
   * resolving with the chosen bbox or `null` if cancelled.
   */
  requestDrawBbox(): Promise<[number, number, number, number] | null>;
  /** Latest build progress event, or `null` if no build is active. */
  progress: PackBuildProgress | null;
  /** Most recent error to display, or `null` for none. */
  error: string | null;
  /** Clear the displayed error. */
  onClearError(): void;
  /** Report a new error (e.g. local form validation). */
  onReportError(msg: string): void;
  /** Kick off a build. Resolves once the IPC `start` call returns. */
  onStart(req: StartBuildRequest): Promise<void>;
  /** Cancel the active build (no-op if none). */
  onCancel(): Promise<void>;
}

type Tab = 'custom' | 'country';

/**
 * Modal for in-app pack construction. Has two tabs:
 *   - Custom: pick a bbox (drag on the map, or type coordinates) and
 *     fetch the area from Overpass.
 *   - Country: pick from a curated Geofabrik list and download the
 *     country-scale PBF.
 *
 * The same lower half (progress + cancel) handles both flows because
 * the IPC contract is shared.
 */
export function AddRegionModal({
  onClose,
  requestDrawBbox,
  progress,
  error,
  onClearError,
  onReportError,
  onStart,
  onCancel,
}: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('custom');
  const [countries, setCountries] = useState<GeofabrikCountryDTO[]>([]);
  const [countryFilter, setCountryFilter] = useState('');
  const [selectedCountryId, setSelectedCountryId] = useState<string | null>(null);

  // Custom-area form state.
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  const [bboxText, setBboxText] = useState<string>('');
  const [packId, setPackId] = useState('');
  const [packName, setPackName] = useState('');
  const [country, setCountry] = useState('XX');

  // Load Geofabrik list lazily — countries() is a static JSON returned by
  // the main process, so it's cheap, but we still don't need it until the
  // user clicks the Country tab.
  useEffect(() => {
    if (tab !== 'country' || countries.length > 0) return;
    void api.packBuilder.countries().then(setCountries);
  }, [tab, countries.length]);

  // Keep the bbox text field in sync when the user draws on the map.
  useEffect(() => {
    if (bbox) {
      setBboxText(bbox.map((n) => n.toFixed(4)).join(', '));
    }
  }, [bbox]);

  function parseBboxText(s: string): [number, number, number, number] | null {
    const parts = s.split(/[\s,]+/).map((p) => Number(p.trim())).filter((n) => Number.isFinite(n));
    if (parts.length !== 4) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    // Accept either (minLon,minLat,maxLon,maxLat) or wrong-order; normalize.
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }

  async function startCustom(): Promise<void> {
    const parsed = parseBboxText(bboxText) ?? bbox;
    if (!parsed) {
      onReportError('Set a bounding box first (drag on the map or paste coordinates).');
      return;
    }
    const id = packId.trim() || suggestId(packName || 'custom');
    if (!/^[a-z0-9-]+$/.test(id)) {
      onReportError('Pack id must be lowercase letters, digits, and dashes only.');
      return;
    }
    onClearError();
    await onStart({
      kind: 'overpass',
      packId: id,
      packName: packName.trim() || id,
      country: (country || 'XX').toUpperCase().slice(0, 2),
      bbox: parsed,
    });
  }

  async function startCountry(): Promise<void> {
    if (!selectedCountryId) {
      onReportError('Pick a country from the list.');
      return;
    }
    onClearError();
    await onStart({ kind: 'geofabrik', countryId: selectedCountryId });
  }

  async function drawOnMap(): Promise<void> {
    // Hide the modal visually while the user draws. The parent handles
    // un-hiding via the requestDrawBbox callback.
    const result = await requestDrawBbox();
    if (result) setBbox(result);
  }

  const filteredCountries = useMemo(() => {
    const q = countryFilter.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(
      (c) => c.name.toLowerCase().includes(q) || c.iso.toLowerCase().includes(q),
    );
  }, [countries, countryFilter]);

  // Group the (filtered) list by continent so the user can scan
  // regionally. Europe first because the bundled Aalborg pack and most
  // initial users live there; the rest follow in a consistent order.
  const groupedCountries = useMemo(() => {
    const byContinent = new Map<GeofabrikCountryDTO['continent'], GeofabrikCountryDTO[]>();
    for (const c of filteredCountries) {
      const list = byContinent.get(c.continent) ?? [];
      list.push(c);
      byContinent.set(c.continent, list);
    }
    return CONTINENT_ORDER
      .map((cont) => ({ continent: cont, countries: byContinent.get(cont) ?? [] }))
      .filter((g) => g.countries.length > 0);
  }, [filteredCountries]);

  const isRunning =
    !!progress && !(TERMINAL_PHASES as readonly string[]).includes(progress.phase);
  const isFinished = !!progress && progress.phase === 'done';
  const pct =
    progress?.bytesDownloaded != null && progress.bytesTotal
      ? Math.min(100, (progress.bytesDownloaded / progress.bytesTotal) * 100)
      : null;

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-header">
          <span>Add a region</span>
          <button onClick={onClose} disabled={isRunning} title="Close" aria-label="Close">
            ✕
          </button>
        </div>

        {!isRunning && !isFinished ? (
          <div className="modal-body">
            <div className="modal-tabs">
              <button
                className={tab === 'custom' ? 'primary' : ''}
                onClick={() => setTab('custom')}
              >
                Custom area
              </button>
              <button
                className={tab === 'country' ? 'primary' : ''}
                onClick={() => setTab('country')}
              >
                Country
              </button>
            </div>

            {tab === 'custom' ? (
              <>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Pick a bounding box for the area you want offline. Smaller is faster
                  and uses less disk; a typical city fits in ~10 MB.
                </div>
                <label>
                  Bounding box
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={bboxText}
                      onChange={(e) => setBboxText(e.target.value)}
                      placeholder="minLon, minLat, maxLon, maxLat"
                      style={{ flex: 1 }}
                    />
                    <button onClick={() => void drawOnMap()} title="Drag a rectangle on the map">
                      Draw…
                    </button>
                  </div>
                </label>
                <label>
                  Pack id
                  <input
                    type="text"
                    value={packId}
                    onChange={(e) => setPackId(e.target.value.toLowerCase())}
                    placeholder="e.g. amsterdam"
                  />
                </label>
                <label>
                  Display name
                  <input
                    type="text"
                    value={packName}
                    onChange={(e) => setPackName(e.target.value)}
                    placeholder="e.g. Amsterdam"
                  />
                </label>
                <label>
                  Country code
                  <input
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
                    placeholder="NL"
                    style={{ width: 60 }}
                  />
                </label>
                <button className="primary" onClick={() => void startCustom()}>
                  Download &amp; build
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Whole-country downloads from Geofabrik. Sizes shown are approximate;
                  building a country pack takes 1–5 minutes depending on size.
                </div>
                <input
                  type="text"
                  placeholder="Filter…"
                  value={countryFilter}
                  onChange={(e) => setCountryFilter(e.target.value)}
                />
                <div className="country-list">
                  {groupedCountries.length === 0 ? (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: '#888' }}>
                      No matches.
                    </div>
                  ) : null}
                  {groupedCountries.map((group) => (
                    <div key={group.continent}>
                      <div className="continent-header">{group.continent}</div>
                      {group.countries.map((c) => (
                        <label
                          key={c.id}
                          className={`country-row${selectedCountryId === c.id ? ' selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="country"
                            value={c.id}
                            checked={selectedCountryId === c.id}
                            onChange={() => setSelectedCountryId(c.id)}
                          />
                          <div style={{ flex: 1 }}>
                            <div>
                              {c.name} <span style={{ color: '#888' }}>({c.iso})</span>
                            </div>
                            <div style={{ fontSize: 11, color: '#888' }}>
                              ~{c.approxMb >= 1000 ? `${(c.approxMb / 1000).toFixed(1)} GB` : `${c.approxMb} MB`} download
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
                <button
                  className="primary"
                  onClick={() => void startCountry()}
                  disabled={!selectedCountryId}
                >
                  Download &amp; build
                </button>
              </>
            )}
            {error ? (
              <div style={{ fontSize: 12, color: '#a32f25' }}>{error}</div>
            ) : null}
          </div>
        ) : (
          <div className="modal-body">
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {progress?.phase === 'done'
                ? 'Done.'
                : progress?.phase === 'cancelled'
                  ? 'Cancelled.'
                  : progress?.phase === 'failed'
                    ? 'Failed.'
                    : phaseLabel(progress?.phase)}
            </div>
            <div style={{ fontSize: 12, color: '#444' }}>{progress?.message}</div>
            {pct != null ? (
              <div className="progress-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            {isRunning ? (
              <button onClick={() => void onCancel()}>Cancel</button>
            ) : (
              <button onClick={onClose}>Close</button>
            )}
            {error ? (
              <div style={{ fontSize: 12, color: '#a32f25' }}>{error}</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const TERMINAL_PHASES = ['done', 'cancelled', 'failed'] as const;

const CONTINENT_ORDER: ReadonlyArray<GeofabrikCountryDTO['continent']> = [
  'Europe',
  'North America',
  'South America',
  'Asia',
  'Africa',
  'Oceania',
];

function phaseLabel(phase: PackBuildProgress['phase'] | undefined): string {
  switch (phase) {
    case 'starting': return 'Starting…';
    case 'downloading': return 'Downloading';
    case 'parsing': return 'Parsing OSM data';
    case 'building-tiles': return 'Building vector tiles';
    case 'building-graph': return 'Building routing graph';
    case 'building-geocode': return 'Building search index';
    case 'writing-manifest': return 'Writing manifest';
    case 'installing': return 'Installing';
    default: return 'Working…';
  }
}

function suggestId(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

