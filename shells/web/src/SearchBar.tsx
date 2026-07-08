import { useState } from 'react';
import type { SearchResult } from '@openmaps/core';
import { api } from './openmapsApi.js';

interface Props {
  onSelect(result: SearchResult): void;
}

export function SearchBar({ onSelect }: Props): JSX.Element {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  async function runSearch(query: string): Promise<void> {
    setSearching(true);
    try {
      const r = await api.geocode.search(query, { limit: 8 });
      setResults(r);
    } catch (e) {
      // Search must NOT throw on offline. If it does, that's a real bug —
      // print it so we see it during testing.
      // eslint-disable-next-line no-console
      console.error('search failed:', e);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="panel">
      <h3>Search</h3>
      <input
        type="text"
        value={q}
        placeholder="Place name…"
        onChange={(e) => {
          setQ(e.target.value);
          if (e.target.value.trim().length >= 2) {
            void runSearch(e.target.value);
          } else {
            setResults([]);
          }
        }}
      />
      {searching ? <div style={{ fontSize: 12, color: '#888' }}>Searching…</div> : null}
      {results.length > 0 ? (
        <ul className="result-list">
          {results.map((r) => (
            <li
              key={r.id}
              onClick={() => {
                onSelect(r);
                setQ(r.displayName);
                setResults([]);
              }}
            >
              <div>{r.displayName}</div>
              <div className="kind">
                {r.kind}
                {r.adminPath ? ` · ${r.adminPath}` : ''}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
