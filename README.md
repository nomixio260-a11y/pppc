# ANP Chat — 分散型チャットサービス

サーバーにメッセージを預けない分散チャット。**表示名を決めるだけ**で使えて、**チャンネル**（公開グループ）と**DM**（1対1・エンドツーエンド暗号化）を、LINE/Slack のような画面で使えます。相手の発見だけを Relay（軽量な中継サーバー）が担い、チャット本体はブラウザ同士が WebRTC で直接つながって流れます。基盤は自律分散プロトコル ANP v2（[プロトコル詳細](#プロトコル要点)）。

- **チャンネル**: `#名前` の公開ルーム。サイドバーから作成/参加。同じチャンネルを開いた人と自動でつながる。`network_id = SHA-256("anp-open-v1:"+名前)`
- **DM**: 相手の「ユーザーID」を指定して1対1。本文は2人だけが導出できる ECDH 共有鍵で暗号化され、Relay にも中身は見えない。`network_id = SHA-256("anp-open-v1:dm:"+2人の公開鍵)`、当事者以外は参加不可
- **複数会話を同時に**保持し、サイドバーで切替（未読バッジつき）
- 招待制ネットワーク（承認した人だけ）はプロトコルとして残っているが、UIの主役はチャンネル/DM

```text
表示名 → 端末に鍵を生成 → チャンネル/DMごとに Network ID
       → Relayで相手を自動発見 → E2E暗号シグナリング → WebRTC直結
       → 署名付きCRDTでメッセージ同期（DMは本文も暗号化）
```

## 使い方

### PC / ブラウザ

```bash
npm install
npm start          # Relay + フロントを起動 → http://localhost:8787/
```

1. 開いたら**表示名**を入れて「はじめる」。自動で `#general` に入ります。
2. 左のサイドバーが会話一覧。**「＃ チャンネル」**で公開ルームを作成/参加、**「✉ DM」**で1対1を開始。
3. 同じ Relay につないだ人が同じチャンネルを開くと自動で接続し、チャットできます。

### 📱 スマホでの使い方

スマホのブラウザ（iOS Safari / Android Chrome）で、PCで動かしている Relay の URL を開くだけです。

1. **Relay を公開URLで用意する**（どれか）
   - 手軽: GitHub の **Actions → "ANP Demo (Cloudflare Tunnel)"** を実行 → 表示された `https://….trycloudflare.com` をスマホで開く（下記デモ参照）
   - 自前: どこか（VPS等）で `npm start` し、`https://` で公開（スマホの WebRTC/Web Crypto は **https 必須**）
2. スマホのブラウザでその URL を開く → 表示名を入れて「はじめる」
3. **画面はスマホ最適化**: 一覧をタップすると会話が全画面で開き、左上の「←」で一覧に戻る。下部の入力欄からメッセージ送信、📎でファイル共有。
4. **友達を招く**: チャンネルの共有ボタン（右上）で `#channel=名前` 付きリンクをコピー/共有 → 相手が開けば同じチャンネルへ。DM は設定（歯車）→「あなたのID」を相手に渡し、相手のIDで「✉ DM」から開始。
5. ホーム画面に追加すればアプリのように起動できます（PWA 相当の全画面表示・セーフエリア対応済み）。

> スマホは `https`（またはlocalhost）でないと Web Crypto / WebRTC が動きません。`http://<PCのIP>` 直アクセスでは動かない点に注意（Cloudflare Tunnel を使えば https で解決）。

### フロントだけをダウンロードして配布する

`npm run build` で **`dist/`** フォルダ（`index.html` + `styles.css` + `anp.js` + 単一ファイル版 `anp.html` + 説明書）が生成されます。これがフロント一式です。

- 任意の静的ホスティング（GitHub Pages / Netlify / `npx serve` / nginx …）に `dist/` を置き、Relay を指定すれば動きます。
- GitHub の Actions 実行結果 → Artifacts の **`anp-frontend`**（フロント一式のzip）／**`anp-single-file-html`**（`anp.html` 単体）からダウンロードできます。
- 注: 複数ファイル版はブラウザのモジュール制約で `file://` 直開きはできません（http(s) 配信が必要）。`file://` で開きたい場合は単一ファイルの `anp.html` を使ってください。

### 公開デモ（GitHub Actions + Cloudflare Tunnel）

中央サーバーを常設せずに、一時的な公開デモを起動できる。GitHub の **Actions → "ANP Demo (Cloudflare Tunnel)" → Run workflow** を実行すると、Actions ランナー内で Relay が起動し、Cloudflare Tunnel 経由で公開URL（`https://<ランダム>.trycloudflare.com`）がジョブサマリーに表示される。そのURLを複数のブラウザ/プロファイルで開けば招待制P2Pネットワークを試せる。指定した分数が過ぎるとトンネルは自動停止する。

> **「Run workflow」ボタンが出ない場合**: `workflow_dispatch` のワークフローは、そのファイルが**デフォルトブランチ（main等）に存在する場合のみ** Actions UI に手動実行ボタンが表示される、というGitHubの仕様。作業ブランチのままでは出ない。デフォルトブランチにこのブランチをマージ（またはワークフローファイルを取り込み）すればボタンが現れる。マージ前でも、`push` で走る **CI** ワークフローが毎回 `anp.html` を Artifacts に上げるので、そこからダウンロードしてローカルで開けば（上記「最短で試す」）サーバーなしで試せる。

- 難易度と起動時間は Run workflow の入力で指定
- 安定したホスト名が欲しい場合はリポジトリシークレット `CF_TUNNEL_TOKEN`（named tunnel のトークン）と変数 `CF_PUBLIC_URL` を設定
- ローカルでも同じことができる: `cloudflared` を入れて `DURATION=1800 bash scripts/demo.sh`

Tunnel の背後では全クライアントが同一送信元IPに見えるため、Relay は `ANP_TRUST_PROXY=1` のとき `CF-Connecting-IP` / `X-Forwarded-For` を使ってIP毎レート制限を正しく効かせる（直接公開時はヘッダを信用しない安全側がデフォルト）。`scripts/demo.sh` はトンネルがエッジに接続登録されるまで待ってからURLを提示するので、到達不能なURLを渡さない。

> 注: cloudflared はエッジ接続に outbound port 7844（QUIC/TCP）を使う。GitHub Actions ランナーはこれを許可するが、ポート7844を塞ぐ制限環境ではトンネルが張れずスクリプトが明示エラーで停止する（その場合はビルド・Relay・URL発行までは確認できる）。

別の端末やブラウザプロファイル（シークレットウィンドウ等）で同じ Relay を開くと、それぞれ独立ユーザーになり、同じチャンネル/相互DMで接続します（IndexedDB がプロファイルごとに分かれる）。

- 難易度と起動時間は Run workflow の入力で指定
- 安定したホスト名が欲しい場合はリポジトリシークレット `CF_TUNNEL_TOKEN`（named tunnel のトークン）と変数 `CF_PUBLIC_URL` を設定
- ローカルでも同じことができる: `cloudflared` を入れて `DURATION=1800 bash scripts/demo.sh`

Tunnel の背後では全クライアントが同一送信元IPに見えるため、Relay は `ANP_TRUST_PROXY=1` のとき `CF-Connecting-IP` / `X-Forwarded-For` を使ってIP毎レート制限を正しく効かせる（直接公開時はヘッダを信用しない安全側がデフォルト）。

> **「Run workflow」ボタンが出ない場合**: `workflow_dispatch` はワークフローファイルが**デフォルトブランチに存在する場合のみ**手動実行ボタンが出る、というGitHubの仕様。マージ前でも `push` で走る **CI** が `anp-frontend`（フロント一式）と `anp.html` を Artifacts に上げるので、そこから取得できる。
> cloudflared はエッジ接続に outbound port 7844（QUIC/TCP）を使う。ポート7844を塞ぐ環境ではトンネルが張れず、`scripts/demo.sh` は明示エラーで停止する。

## コマンド

| コマンド | 説明 |
|---|---|
| `npm run build` | 型チェック + フロントビルド（`public/anp.js`・単一ファイル`anp.html`・配布`dist/`） |
| `npm run relay` | Relay サーバー起動（`PORT` / `HOST` / `ANP_POW_BITS` / `ANP_TRUST_PROXY`） |
| `npm start` | build + relay |
| `npm test` | ユニット + Relay 統合テスト（70件） |
| `npm run test:e2e` | 実ブラウザE2E（チャンネル自動探索 + 暗号DM、要 Chromium） |
| `bash scripts/demo.sh` | Relay起動 + Cloudflare Tunnel で公開 |

## 構成

```text
src/shared/    ブラウザ・Node 共通（Web Crypto ベース）
  crypto.ts       ECDSA P-256署名 / SHA-256 / CID / ECIES / DM共有鍵(ECDH) / 軽量PoW
  identity.ts     Network ID / Node ID / オープンルーム / DMルーム導出 / 招待チェーン
  events.ts       JOIN(PoW・オープン/DM/招待) / HEARTBEAT / LEAVE / MANIFEST / SIGNAL(E2E暗号)
  nameservice.ts  署名付きレコード集合（決定的マージ・著者別失効）
  crdt.ts         GSetLog（VV同期・エポックorigin・署名エントリ）と LwwMap
  reputation.ts   ローカル信頼スコア（挙動観測→加減点・遮断）
src/relay/     Relay サーバー（発見の中継のみ。メッセージ本体は持たない）
  server.ts       WebSocket + REST + TTL + 署名/PoW検証 + メンバーシップゲート + レート制限
src/client/    フロント
  conversation.ts 1会話ぶんのランタイム（Relay購読 + WebRTCメッシュ + チャットCRDT + DM暗号）
  main.ts         オーケストレータ（アイデンティティ + 会話一覧 + サイドバーUI）
  webrtc.ts       WebRTCメッシュ（Trickle ICE・E2E暗号SIGNAL・keepalive・再試行）
  relayclient.ts  複数Relay接続プール（送信キュー・バックオフ）
  files.ts        ファイル共有（CID検証付きチャンク転送）
  store.ts        IndexedDB（IndexedDB不可環境はメモリfallback）
public/        フロントUI（index.html / styles.css / ビルド生成物）
dist/          配布用フロント一式（ビルドで生成）
test/          ユニット70件 + 実ブラウザE2E
```

以下は基盤プロトコル ANP v2 の詳細（チャットUIはこの上に構築）。

## プロトコル要点

### 会話モデル（チャンネル / DM）

- **チャンネル**: オープンルーム。`network_id = SHA-256("anp-open-v1:"+正規化した名前)`。JOIN は招待チェーン不要で、署名 + PoW のみ。同名チャンネルを開いた全員が同じ `network_id` を計算して Relay で出会い、WebRTC メッシュを組む。
- **DM**: `network_id = SHA-256("anp-open-v1:dm:"+ソートした2つの公開鍵)`。当事者2人だけがこの値を計算でき、`verifyEvent` は DM ルームへの JOIN を**当事者2名の公開鍵に限定**する（第三者は参加不可）。本文は両者が `ECDH(自分の秘密鍵, 相手の公開鍵)` から HKDF で導く同一の AES-256-GCM 鍵で暗号化するため、Relay も第三者も復号できない。CRDT エントリはこの暗号文を運び、表示時に復号する。
- 各会話は独立した `Conversation`（Relay購読 + メッシュ + チャットCRDT）。1つのアイデンティティ（端末の鍵）で複数を並行実行し、サイドバーで切替える。
- **プライバシー注記**: DM の**本文**は秘匿されるが、Relay は「ある `network_id` に2つの JOIN がある」というメタデータは観測しうる（誰と誰か＝公開鍵は、room 文字列を持たない限り即座には分からないが、相関の余地は残る）。完全なメタデータ秘匿（誰が誰とやり取りしたか）はミックスネット等が必要で本実装の範囲外。

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
| 13 | オープンルーム（招待不要・自動探索）をデフォルトに、招待制をサブ機能へ | すぐ使えるチャットに |
| 14 | スマホ対応のモダンなチャットUIに全面刷新 | バブル・アバター・ドロワー・ライト/ダーク |
| 15 | **チャンネル＋DM（複数会話の同時実行）+ サイドバー** | 本物のチャットサービスの会話モデル |
| 16 | **DMの本文暗号化**（当事者2人がECDHで導く共有鍵・AES-GCM） | 1対1は当事者以外（Relay含む）復号不可、第三者はDM網に参加不可 |
| 17 | フロント一式(`dist/`)配布 + 相対パス化 | 任意の静的ホストに置ける／Actionsアーティファクト化 |

**設計上の既知のトレードオフ**: JOIN の招待チェーンは Relay がスパム対策として検証するため、Relay はネットワークのメンバーグラフ（公開鍵・招待関係・ニックネーム）を観測できる。SDP・チャット・ファイルは見えない。メンバーグラフも隠す場合は Relay の検証を放棄する必要があり、本実装では検証を優先した。

## 検証

- `npm test`: 70件 — 暗号（ECIES・PoW）、証明書チェーン（偽造/期限/失効/昇格/長さ）、**オープンルーム（room束縛JOIN・招待網侵入不可・PoW必須）**、**DM（共有鍵の対称性・第三者は復号/参加不可）**、イベント（改ざん/リプレイ/期限）、CRDT（収束/VV/エポック/署名）、NS（決定的マージ/著者別失効/squat防止/再ゴシップ抑止）、信頼スコア、Relay統合（メンバーシップゲート/不正イベント耐性）
- `npm run test:e2e`: 実ブラウザ — **表示名だけで #general に自動参加→自動探索→WebRTC接続**、チャンネル双方向チャット、CID検証ファイル転送、**ECDH暗号DMの双方向同期**、共有リンクからのチャンネル参加。スマホ(390px)/PC 両ビューポートでスクリーンショット確認済み
- 4ラウンドの敵対的監査（AIエージェントによる多次元レビュー＋反証検証）を実施し、各ラウンドの確認済み欠陥をすべて修正（クリティカル: Relayクラッシュ、失効un-revoke攻撃、NSゴシップ無限ストーム 等）
- 4ラウンドの敵対的監査（AIエージェントによる多次元レビュー＋反証検証）を実施し、各ラウンドの確認済み欠陥をすべて修正（クリティカル: Relayクラッシュ、失効un-revoke攻撃、NSゴシップ無限ストーム 等）
