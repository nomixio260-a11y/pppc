/**
 * service/files: content-addressed file sharing over DataChannels
 * (design doc §11.2, Phase 3).
 *
 * Files are identified by their CID (sha256 of the bytes). Sharing stores the
 * blob in IndexedDB and announces it as a signed chat entry; any peer can
 * then fetch it with BLOB_REQ. Transfers are chunked (16 KiB), sent with
 * DataChannel backpressure (bufferedAmount watermarks), and the receiver
 * re-hashes the assembled bytes — a corrupted or malicious transfer can never
 * produce the wrong content for a CID.
 */

import { base64UrlDecode, base64UrlEncode, sha256Hex } from "../shared/crypto.js";
import type { FileMeta, NodeId } from "../shared/types.js";
import type { AnpStore } from "./store.js";
import type { DcMessage, Mesh } from "./webrtc.js";

const CHUNK_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const BUFFER_HIGH = 1 * 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
/** idle (no-progress) timeout — resets on every received chunk, so large
 * files on slow links keep going as long as bytes are flowing */
const IDLE_TIMEOUT_MS = 20_000;

interface IncomingTransfer {
  cid: string;
  /** the peer we requested this blob from; only it may advance the transfer */
  peer: NodeId;
  chunks: (Uint8Array | undefined)[];
  received: number;
  total: number;
  size: number;
  /** running total of bytes accepted, to cap memory amplification */
  bytesSeen: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FileService {
  /** cid -> in-flight download */
  private incoming = new Map<string, IncomingTransfer>();

  constructor(
    private readonly store: AnpStore,
    private readonly mesh: Mesh,
    private readonly log: (line: string) => void,
  ) {}

  async cidOfBytes(bytes: Uint8Array): Promise<string> {
    return `cid:sha256:${await sha256Hex(bytes)}`;
  }

  /** Store a local file and return its metadata for announcement. */
  async shareFile(file: File): Promise<FileMeta> {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`ファイルが大きすぎます (上限 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB)`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cid = await this.cidOfBytes(bytes);
    await this.store.put("blobs", cid, bytes.buffer);
    return { cid, name: file.name, size: bytes.length, mime: file.type || "application/octet-stream" };
  }

  async localBlob(cid: string): Promise<Uint8Array | undefined> {
    const buf = await this.store.get<ArrayBuffer>("blobs", cid);
    return buf ? new Uint8Array(buf) : undefined;
  }

  /**
   * Fetch a blob: local cache first, then each connected peer in turn until
   * one delivers bytes that hash to the CID.
   */
  async fetchBlob(cid: string): Promise<Uint8Array> {
    const local = await this.localBlob(cid);
    if (local) return local;
    const peers = this.mesh.connectedNodeIds();
    if (peers.length === 0) throw new Error("接続中のピアがいません");
    let lastError = "no provider";
    for (const peer of peers) {
      try {
        const bytes = await this.requestFrom(peer, cid);
        await this.store.put("blobs", cid, bytes.buffer);
        return bytes;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    throw new Error(`取得失敗: ${lastError}`);
  }

  private requestFrom(peer: NodeId, cid: string): Promise<Uint8Array> {
    if (this.incoming.has(cid)) {
      return Promise.reject(new Error("already fetching"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const transfer: IncomingTransfer = {
        cid,
        peer,
        chunks: [],
        received: 0,
        total: -1,
        size: 0,
        bytesSeen: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.incoming.delete(cid);
          reject(new Error("転送タイムアウト (無応答)"));
        }, IDLE_TIMEOUT_MS),
      };
      this.incoming.set(cid, transfer);
      if (!this.mesh.send(peer, { t: "BLOB_REQ", cid })) {
        clearTimeout(transfer.timer);
        this.incoming.delete(cid);
        reject(new Error("送信失敗"));
      }
    }).finally(() => {
      const transfer = this.incoming.get(cid);
      if (transfer) {
        clearTimeout(transfer.timer);
        this.incoming.delete(cid);
      }
    });
  }

  private touch(transfer: IncomingTransfer): void {
    clearTimeout(transfer.timer);
    transfer.timer = setTimeout(() => {
      this.incoming.delete(transfer.cid);
      transfer.reject(new Error("転送タイムアウト (無応答)"));
    }, IDLE_TIMEOUT_MS);
  }

  /** Handle file-transfer DataChannel messages. Returns true when consumed. */
  async handleMessage(from: NodeId, msg: DcMessage): Promise<boolean> {
    switch (msg.t) {
      case "BLOB_REQ": {
        await this.serve(from, msg.cid);
        return true;
      }
      case "BLOB_META": {
        const transfer = this.incoming.get(msg.cid);
        if (!transfer || transfer.peer !== from) return true; // only the serving peer
        this.touch(transfer);
        if (
          typeof msg.size !== "number" ||
          typeof msg.chunks !== "number" ||
          msg.size < 0 ||
          msg.size > MAX_FILE_BYTES ||
          msg.chunks < 0 ||
          msg.chunks > Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES)
        ) {
          transfer.reject(new Error("不正なメタデータ"));
          return true;
        }
        transfer.total = msg.chunks;
        transfer.size = msg.size;
        transfer.chunks = new Array(msg.chunks);
        if (msg.chunks === 0) this.finish(transfer);
        return true;
      }
      case "BLOB_CHUNK": {
        const transfer = this.incoming.get(msg.cid);
        if (!transfer || transfer.peer !== from || transfer.total < 0) return true;
        if (typeof msg.idx !== "number" || msg.idx < 0 || msg.idx >= transfer.total) return true;
        if (transfer.chunks[msg.idx]) return true; // duplicate
        this.touch(transfer); // progress resets the idle deadline
        let bytes: Uint8Array;
        try {
          bytes = base64UrlDecode(msg.data);
        } catch {
          transfer.reject(new Error("チャンクの復号失敗"));
          return true;
        }
        // bound memory amplification: every chunk but the last must be exactly
        // CHUNK_BYTES, and the running total may never exceed the announced
        // size (itself capped at MAX_FILE_BYTES in BLOB_META)
        if (bytes.length > CHUNK_BYTES || transfer.bytesSeen + bytes.length > transfer.size) {
          transfer.reject(new Error("チャンクサイズ超過"));
          return true;
        }
        transfer.bytesSeen += bytes.length;
        transfer.chunks[msg.idx] = bytes;
        transfer.received += 1;
        if (transfer.received === transfer.total) await this.finish(transfer);
        return true;
      }
      case "BLOB_ERR": {
        const transfer = this.incoming.get(msg.cid);
        if (transfer && transfer.peer === from) transfer.reject(new Error(msg.reason || "peer error"));
        return true;
      }
      default:
        return false;
    }
  }

  private async finish(transfer: IncomingTransfer): Promise<void> {
    let size = 0;
    for (const chunk of transfer.chunks) size += chunk?.length ?? 0;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      if (!chunk) {
        transfer.reject(new Error("欠損チャンク"));
        return;
      }
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    // content addressing is the integrity check: re-hash before accepting
    const cid = await this.cidOfBytes(bytes);
    if (cid !== transfer.cid) {
      transfer.reject(new Error("CID不一致 (改ざんまたは破損)"));
      return;
    }
    transfer.resolve(bytes);
  }

  /** Stream a local blob to a requesting peer with backpressure. */
  private async serve(to: NodeId, cid: string): Promise<void> {
    if (typeof cid !== "string" || !/^cid:sha256:[0-9a-f]{64}$/.test(cid)) return;
    const bytes = await this.localBlob(cid);
    if (!bytes) {
      this.mesh.send(to, { t: "BLOB_ERR", cid, reason: "not found" });
      return;
    }
    const total = Math.ceil(bytes.length / CHUNK_BYTES);
    this.mesh.send(to, { t: "BLOB_META", cid, size: bytes.length, chunks: total });
    const dc = this.mesh.channelOf(to);
    if (!dc) return;
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    for (let idx = 0; idx < total; idx++) {
      if (dc.readyState !== "open") return;
      if (dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise<void>((resolve) => {
          const onLow = () => {
            dc.removeEventListener("bufferedamountlow", onLow);
            resolve();
          };
          dc.addEventListener("bufferedamountlow", onLow);
          setTimeout(onLow, 5_000); // safety valve
        });
      }
      const chunk = bytes.subarray(idx * CHUNK_BYTES, (idx + 1) * CHUNK_BYTES);
      if (!this.mesh.send(to, { t: "BLOB_CHUNK", cid, idx, data: base64UrlEncode(chunk) })) return;
    }
    this.log(`blob ${cid.slice(11, 19)}… (${bytes.length}B) served to ${to.slice(0, 8)}`);
  }
}
