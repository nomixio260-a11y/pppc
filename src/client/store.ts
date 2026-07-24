/**
 * Data Layer: local persistence in IndexedDB (design doc §11.1).
 *
 * Object stores:
 *   kv       — node keys, genesis keys, network config, invite chain
 *   peers    — peer table (keyed by node_id)
 *   crdt     — CRDT documents (chat log, profile map)
 *   ns       — cached Name Service records (keyed by name)
 *   blobs    — content-addressed blobs (keyed by cid)
 */

const DB_NAME = "anp";
const DB_VERSION = 2;
const STORES = ["kv", "peers", "crdt", "ns", "blobs", "members"] as const;
type StoreName = (typeof STORES)[number];

export class AnpStore {
  private db!: IDBDatabase;

  static async open(): Promise<AnpStore> {
    const store = new AnpStore();
    store.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return store;
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

  put(store: StoreName, key: string, value: unknown): Promise<IDBValidKey> {
    return this.tx(store, "readwrite", (s) => s.put(value, key));
  }

  delete(store: StoreName, key: string): Promise<undefined> {
    return this.tx(store, "readwrite", (s) => s.delete(key) as IDBRequest<undefined>);
  }

  all<T>(store: StoreName): Promise<T[]> {
    return this.tx(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
  }

  clearAll(): Promise<void> {
    return Promise.all(STORES.map((s) => this.tx(s, "readwrite", (os) => os.clear()))).then(() => undefined);
  }
}
