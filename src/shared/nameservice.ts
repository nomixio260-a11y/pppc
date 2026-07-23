/**
 * Name Service (design doc §10).
 *
 * A replicated set of signed records, not a server. Every node keeps a copy
 * and applies the same deterministic merge rules, so all replicas converge on
 * the same "latest" value for each name:
 *
 *   1. higher `version` wins
 *   2. same `version`: newer `updated_at` wins
 *   3. still tied: lexicographically larger signature wins (total order)
 *   4. invalid signature -> discarded
 *   5. past `ttl` -> expired
 */

import { type KeyPairHandle, nowSeconds, signObject, verifyObject } from "./crypto.js";
import type { NameRecord, NetworkId } from "./types.js";

export async function createNameRecord(
  networkId: NetworkId,
  keys: KeyPairHandle,
  name: string,
  value: unknown,
  version: number,
  ttl = 600,
): Promise<NameRecord> {
  const record: NameRecord = {
    network_id: networkId,
    name,
    value,
    version,
    ttl,
    updated_at: nowSeconds(),
    author_pubkey: keys.publicKeyHex,
    signature: "",
  };
  record.signature = await signObject(keys.privateKey, record as unknown as Record<string, unknown>, [
    "signature",
  ]);
  return record;
}

export async function verifyNameRecord(record: NameRecord): Promise<boolean> {
  if (!record || typeof record.name !== "string" || typeof record.version !== "number") return false;
  return verifyObject(record.author_pubkey, record as unknown as Record<string, unknown>, ["signature"]);
}

export function isExpired(record: NameRecord, now = nowSeconds()): boolean {
  return record.updated_at + record.ttl <= now;
}

/** Returns the record that should win; deterministic across nodes. */
export function pickNewer(a: NameRecord, b: NameRecord): NameRecord {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  return a.signature >= b.signature ? a : b;
}

/** In-memory replica of the record set, keyed by name. */
export class NameServiceStore {
  private records = new Map<string, NameRecord>();

  constructor(private readonly networkId: NetworkId) {}

  /** Merge one record in; returns true if it became the winner for its name. */
  async merge(record: NameRecord, now = nowSeconds()): Promise<boolean> {
    if (record.network_id !== this.networkId) return false;
    if (isExpired(record, now)) return false;
    if (!(await verifyNameRecord(record))) return false;
    const current = this.records.get(record.name);
    if (!current || pickNewer(record, current) === record) {
      this.records.set(record.name, record);
      return true;
    }
    return false;
  }

  resolve(name: string, now = nowSeconds()): NameRecord | undefined {
    const record = this.records.get(name);
    if (!record) return undefined;
    if (isExpired(record, now)) {
      this.records.delete(record.name);
      return undefined;
    }
    return record;
  }

  all(now = nowSeconds()): NameRecord[] {
    for (const [name, record] of this.records) {
      if (isExpired(record, now)) this.records.delete(name);
    }
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  load(records: NameRecord[]): void {
    for (const record of records) {
      const current = this.records.get(record.name);
      this.records.set(record.name, current ? pickNewer(record, current) : record);
    }
  }
}
