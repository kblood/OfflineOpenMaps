import { MAP_THEMES } from './buildMapStyle.js';
import type { LayerToggles, MapTheme } from './buildMapStyle.js';

interface Props {
  theme: MapTheme;
  onThemeChange(theme: MapTheme): void;
  toggles: LayerToggles;
  onTogglesChange(toggles: LayerToggles): void;
}

/**
 * Compact panel that lets the user pick a theme (light/dark/mono) and
 * toggle the visibility of individual layer groups. Theme changes call
 * `map.setStyle()` under the hood; toggle changes feed into the same
 * style rebuild. Both are persisted by the parent into localStorage.
 */
export function MapStylePanel({ theme, onThemeChange, toggles, onTogglesChange }: Props): JSX.Element {
  return (
    <div className="panel">
      <h3>Map style</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {MAP_THEMES.map((t) => (
          <button
            key={t.id}
            className={theme === t.id ? 'primary' : ''}
            onClick={() => onThemeChange(t.id)}
            style={{ flex: 1 }}
            title={t.description}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Show layers</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <label>
          <input
            type="checkbox"
            checked={toggles.water}
            onChange={(e) => onTogglesChange({ ...toggles, water: e.target.checked })}
          />{' '}
          Water (lakes, fjords)
        </label>
        <label>
          <input
            type="checkbox"
            checked={toggles.roadLabels}
            onChange={(e) => onTogglesChange({ ...toggles, roadLabels: e.target.checked })}
          />{' '}
          Road names + numbers
        </label>
        <label>
          <input
            type="checkbox"
            checked={toggles.places}
            onChange={(e) => onTogglesChange({ ...toggles, places: e.target.checked })}
          />{' '}
          Place markers
        </label>
        <label>
          <input
            type="checkbox"
            checked={toggles.cyclePaths}
            onChange={(e) => onTogglesChange({ ...toggles, cyclePaths: e.target.checked })}
          />{' '}
          <span style={{ color: '#1e9eb3' }}>━ ━</span> Cycle paths
        </label>
        <label>
          <input
            type="checkbox"
            checked={toggles.footPaths}
            onChange={(e) => onTogglesChange({ ...toggles, footPaths: e.target.checked })}
          />{' '}
          <span style={{ color: '#c97894' }}>· · ·</span> Foot paths
        </label>
      </div>
    </div>
  );
}
