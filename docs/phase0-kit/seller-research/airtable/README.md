# セラーウォッチ検出：共有データストアのセットアップ（Airtable版）

Google Apps Script版（`../apps-script/`）は、Googleアカウントが複数ログインして
いる環境で「意図しないアカウントに振り分けられて404になる」という問題が実機で
発生し、解消できなかったため**Airtableに切り替えた**（2026-09-23）。Airtableは
Googleアカウントの仕組みと無関係な、独立したAPIキー認証なので、この種の問題が
そもそも起こらない。

PC拡張機能・Kiwi Browser拡張機能・スマホのブックマークレットが、全部同じ
Airtableベースにデータを読み書きするようにするための設定。

## セットアップ手順（初回のみ・10分程度）

### 1. Airtableアカウントを作る

[airtable.com](https://airtable.com) でアカウントを作成する（メールアドレスでOK）。

### 2. ベース（Base）とテーブルを作る

1. 新しいベースを作成する（名前は何でもよい。例：「セラーウォッチDB」）
2. デフォルトで作られるテーブルの名前を **`Seen`** に変更し、以下の列を作る：

   | 列名 | 型 |
   |---|---|
   | `seller_id`（1列目・主キー扱い） | 単一行テキスト |
   | `status` | 単一行テキスト |
   | `checked_at` | 単一行テキスト |

3. もう1つテーブルを追加し、名前を **`Watchlist`** にして、以下の列を作る：

   | 列名 | 型 |
   |---|---|
   | `seller_id`（1列目） | 単一行テキスト |
   | `seller_name` | 単一行テキスト |
   | `seller_url` | 単一行テキスト |
   | `review_count` | 数値 |
   | `category_tendency` | 単一行テキスト |
   | `quality_rating` | 単一行テキスト |
   | `first_checked_date` | 単一行テキスト |
   | `last_evaluated_date` | 単一行テキスト |
   | `last_checked_date` | 単一行テキスト |
   | `status` | 単一行テキスト |
   | `notes` | 長文テキスト |

   デフォルトで作られている不要な列（Notes、Assigneeなど）は削除してよい。

### 3. Base IDを控える

ベースを開いた状態で、左上の「ヘルプ」→「API documentation」を開くと、
ページの上の方に `https://airtable.com/appXXXXXXXXXXXXXX/api/docs` のような
URLが表示される。この **`appXXXXXXXXXXXXXX`の部分がBase ID**。

### 4. Personal Access Tokenを作る

1. 右上のアカウントアイコン→「Developer hub」→「Personal access token」を開く
   （または直接 [airtable.com/create/tokens](https://airtable.com/create/tokens)）
2. 「Create new token」をクリック
3. 名前を付ける（例：`seller-watch`）
4. スコープに **`data.records:read`** と **`data.records:write`** を追加
5. アクセス範囲に、さっき作ったベースを選択
6. 「Create token」をクリックし、表示されたトークン（`pat...`から始まる文字列）を
   コピーする（**この画面を閉じると二度と表示されないので、必ずこの時点で控える**）

### 5. 拡張機能・ブックマークレットに設定する

控えた **Base ID** と **トークン** の2つを、以下の場所に設定する：

- **PC/Kiwi拡張機能**：ツールバーアイコン→ポップアップの設定欄に入力して保存
- **ブックマークレット**：初回実行時に`prompt()`で入力を求められるので、
  そこで入力する（以後はスマホの`localStorage`に保存され、再入力不要）

## データを直接確認したいとき

Airtableのベースを直接開けば、`Seen`・`Watchlist`テーブルに今のデータが
リアルタイムで見える。スプレッドシートのように行を選択してExcel/CSV形式で
エクスポートすることもできる。

## 通信・規約リスクについて

Amazonへの追加通信は増えない。通信先はAirtableのサーバー
（api.airtable.com）のみで、Amazon側のボット検知・アクセス制限とは無関係。
