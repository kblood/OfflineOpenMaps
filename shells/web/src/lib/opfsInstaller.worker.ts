/// <reference lib="webworker" />

import { Sha256 } from './Sha256.js';

type Request =
  | { id: number; operation: 'install-url'; directory: string; path: string; url: string; bytes: number; sha256: string }
  | { id: number; operation: 'install-file'; directory: string; path: string; file: File; bytes: number; sha256: string }
  | { id: number; operation: 'verify'; directory: string; path: string; bytes: number; sha256: string };

const scope = self as DedicatedWorkerGlobalScope;
const CHUNK_BYTES = 4 * 1024 * 1024;
const FLUSH_BYTES = 64 * 1024 * 1024;

scope.onmessage = (event: MessageEvent<Request>) => {
  void handle(event.data).then(
    () => scope.postMessage({ id: event.data.id, type: 'result', ok: true }),
    (error: unknown) => scope.postMessage({
      id: event.data.id,
      type: 'result',
      ok: false,
      error: formatError(error),
      errorName: error instanceof DOMException || error instanceof Error ? error.name : undefined,
    }),
  );
};

async function handle(request: Request): Promise<void> {
  const fileHandle = await getPackFile(request.directory, request.path);
  const access = await fileHandle.createSyncAccessHandle();
  try {
    if (request.operation === 'verify') {
      await verifyAccessHandle(access, request.bytes, request.sha256, request.id);
      return;
    }
    await install(access, request);
  } finally {
    access.close();
  }
}

async function install(
  access: FileSystemSyncAccessHandle,
  request: Extract<Request, { operation: 'install-url' | 'install-file' }>,
): Promise<void> {
  let position = access.getSize();
  if (position > request.bytes) {
    access.truncate(0);
    access.flush();
    position = 0;
  }

  let hash = new Sha256();
  if (position > 0) {
    hashAccessHandle(access, position, hash, request.id, request.bytes);
  }
  if (position === request.bytes) {
    if (hash.hex() === request.sha256.toLowerCase()) return;
    access.truncate(0);
    access.flush();
    position = 0;
    hash = new Sha256();
  }

  let response: Response | null = null;
  let stream: ReadableStream<Uint8Array>;
  if (request.operation === 'install-url') {
    const init: RequestInit = { cache: 'no-cache' };
    if (position > 0) init.headers = { Range: `bytes=${position}-` };
    response = await fetch(request.url, init);
    if (!response.ok) throw new Error(`${request.url}: HTTP ${response.status}`);
    if (position > 0 && response.status === 200) {
      // The host ignored Range. Restart safely instead of appending a second copy.
      access.truncate(0);
      access.flush();
      position = 0;
      hash = new Sha256();
    } else if (position > 0) {
      if (response.status !== 206) throw new Error(`resume expected HTTP 206, got ${response.status}`);
      const range = response.headers.get('content-range');
      if (!range?.startsWith(`bytes ${position}-`)) throw new Error(`invalid Content-Range for resume: ${range ?? 'missing'}`);
    }
    if (!response.body) stream = new Blob([await response.arrayBuffer()]).stream();
    else stream = response.body;
  } else {
    stream = request.file.slice(position).stream();
  }

  const reader = stream.getReader();
  let bytesSinceFlush = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (position + value.byteLength > request.bytes) {
        throw new Error(`database download exceeded expected size ${request.bytes}`);
      }
      writeAll(access, value, position);
      hash.update(value);
      position += value.byteLength;
      bytesSinceFlush += value.byteLength;
      if (bytesSinceFlush >= FLUSH_BYTES) {
        access.flush();
        bytesSinceFlush = 0;
      }
      progress(request.id, position, request.bytes);
    }
    access.flush();
  } catch (error) {
    // Make completed chunks durable so the next attempt can issue a Range request.
    access.flush();
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (position !== request.bytes) {
    throw new Error(`database size mismatch: expected ${request.bytes}, got ${position}; retry to resume`);
  }
  const actualHash = hash.hex();
  if (actualHash !== request.sha256.toLowerCase()) {
    access.truncate(0);
    access.flush();
    throw new Error(`database sha256 mismatch: expected ${request.sha256}, got ${actualHash}`);
  }
}

async function verifyAccessHandle(
  access: FileSystemSyncAccessHandle,
  expectedBytes: number,
  expectedHash: string,
  requestId: number,
): Promise<void> {
  const size = access.getSize();
  if (size !== expectedBytes) throw new Error(`database size mismatch: expected ${expectedBytes}, got ${size}`);
  const hash = new Sha256();
  hashAccessHandle(access, size, hash, requestId, expectedBytes);
  const actual = hash.hex();
  if (actual !== expectedHash.toLowerCase()) throw new Error(`database sha256 mismatch: expected ${expectedHash}, got ${actual}`);
}

function hashAccessHandle(
  access: FileSystemSyncAccessHandle,
  bytes: number,
  hash: Sha256,
  requestId: number,
  total: number,
): void {
  const buffer = new Uint8Array(Math.min(CHUNK_BYTES, Math.max(bytes, 1)));
  let offset = 0;
  while (offset < bytes) {
    const length = Math.min(buffer.byteLength, bytes - offset);
    const read = access.read(buffer.subarray(0, length), { at: offset });
    if (read <= 0) throw new Error(`could not read OPFS database at offset ${offset}`);
    hash.update(buffer.subarray(0, read));
    offset += read;
    progress(requestId, offset, total);
  }
}

function writeAll(access: FileSystemSyncAccessHandle, bytes: Uint8Array, at: number): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = access.write(bytes.subarray(offset), { at: at + offset });
    if (written <= 0) throw new Error(`could not write OPFS database at offset ${at + offset}`);
    offset += written;
  }
}

function progress(id: number, bytesReceived: number, bytesTotal: number): void {
  scope.postMessage({ id, type: 'progress', bytesReceived, bytesTotal });
}

function formatError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return 'The browser reached its actual storage limit while saving the map.';
  }
  return error instanceof Error ? error.message : String(error);
}

async function getPackFile(directory: string, path: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  let dir = await root.getDirectoryHandle('openmaps-v2-packs', { create: true });
  dir = await dir.getDirectoryHandle(directory, { create: true });
  const segments = path.split('/').filter(Boolean);
  const leaf = segments.pop();
  if (!leaf) throw new Error('database path is empty');
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
  return dir.getFileHandle(leaf, { create: true });
}

export {};
