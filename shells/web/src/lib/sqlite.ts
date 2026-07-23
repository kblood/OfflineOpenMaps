// Thin compatibility layer over `@sqlite.org/sqlite-wasm`. Exposes just
// enough of the node:sqlite shape (`exec`, `prepare(sql).all(...args) /
// .get(...args)`) to make porting the platform-node code a near-direct
// copy. Each prepared statement is reset + rebound on every call so it
// behaves like node:sqlite's `StatementSync`.
//
// Small packs can be deserialized in memory. Country-scale unified packs are
// opened from OPFS in a dedicated worker, where sqlite-wasm's OPFS VFS is
// available without copying the complete database into the JS heap.
import sqlite3InitModule, {
  type Database,
  type PreparedStatement,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';

type SqlValue = string | number | bigint | Uint8Array | null;

let initPromise: Promise<Sqlite3Static> | null = null;

async function getSqlite3(): Promise<Sqlite3Static> {
  if (!initPromise) {
    // sqlite-wasm prints a fairly chatty banner on init; we silence print
    // and route real errors to console.error.
    initPromise = sqlite3InitModule({ print: () => {}, printErr: console.error });
  }
  return initPromise;
}

/** A row object keyed by column name. */
export type Row = Record<string, SqlValue>;

export interface Stmt {
  all(...args: SqlValue[]): Row[];
  get(...args: SqlValue[]): Row | undefined;
  finalize(): void;
}

export class WebDb {
  constructor(
    private readonly db: Database,
    private readonly stmts: PreparedStatement[] = [],
  ) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Stmt {
    const stmt = this.db.prepare(sql);
    this.stmts.push(stmt);
    return {
      all: (...args: SqlValue[]) => {
        stmt.reset(true);
        bindAll(stmt, args);
        const rows: Row[] = [];
        while (stmt.step()) rows.push(stmt.get({}) as unknown as Row);
        return rows;
      },
      get: (...args: SqlValue[]) => {
        stmt.reset(true);
        bindAll(stmt, args);
        if (!stmt.step()) return undefined;
        return stmt.get({}) as unknown as Row;
      },
      finalize: () => {
        stmt.finalize();
      },
    };
  }

  close(): void {
    for (const s of this.stmts) {
      try {
        s.finalize();
      } catch {
        // ignore — finalize is a destructor and "destructors must not throw"
      }
    }
    this.db.close();
  }
}

function bindAll(stmt: PreparedStatement, args: ReadonlyArray<SqlValue>): void {
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i];
    // sqlite-wasm's bind(idx, value) is 1-indexed and accepts null directly.
    // We treat undefined as null too so callers don't have to coerce.
    stmt.bind(i + 1, v === undefined ? null : v);
  }
}

/**
 * Open a SQLite file (MBTiles, geocode, etc.) from in-memory bytes.
 *
 * Uses `sqlite3_deserialize` to hand SQLite the buffer without a round-trip
 * through any virtual filesystem. The `FREEONCLOSE` flag transfers ownership
 * of the WASM-side allocation to SQLite, so we don't need to free it
 * ourselves; `RESIZEABLE` lets SQLite grow the buffer in case we later use
 * the same handle in a writable context (we don't, today, but it's the
 * forward-compatible default).
 */
export async function openSqliteFromBytes(bytes: Uint8Array): Promise<WebDb> {
  const s = await getSqlite3();
  const db = new s.oo1.DB(':memory:', 'c');
  const p = s.wasm.allocFromTypedArray(bytes);
  const rc = s.capi.sqlite3_deserialize(
    db,
    'main',
    p,
    bytes.byteLength,
    bytes.byteLength,
    s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== s.capi.SQLITE_OK) {
    throw new Error(`sqlite3_deserialize failed: rc=${rc}`);
  }
  return new WebDb(db);
}

/** Open an existing OPFS database read-only. Must be called from a Worker. */
export async function openSqliteFromOpfs(path: string): Promise<WebDb> {
  const sqlite3 = await getSqlite3();
  if (!sqlite3.oo1.OpfsDb) {
    throw new Error('sqlite-wasm OPFS VFS is unavailable; check browser support and COOP/COEP headers');
  }
  return new WebDb(new sqlite3.oo1.OpfsDb(path, 'r'));
}
