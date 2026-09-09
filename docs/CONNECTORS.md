# Neo Memo v1 — 接続設定と初回運用

2026-09-08。実APIへの接続には自分のアカウントで作成したトークンが必要です。この配布物に鍵は含みません。

## 最初の動作確認

Node.js 22以上とGitを入れ、ソースフォルダで `npm install` → `npm start`。まず連携なしでURLとメモを1件保存してください。「保存先を開く」で `items/` のMarkdownを確認できます。下部のGit警告が空で、HEADが表示されていればローカルcommitも完了しています。

設定画面で専用データフォルダを変更できます。既存のソースrepoではなく、空の専用フォルダ、または既存のNeo Memoデータrepoを選んでください。フォルダを変更しても、旧データが自動的に新フォルダへ移動するわけではありません。

## Slack

### Appを作成する

Slack App管理画面（https://api.slack.com/apps）で、使用するワークスペースに自作Appを作成します。組織のワークスペースでは管理者の承認が必要な場合があります。自分専用のワークスペースとprivate channelでの運用が分かりやすい構成です。

「From a manifest」を選ぶ場合は `examples/slack-app-manifest.json` を使えます。手動で設定する場合は、Bot Token Scopesへ使用する場所に応じて次を追加します。

| 場所 | scope |
|---|---|
| private channel | `groups:history` |
| public channel | `channels:history` |
| BotとのDM | `im:history` |

最初はprivate channel 1つだけでも構いません。Manifest例には3種類を含みますが、使わないscopeは削除できます。v1ではワークスペース一覧・チャンネル一覧を取得しないので、一覧取得のscopeは要求しません。[S1]

Appをワークスペースへインストールし、OAuth & Permissionsに表示される **Bot User OAuth Token（通常 `xoxb-`）** をコピーします。`xapp-` のApp-level TokenやIncoming Webhook URLを入力する構成ではありません。

`#neo-memo` などの専用チャンネルを作り、チャンネルの「インテグレーション / Appを追加」からBotを参加させます。チャンネル詳細からChannel IDをコピーしてください。スコープを変更した場合はAppを再インストールします。

### Neo Memoへ登録する

「設定・連携」のSlack欄にTokenとChannel IDを入力します。複数のIDはカンマ区切りです。User ID欄は空なら対象チャンネルの人間の投稿を読みます。自分の投稿だけに限定したい場合は自分のMember IDを指定します。機密情報を含む共有チャンネルを指定しないでください。

PC / スマホのSlackから、通常のメッセージとして投稿します。

```text
https://example.com/article
この構成が参考になる
```

PCアプリで「取り込む」を実行します。「起動・再接続時に取り込む」が有効なら起動時にも実行します。v1では1回最大5ページ。続きがある場合は再度「取り込む」を実行します。スレッド返信ではなく新しいトップレベル投稿として送ってください。

Events API、Socket Mode、常駐プロセス、公開コールバックURLは不要です。自作の内部利用Appは `conversations.history` の内部App向けレート制限に従います。[S1] サービスが429を返した場合は警告を表示し、次の実行で再開します。

Slack無料枠では履歴へのアクセスが直近90日に制限されます。Slack側で投稿が消える前にPCへ取り込んでください。v1はSlackへの保存完了リアクションを付けず、取り込み結果はPC画面で確認します。[S2]

CLIでも同じ操作ができます。以下はmacOS / Linuxの例です。

```sh
# 実トークンはシェル履歴へ直接書かず、秘密管理ツール等から環境変数へ渡してください。
export SLACK_BOT_TOKEN='<YOUR_BOT_TOKEN>'
node bin/neo-memo.mjs pull slack --channel C0123456789
```

## Discord

Discord Developer Portal（https://discord.com/developers/applications）で自分用ApplicationとBotを作成し、自分のDiscordサーバーへ追加します。ここでいう「Discordサーバー」は既存サービス上のコミュニティであり、自分がマシンを常時稼働するものではありません。

Bot設定のPrivileged Gateway Intentsで **MESSAGE CONTENT INTENT** を有効にします。名前にGatewayとありますが、メッセージ本文フィールドの取得にも影響します。v1はGateway接続を使いません。[S3]

対象チャンネルについて、Botに `View Channel` と `Read Message History` を許可します。投稿・管理者権限は不要です。通常のBot tokenを使い、ユーザーの認証トークンを使うself-bot方式にはしません。[S3]

Discordアプリで開発者モードを有効にしてChannel IDをコピーし、Neo Memoの設定にTokenとIDを入力します。User IDを指定すると自分の投稿だけに限定できます。取り込みはSlackと同じく通常のテキストチャンネルに対して行います。

```sh
export DISCORD_BOT_TOKEN='<YOUR_BOT_TOKEN>'
node bin/neo-memo.mjs pull discord --channel 123456789012345678
```

