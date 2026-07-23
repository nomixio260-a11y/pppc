# ANP: Autonomous Network Protocol

ブラウザ完結型・招待制・分散ホストネットワークの実装（設計書 v1.0 準拠）。

固定URL `anp://<network-id>` を名前とするネットワークに、招待証明書を持つブラウザだけが参加できる。発見は Relay（Nostr風の署名イベント中継）、通信は WebRTC DataChannel、状態は CRDT と署名付き Name Service レコード、永続化は IndexedDB で行う。

```text
固定URL → Network ID → 招待証明書 → Relayで発見 → WebRTCで直接接続
        → P2Pメッシュ → Name Service → サービス全体が1つの仮想サーバー
```

## クイックスタート

```bash
npm install
npm start          # ビルドして Relay + クライアントUI を起動
# → http://localhost:8787/ をブラウザで開く
```

複数ノードを試すには、同じURLを **別のブラウザプロファイル**（またはシークレットウィンドウ）で開く。IndexedDB がプロファイルごとに分かれるため、それぞれが独立ノードになる。

1. ブラウザA: 「ネットワークを作成して参加」→ Genesis 鍵と Network ID が生成される
2. ブラウザB: 「参加リクエストコードを作成」→ 表示されたコード（公開鍵）をAに渡す
3. ブラウザA: 「招待を発行」にコードを貼り付け → 招待バンドルをBに渡す
4. ブラウザB: バンドルを貼り付けて参加 → Relay 経由で発見 → WebRTC で直接接続
5. チャット送信・Name Service レコード公開が DataChannel 越しに同期される

## コマンド

| コマンド | 説明 |
|---|---|
| `npm run build` | 型チェック + クライアントバンドル生成 (`public/anp.js`) |
| `npm run relay` | Relay サーバー起動（`PORT` 環境変数、既定 8787） |
| `npm start` | build + relay |
| `npm test` | ユニット + Relay 統合テスト |

## 構成

```text
src/shared/    ブラウザ・Node 共通（Web Crypto ベース）
  crypto.ts       ECDSA P-256 署名 / SHA-256 / 正規化JSON / CID
  types.ts        プロトコル型定義（イベント・証明書・NSレコード）
  identity.ts     Network ID / Node ID / 招待証明書チェーン / 招待バンドル
  events.ts       JOIN / HEARTBEAT / LEAVE / MANIFEST / SIGNAL の生成と検証
  nameservice.ts  署名付きレコード集合（version → updated_at → 署名で決定的マージ）
  crdt.ts         GSetLog（チャット）と LwwMap（プロファイル）、delta同期対応
src/relay/     Relay サーバー（保存・検索・配布のみ。サービス本体ではない）
  server.ts       WebSocket (EVENT/REQ/EOSE/OK/NOTICE) + REST (POST /event, GET /events)
                  + TTL sweep + 署名検証 + 静的クライアント配信
src/client/    ブラウザノード
  store.ts        IndexedDB（鍵・Peer Table・CRDT・NSキャッシュ・blob）
  relayclient.ts  複数Relay接続プール（全Relayへ発行、id重複排除、ローカル再検証）
  webrtc.ts       WebRTCメッシュ（SIGNALイベントでSDP交換、DataChannel同期）
  main.ts         参加フロー・招待発行・チャット・Name Service・UI
public/        クライアントUI（index.html / styles.css / ビルド生成物 anp.js）
test/          ユニットテスト + Relay統合テスト
```

## プロトコル要点

### Identity（設計書 §4, §12）

- `Network ID = SHA-256(Genesis Public Key)` — 同じ定義から常に同じ名前が得られる
- `Node ID = SHA-256(Node Public Key)` — 秘密鍵は IndexedDB から出ない
- 参加は招待証明書チェーンで証明する。チェーンの先頭は Genesis 鍵の署名、`invite` 権限を持つリンクだけが次のリンクを発行でき、末尾が参加ノードの公開鍵を指名する
- 招待は2段階: 参加者が鍵を生成して公開鍵（参加リクエストコード）を渡し、招待者が証明書チェーンを含む招待バンドルを返す

### イベント（§6, §9, §14）

全イベントは署名必須。`id` は正規化JSONの SHA-256。Relay とクライアントの両方が `verifyEvent`（署名・有効期限・node_id整合・JOINの招待チェーン）を実行する。`SIGNAL` は WebRTC の offer/answer を運ぶ point-to-point イベントで、Relay は宛先ノードにしか配布しない。

### Relay（§7）

イベントの保存・検索・配布・TTL破棄のみを行う。ユーザーデータの永続保管、ルール裁定、サービス実行はしない。状態はメモリのみ — 消えても各ノードが再アナウンスして再生成される（§13「復元ではなく再生成」）。クライアントは複数 Relay に同時接続し、単一 Relay への依存を避ける（§14.3）。

### WebRTC メッシュ（§9）

Node ID が辞書順で小さい側が offer を出す（glare 回避）。ICE gathering 完了を待って SIGNAL 1往復で接続する。DataChannel 上のプロトコル: `HELLO`（自己紹介 + Peer Table gossip）、`SYNC_REQ` / `CHAT_DELTA` / `PROFILE_DELTA`（CRDT delta 同期）、`NS`（Name Service レコード複製）。

### Name Service（§10）

単一サーバーではなく署名付きレコード集合。全ノードが複製し、同じ決定的マージ規則（version 大 → updated_at 大 → 署名の辞書順、署名不正は破棄、TTL失効）を適用するため、全レプリカが同じ「最新値」に収束する。

### CRDT（§11.3）

- `GSetLog`: grow-only set + Lamport clock。チャットに使用。マージは集合和なので到達順序・重複に依存せず収束する
- `LwwMap`: last-writer-wins レジスタマップ。プロファイルに使用。タイは replica id で決定的に解消

## 設計書との対応

| 設計書 | 実装 |
|---|---|
| Phase 1: Network ID / 招待証明書 / 署名付きJOIN / Relay保存 / WebRTC接続 | ✅ |
| Phase 2: HEARTBEAT / LEAVE / Peer Table同期 / CRDT delta | ✅ |
| Phase 3: Name Service / service/chat / service/profile | ✅（files はCID関数と blob ストアまで） |
| Phase 4: 複数Relay / レコード複製 / 失効管理(TTL+revokedフラグ) | ✅（信頼スコアは未実装） |

設計書からの実装上の判断:

- **SIGNAL イベントの追加**: 設計書 §6.3 は JOIN に offer を含めるが、answer の返送経路が必要なため、宛先指定の `SIGNAL` イベント（TTL 60秒）を Transport Layer の調停用に追加した。Discovery の4種別（JOIN/HEARTBEAT/LEAVE/MANIFEST）はそのまま維持している
- **招待の2段階ハンドシェイク**: 秘密鍵を招待者側で生成・受け渡ししないため、「参加リクエストコード（公開鍵）→ 招待バンドル」の2段階とした
