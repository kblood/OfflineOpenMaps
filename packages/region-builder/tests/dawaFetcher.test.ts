import { describe, expect, it, vi } from 'vitest';
import { fetchDawa } from '../src/dawaFetcher.js';

describe('fetchDawa', () => {
  it('uses GeoJSON feature IDs so repeated readable addresses remain distinct', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      features: [
        {
          id: 'first-uuid',
          geometry: { type: 'Point', coordinates: [9.9, 57.0] },
          properties: { vejnavn: 'Havnevej', husnr: '1', postnr: '9000', postnrnavn: 'Aalborg' },
        },
        {
          id: 'second-uuid',
          geometry: { type: 'Point', coordinates: [9.901, 57.001] },
          properties: { vejnavn: 'Havnevej', husnr: '1', postnr: '9000', postnrnavn: 'Aalborg' },
        },
      ],
    }), { status: 200 }));

    const result = await fetchDawa({
      bbox: [9.8, 56.9, 10.0, 57.1],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      includeParcels: false,
    });

    expect(result.addresses.map((address) => address.id)).toEqual([
      'dawa:first-uuid',
      'dawa:second-uuid',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('disambiguates duplicate source IDs with coordinates', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      features: [
        { geometry: { type: 'Point', coordinates: [9.9, 57.0] }, properties: { vejnavn: 'Havnevej', husnr: '1', postnr: '9000' } },
        { geometry: { type: 'Point', coordinates: [9.901, 57.001] }, properties: { vejnavn: 'Havnevej', husnr: '1', postnr: '9000' } },
      ],
    }), { status: 200 }));
    const result = await fetchDawa({
      bbox: [9.8, 56.9, 10.0, 57.1], fetchImpl: fetchImpl as unknown as typeof fetch, includeParcels: false,
    });
    expect(new Set(result.addresses.map((address) => address.id)).size).toBe(2);
  });
});
