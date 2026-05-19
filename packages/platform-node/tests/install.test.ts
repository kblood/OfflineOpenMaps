/**
 * Tests for FsPackStorage.installFromDir() — the workhorse behind the
 * "Install from folder…" button in the UI.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FsPackStorage } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const builderCli = resolve(repoRoot, 'packages/region-builder/dist/cli.js');

let sourceDir: string;
let packsDir: string;
const PACK_ID = 'fakeland';

beforeAll(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-src-'));
  packsDir = await mkdtemp(join(tmpdir(), 'openmaps-v2-dest-'));
  execFileSync('node', [builderCli, 'build-synthetic', '--id', PACK_ID, '--out', sourceDir], {
    stdio: 'pipe',
  });
}, 60000);

afterAll(async () => {
  if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  if (packsDir) await rm(packsDir, { recursive: true, force: true });
});

describe('FsPackStorage.installFromDir', () => {
  it('copies a pack from a source directory and reports the manifest', async () => {
    const storage = new FsPackStorage(packsDir);
    const srcPack = join(sourceDir, PACK_ID);
    const manifest = await storage.installFromDir(srcPack);
    expect(manifest.id).toBe(PACK_ID);

    // The pack should now appear in listInstalled and verify cleanly.
    const list = await storage.listInstalled();
    expect(list.map((m) => m.id)).toContain(PACK_ID);
    const v = await storage.verify(PACK_ID);
    expect(v).toEqual({ ok: true });
  });

  it('refuses to overwrite an existing pack unless overwrite:true is passed', async () => {
    const storage = new FsPackStorage(packsDir);
    const srcPack = join(sourceDir, PACK_ID);
    // First install (or re-install — depending on test ordering).
    try {
      await storage.installFromDir(srcPack);
    } catch {
      /* already installed from previous test — fine */
    }
    await expect(storage.installFromDir(srcPack)).rejects.toThrow(/already installed/);
    // With overwrite:true it succeeds.
    const m = await storage.installFromDir(srcPack, { overwrite: true });
    expect(m.id).toBe(PACK_ID);
  });

  it('rejects sources that lack a valid manifest', async () => {
    const storage = new FsPackStorage(packsDir);
    const bogus = await mkdtemp(join(tmpdir(), 'openmaps-v2-bogus-'));
    try {
      await expect(storage.installFromDir(bogus)).rejects.toThrow(/not a valid pack/);
      // Now write a malformed manifest and try again.
      await writeFile(join(bogus, 'manifest.json'), '{"id":"x"}', 'utf8');
      await expect(storage.installFromDir(bogus)).rejects.toThrow(/not a valid pack/);
    } finally {
      await rm(bogus, { recursive: true, force: true });
    }
  });

  it('uninstall removes the pack from disk and from listInstalled', async () => {
    const storage = new FsPackStorage(packsDir);
    const srcPack = join(sourceDir, PACK_ID);
    try {
      await storage.installFromDir(srcPack);
    } catch {
      /* already installed */
    }
    await storage.uninstall(PACK_ID);
    const list = await storage.listInstalled();
    expect(list.map((m) => m.id)).not.toContain(PACK_ID);
  });
});
