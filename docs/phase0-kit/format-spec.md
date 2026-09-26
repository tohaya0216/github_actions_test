# Phase 0 データ収集フォーマット仕様（他AI相談用）

電脳せどり（楽天で仕入れてAmazon FBAで売る）の初期リサーチのために、
候補商品100件程度を1行1商品のCSVで記録したい。以下の列定義に従ったサンプル行を
何件か作れるか相談したい。

## 前提

- 各行は「楽天で見つけた商品1点」を表す
- 目的は、この商品を仕入れてAmazonで売った場合に利益が出るかを判定すること
- **数値は実在の商品から調べて埋めるのが理想だが、フォーマット確認用のダミー値でもよい**

## CSVの列（この順序・列名で出力してほしい）

```
asin,product_name,rakuten_price,point_rebate_rate,amazon_price,referral_fee_rate,fba_fee,estimated_monthly_sales,seller_count_spike,amazon_itself_selling,is_famous_brand,research_minutes,notes
```

| 列名 | 型 | 必須 | 説明 |
|---|---|---|---|
| `asin` | 文字列 | ○ | 商品識別子（ASIN、または管理用の任意ID） |
| `product_name` | 文字列 | | 商品名 |
| `rakuten_price` | 数値（円） | ○ | 楽天での購入価格（税込） |
| `point_rebate_rate` | 小数（0〜1） | | 実質ポイント還元率。例：10%還元なら`0.10`。楽天カードを使わない前提なら0.08〜0.10程度、使う前提（お買い物マラソン＋5と0のつく日）なら0.12〜0.15程度が目安 |
| `amazon_price` | 数値（円） | ○ | Amazonでの現在の販売価格 |
| `referral_fee_rate` | 小数（0〜1） | | Amazon販売手数料率。カテゴリにより5〜15.4%程度で変動。不明なら`0.15`で仮置き |
| `fba_fee` | 数値（円） | | FBA配送代行手数料。商品サイズ・重量で変動（小型200〜300円程度／標準300〜600円程度が目安） |
| `estimated_monthly_sales` | 数値 | | 月間の想定販売個数（Amazonのランキング推移等から見積もる） |
| `seller_count_spike` | `yes`/`no` | | 出品者数が急増している商品か |
| `amazon_itself_selling` | `yes`/`no` | | Amazon本体（Amazon.co.jp自身）がその商品を出品しているか |
| `is_famous_brand` | `yes`/`no` | | 有名ブランド品か（真贋調査リスクの目安） |
| `research_minutes` | 数値（分） | | この商品の調査に要した時間 |
| `notes` | 文字列 | | 自由記入 |

## 出力例（ダミーデータ）

```csv
asin,product_name,rakuten_price,point_rebate_rate,amazon_price,referral_fee_rate,fba_fee,estimated_monthly_sales,seller_count_spike,amazon_itself_selling,is_famous_brand,research_minutes,notes
B0EXAMPLE1,洗濯洗剤リフィル4個セット,2980,0.10,4980,0.15,588,8,no,no,no,6,ダミー例
B0EXAMPLE2,圧力鍋パッキン3個セット,3480,0.14,5480,0.15,650,4,no,no,no,5,ダミー例
```

## 相談したいこと

- 実在しそうな日用品・消耗品カテゴリ（洗剤、掃除用品、キッチン消耗品、ペット用品など）で、
  上記フォーマットに沿ったサンプル行を10〜20件程度作れるか
- 楽天とAmazonの価格差・ポイント還元は、一般的な相場感（利益率10〜30%程度に収まる範囲）で
  仮定してよい。**実在の商品の実際の現在価格として断定しないこと**が前提
- 出力はこのCSV形式（ヘッダー行つき）でそのまま欲しい

## 用途

このCSVを `docs/phase0-kit/analyze.py`（電脳せどりの仕入れ基準を自動判定するスクリプト）に
読み込ませて、判定ロジックの動作確認・練習に使う。**実際の仕入れ判断には使わない**
（実際の判断には、必ず自分でKeepaやAmazon Revenue Calculatorを確認した実データを使う）。
