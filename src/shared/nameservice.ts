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
import type { NameRecord, NetworkId, PubKeyHex, RevocationMap, RevocationValue } from "./types.js";

/** Name prefix for invite-certificate revocations (protocol v2). */
export const REVOKED_PREFIX = "revoked/";

/**
 * Canonical name for a revocation of `inviteId` published by `authorPubkey`.
 *
 * Revocation is a MULTI-AUTHOR, MONOTONIC set (any authorized revoker may add
 * itself), so each (invite, author) pair gets its OWN name slot. This is the
 * fix for the LWW-squatting bug: a plain `revoked/<id>` single record could be
 * overwritten by any member with a higher version, silently un-revoking. With
 * per-author names, a record can only occupy its own author's slot (enforced
 * in `merge`), so no one can evict or forge another authority's revocation.
 */
export function revocationName(inviteId: string, authorPubkey: PubKeyHex): string {
  return `${REVOKED_PREFIX}${inviteId}/${authorPubkey}`;
}

/**
 * Parse a revocation name back into its (inviteId, authorPubkey) parts, or
 * null if it is not a well-formed revocation name.
 */
export function parseRevocationName(name: string): { inviteId: string; authorPubkey: PubKeyHex } | null {
  if (!name.startsWith(REVOKED_PREFIX)) return null;
  const rest = name.slice(REVOKED_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const inviteId = rest.slice(0, slash);
  const authorPubkey = rest.slice(slash + 1);
  if (!/^[0-9a-f]{130}$/.test(authorPubkey)) return null;
  return { inviteId, authorPubkey };
}

/**
 * A record under the `revoked/` namespace is only structurally valid when its
 * name binds it to its own author and its value is a matching revocation. This
 * makes the namespace forge-proof: a record can never occupy another author's
 * slot, and the slot can only ever hold a real revocation (never a benign
 * value that would suppress `revocations()`).
 */
export function isValidRevocationRecord(record: NameRecord): boolean {
  const parts = parseRevocationName(record.name);
  if (!parts) return false;
  if (parts.authorPubkey !== record.author_pubkey) return false;
  const value = record.value as RevocationValue;
  return value?.kind === "revocation" && value.invite_id === parts.inviteId;
}

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
    if (typeof record.name !== "string") return false;
    // The `revoked/` namespace may ONLY ever hold author-bound revocation
    // records — reject anything else, so a benign or forged value can never
    // squat a revocation slot and suppress enforcement.
    if (record.name.startsWith(REVOKED_PREFIX) && !isValidRevocationRecord(record)) return false;
    if (!(await verifyNameRecord(record))) return false;
    const current = this.records.get(record.name);
    // an expired stored record never beats a fresh incoming one — otherwise a
    // name whose publisher restarted at version 1 could stay dead forever
    if (!current || isExpired(current, now) || pickNewer(record, current) === record) {
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

  /**
   * Extract the revocation map from `revoked/<invite_id>/<author>` records.
   * Each valid record contributes its author to the invite's revoker set; the
   * map only carries who *claimed* each revocation, and authority (issuer or
   * genesis) is judged at chain-verification time by `isCertRevoked`.
   */
  revocations(now = nowSeconds()): RevocationMap {
    const map: RevocationMap = new Map();
    for (const record of this.all(now)) {
      if (!record.name.startsWith(REVOKED_PREFIX)) continue;
      if (!isValidRevocationRecord(record)) continue;
      const value = record.value as RevocationValue;
      let revokers = map.get(value.invite_id);
      if (!revokers) {
        revokers = new Set();
        map.set(value.invite_id, revokers);
      }
      revokers.add(record.author_pubkey);
    }
    return map;
  }
}
