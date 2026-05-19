import { useState } from 'react';
import type { Profile, RouteResult } from '@openmaps/core';
import { api } from './openmapsApi.js';

interface Props {
  start: { lat: number; lon: number } | null;
  end: { lat: number; lon: number } | null;
  /** Which waypoint (if any) is currently armed for click-to-set. */
  picking: 'start' | 'end' | null;
  onRoute(route: RouteResult | null): void;
  onPickWaypoint(which: 'start' | 'end'): void;
}

export function RoutePanel({ start, end, picking, onRoute, onPickWaypoint }: Props): JSX.Element {
  const [profile, setProfile] = useState<Profile>('car');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteResult | null>(null);

  async function compute(): Promise<void> {
    if (!start || !end) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.route.compute([start, end], profile);
      setResult(r);
      onRoute(r);
    } catch (e) {
      // Honest error: no fake fallback. This is the v2 principle in action.
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      onRoute(null);
    } finally {
      setBusy(false);
    }
  }

  // Tutorial-style hint only appears while waypoints are missing. Once
  // both are set, the user knows the flow — drop the hint to reduce noise.
  const hint = !start
    ? 'Pick A on the map, then B, then choose a profile and find the route.'
    : !end
      ? 'Now pick B on the map.'
      : null;

  return (
    <div className="panel">
      <h3>Route</h3>
      {hint ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{hint}</div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        <button
          className={picking === 'start' ? 'primary' : ''}
          onClick={() => onPickWaypoint('start')}
        >
          A:{' '}
          {picking === 'start'
            ? 'click on the map…'
            : start
              ? `${start.lat.toFixed(4)}, ${start.lon.toFixed(4)}`
              : 'click map…'}
        </button>
        <button
          className={picking === 'end' ? 'primary' : ''}
          onClick={() => onPickWaypoint('end')}
        >
          B:{' '}
          {picking === 'end'
            ? 'click on the map…'
            : end
              ? `${end.lat.toFixed(4)}, ${end.lon.toFixed(4)}`
              : 'click map…'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {(['car', 'bike', 'foot'] as Profile[]).map((p) => (
          <button
            key={p}
            className={profile === p ? 'primary' : ''}
            onClick={() => setProfile(p)}
            style={{ flex: 1 }}
            title={
              p === 'car'
                ? 'Routes by drivable roads (no footways, no motorway shoulders)'
                : p === 'bike'
                  ? 'Routes by bike-allowed ways (includes cycleways, excludes motorways)'
                  : 'Walking: includes footways, paths, pedestrian streets, steps'
            }
          >
            {p}
          </button>
        ))}
      </div>
      <button
        className="primary"
        onClick={() => void compute()}
        disabled={!start || !end || busy}
        style={{ width: '100%' }}
      >
        {busy ? 'Routing…' : 'Find route'}
      </button>
      {error ? (
        <div style={{ marginTop: 8, fontSize: 12, color: '#a32f25' }}>{error}</div>
      ) : null}
      {result ? (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <strong>{(result.distanceM / 1000).toFixed(2)} km</strong> · about{' '}
          {Math.round(result.durationS / 60)} min · {result.steps.length} steps · engine:{' '}
          {result.engine}
          <ol
            style={{
              marginTop: 8,
              paddingLeft: 20,
              maxHeight: 280,
              overflowY: 'auto',
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {result.steps.map((s, i) => (
              <li
                key={i}
                style={{
                  marginBottom: 4,
                  color: s.maneuver === 'depart' || s.maneuver === 'arrive' ? '#2566e6' : '#222',
                }}
              >
                <span style={{ display: 'inline-block', width: 18, textAlign: 'center' }}>
                  {maneuverIcon(s.maneuver)}
                </span>
                {s.instruction}
                {s.distanceM > 0 ? (
                  <span style={{ color: '#666' }}>
                    {' '}
                    · {formatDist(s.distanceM)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

// All icons are picked from the same Unicode Arrows block so they render
// at consistent sizes/weights across the platform fonts. Avoid mixing in
// glyphs from Dingbats / Geometric Shapes — they look mismatched at 12px.
function maneuverIcon(m: string): string {
  switch (m) {
    case 'depart': return '↑';
    case 'arrive': return '◉';
    case 'turn-left':
    case 'turn-slight-left':
    case 'turn-sharp-left': return '←';
    case 'turn-right':
    case 'turn-slight-right':
    case 'turn-sharp-right': return '→';
    case 'uturn': return '↺';
    case 'roundabout': return '↻';
    case 'merge': return '↗';
    default: return '↑';
  }
}

function formatDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}
