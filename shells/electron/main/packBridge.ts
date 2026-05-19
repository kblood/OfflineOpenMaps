import { dialog, ipcMain, BrowserWindow } from 'electron';
import { FsPackStorage } from '@openmaps/platform-node';
import { runSelfTest } from '@openmaps/core';
import type { RegionPack, SearchOptions, ReverseOptions, Profile } from '@openmaps/core';

/**
 * Central state: the renderer can have at most one pack open at a time. All
 * IPC handlers operate against `currentPack`. Switching packs closes the old
 * one cleanly.
 */
let storage: FsPackStorage | null = null;
let currentPack: RegionPack | null = null;
let currentPackId: string | null = null;

export function initPackBridge(packsDir: string): void {
  storage = new FsPackStorage(packsDir);

  ipcMain.handle('packs:list', async () => {
    return storage!.listInstalled();
  });

  ipcMain.handle('packs:verify', async (_e, packId: string) => {
    return storage!.verify(packId);
  });

  ipcMain.handle('packs:open', async (_e, packId: string) => {
    if (currentPack && currentPackId === packId) {
      return currentPack.manifest;
    }
    if (currentPack) {
      await currentPack.close();
      currentPack = null;
      currentPackId = null;
    }
    const pack = await storage!.open(packId);
    currentPack = pack;
    currentPackId = packId;
    return pack.manifest;
  });

  ipcMain.handle('packs:close', async () => {
    if (currentPack) {
      await currentPack.close();
      currentPack = null;
      currentPackId = null;
    }
  });

  ipcMain.handle('packs:current', async () => {
    return currentPack ? currentPack.manifest : null;
  });

  ipcMain.handle('packs:install-from-dir', async (e, opts?: { overwrite?: boolean }) => {
    // Open a folder picker anchored to the window that called us, so it
    // appears modal to the user's app context.
    const win = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select a region pack folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { installed: false as const };
    }
    const srcDir = result.filePaths[0]!;
    const manifest = await storage!.installFromDir(
      srcDir,
      opts?.overwrite ? { overwrite: true } : {},
    );
    return { installed: true as const, manifest };
  });

  ipcMain.handle('packs:uninstall', async (_e, packId: string) => {
    // If the pack being uninstalled is currently open, close it first so
    // the SQLite file handle is released before rm() touches it.
    if (currentPack && currentPackId === packId) {
      await currentPack.close();
      currentPack = null;
      currentPackId = null;
    }
    await storage!.uninstall(packId);
  });

  ipcMain.handle('tiles:get', async (_e, z: number, x: number, y: number) => {
    if (!currentPack) return null;
    const tile = await currentPack.tiles.getTile(z, x, y);
    if (!tile) return null;
    // Electron IPC structured clone supports Uint8Array.
    return {
      bytes: tile.bytes,
      contentType: tile.contentType,
      contentEncoding: tile.contentEncoding,
    };
  });

  ipcMain.handle('geocode:search', async (_e, query: string, opts?: SearchOptions) => {
    if (!currentPack) return [];
    return currentPack.geocode.search(query, opts);
  });

  ipcMain.handle('geocode:reverse', async (_e, lat: number, lon: number, opts?: ReverseOptions) => {
    if (!currentPack) return null;
    return currentPack.geocode.reverse(lat, lon, opts);
  });

  ipcMain.handle(
    'route:compute',
    async (
      _e,
      waypoints: ReadonlyArray<{ lat: number; lon: number }>,
      profile: Profile,
    ) => {
      if (!currentPack) {
        throw new Error('no pack open');
      }
      return currentPack.router.route({ waypoints, profile });
    },
  );

  ipcMain.handle('selftest:run', async () => {
    if (!currentPack) {
      throw new Error('no pack open');
    }
    return runSelfTest(currentPack);
  });
}

export async function shutdownPackBridge(): Promise<void> {
  if (currentPack) {
    await currentPack.close();
    currentPack = null;
    currentPackId = null;
  }
}
