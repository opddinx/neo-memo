# Neo Memo

Neo Memoは、URLと短いメモを素早く捕獲し、あとから一覧・編集・検索できる軽量な個人用メモアプリです。デスクトップGUIとCLIを備え、常設サーバーを必要としないlocal-first設計です。

Quick Noteに加え、本のタイトルと任意の著者・ページ位置を添えたReading Noteを保存できます。ユーザー本文`content`、出典`source`、派生情報`summary`はStore上で明確に分離されます。

アプリ本体とデータは完全に独立しています。アプリの配置場所からStoreの場所を推測せず、Storeは任意の絶対パスに置けます。個人データを含むStoreは、アプリとは別のprivate Git repositoryとして管理できます。Git remoteは任意で、remoteなしでも保存・閲覧・編集・検索・ローカルcommitが動作します。

## 必要環境

- Node.js 22以上
- Git（Storeのローカル履歴を利用する場合）

```sh
npm install
npm start
```

初回GUI起動時は、既存のNeo Memo Storeを選択するか、空フォルダを明示的にStoreとして初期化します。未設定時に既定フォルダを勝手に作成することはありません。

## CLI

空フォルダをStoreとして初期化します。

```sh
node bin/neo-memo.mjs init store --store /path/to/neo-memo-data
```

すべてのCLI操作で `--store` を指定できます。

```sh
node bin/neo-memo.mjs add "https://example.com" --store /path/to/neo-memo-data
node bin/neo-memo.mjs search "graphics" --store /path/to/neo-memo-data
node bin/neo-memo.mjs add-note "思いついた内容" --store /path/to/neo-memo-data
node bin/neo-memo.mjs add-reading-note --book "The Design of Everyday Things" --location "p.142" "物理的制約そのものより..." --store /path/to/neo-memo-data
```

環境変数も利用できます。`--store` が常に優先されます。

```sh
export NEO_MEMO_STORE=/path/to/neo-memo-data
node bin/neo-memo.mjs list
```

Windows PowerShell:

```powershell
$env:NEO_MEMO_STORE = 'D:\data\neo-memo-data'
node bin/neo-memo.mjs list
```

Store未指定時、CLIは設定方法を示すエラーで終了し、ディレクトリを作成しません。

## Data Store

Canonical Storeは次の3要素だけで解釈できます。

```text
neo-memo-data/
├── neo-memo-store.json
├── items/
└── assets/
```

ItemにはURLと独立した不変IDがあります。assetは `sha256:<hash>` で参照されます。connector checkpoint、検索index、embedding、thumbnail cache、一時ファイル、API tokenはStoreに含まれません。

既存v1 Storeは内容を保持したまま明示的に移行できます。

```sh
node bin/neo-memo.mjs migrate store --store /path/to/existing-v1-store
```

詳細は[Neo Memo Store contract](docs/REPOSITORY-OPERATIONS.md)を参照してください。

## Optional connectors

Slack、Discord、X API、Web metadata取得、LLMによる要約・タグ付けはすべて任意です。基本的なcapture/list/edit/searchに外部APIやAPI keyは不要です。X投稿URLの通常captureは、認証不要の公式oEmbedを使います。ブックマーク同期や詳細情報の取得だけが、明示操作によるX API利用です。設定方法は[Connector guide](docs/CONNECTORS.md)を参照してください。

## テスト

```sh
npm run check
npm test
```

テストは外部API keyや実アカウントを使用しません。Windowsではsymlink作成権限が必要なセキュリティテストだけをskipします。

## ドキュメント

- [Neo Memo Store contract](docs/REPOSITORY-OPERATIONS.md)
- [設計・アーキテクチャ](docs/PLAN.md)
- [Connector guide](docs/CONNECTORS.md)
- [既知の制約](docs/LIMITATIONS.md)

## License

MIT。詳細は[LICENSE](LICENSE)を参照してください。
