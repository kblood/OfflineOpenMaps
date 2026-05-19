import { useState } from 'react';
import type { SelfTestReport, CheckId } from '@openmaps/core';
import { api } from './openmapsApi.js';

/**
 * The one-click "Go Offline & Self-Test" experience. This is the user-visible
 * proof that v2 actually works offline. If anything turns red, that's a bug —
 * v2 doesn't have a "well, fall back to online" path.
 *
 * Sequence:
 *   1. flip the BrowserWindow's session into offline mode (no fetch, no DNS)
 *   2. call runSelfTest() in the main process
 *   3. show the per-check results
 *   4. restore online mode
 */
const CHECK_NAMES: Record<CheckId, string> = {
  tiles: 'Map tiles render',
  search: 'Search returns results',
  reverse: 'Reverse geocode finds a road',
  route: 'Routing computes a real path',
};

export function SelfTestPanel(): JSX.Element {
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(): Promise<void> {
    setRunning(true);
    setError(null);
    setReport(null);
    let wentOffline = false;
    try {
      await api.offline.set(true);
      wentOffline = true;
      const r = await api.selftest.run();
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (wentOffline) await api.offline.set(false);
      setRunning(false);
    }
  }

  return (
    <div className="panel">
      <h3>Offline self-test</h3>
      <p style={{ fontSize: 12, color: '#555', margin: '0 0 8px 0' }}>
        Cuts the network and verifies tiles, search, reverse, and routing all
        work from the local pack. Takes a few seconds.
      </p>
      <button
        className={report?.allPassed ? 'primary' : 'danger'}
        onClick={() => void go()}
        disabled={running}
        style={{ width: '100%' }}
      >
        {running ? 'Running…' : 'Go offline & self-test'}
      </button>
      {error ? (
        <div style={{ marginTop: 8, fontSize: 12, color: '#a32f25' }}>{error}</div>
      ) : null}
      {report ? (
        <div style={{ marginTop: 10 }}>
          <div className="selftest-grid">
            {report.results.map((r) => (
              <RowsFragment
                key={r.id}
                status={r.status}
                name={CHECK_NAMES[r.id]}
                summary={r.summary}
                ms={r.ms}
              />
            ))}
          </div>
          <div
            style={{
              marginTop: 10,
              padding: '6px 8px',
              borderRadius: 4,
              background: report.allPassed ? '#e0f4e3' : '#fde2e2',
              color: report.allPassed ? '#1e6a2a' : '#6a1c1c',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {report.allPassed ? '✓ Fully offline.' : '✗ Offline guarantees broken.'}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RowsFragment(props: {
  status: 'pass' | 'fail' | 'skip';
  name: string;
  summary: string;
  ms: number;
}): JSX.Element {
  return (
    <>
      <div>
        <div className={`selftest-status ${props.status}`} />
      </div>
      <div className={`selftest-row ${props.status}`}>{props.name}</div>
      <div style={{ textAlign: 'right', color: '#888' }}>{props.ms}ms</div>
      <div className="selftest-summary">{props.summary}</div>
    </>
  );
}
