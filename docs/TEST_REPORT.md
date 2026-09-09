# Neo Memo v1 — 実装・検証レポート

検証日: 2026-09-08 / ソースバージョン: 1.0.0

## 結果

**Node自動テスト40件: 40件成功、失敗0。** 構文検査成功。Chromium上のGUIから実Nodeコアと実Gitへ接続する結合テスト7項目も成功しました。

これは全OS・全外部サービスへの動作保証ではありません。以下の確認範囲を区別します。

## 環境

- Linuxコンテナ
- Node.js v22.16.0
- Git 2.47.3
- Chromium 144.0.7559.96 / Playwright (Python)
- 外部アカウントの鍵なし
- 外部npm / Electronダウンロードは環境のDNS・ネットワーク制約により利用不可

GUIの指定依存はElectron 44.2.0です。**この実バイナリのインストール・起動は未実施**です。ZIPにはバイナリやnode_modulesは含みません。直接依存のバージョンは指定していますが、npm installをこの環境で完了できなかったため、検証済みpackage-lock.jsonは同梱していません。

## 1. コア / adapter / Git（40件）

`npm test` はNode標準のtest runnerを使用します。

| 分類 | 主な確認内容 |
|---|---|
| 入力・重複 | X Post ID、追跡URL、意味のあるquery/fragmentの保持、複数URL、Slack書式、イベント再送 |
| ファイル | URLなしメモ、日本語検索、Markdown round-trip、破損検出、空でない保存先拒否、symlink拒否 |
| メモ保護 | AI更新で手動タグを保護、メモ送信のopt-in、未完了AI応答で既存データを保持 |
| 画像・取得 | SHA-256重複排除、SVG拒否、passive metadata、robotsの基本規則、リダイレクト先確認 |
| 通信障害 | 取得失敗後もURL/メモ保持、private IP/credential URL拒否、429エラー通知 |
| 並行性 | 独立サービスインスタンス間の排他、通信中の追加保存、非同期応答による人間の編集上書き防止 |
| Slack | ページング、通信断再開、ディスク失敗前のcursor保護、ユーザーフィルタ、失効cursor再開 |
| Discord | REST形式の取り込み、再実行、本文Intent不足、100件を超えるページ境界 |
| X | API JSON、既存カードへの補完、1ページ上限、単一Post、他クライアント保存、手動タイトル保護 |
| Git | 実commit、ローカルbare repoへのpush/fast-forward、分岐停止、対象外stage保護 |

外部サービスのHTTP応答はfixtureに置換しています。一方、カードファイルの読み書き、処理位置の保存、Gitコマンドは実行しています。Git remoteテストではURLポリシー部だけをテスト用に置換し、実際のGit転送処理はローカルbare repositoryを相手に実行しました。実GitHubへのpushをしたわけではありません。

生ログ: [test-results.txt](test-results.txt)、[syntax-check.txt](syntax-check.txt)。

## 2. GUIと実コアの結合（7項目）

`python scripts/ui-test.py` を実行しました。

1. GUI入力 → Markdownファイル作成 → Git commit。
2. タイトル・メモ・タグ編集、日本語検索、入力HTMLを実行せず文字列として扱うこと。
3. 同一URLを保存し直すとカードは増えず保存理由が追記されること。
4. アーカイブと画面再読込後のデータ再表示。
5. 設定フォームの入力・保存呼び出し。
6. 横幅900pxでページ全体の横あふれがないこと。
7. テスト経路でbrowser JavaScriptエラーがないこと。

テストではHTML/CSS/JSの実装ファイルをChromiumへメモリ内で読み込み、`window.neo`をstdio RPCへ差し替えてNodeの実MemoServiceを呼びます。コンテナのfile://ナビゲーション制約に対応するため、**テスト用に読み込んだ文書だけCSPを除去**しています。配布するHTMLのCSPは残しています。

この手法ではElectronのIPC origin検証、contextIsolation、safeStorage、ネイティブfile dialog、画像縮小、リンクを外部ブラウザへ開く処理は検証していません。設定の永続化と鍵保存もテスト用ブリッジに置き換えています。画面再読込のテストはOSプロセスの再起動試験ではありません。コアの別インスタンスからの再読込はNodeテストで確認しています。

生ログ: [ui-test-results.txt](ui-test-results.txt)。画面例: [screenshot-library.png](screenshot-library.png)。画面内の資料はデモ用の架空データです。

## 3. コードはあるが、実環境で確認していない範囲

Electron 44.2.0の起動、macOS / WindowsのOS統合、Slack / Discordの実App設定、実APIレート制限、Xの実OAuthユーザートークン、OpenAIの実モデルによる出力、実GitHub認証とpushは未検証です。

また、OS強制終了や電源断を用いた耐障害試験、大量データでの性能測定、網羅的なセキュリティ監査は実施していません。原子的ファイル書き込みやURL取得制限は実装していますが、それをもって全障害・全攻撃への保証とはしません。

## 4. 手元での初回受入手順

1. Node.js 22以上 / Gitを確認し、ソースフォルダで `npm install` と `npm start`。
2. APIキーなしでURLとURLなしメモを保存し、検索・追記・アプリ再起動後の表示を確認。
3. 通信を切って同じ操作を確認し、再接続する。
4. 自分のSlackまたはDiscord専用チャンネル1つだけを接続し、2件投稿→取り込み→再取り込みでカード数が増えないことを確認。
5. Web補完を1件だけ実行して、URL・メモが保持されることを確認。その後必要な自動化を有効にする。
6. private Git remoteを設定し、CLIかGUIから1回同期する。

最初の4段階で、本体と主入力経路を普段使いできるか判断できます。LLMやXはその後の任意接続です。
