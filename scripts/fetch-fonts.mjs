#!/usr/bin/env node
/**
 * One-shot fetcher: downloads pre-built Open Sans Regular glyph PBFs from
 * MapLibre's demotiles font server into
 * `shells/electron/renderer/public/fonts/<fontstack>/`.
 *
 * MapLibre composes a glyph URL from the style's `glyphs` template by
 * substituting `{fontstack}` with the joined `text-font` array (joined by
 * `,`) and `{range}` with a 256-codepoint Unicode block (e.g. `0-255`).
 * Each block is ~30-80 KB; we fetch enough ranges to cover ASCII, Latin
 * Supplement (includes æ ø å), Latin Extended-A/B, and General
 * Punctuation — comfortably enough for Danish, German, French, etc.
 *
 * We use the exact fontstack `Open Sans Regular,Arial Unicode MS Regular`
 * because that's what MapLibre's demo server publishes. The literal comma
 * is part of the URL and the on-disk folder name; vite's publicDir copies
 * the folder as-is, and at runtime MapLibre asks for the same URL, so the
 * round-trip works without rewriting.
 *
 * Run once at build/dev time:  `node scripts/fetch-fonts.mjs`
 * Refresh:                     `node scripts/fetch-fonts.mjs --force`
 *
 * The PBFs are gitignored — we don't keep them in version control, only
 * in the bundled .exe.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const FONTSTACK = 'Open Sans Regular,Arial Unicode MS Regular';
const outDir = resolve(repoRoot, 'shells/electron/renderer/public/fonts', FONTSTACK);
const force = process.argv.includes('--force');

// 256-codepoint Unicode ranges to fetch. Covers ASCII, Latin-1 Supplement
// (æ ø å Æ Ø Å), Latin Extended-A/B, IPA, spacing modifiers, combining
// diacritics, Greek, Cyrillic, and general punctuation. Anything beyond
// these tends to be CJK / RTL scripts that this build doesn't need.
const RANGES = [
  '0-255',     // Basic Latin + Latin-1 Supplement
  '256-511',   // Latin Extended-A + part of Latin Extended-B
  '512-767',   // Latin Extended-B + IPA
  '768-1023',  // Combining diacritics + Greek
  '1024-1279', // Cyrillic
  '8192-8447', // General punctuation (smart quotes, en/em dashes, …)
];

const BASE_URL = `https://demotiles.maplibre.org/font/${encodeURIComponent(FONTSTACK)}`;

async function main() {
  mkdirSync(outDir, { recursive: true });
  let downloaded = 0;
  let skipped = 0;
  for (const range of RANGES) {
    const dst = resolve(outDir, `${range}.pbf`);
    if (existsSync(dst) && !force) {
      const sz = statSync(dst).size;
      process.stdout.write(`Already have ${range}.pbf (${sz} bytes). Use --force to refresh.\n`);
      skipped++;
      continue;
    }
    const url = `${BASE_URL}/${range}.pbf`;
    process.stdout.write(`Fetching ${url}\n`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'openmaps-v2-font-fetcher/0.1' },
    });
    if (!res.ok) {
      throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Sanity check — a real glyph PBF is at least a few hundred bytes and
    // is binary. An HTML 404 page is ~9 KB of text.
    if (buf.length < 200 || buf.slice(0, 6).toString('utf8').includes('<')) {
      throw new Error(
        `${url} returned ${buf.length} bytes that look like HTML, not a PBF — endpoint may have changed.`,
      );
    }
    writeFileSync(dst, buf);
    process.stdout.write(`  wrote ${dst} (${buf.length} bytes)\n`);
    downloaded++;
  }
  process.stdout.write(`Done. ${downloaded} new, ${skipped} already present.\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-fonts failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
