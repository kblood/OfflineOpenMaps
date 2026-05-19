// Preload script. Exposes a minimal, typed API to the renderer via
// contextBridge. The renderer never sees Node modules directly; every
// privileged operation goes through one of these IPC channels.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const api = {
  packs: {
    list: () => ipcRenderer.invoke('packs:list'),
    verify: (packId: string) => ipcRenderer.invoke('packs:verify', packId),
    open: (packId: string) => ipcRenderer.invoke('packs:open', packId),
    close: () => ipcRenderer.invoke('packs:close'),
    current: () => ipcRenderer.invoke('packs:current'),
    installFromDir: (opts?: { overwrite?: boolean }) =>
      ipcRenderer.invoke('packs:install-from-dir', opts),
    uninstall: (packId: string) => ipcRenderer.invoke('packs:uninstall', packId),
  },
  packBuilder: {
    countries: () => ipcRenderer.invoke('packBuilder:countries'),
    start: (req: unknown) => ipcRenderer.invoke('packBuilder:start', req),
    cancel: (buildId: string) => ipcRenderer.invoke('packBuilder:cancel', buildId),
    /**
     * Subscribe to progress events. Returns an unsubscribe function.
     * Listener receives a PackBuildProgress envelope; the renderer
     * filters by buildId.
     */
    onProgress: (listener: (p: unknown) => void) => {
      const fn = (_e: IpcRendererEvent, p: unknown): void => listener(p);
      ipcRenderer.on('packBuilder:progress', fn);
      return () => ipcRenderer.removeListener('packBuilder:progress', fn);
    },
  },
  tiles: {
    get: (z: number, x: number, y: number) => ipcRenderer.invoke('tiles:get', z, x, y),
  },
  geocode: {
    search: (query: string, opts?: unknown) => ipcRenderer.invoke('geocode:search', query, opts),
    reverse: (lat: number, lon: number, opts?: unknown) =>
      ipcRenderer.invoke('geocode:reverse', lat, lon, opts),
  },
  route: {
    compute: (waypoints: ReadonlyArray<{ lat: number; lon: number }>, profile: string) =>
      ipcRenderer.invoke('route:compute', waypoints, profile),
  },
  offline: {
    set: (offline: boolean) => ipcRenderer.invoke('offline:set', offline),
    get: () => ipcRenderer.invoke('offline:get'),
  },
  selftest: {
    run: () => ipcRenderer.invoke('selftest:run'),
  },
};

contextBridge.exposeInMainWorld('openmaps', api);

export type OpenMapsApi = typeof api;
