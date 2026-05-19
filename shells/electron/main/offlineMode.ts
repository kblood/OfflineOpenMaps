import { ipcMain, type BrowserWindow } from 'electron';

/**
 * The canonical "go offline" toggle. session.enableNetworkEmulation with
 * { offline: true } severs ALL network access for the BrowserWindow's
 * session — no fetch, no DNS, no nothing. This is how we PROVE offline
 * works rather than claiming it.
 *
 * The SelfTestPanel in the renderer flips this on, then runs runSelfTest.
 * If anything tries to hit the network, it fails. There is no escape hatch.
 */

// Wrapped in an object so other modules (notably packBuilder) can hold a
// shared reference and observe state changes without going through IPC.
export const offlineState: { value: boolean } = { value: false };

export function initOfflineMode(win: BrowserWindow): void {
  ipcMain.handle('offline:set', (_e, offline: boolean) => {
    win.webContents.session.enableNetworkEmulation({
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    offlineState.value = offline;
    return offlineState.value;
  });

  ipcMain.handle('offline:get', () => offlineState.value);
}

export function disableOfflineMode(win: BrowserWindow): void {
  win.webContents.session.enableNetworkEmulation({
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  offlineState.value = false;
}
