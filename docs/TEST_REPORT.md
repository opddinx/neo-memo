# Neo Memo v1 verification report

検証日: 2026-09-10

## 対象

- Node.js 22
- Store schema v3
- Quick Note / Reading Note / Web / X capture
- CLI / Store / Git境界
- 時系列メモ履歴と詳細編集画面

## 自動テスト

`npm run check` は成功した。`npm test` は59件中58件成功、失敗0、skip 1件だった。CIもNode.js 22を使い、LinuxとWindowsで同じsyntax checkおよびcore/CLI/Store/Git testを実行する。

Windowsでsymlink作成権限がない環境では、symlink拒否テスト1件だけを理由付きでskipする。それ以外のテストは外部API keyを必要とせず、HTTP応答をfixtureで置き換える。Xの通常captureが有料X APIを自動実行しないこともテスト対象である。

## schema v3とメモ履歴

- canonicalなユーザーメモはItemの`memoEntries[]`に時系列で保存する。
- 各Entryは不変の`id`、`createdAt`、編集時に更新される`updatedAt`を持つ。
- 追記は既存Entryを上書きせず、新しいEntryを末尾へ追加する。
- 個別Entryの編集はEntry IDを維持する。
- 検索・カードpreview・AIへの任意送信は全Entryを対象にする。
- AI/Web/X enrichmentはユーザーの`memoEntries`を変更しない。

## migration実測

実利用Storeをschema v2からv3へ明示的にmigrationした。32 Itemについて、移行前後の次の値をプログラムで全件比較した。

- Item ID
- ユーザーメモ本文
- source
- captures / provenance
- assets
- tags
- createdAt

すべて一致し、ファイル追加・削除およびItem ID変更はなかった。v2の`content`は、そのItemの既存日時を使う最初の`memoEntries`要素へ変換された。

## UI確認項目

実Node coreへ接続したPlaywright GUI integrationをMicrosoft Edgeで実行し、capture、メモ履歴の追記と個別編集、日本語検索、冒頭previewとトグル、HTMLの文字列扱い、重複capture、archive後の再読込、設定保存、900px幅での横overflowなし、browser JavaScript errorなしを確認した。

詳細画面はウィンドウ高を広く利用し、source titleと日時を読みやすく表示する。メモ履歴は各Entryの冒頭4行を常時表示し、トグルで全文と編集欄を展開する。新規追記欄は履歴の後にあり、追加後も同じ画面で次の追記を重ねられる。

## 境界

Storeのcanonical dataは`neo-memo-store.json`、`items/`、`assets/`で理解できる。cache、connector checkpoint、secret、SQLite indexはStore外であり、削除後に再構築可能である。App repositoryとData Store repositoryの相対配置は前提にしない。
