import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from '../src/lib/Sha256.js';

describe('Sha256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
  ])('hashes %j', (input, expected) => {
    expect(new Sha256().update(new TextEncoder().encode(input)).hex()).toBe(expected);
  });

  it('matches Node when updated using uneven chunks', () => {
    const input = new Uint8Array(3 * 1024 * 1024 + 137);
    for (let i = 0; i < input.length; i += 1) input[i] = (i * 31 + 17) & 0xff;
    const hash = new Sha256();
    for (let offset = 0; offset < input.length; offset += 7919) {
      hash.update(input.subarray(offset, Math.min(offset + 7919, input.length)));
    }
    expect(hash.hex()).toBe(createHash('sha256').update(input).digest('hex'));
  });
});
