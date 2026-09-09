# Neo Memo v1 — 計画書・アーキテクチャ

更新日: 2026-09-08 / 実装バージョン: 1.0.0

## 1. 目的と利用体験

日々目に入るURLや小さな思いつきを、整理の負担なく保存し、あとで確認できる個人用メモ帳を作る。入力時に必須なのはURLまたは短い文章だけ。理由・タグ・タイトルを先に考える必要はない。

スマホでは普段使うSlack / Discordの専用チャンネルへ投稿する。PCを開いたときに、投稿済みの情報がローカルへ取り込まれる。PC側では一覧、検索、メモ追記だけを中心にする。

**v1の到達点は「取り逃さず放り込め、内容と自分の反応をあとで見返せる」こと。** 発想を展開するための別ツールとは、ファイルやCLIを介して接続できるデータ境界にしておく。

## 2. 今回の前提変更に伴う最適化

| 前の構成 | v1で採用した構成 | 理由 |
|---|---|---|
| 常時稼働するWebアプリ / API | Electron内のローカル画面 + Nodeサービス | PC停止時の運用、外部公開、証明書、接続先管理を不要にする |
| POST /captureへの送信 | デスクトップIPC / CLIから同じライブラリを呼ぶ | localhostのHTTPサーバーも不要 |
| Slack/Discordのリアルタイムイベント | 起動・再接続・手動操作時の履歴REST取得 | Botの常駐やイベント配送を受ける公開URLが不要 [S1][S2] |
| SQLite正本・各種インデックス | Markdownを正本とし、読み出して検索 | v1の永続データを一種類に絞り、DB移行や復旧作業をなくす |
| 自動分類が保存の前提 | 保存を先に完了し、補完・分類は後段 | ネット障害・API障害・LLM待ちで入力を妨げない |
| 同期サービス | ローカルGit commit + 明示的なremote同期 | 固定の同期サービス契約を不要にする |

Electronを選ぶ理由は、Web UIとNodeのCLI・ファイル処理・Git処理を同じコードで使うため。Electronの実行基盤自体が小さいわけではなく、v1は操作・依存関係・運用の軽さを優先している。コアとCLIの外部ライブラリ依存はゼロ。

## 3. システム構成

```text
スマホ / 別PC
  Slack専用チャンネル       Discord専用チャンネル
          │                         │
          └──────── 投稿履歴 ───────┘
                       │
               PC接続時にだけREST取得
                       │
┌──────────────── ローカルPC ──────────────────┐
│                                             │
│  Electron UI ── IPC ──┐                      │
│                        ├─ MemoService         │
│  CLI ─── ライブラリ呼出 ┘      │               │
│                         Capture / Edit       │
│                               │              │
│             Markdown + 添付プレビュー画像      │
│                  + 取り込み位置               │
│                               │              │
│                      ローカルGit commit       │
│                               │              │
│  任意・接続時: metadata取得 / LLM / X API      │
│  任意・明示時: Git fetch → FF判定 → push      │
└───────────────────────┬─────────────────────┘
                        │ 明示的に同期
               private Git remote（任意）
```

アプリはTCPポートをlistenしない。Slack/Discordとremote Gitは既存サービスとして使うが、利用者が運用するサーバーはない。

### PCとスマホの機能分担

PCは追加・取り込み・閲覧・編集・検索・Git操作を担当する。スマホはSlack/Discordを使った投稿を担当する。PCを停止したまま、スマホからPC上のライブラリを閲覧することは、この構成には含まれない。これは保存先をローカルにしたことに伴う機能境界であり、スマホから入力できないという意味ではない。

## 4. データ設計

### 4.1 カード

`items/<id>.md` を1カードとする。ファイル名にはURL由来の安定キーのSHA-256先頭32桁を使用する。URLなしのメモは保存イベントIDからキーを作る。同じ文章を別の機会に書いたメモは、勝手に同一視しない。

主要フィールドは `id / key / url / original_url / type / title / description / summary / summary_basis / tags / ai_tags / captures / preview / saved_at / updated_at / enrichment / archived`。Markdown本文を自由追記欄にする。

元の内容・自分のメモ・LLMの整理結果を分離する。手動タグとAIタグも別配列で、再分類は手動タグを消さない。保存理由は各captureイベントの `note` に残す。重複取り込みのために同じカードを増やさない一方、別の理由で保存し直した記録は保持する。

