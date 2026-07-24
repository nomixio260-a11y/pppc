/**
 * Data Layer: local persistence (design doc §11.1).
 *
 * Object stores:
 *   kv       — node keys, genesis keys, network config, invite chain
 *   peers    — peer table / trust scores (keyed by node_id)
 *   crdt     — CRDT documents (chat log, profile map)
 *   ns       — cached Name Service records (keyed by name)
 *   blobs    — content-addressed blobs (keyed by cid)
 *   members  — verified membership registry
 *
 * Primary backend is IndexedDB. When IndexedDB is unavailable — e.g. a page
 * opened straight from a `file://` URL in a browser that gives it an opaque
 * origin — the store transparently falls back to an in-memory map so the app
 * still runs (data just won't persist across reloads). Both backends share
 * the same async interface.
 */

const DB_NAME = "anp";
const DB_VERSION = 2;
const STORES = ["kv", "peers", "crdt", "ns", "blobs", "members"] as const;
type StoreName = (typeof STORES)[number];

interface Backend {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  all<T>(store: StoreName): Promise<T[]>;
  clearAll(): Promise<void>;
}

class IdbBackend implements Backend {
  constructor(private readonly db: IDBDatabase) {}

  static open(): Promise<IdbBackend> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        return reject(err);
      }
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(new IdbBackend(req.result));
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB blocked"));
    });
  }

  private tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = fn(this.db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.tx(store, "readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
  }
  put(store: StoreName, key: string, value: unknown): Promise<void> {
    return this.tx(store, "readwrite", (s) => s.put(value, key)).then(() => undefined);
  }
  delete(store: StoreName, key: string): Promise<void> {
    return this.tx(store, "readwrite", (s) => s.delete(key) as IDBRequest<undefined>).then(() => undefined);
  }
  all<T>(store: StoreName): Promise<T[]> {
    return this.tx(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
  }
  clearAll(): Promise<void> {
    return Promise.all(STORES.map((s) => this.tx(s, "readwrite", (os) => os.clear()))).then(() => undefined);
  }
}

class MemoryBackend implements Backend {
  private maps: Record<StoreName, Map<string, unknown>> = {
    kv: new Map(),
    peers: new Map(),
    crdt: new Map(),
    ns: new Map(),
    blobs: new Map(),
    members: new Map(),
  };
  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.maps[store].get(key) as T | undefined;
  }
  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    this.maps[store].set(key, value);
  }
  async delete(store: StoreName, key: string): Promise<void> {
    this.maps[store].delete(key);
  }
  async all<T>(store: StoreName): Promise<T[]> {
    return [...this.maps[store].values()] as T[];
  }
  async clearAll(): Promise<void> {
    for (const map of Object.values(this.maps)) map.clear();
  }
}

export class AnpStore {
  /** true when persistence is unavailable (in-memory fallback in use) */
  readonly ephemeral: boolean;

  private constructor(
    private readonly backend: Backend,
    ephemeral: boolean,
  ) {
    this.ephemeral = ephemeral;
  }

  static async open(): Promise<AnpStore> {
    try {
      return new AnpStore(await IdbBackend.open(), false);
    } catch {
      // file:// opaque origin, private mode with IDB disabled, etc.
      return new AnpStore(new MemoryBackend(), true);
    }
  }

  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.backend.get<T>(store, key);
  }
  put(store: StoreName, key: string, value: unknown): Promise<void> {
    return this.backend.put(store, key, value);
  }
  delete(store: StoreName, key: string): Promise<void> {
    return this.backend.delete(store, key);
  }
  all<T>(store: StoreName): Promise<T[]> {
    return this.backend.all<T>(store);
  }
  clearAll(): Promise<void> {
    return this.backend.clearAll();
  }
}
