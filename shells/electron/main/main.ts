import { app, BrowserWindow, session } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { initPackBridge, shutdownPackBridge } from './packBridge.js';
import { initOfflineMode, offlineState } from './offlineMode.js';
import { initPackBuilder, setIsOfflineRef } from './packBuilder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Packs live next to the app on disk. In dev, `<repo>/packs/`. In a packaged
// build, override via OPENMAPS_PACKS_DIR or use app.getPath('userData').
const packsDir =
  process.env.OPENMAPS_PACKS_DIR ??
  (app.isPackaged
    ? join(app.getPath('userData'), 'packs')
    : resolve(__dirname, '..', '..', '..', '..', 'packs'));

/**
 * In a packaged build we ship one or more region packs as `extraResources`
 * (see package.json `build.extraResources`). They land at
 * `process.resourcesPath/packs/*`. On first launch we copy each one into
 * the writable `userData/packs/` location so `FsPackStorage` can manage
 * them like any other installed pack. We skip packs that already exist
 * to keep launches idempotent and to respect user uninstalls.
 */
function readBuiltAt(manifestPath: string): string | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { builtAt?: string };
    return typeof m.builtAt === 'string' ? m.builtAt : null;
  } catch {
    return null;
  }
}

function seedBundledPacks(): void {
  if (!app.isPackaged) return;
  const bundledRoot = join(process.resourcesPath, 'packs');
  if (!existsSync(bundledRoot)) return;
  mkdirSync(packsDir, { recursive: true });
  for (const entry of readdirSync(bundledRoot)) {
    const src = join(bundledRoot, entry);
    if (!statSync(src).isDirectory()) continue;
    const dst = join(packsDir, entry);
    if (existsSync(dst)) {
      // Same pack already installed. If the bundled version is newer
      // (newer `builtAt`), replace it — this is how a freshly-shipped
      // exe transparently updates an older pack on the user's disk.
      const dstBuiltAt = readBuiltAt(join(dst, 'manifest.json'));
      const srcBuiltAt = readBuiltAt(join(src, 'manifest.json'));
      if (!srcBuiltAt || !dstBuiltAt) continue;
      if (Date.parse(srcBuiltAt) <= Date.parse(dstBuiltAt)) continue;
      // eslint-disable-next-line no-console
      console.log(`[seed] upgrading bundled pack ${entry}: ${dstBuiltAt} -> ${srcBuiltAt}`);
      rmSync(dst, { recursive: true, force: true });
    } else {
      // eslint-disable-next-line no-console
      console.log(`[seed] copying bundled pack ${entry} -> ${dst}`);
    }
    cpSync(src, dst, { recursive: true });
  }
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'OpenMaps v2',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // CSP that disallows ALL remote origins. This is the lint-time guarantee
  // from PLAN.md expressed at runtime: no external network, period.
  // 'unsafe-inline' is allowed only for styles (Maplibre needs it). Scripts
  // are bundled into renderer/index.js so 'self' is enough.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        // `'wasm-unsafe-eval'` is required so MapLibre's MVT decoder can run
        // (Chromium 95+ enforces wasm-csp). All other sources are 'self' or
        // local data:/blob: — no remote origins are reachable.
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "script-src 'self' 'wasm-unsafe-eval'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "font-src 'self'; " +
            "connect-src 'self' blob:; " +
            "worker-src 'self' blob:;",
        ],
      },
    });
  });

  initOfflineMode(win);

  // Only load the dev URL when OPENMAPS_DEV_URL is explicitly set
  // (developer running `vite dev`). Otherwise always load the bundled
  // renderer. This keeps e2e and packaged runs identical.
  if (process.env.OPENMAPS_DEV_URL) {
    await win.loadURL(process.env.OPENMAPS_DEV_URL);
    if (process.env.OPENMAPS_OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
    // DevTools opt-in via env var. Toggle at runtime with View → Toggle
    // Developer Tools or Ctrl+Shift+I.
    if (process.env.OPENMAPS_DEBUG === '1') {
      win.webContents.openDevTools({ mode: 'right' });
    }
  }
  return win;
}

app.whenReady().then(async () => {
  // Disable navigation to remote origins from any window. Belt-and-braces.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      const allowed = url.startsWith('http://localhost:') || url.startsWith('file://');
      if (!allowed) event.preventDefault();
    });
  });

  seedBundledPacks();
  initPackBridge(packsDir);
  setIsOfflineRef(offlineState);
  initPackBuilder(packsDir);
  await createWindow();
});

app.on('window-all-closed', async () => {
  await shutdownPackBridge();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

// Silence the experimental node:sqlite warning in production builds.
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && w.message.includes('SQLite')) return;
  // eslint-disable-next-line no-console
  console.warn(w);
});

// Ignore unused import.
void session;