### 4.2 重複判定

XはPost IDが同じなら同じカード。`twitter.com` / `x.com`、ユーザー名の違い、`/photo/1`、追跡パラメータを吸収する。

一般WebはURLを構文として正規化し、既知の追跡パラメータだけ除去する。`id` や `ref`、意味のあるfragment、末尾スラッシュの違いは無差別に消さない。OGPやcanonical指定だけで別URLを自動統合しない。

カードの重複とは別に、`source + event_id` で同じ配送・読み出しイベントの再実行を無害化する。画像は実バイト列のSHA-256で重複排除する。見た目が似た画像を統合する機能ではない。

### 4.3 検索

読み出したファイルから、タイトル、URL、説明、要約、自由メモ、captureの理由、タグをNFKC正規化して検索する。空白で区切った複数語はAND条件。タイトル、メモ、タグの一致を優先し、同点は保存日の降順。

SQLiteや埋め込みDBは必須にしない。GUIは一度に120件まで描画し、「さらに表示」で増やす。大量データで問題が出た際も、検索インデックスだけ後付けでき、正本は変えない。

## 5. 保存と差分取り込み

### 5.1 即時ローカル保存

GUI / CLI入力を解析し、URLキーとイベントIDを決定する。カードを一時ファイルへ書き、fsync後にrenameする。ファイル確定後、管理対象だけをGitにstageしてcommitする。

ファイル保存失敗時には成功を返さない。Git失敗時はファイルを残して明示警告を返す。未保存と未コミットを区別する。通信を伴う補完は、この保存手順の後に実施する。

プロセス内の書き込みキューと、プロセス間のファイルロックでGUI / CLIの競合を防ぐ。**ネットワーク待機中はwriter lockを保持しない**。取得結果を適用する短い区間だけロックする。Git remoteとの同期はcheckoutに相当する操作を伴うため、書き込みと直列化する。

### 5.2 Slack

`conversations.history` を使用。前回完了したhigh-watermarkと、現在のscanの `base / latest / cursor / high` を保存する。古い取り残しがあるのに最新timestampだけを更新して飛ばさないよう、scan完了まで完了済みhigh-watermarkを進めない。

各ページ内のカードが保存できた後にcursorを確定する。途中障害では同じページを再実行できる。Slack cursorが失効した場合は未完了scanを破棄し、最後に完了した位置から安全に読み直す。1回最大5ページとし、続きがある場合はUIに表示する。

無料枠では参照できる履歴に制限があるため、90日以内の取り込みが必要。[S3] v1ではトップレベルの通常投稿が対象。スレッド返信と、取り込み済みの過去投稿の編集・削除は追跡しない。

### 5.3 Discord

`GET /channels/{id}/messages` を使用。新しい側から `before` で過去へ進み、前回のhigh-watermarkへ到達するまで走査する。Message IDは文字列/BigIntとして扱う。

本文が不自然に空の場合はMESSAGE CONTENT INTENTの設定不足を疑い、保存位置を進めず停止する。VIEW_CHANNEL / READ_MESSAGE_HISTORY権限とMESSAGE_CONTENT設定が必要。[S2] ユーザーの通常トークンを使うself-botは使用しない。

### 5.4 X

公式APIのみを使う。ブックマークは1回最大100件。ページに含まれるデータを保存し、next_tokenを記録する。一般の自動取り込みボタンには含めず、明示的に実行する。既知Post IDに出会っただけでscanを打ち切ることもしない。

過去の全ブックマークを必ず回収できるとは保証しない。取得可能な範囲はAPI・認可状態に依存する。取得済みX API JSONのファイルインポートも用意する。OAuthユーザートークンは利用者が取得・更新するv1仕様。[S4][S6]

## 6. メタデータ・画像・AI

### Web / note

指定URLのrobots.txtを確認し、HTMLのheadからtitle / description / author / og:imageを読む。スクリプトは実行せず、本文は保存せず、リンクをたどって資料群を収集しない。別ページへのリダイレクトは遷移先のrobots.txtも確認する。

OGPだけを使う場合でもHTMLへの自動アクセスは発生する。これは「自動アクセスではない」という意味ではない。robots.txtはアクセス認証や法的な利用許可ではなく、運用上の取得制御として扱う。[S7] サイトの個別条件を確認し、必要なURLは自動取得を使わずメモだけ保存する。

