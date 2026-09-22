#!/usr/bin/env python3
"""
セラーリサーチ統合スクリプト（Amazon側 + 楽天側 → analyze.py用CSV）

`seller-products.csv`（Amazon側を人力で埋めたもの）と、Astraが返す楽天側確認結果
（`astra-prompt-rakuten-check.md`の出力フォーマット）を、商品名で突き合わせて
`../analyze.py`が読める1つのCSVに整形する。

除外ルール（自動）:
  - 楽天側で在庫なし（in_stock = no）
  - ショップが転売目的の購入を拒否している（resale_prohibited = yes）
  - 型番が不一致（model_match = no）
これらに該当する行は結合結果から除外し、除外理由とともに別途一覧表示する。

外部ライブラリ不要（標準ライブラリのみ）。

使い方:
    python3 merge_seller_research.py \\
        --amazon-side seller-products.csv \\
        --rakuten-side rakuten-check-result.csv \\
        --out merged.csv

    # 統合結果をそのまま判定にかける場合
    python3 ../analyze.py merged.csv
"""

import argparse
import csv
import re
import sys
from pathlib import Path

YES_VALUES = {"yes", "y", "true", "1", "はい"}

# analyze.py が読む最終フォーマット（列の意味は analyze.py のdocstring参照）
OUTPUT_FIELDNAMES = [
    "asin", "product_name", "rakuten_price", "point_rebate_rate", "amazon_price",
    "referral_fee_rate", "fba_fee", "estimated_monthly_sales", "seller_count",
    "seller_count_spike", "amazon_itself_selling", "is_famous_brand",
    "research_minutes", "notes",
]


def is_yes(value: str) -> bool:
    return str(value or "").strip().lower() in YES_VALUES


def load_csv(path: Path) -> list:
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def norm_name(name: str) -> str:
    """商品名の突き合わせ用に前後空白・全角半角スペース・連続空白の差を軽く吸収する"""
    normalized = (name or "").strip().replace("　", " ")
    return re.sub(r" {2,}", " ", normalized)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--amazon-side", type=Path, required=True,
                         help="seller-products.csv（Amazon側を人力で埋めたファイル）")
    parser.add_argument("--rakuten-side", type=Path, required=True,
                         help="Astraが返した楽天側確認結果のCSV")
    parser.add_argument("--out", type=Path, default=Path("merged.csv"),
                         help="出力先（省略時は merged.csv。そのまま analyze.py に渡せる）")
    args = parser.parse_args()

    if not args.amazon_side.exists():
        sys.exit(f"エラー: ファイルが見つかりません: {args.amazon_side}")
    if not args.rakuten_side.exists():
        sys.exit(f"エラー: ファイルが見つかりません: {args.rakuten_side}")

    amazon_rows = load_csv(args.amazon_side)
    rakuten_rows = load_csv(args.rakuten_side)

    rakuten_by_name = {}
    for r in rakuten_rows:
        key = norm_name(r.get("product_name"))
        if key in rakuten_by_name:
            print(f"警告: 楽天側データに商品名の重複があります（後勝ちで上書き）: {key}")
        rakuten_by_name[key] = r

    merged = []
    excluded = []
    unmatched_amazon = []

    for a in amazon_rows:
        name = norm_name(a.get("product_name"))
        r = rakuten_by_name.pop(name, None)

        if r is None:
            unmatched_amazon.append(name)
            continue

        reasons = []
        if not is_yes(r.get("in_stock")):
            reasons.append("楽天側で在庫なし")
        if is_yes(r.get("resale_prohibited")):
            reasons.append("ショップが転売目的の購入を拒否")
        if str(r.get("model_match", "")).strip().lower() == "no":
            reasons.append("型番が不一致")

        combined_notes_parts = []
        if a.get("notes"):
            combined_notes_parts.append(f"[Amazon側] {a['notes']}")
        if r.get("notes"):
            combined_notes_parts.append(f"[楽天側] {r['notes']}")
        if r.get("pse_note"):
            combined_notes_parts.append(f"[PSE] {r['pse_note']}")
        if r.get("rakuten_url"):
            combined_notes_parts.append(f"楽天URL={r['rakuten_url']}")
        if a.get("seller_id"):
            combined_notes_parts.append(f"seller_id={a['seller_id']}")
        combined_notes = " / ".join(combined_notes_parts)

        if reasons:
            excluded.append({
                "product_name": name,
                "reasons": " / ".join(reasons),
            })
            continue

        research_minutes = 0.0
        for src in (a.get("research_minutes"), r.get("research_minutes")):
            try:
                research_minutes += float(src)
            except (TypeError, ValueError):
                pass

        merged.append({
            "asin": a.get("asin", "").strip() or name,
            "product_name": name,
            "rakuten_price": r.get("rakuten_price", ""),
            "point_rebate_rate": "",  # 9-4の前提（楽天カードなし=10%目安）を各自で当てはめる
            "amazon_price": a.get("amazon_price", ""),
            "referral_fee_rate": "",  # Revenue Calculatorの実測値を別途入力
            "fba_fee": "",            # 同上
            "estimated_monthly_sales": a.get("estimated_monthly_sales", ""),
            "seller_count": a.get("seller_count", ""),
            "seller_count_spike": a.get("seller_count_spike", ""),
            "amazon_itself_selling": a.get("amazon_itself_selling", ""),
            "is_famous_brand": a.get("is_famous_brand", ""),
            "research_minutes": research_minutes,
            "notes": combined_notes,
        })

    unmatched_rakuten = [norm_name(r.get("product_name")) for r in rakuten_by_name.values()]

    with args.out.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDNAMES)
        writer.writeheader()
        writer.writerows(merged)

    print("=" * 60)
    print("セラーリサーチ統合結果")
    print("=" * 60)
    print(f"Amazon側の商品数     : {len(amazon_rows)}件")
    print(f"楽天側の商品数       : {len(rakuten_rows)}件")
    print(f"統合成功（判定対象） : {len(merged)}件")
    print(f"自動除外             : {len(excluded)}件")
    print()

    if excluded:
        print("除外理由の内訳:")
        for e in excluded:
            print(f"  - {e['product_name']}: {e['reasons']}")
        print()

    if unmatched_amazon:
        print("警告: Amazon側にあるが楽天側の結果が見つからなかった商品"
              "（商品名の表記ゆれの可能性。手動で確認してください）:")
        for name in unmatched_amazon:
            print(f"  - {name}")
        print()

    if unmatched_rakuten:
        print("警告: 楽天側にあるがAmazon側に見つからなかった商品"
              "（商品名の表記ゆれの可能性。手動で確認してください）:")
        for name in unmatched_rakuten:
            print(f"  - {name}")
        print()

    print(f"統合結果を書き出しました: {args.out}")
    print(f"次のコマンドで判定できます: python3 ../analyze.py {args.out}")
    print("=" * 60)


if __name__ == "__main__":
    main()