最初はURL入りの人間の投稿を1件作ってから読み出してください。本文が不自然に空の場合はIntentの不足を警告して停止します。添付ファイルだけの投稿や、Discordフォーラム・スレッドの自動走査はv1の対象にしていません。

## スマホからの入力

iPhone / Androidでは、閲覧中のアプリの「共有」からSlackまたはDiscordを選んで専用チャンネルへ送るか、URLをコピーして貼ります。共有先に直接出るか、チャンネルを毎回選ぶ必要があるかはOS・アプリ側の挙動によります。

PCがオフでも投稿できます。スマホ自身がオフラインのときの送信待ち・再送はSlack/Discord側の挙動です。Neo Memoがスマホ内に独自キューを持つ構成ではありません。PCの電源が切れている間、Neo Memoのライブラリ全体をスマホから閲覧・編集する機能はありません。

## Web / noteの補完

タイトル・説明・プレビュー画像は詳細画面の「情報を補完」から取得します。継続使用する場合は設定で自動補完を有効にします。既定は無効です。本文を読んだ要約ではなく、HTMLメタデータからの説明です。

取得失敗時もURLと保存理由は残ります。ログイン、購読、JavaScript実行が必要なページは取得できない場合があります。タイトルとメモは手動で編集でき、プレビュー画像も手動添付できます。個別サイトの利用条件を無視した取得や認証迂回は実装していません。

## LLM（任意）

設定のOpenAI APIキーとモデル名を入力します。モデル名はそのアカウントで利用可能なResponses API・構造化出力対応モデルを指定してください。アプリにモデル名や単価を固定していません。ChatGPTの契約とは別にAPI側の利用設定が必要です。[S4]

まず詳細画面の「AIで整理」を明示実行して結果を確認します。自動化は「AI自動生成」を有効にします。「自分のメモもモデルへ送る」は別の設定で、既定では無効です。URLなしの私的メモにAI整理を使う場合は、この許可も必要になります。

手動タグやメモは再生成で消えません。AI説明は正本とは分離され、入力に本文がなければ本文要約と表示しません。リクエストでは `store:false` を指定しますが、これだけでAPI提供者側のあらゆる保持がなくなると保証するものではありません。[S4]

## X（任意・API料金に注意）

v1には取得済みトークンを用いるAPI adapterがありますが、**OAuthログイン画面・リダイレクト処理・refresh tokenによる自動更新は実装していません**。ここはSlack / Discordより手動設定の負担が大きい部分です。

ブックマーク読み出しには、自分のXアカウントでOAuth 2.0 PKCE認可を完了したuser access tokenと数値のUser IDが必要です。scopeは `bookmark.read tweet.read users.read`。自分で継続的な更新処理を運用する場合には `offline.access` も関係します。App-only Bearer Tokenではブックマークを取得できません。[S5][S6]

取得済みトークンがある場合は設定へ入力し、「Xブックマーク取得」を実行します。1回最大100件。続きを取得すると追加料金が発生し得ます。自動Slack / Discord取り込みにはX API取得を含めません。

```sh
export X_USER_TOKEN='<YOUR_USER_ACCESS_TOKEN>'
node bin/neo-memo.mjs pull x --user-id 123456789
# 既存Xカードの本文を1件取得する場合
node bin/neo-memo.mjs x-get <LOCAL_ITEM_ID>
```

OAuth設定が未完了でも、XのURLと自分のメモは普通に保存できます。既に取得してあるAPIレスポンスのJSONを読み込む経路もあります。

```sh
node bin/neo-memo.mjs import examples/x-api-page.sample.json
```

この例は架空のfixtureであり実投稿ではありません。Xからダウンロードしたアカウント全体のアーカイブをそのまま解釈する機能ではなく、`data: [...]` と `includes` を持つAPIレスポンス形式です。

## Git remote / PC移行

最初はローカルGitだけで使えます。遠隔バックアップが必要なら、データ用のprivate repositoryを作り、GitのSSH / credential helperを設定してください。

```sh
git -C "/path/to/neo-memo-data" remote add origin <PRIVATE_REPOSITORY_URL>
node bin/neo-memo.mjs git-sync
```

remoteの初期README等と履歴を分岐させないため、remoteは空で用意します。アプリはremote repositoryの作成や強制上書きをしません。Gitの認証を別途確認した後、GUIの「Git remoteへ同期」でも実行できます。

別PCへ移すときはデータrepoをcloneし、Neo Memoの保存先として選択します。API接続設定と鍵は移行先で入れ直します。2台で独立に編集して履歴が分岐した場合は停止するため、主端末を1台に決めて使うのがv1の運用です。

## 参照

- [S1] https://docs.slack.dev/reference/methods/conversations.history
- [S2] https://slack.com/help/articles/27204752526611-Feature-limitations-on-the-free-version-of-Slack
- [S3] https://docs.discord.com/developers/resources/message
- [S4] https://developers.openai.com/api/docs/guides/migrate-to-responses
- [S5] https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup
- [S6] https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
