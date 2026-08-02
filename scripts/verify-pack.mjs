#!/usr/bin/env node
/** Verify a locally-built pack's checksums and complete offline contract. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsPackStorage } from '../packages/platform-node/dist/index.js';
import { runSelfTest } from '../packages/core/dist/index.js';

const packId = process.argv[2];
if (!packId) throw new Error('Usage: node scripts/verify-pack.mjs <pack-id>');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const storage = new FsPackStorage(resolve(root, 'packs'));
const verification = await storage.verify(packId);
if (!verification.ok) throw new Error(`Checksum verification failed: ${verification.problem}`);

const pack = await storage.open(packId);
try {
  const report = await runSelfTest(pack);
  for (const result of report.results) {
    process.stdout.write(`${result.status.toUpperCase()} ${result.id}: ${result.summary}\n`);
  }
  if (!report.allPassed) throw new Error(`Offline self-test failed for ${packId}`);
} finally {
  await pack.close();
}

process.stdout.write(`Verified ${packId}\n`);
