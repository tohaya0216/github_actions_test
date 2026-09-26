# GPT-6 Astra依頼プロンプト（セラーリサーチ・楽天側確認専用）

`seller-products-template.csv`（Amazon側を人力で埋めたリスト）の型番を渡し、
**楽天側だけ**を確認してもらうためのプロンプト。Amazon側は既に埋まっているので
依頼しない（Astraが毎回ブロックされる箇所を最初から回避する設計）。

---

あなたに、電脳せどり（楽天で仕入れてAmazon FBAで販売する）の下調べを手伝ってほしい。
今回は**楽天市場側の情報確認だけ**を頼みたい。Amazon側の情報（価格・出品者数等）は
こちらで既に確認済みなので、調べる必要はない。

## 絶対に守ってほしい制約

1. **自動巡回・大量スクレイピングはしないこと**。人間が手作業でブラウジングするのと
   同じような自然なペースで、1件ずつ確認すること。
2. **確認できない情報は絶対に推測で埋めないこと**。分からない項目は空欄にするか
   「unknown」と明記する。
3. 実際に購入・カートへの追加・アカウントへのログインが必要な操作はしないこと。
4. **型番の完全一致を重視すること**。以下のリストに挙げた商品名・型番と、
   楽天で見つかった商品の型番が完全に一致するか必ず確認し、一致しない場合は
   「型番不一致のため別商品の可能性」とnotesに明記すること。似ているだけの
   別モデルを同一商品として扱わないこと。

## 確認してほしい商品リスト

以下は、Amazon側で既に確認済みの商品（型番を含む）のリスト。この商品と**完全に
一致する型番**を楽天市場で探し、価格等を確認してほしい。

```
（ここに seller-products-template.csv の product_name 列を貼り付ける。
　例：
　ダミー工具セット TU-XX
　Effects Bakery Bagel OverDrive
　...）
```

## 商品ごとに確認してほしいこと

1. **楽天市場の実際の店舗ページ**で、現在の販売価格・型番・容量/仕様を確認する
   （価格比較サイトの集計最安値ではなく、実際にその店が提示している価格そのもの）
2. **在庫があるか**（売り切れ表示がないか）を確認する
3. **型番が完全一致するか**を確認する（一致しない場合は上記の通り明記）
4. 商品説明・ショップ情報に「転売目的の購入はご遠慮ください」「業者様の購入は
   お断り」等の記載がないか確認する。記載があれば除外対象としてnotesに明記する
5. 商品が電気用品（ACアダプター等を伴うもの）の場合、PSEマークの記載があるか、
   個人輸入・並行輸入品の記載がないか確認する
6. **楽天側の店舗名を必ずnotesに明記する**（Amazon側のセラー名と同一・類似の店舗
   でないかを確認するため。メーカー・代理店が楽天・Amazon両方に自ら出品して
   価格を同期させているケースが実際に見つかっている）
7. 調査にかかったおおよその時間（分）をメモする

## 出力フォーマット

以下の列名・順序のCSV形式で、ヘッダー行つきで出力すること。

```
product_name,rakuten_price,rakuten_url,in_stock,model_match,resale_prohibited,pse_note,research_minutes,notes
```

| 列名 | 入力内容 |
|---|---|
| `product_name` | 確認対象リストと同じ商品名（照合用） |
| `rakuten_price` | 楽天の実店舗価格（円、税込）。見つからなければ空欄 |
| `rakuten_url` | 楽天の商品ページURL |
| `in_stock` | 在庫があるか（yes/no）。売り切れならno |
| `model_match` | 型番が完全一致するか（yes/no/unknown） |
| `resale_prohibited` | ショップが転売目的の購入を拒否する記載をしているか（yes/no） |
| `pse_note` | 電気用品の場合のPSE確認結果、または非該当の旨 |
| `research_minutes` | その商品の調査に要した時間（分） |
| `notes` | 調査日、店舗名、その他不確実な点 |

## 最後に

リストにある商品が楽天で見つからない場合は、無理に類似品で代用せず
「該当商品なし」として報告してほしい。判断に迷った項目は無理に埋めず、
空欄またはnotesへの記載で正直に示してほしい。

---

## この結果をanalyze.pyにかける前に

Astraの結果（`rakuten_price`等）を、`seller-products-template.csv`
（`amazon_price`・`seller_count`等）と`product_name`で突き合わせて1つのCSVにまとめ、
`../analyze.py`が読める列名（`asin,product_name,rakuten_price,point_rebate_rate,
amazon_price,referral_fee_rate,fba_fee,estimated_monthly_sales,seller_count,
seller_count_spike,amazon_itself_selling,is_famous_brand,research_minutes,notes`）
に整形してから実行する。`resale_prohibited`がyesの行、`model_match`がnoの行は
判定に回さず先に除外してよい。