汎用取得はサイズ・時間・リダイレクトに上限を設ける。プライベートIP、loopback、認証情報入りURL、非HTTP(S) URLを拒否し、DNSの確認結果を実接続へ固定する。取得できなくても、URLと自分のメモは残る。

### 画像

GUIでは最大5 MiBの入力から、長辺1200pxのJPEGプレビューを作る。保存サイズは1 MiB以下。表示用画像はローカルに保存し、カードを開くたびに第三者へ画像リクエストを送らない。

CLIは画像処理ライブラリに依存せず、取得したPNG/JPEG/WebP/GIFが1 MiB以下の場合のみ保存する。SVGや動画は保存対象にしない。複数画像の完全アーカイブではなく、1カードにつき表示用プレビュー1枚。

### AI

Responses APIを使用し、`store:false`、構造化出力、入力サイズ制限を設定する。利用者がAPIキーとモデル名を設定し、手動または自動生成を明示的に有効化したときだけ呼ぶ。[S8]

一般記事の全文を送っていない場合には「メタデータからのAI説明」と表示し、本文を読んだ要約に見せない。メモ送信は別のopt-in。URLなしのメモを処理するには、そのopt-inが必要。

AI応答を待っている間に人間が編集したメモやタグを上書きしない。応答を適用するときに最新版のカードを再読込し、AI専用フィールドだけを更新する。

## 7. Gitと移行

ソースrepoとデータrepoを分離する。データrepoにAPIキーやOS依存設定は含めない。暗号化鍵ストアはOSのアプリデータ領域に置く。safeStorageで安全なバックエンドが使えない場合は、環境変数による実行のみとする。[S5]

remote同期は `commit → fetch → ahead/behind確認 → fast-forward可能なら反映 → push`。履歴が分岐した場合は明示停止する。GUI / CLIが同一PC上で使う分にはロックで保護し、複数PCは1台の主端末を基本とする。

Gitは履歴を保存する。ハッシュ画像でも新しい画像は蓄積するため、容量を無制限に小さく保てるとは主張しない。1 MiBの画像上限は1枚ごとの上限であり、総容量上限ではない。ローカルGitは機器故障から守らないので、remote同期の実行は利用者が行う。

## 8. 実装の単位と受入確認

| 単位 | ファイル | 確認方法 |
|---|---|---|
| Capture / URL正規化 | `src/core/urls.mjs`, `store.mjs` | URL同一化、複数入力、重複メモ、Markdown round-trip |
| 排他・整合性 | `util.mjs`, `service.mjs` | 別サービスインスタンスの同時保存、途中障害、通信中の保存 |
| 取得adapter | `src/adapters/pull.mjs` | ページング、再開、権限不足、X JSON、単一Post取得 |
| Web / AI | `net.mjs`, `metadata.mjs` | SSRF拒否、robots、redirect、取得失敗、AIの手動データ保護 |
| Git | `src/core/git.mjs` | 実Gitによるcommit、local bare remoteへのpush/FF、分岐時停止 |
| Desktop | `src/desktop/`, `src/ui/` | Chromium + 実コアを用いた保存、検索、追記、画像、再表示 |
| CLI | `bin/neo-memo.mjs` | 実ファイル・Gitに対する保存、検索、書き出し |

ここで検証した内容と、実アカウント・Electron本体・各OSで確認が必要な内容は、`TEST_REPORT.md`に区別して記録する。v1の初回導入では、まずAPIなしで1件保存し、その後1つのSlackまたはDiscord専用チャンネルだけを接続して運用を確認する。

## 参照

- [S1] Slack conversations.history: https://docs.slack.dev/reference/methods/conversations.history
- [S2] Discord Message resource: https://docs.discord.com/developers/resources/message
- [S3] Slack Free plan limits: https://slack.com/help/articles/27204752526611-Feature-limitations-on-the-free-version-of-Slack
- [S4] X Bookmarks Lookup: https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup
- [S5] Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- [S6] X OAuth 2.0 PKCE: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- [S7] RFC 9309: https://www.rfc-editor.org/rfc/rfc9309.html
- [S8] OpenAI Responses migration / store: https://developers.openai.com/api/docs/guides/migrate-to-responses
