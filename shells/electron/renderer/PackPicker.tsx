import { useEffect, useState } from 'react';
import type { RegionManifest } from '@openmaps/core';
import { api } from './openmapsApi.js';

interface Props {
  current: RegionManifest | null;
  onOpened(manifest: RegionManifest): void;
  onClosed?(): void;
  /** Trigger the parent's "Add region" modal. */
  onAddRegion(): void;
  /**
   * If set, the parent has just installed a pack with this id and wants
   * us to refresh the list. The PackPicker will refresh, highlight the
   * new pack, and clear the prompt by calling onJustInstalledHandled.
   */
  justInstalledId?: string | null;
  onJustInstalledHandled?(): void;
}

export function PackPicker({ current, onOpened, onClosed, onAddRegion, justInstalledId, onJustInstalledHandled }: Props): JSX.Element {
  const [installed, setInstalled] = useState<RegionManifest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const list = await api.packs.list();
      setInstalled(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // When a new pack arrives from the in-app builder, refresh and surface a
  // success message. The parent clears `justInstalledId` once we've shown it.
  useEffect(() => {
    if (!justInstalledId) return;
    setInfo(`Installed ${justInstalledId}. Click it to open.`);
    void refresh();
    onJustInstalledHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justInstalledId]);

  // Auto-open the only installed pack on first load. With the bundled
  // Aalborg pack seeded on first launch, the user otherwise has to
  // realise the row in the list is clickable — confusing first-run UX.
  useEffect(() => {
    if (autoOpened) return;
    if (current) return;
    if (installed.length !== 1) return;
    setAutoOpened(true);
    void pick(installed[0]!.id);
    // pick is stable enough — no need to depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed, current, autoOpened]);

  async function pick(packId: string): Promise<void> {
    setBusy(packId);
    setError(null);
    setInfo(null);
    try {
      const m = await api.packs.open(packId);
      onOpened(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function install(overwrite: boolean): Promise<void> {
    setBusy('__install__');
    setError(null);
    setInfo(null);
    try {
      const r = await api.packs.installFromDir({ overwrite });
      if (r.installed) {
        setInfo(`Installed: ${r.manifest.name} (${r.manifest.id})`);
        await refresh();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Surface the "already installed" case as a friendly prompt rather than
      // a generic error — give the user a one-click overwrite path.
      if (/already installed/i.test(msg) && !overwrite) {
        const yes = confirm(`${msg}\n\nReplace the existing pack?`);
        if (yes) {
          setBusy(null);
          return void install(true);
        }
      } else {
        setError(msg);
      }
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(packId: string, name: string): Promise<void> {
    if (!confirm(`Uninstall '${name}'? This deletes the pack files from disk.`)) return;
    setBusy(packId);
    setError(null);
    setInfo(null);
    try {
      await api.packs.uninstall(packId);
      if (current?.id === packId) onClosed?.();
      setInfo(`Uninstalled ${name}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h3>Region</h3>
      {installed.length === 0 ? (
        <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
          No packs installed. Build one with{' '}
          <code style={{ background: '#eee', padding: '0 4px' }}>
            region-builder build-osm --in &lt;file.osm&gt; --id &lt;id&gt; --out ./packs
          </code>{' '}
          or install one from a folder.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {!current ? (
            <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
              Click a pack to load it:
            </div>
          ) : null}
          {installed.map((m) => {
            const isOpen = current?.id === m.id;
            const [minLon, minLat, maxLon, maxLat] = m.bbox;
            return (
              <div key={m.id} style={{ display: 'flex', gap: 4 }}>
                <button
                  className={isOpen ? 'primary' : ''}
                  style={{ flex: 1, textAlign: 'left' }}
                  onClick={() => void pick(m.id)}
                  disabled={busy === m.id}
                  title={`${m.country} · bbox ${m.bbox.map((n) => n.toFixed(3)).join(', ')}`}
                >
                  <div>
                    {m.name} <span style={{ color: '#888' }}>({m.id})</span>
                    {isOpen ? <span style={{ color: '#2d6a4f' }}> · open</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {m.country} · {minLat.toFixed(3)}–{maxLat.toFixed(3)}°N,{' '}
                    {minLon.toFixed(3)}–{maxLon.toFixed(3)}°E
                  </div>
                </button>
                <button
                  onClick={() => void uninstall(m.id, m.name)}
                  disabled={busy === m.id}
                  title={`Uninstall ${m.name}`}
                  style={{ padding: '0 8px' }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="primary" onClick={onAddRegion}>
          + Add region…
        </button>
        <button onClick={() => void install(false)} disabled={busy === '__install__'}>
          {busy === '__install__' ? 'Installing…' : 'Install from folder…'}
        </button>
      </div>
      {info ? (
        <div style={{ marginTop: 8, fontSize: 12, color: '#2d6a4f' }}>{info}</div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 8, fontSize: 12, color: '#a32f25' }}>{error}</div>
      ) : null}
    </div>
  );
}
