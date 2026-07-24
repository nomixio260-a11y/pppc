# ANP: Autonomous Network Protocol (v2)

ブラウザ完結型・分散チャットネットワークの実装。**ルーム名を入れて参加するだけ**で、Relay 経由で自動的に他の参加者を見つけ、ブラウザ同士が WebRTC で直接つながる。設計書 v1.0 に準拠しつつプロトコルを v2 に進化させている（[進化点](#設計書からのプロトコル進化v2)参照）。

- **デフォルト = オープンルーム（自動探索）**: `network_id = SHA-256("anp-open-v1:"+ルーム名)`。招待不要、URL/ルーム名を共有するだけで誰でも参加。Sybil対策は JOIN の proof-of-work とローカル信頼スコア。
- **招待制ネットワーク = サブ機能**: 承認した相手だけが入れる非公開ネットワーク（従来の genesis + 招待証明書チェーン）も作れる。
- 発見は Relay（Nostr風の署名イベント中継）、通信は WebRTC DataChannel、状態は署名付き CRDT と Name Service、永続化は IndexedDB。

```text
ルーム名 → Network ID → Relayで自動発見 → E2E暗号シグナリング
        → WebRTCメッシュ → 署名付きCRDT/ファイル同期
```

UI はスマホ対応のモダンなチャットアプリ。ライト/ダーク自動対応。

## クイックスタート

```bash
npm install
npm start          # ビルドして Relay + クライアントUI を起動
# → http://localhost:8787/ をブラウザで開く → ルーム名を入れて「参加する」
```

同じルームを別のブラウザ/プロファイル（またはスマホ）で開くと、自動で相互接続してチャットできる。`共有リンクをコピー` で `#room=...` 付きのリンクを配れば、開いてワンタップで参加。

`public/anp.html` は JS/CSS を全部インライン化した単一ファイル版（Actions の `anp-single-file-html` アーティファクトからも取得可）。Relay 配信のページと同じもので、http(s) 経由で開けば同様に動作する。

### 公開デモ（GitHub Actions + Cloudflare Tunnel）

中央サーバーを常設せずに、一時的な公開デモを起動できる。GitHub の **Actions → "ANP Demo (Cloudflare Tunnel)" → Run workflow** を実行すると、Actions ランナー内で Relay が起動し、Cloudflare Tunnel 経由で公開URL（`https://<ランダム>.trycloudflare.com`）がジョブサマリーに表示される。そのURLを複数のブラウザ/プロファイルで開けば招待制P2Pネットワークを試せる。指定した分数が過ぎるとトンネルは自動停止する。

> **「Run workflow」ボタンが出ない場合**: `workflow_dispatch` のワークフローは、そのファイルが**デフォルトブランチ（main等）に存在する場合のみ** Actions UI に手動実行ボタンが表示される、というGitHubの仕様。作業ブランチのままでは出ない。デフォルトブランチにこのブランチをマージ（またはワークフローファイルを取り込み）すればボタンが現れる。マージ前でも、`push` で走る **CI** ワークフローが毎回 `anp.html` を Artifacts に上げるので、そこからダウンロードしてローカルで開けば（上記「最短で試す」）サーバーなしで試せる。

- 難易度と起動時間は Run workflow の入力で指定
- 安定したホスト名が欲しい場合はリポジトリシークレット `CF_TUNNEL_TOKEN`（named tunnel のトークン）と変数 `CF_PUBLIC_URL` を設定
- ローカルでも同じことができる: `cloudflared` を入れて `DURATION=1800 bash scripts/demo.sh`

Tunnel の背後では全クライアントが同一送信元IPに見えるため、Relay は `ANP_TRUST_PROXY=1` のとき `CF-Connecting-IP` / `X-Forwarded-For` を使ってIP毎レート制限を正しく効かせる（直接公開時はヘッダを信用しない安全側がデフォルト）。`scripts/demo.sh` はトンネルがエッジに接続登録されるまで待ってからURLを提示するので、到達不能なURLを渡さない。

> 注: cloudflared はエッジ接続に outbound port 7844（QUIC/TCP）を使う。GitHub Actions ランナーはこれを許可するが、ポート7844を塞ぐ制限環境ではトンネルが張れずスクリプトが明示エラーで停止する（その場合はビルド・Relay・URL発行までは確認できる）。

複数ノードを試すには、同じURLを **別のブラウザプロファイル**（またはシークレットウィンドウ）で開く。IndexedDB がプロファイルごとに分かれるため、それぞれが独立ノードになる。

1. ブラウザA: 「ネットワークを作成して参加」→ Genesis 鍵と Network ID が生成される
2. ブラウザB: 「参加リクエストコードを作成」→ 表示されたコード（公開鍵）をAに渡す
3. ブラウザA: 「招待を発行」にコードを貼り付け → **招待リンク**（または招待バンドル）をBに渡す
4. ブラウザB: リンクを開く（バンドル自動入力）→ 参加 → Relay 経由で発見 → WebRTC 直接接続
5. チャット・**ファイル共有**・Name Service レコードが DataChannel 越しに同期される
6. 招待の**失効**は「発行済み招待」から。失効すると該当ノード（とその招待で連なる全ノード）が排除される

## コマンド

| コマンド | 説明 |
|---|---|
| `npm run build` | 型チェック + クライアントバンドル生成 (`public/anp.js`) |
| `npm run relay` | Relay サーバー起動（`PORT` / `HOST` / `ANP_POW_BITS` / `ANP_TRUST_PROXY` 環境変数対応） |
| `npm start` | build + relay |
| `npm test` | ユニット + Relay 統合テスト（61件） |
| `npm run test:e2e` | 実ブラウザ3ノードE2E（要 Chromium、Relay自動起動） |
| `bash scripts/demo.sh` | Relay起動 + Cloudflare Tunnel で公開（`cloudflared` 必要、`DURATION`秒） |

## 構成

```text
src/shared/    ブラウザ・Node 共通（Web Crypto ベース）
  crypto.ts       ECDSA P-256 署名 / SHA-256 / 正規化JSON / CID /
                  ECIES(ECDH-ES+HKDF+AES-GCM) / 軽量PoW
  types.ts        プロトコル型定義（イベント・証明書・NSレコード・メンバー）
  identity.ts     Network ID / Node ID / 招待証明書チェーン（権限昇格防止・
                  長さ上限・失効対応）/ 招待バンドル
  events.ts       JOIN(PoW付き) / HEARTBEAT / LEAVE / MANIFEST / SIGNAL(E2E暗号)
  nameservice.ts  署名付きレコード集合（決定的マージ・TTL・著者別失効レコード抽出）
  crdt.ts         GSetLog（バージョンベクトル同期・エポックorigin）と LwwMap、
                  エントリ/セルの署名・検証
  reputation.ts   ローカル信頼スコア（挙動観測→加点/減点・遮断・プロバイダ順位）
src/relay/     Relay サーバー（保存・検索・配布のみ。サービス本体ではない）
  server.ts       WebSocket (EVENT/REQ/EOSE/OK/NOTICE) + REST + TTL sweep +
                  署名/PoW検証 + メンバーシップゲート + レート制限 + 静的配信
src/client/    ブラウザノード
  store.ts        IndexedDB（鍵・メンバー・CRDT・NS・blob）
  relayclient.ts  複数Relay接続プール（送信キュー・ジッター付きバックオフ・統計）
  webrtc.ts       WebRTCメッシュ（Trickle ICE・E2E暗号SIGNAL・keepalive・
                  ハンドシェイクタイムアウト・指数バックオフ再試行）
  files.ts        service/files: CID検証付きチャンク転送（バックプレッシャー対応）
  main.ts         参加/招待/失効フロー・メンバーレジストリ・ゴシップ同期・UI
public/        クライアントUI
test/          ユニット52件 + 実ブラウザ3ノードE2E
```

## プロトコル要点

### Identity（設計書 §4, §12）

- `Network ID = SHA-256(Genesis Public Key)` — 同じ定義から常に同じ名前が得られる
- `Node ID = SHA-256(Node Public Key)` — 秘密鍵は IndexedDB から出ない
- 参加は招待証明書チェーンで証明。先頭は Genesis 鍵の署名、`invite` 権限を持つリンクだけが委譲でき、**各リンクの権限は発行者の権限の部分集合**（権限昇格不可）、長さは16まで
- 招待は2段階: 参加者が鍵を生成して公開鍵（参加リクエストコード）を渡し、招待者が証明書チェーンを含む招待バンドル/リンクを返す
- **失効**: 発行者または Genesis 鍵が `revoked/<invite_id>` NSレコードを発行すると、そのリンクに依存する全チェーンが無効化され、接続中のノードも排除される

### イベント（§6, §9, §14）

全イベントは署名必須。`id` は正規化JSONの SHA-256。Relay とクライアントの両方が `verifyEvent`（署名・有効期限≦24h・node_id整合・JOINの招待チェーン+PoW）を実行する。検証は例外を投げない（不正入力でRelayを落とせない）。

- **JOIN**: 招待チェーン + **12bit PoW**（正規ノードは瞬時、Sybil量産には実コスト）。TTL 300s、240s毎に再発行
- **SIGNAL**: WebRTC offer/answer/ICE candidate を **ECIES(ECDH-ES+HKDF+AES-256-GCM) で宛先ノード公開鍵に暗号化**して運ぶ。Relay は SDP（IPアドレス含む）を見られず、候補注入もできない。セッション毎の連番でリプレイ排除。Relay は宛先ノードにのみ配布

### Relay（§7）

保存・検索・配布・TTL破棄のみ。ユーザーデータ永続化・ルール裁定・サービス実行はしない。状態はメモリのみ — 消えても各ノードが再アナウンスして再生成される（§13「復元ではなく再生成」）。

堅牢化: 接続毎トークンバケット、REST per-IP レート制限、WS ping/pong 死活監視、接続数上限、購読上限、**メンバーシップゲート**（チェーン検証済みJOINを持つノードのみ非JOINイベントを保存可能 — 捨て鍵での洪水を遮断）、ノード毎イベント上限（SIGNAL は別枠）、ネットワーク数上限は LRU 退避。

### WebRTC メッシュ（§9）

Node ID が辞書順で小さい側が offer を出す（glare 回避、防御的glare解決も実装）。**Trickle ICE** で候補を暗号化SIGNALとして逐次交換し、最初の有効経路が見つかり次第接続。全ハンドシェイクに期限（25s）があり、失敗・停滞はジッター付き指数バックオフで自動再試行 — 失われたSIGNALがペアを永久に固着させることはない。接続後は PING/PONG keepalive（50s無応答で再接続）。古いofferの再配は `created_at` 順序で無視。

### Data Layer（§11）

- **service/chat**: GSetLog（grow-only set + Lamport順序）。エントリは**origin鍵で署名**され、originはエポック付き（`<node_id>.<epoch>`）— 同一identityを別ブラウザに復元してもID衝突による分岐が起きない。**バージョンベクトル**でanti-entropy（未知originの取りこぼしなし）
- **service/profile**: LwwMap。セルは署名付きで、**自分の名前空間（`<field>/<node_id>`）にしか書けない**
- **service/files**: CID（SHA-256）参照のファイル共有。16KiBチャンク転送、DataChannelバックプレッシャー対応、受信側で再ハッシュ検証（改ざん・破損は必ず検出）
- **同期はゴシップ**: マージした差分は他の接続ピアへ転送され（部分メッシュでも伝播）、60s毎にランダムピアと anti-entropy 交換
- **メンバーレジストリ**: 検証済みJOIN/HELLO/MEMBER_PROOFから構築。CRDT書き込みは登録メンバーのみ受理（未知originは MEMBER_REQ/MEMBER_PROOF で証明要求、保留プール経由）。証明書が後に期限切れになったメンバーの履歴は「履歴専用メンバーシップ」（構造+署名+失効のみ検証）で新規ノードでも検証可能

### Name Service（§10）

単一サーバーではなく署名付きレコード集合。決定的マージ（version 大 → updated_at 大 → 署名辞書順、期限切れの保存レコードは新レコードに必ず負ける）。**書き込みは検証済みメンバーと Genesis 鍵のみ**（非メンバーによる汚染不可）。

失効は**複数著者の加算的・単調集合**として扱う。各失効レコードは著者ごとに独立した名前 `revoked/<invite_id>/<author_pubkey>` を持ち、著者束縛（名前の著者セグメント == レコード署名者）と値検証（`{kind:"revocation"}` のみ）を merge 時に強制する。これにより、任意のメンバーが高versionレコードで他者の失効枠を上書き・消去して失効を無効化する攻撃（LWW squatting）を構造的に排除している。失効が実際に効力を持つのは、著者が当該証明書の発行者または Genesis 鍵の場合のみ（`isCertRevoked`）。

### 信頼スコア（§14.4, Phase 4）

各ノードは他ピアの**ローカルな**信頼スコアを持つ（合意もゴシップもしないので、スコア自体が攻撃対象にならない）。挙動を観測して加減点する: 接続成功・有効な同期・ファイル配信で加点、偽造/未署名エントリ・不正な失効レコード・転送失敗・keepalive切れで減点。閾値（-50）を下回ったピアは完全に無視され（接続も処理もしない）、リンクは切断される。ファイル取得時は高スコアのプロバイダを優先。スコアは IndexedDB に永続化され、再起動ごとに 0 方向へ減衰するので、一時的な問題や古い遮断は時間とともに回復する。UIにスコアを表示し、手動リセットも可能。

### Relay の動的追加・ブートストラップ採用

UIから Relay を追加・削除でき、Genesis ノードが署名して公開する `bootstrap` レコード（relay-set）を非Genesisノードが自動採用する。これにより**固定URLを変えずに**ネットワークが Relay を移行・増設できる（Genesis著者のレコードのみ信用し、既存Relayは落とさず追加のみ）。

### DataChannel の認証について

DataChannel を確立した SDP は宛先ノード鍵に暗号化されているため、チャネルの対端はその鍵の保持者であることが暗黙に認証される。さらに CRDT ペイロードはエントリ単位で署名される（二重の防御）。

## 設計書からのプロトコル進化（v2）

| # | 進化 | 理由 |
|---|---|---|
| 1 | SIGNAL の E2E 暗号化（ECIES） | Relay に SDP（IP露出）を見せない。悪意あるRelayの候補注入も不可に |
| 2 | Trickle ICE + ハンドシェイク期限 + 再試行バックオフ | 接続確立の高速化と、SIGNAL喪失による永久固着の排除 |
| 3 | JOIN への軽量PoW（§14.4の具体化） | 捨て鍵の大量生成に実コストを課す。Relayのメンバーシップゲートと併用 |
| 4 | CRDTエントリ/セルの署名 + メンバーレジストリ | メンバー間でも他人のメッセージ・プロファイルを偽造不可能に |
| 5 | 招待チェーンの権限部分集合ルール + 長さ上限 | 権限昇格と検証CPU DoSの排除 |
| 6 | 失効の実装（`revoked/` NSレコード + 生接続への執行） | 設計書の「失効フラグ」を分散環境で実際に機能する形に |
| 7 | バージョンベクトル同期 + ゴシップ転送 + 周期anti-entropy | 部分メッシュ・分断復帰でも全レプリカが収束 |
| 8 | エポック付きorigin | 同一identityの複数セッションによるCRDT分岐を構造的に排除 |
| 9 | 履歴専用メンバーシップ | 証明書期限切れメンバーの過去ログを新規ノードでも検証可能に |
| 10 | 招待リンク / identity エクスポート・インポート / sendBeacon LEAVE | 実運用のUX |
| 11 | ローカル信頼スコア（Phase 4） | 挙動観測で悪意ノードを自動遮断・プロバイダ選好 |
| 12 | Relay動的編集 + Genesis署名bootstrap採用 | 固定URLのままRelayを移行・冗長化 |
| 13 | オープンルーム（招待不要・自動探索）をデフォルトに、招待制をサブ機能へ | ルーム名を入れるだけで参加でき、招待の手間なくすぐ使える |
| 14 | スマホ対応のモダンなチャットUIに全面刷新 | メッセージバブル・アバター・ドロワー・ライト/ダーク |

**設計上の既知のトレードオフ**: JOIN の招待チェーンは Relay がスパム対策として検証するため、Relay はネットワークのメンバーグラフ（公開鍵・招待関係・ニックネーム）を観測できる。SDP・チャット・ファイルは見えない。メンバーグラフも隠す場合は Relay の検証を放棄する必要があり、本実装では検証を優先した。

## 検証

- `npm test`: 67件 — 暗号（ECIES正逆・鍵違い・PoW）、証明書チェーン（偽造/期限/失効/昇格/長さ）、**オープンルーム（room束縛JOIN・招待網への侵入不可・PoW必須）**、イベント（改ざん/リプレイ/期限）、CRDT（収束/VV/エポック/署名）、NS（決定的マージ/期限切れ復帰/著者別失効/squat防止/重複再ゴシップ抑止）、信頼スコア（加減点/遮断/順位/減衰）、Relay統合（メンバーシップゲート/不正イベント耐性/SIGNAL宛先配布）
- `npm run test:e2e`: 実ブラウザ3ノード — **ワンタップでオープンルームに参加→自動探索→WebRTC接続**、署名チャット双方向同期、CID検証ファイル転送、共有リンクからの参加、参加前履歴の受信、**Relay停止中のP2P継続**、Relay再起動後の再接続
- 4ラウンドの敵対的監査（AIエージェントによる多次元レビュー＋反証検証）を実施し、各ラウンドの確認済み欠陥をすべて修正（クリティカル: Relayクラッシュ、失効un-revoke攻撃、NSゴシップ無限ストーム 等）
