#!/usr/bin/env python3
"""
Phase 1〜2 仕入れ記録の集計（purchase-log-template.csv 形式、1個1行）

dennou-sedori-tips.md 15-4／15-5 の判断材料を出す:
  - 実際の利益（1個ごと）と、仕入れ時の見込み利益との差
  - 販売までの日数（出品日→販売日）
  - 出品時の価格から売れた価格までの値下がり率
  - 時給（利益合計 ÷ 作業時間合計）、投下資本利益率（ROI）
  - 売れ残り（在庫）と、その仕入れ額

実際の利益 ＝ 販売価格 − Amazonの手数料（実額） − 仕入れ値 − 送料 ＋ ポイント − FBA納品の送料
Amazonの手数料は、セラーセントラルのペイメントレポート（注文ごとの手数料）から転記する。

外部ライブラリ不要。使い方:
    python3 summarize_log.py purchase-log.csv
    python3 summarize_log.py purchase-log.csv --monthly-fixed 10690 --months 1   # 固定費も引く
"""

import csv
import sys
from datetime import date
from pathlib import Path


def num(value):
    value = str(value or "").replace(",", "").replace("円", "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def to_date(value):
    try:
        return date.fromisoformat(str(value or "").strip())
    except ValueError:
        return None


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="仕入れ記録の集計")
    parser.add_argument("log", type=Path, help="purchase-log.csv")
    parser.add_argument("--monthly-fixed", type=float, default=0,
                        help="毎月の固定費（円）。例：大口出品5,390円＋Keepa約5,300円なら10690")
    parser.add_argument("--months", type=float, default=1,
                        help="この記録の期間（か月）。固定費×か月数を利益から引く")
    args = parser.parse_args()
    path = args.log
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("記録が空です")

    sold = []
    unsold = []
    total_minutes = 0.0
    for r in rows:
        total_minutes += num(r.get("minutes_spent")) or 0
        cost = (num(r.get("unit_price")) or 0) + (num(r.get("shipping_cost")) or 0) \
            - (num(r.get("points_earned")) or 0) + (num(r.get("fba_inbound_cost")) or 0)
        item = {"id": r.get("item_id", ""), "name": r.get("product_name", ""), "cost": cost}
        sold_price = num(r.get("sold_price"))
        if sold_price is None:
            listed = to_date(r.get("listed_date"))
            item["days_listed"] = (date.today() - listed).days if listed else None
            unsold.append(item)
            continue
        item["profit"] = sold_price - (num(r.get("amazon_fees_actual")) or 0) - cost
        item["expected"] = num(r.get("expected_profit"))
        listed_d, sold_d = to_date(r.get("listed_date")), to_date(r.get("sold_date"))
        item["days"] = (sold_d - listed_d).days if listed_d and sold_d else None
        listed_price = num(r.get("listed_price"))
        item["drop"] = (listed_price - sold_price) / listed_price if listed_price else None
        sold.append(item)

    print("=" * 60)
    print(f"仕入れ記録の集計（{len(rows)}個：売れた{len(sold)}個・在庫{len(unsold)}個）")
    print("=" * 60)
    for it in sold:
        exp = f"見込み{it['expected']:.0f}円" if it["expected"] is not None else "見込み未記入"
        days = f"{it['days']}日で販売" if it["days"] is not None else "販売日数不明"
        drop = f"値下がり{it['drop']:.0%}" if it["drop"] is not None else ""
        print(f"  {it['id']} {it['name'][:24]}：利益{it['profit']:.0f}円（{exp}）／{days}　{drop}")
    for it in unsold:
        days = f"出品から{it['days_listed']}日" if it.get("days_listed") is not None else "未出品"
        print(f"  {it['id']} {it['name'][:24]}：在庫（仕入れ額{it['cost']:.0f}円・{days}）")
    print()

    total_profit = sum(it["profit"] for it in sold)
    sold_cost = sum(it["cost"] for it in sold)
    stock_cost = sum(it["cost"] for it in unsold)
    print(f"実際の利益の合計     : {total_profit:.0f}円（売れた分のみ）")
    with_expected = [it for it in sold if it["expected"] is not None]
    if with_expected:
        gap = sum(it["profit"] - it["expected"] for it in with_expected) / len(with_expected)
        print(f"見込みとの差（平均） : {gap:+.0f}円/個（マイナスなら照合ツールの見積もりが甘い）")
    if sold_cost:
        print(f"ROI（投下資本利益率）: {total_profit / sold_cost:.0%}（利益 ÷ 売れた分の仕入れ額）")
    days = [it["days"] for it in sold if it["days"] is not None]
    if days:
        print(f"販売までの日数       : 平均{sum(days) / len(days):.1f}日（最長{max(days)}日）")
    drops = [it["drop"] for it in sold if it["drop"] is not None]
    if drops:
        print(f"出品価格からの値下がり: 平均{sum(drops) / len(drops):.0%}（15-3のストレステストは-20%想定）")
    print(f"在庫（売れ残り）     : {len(unsold)}個・仕入れ額{stock_cost:.0f}円")
    fixed_total = args.monthly_fixed * args.months
    if fixed_total:
        print(f"固定費（{args.months:g}か月分）  : {fixed_total:.0f}円")
        print(f"固定費を引いた利益   : {total_profit - fixed_total:.0f}円")
    if total_minutes:
        print(f"作業時間の合計       : {total_minutes:.0f}分")
        print(f"時給                 : {(total_profit - fixed_total) / (total_minutes / 60):.0f}円/時"
              f"{'（固定費を引いた後）' if fixed_total else ''}"
              "（15-5の例：2,000円/時なら副業として成立、857円/時だと魅力が薄い）")
    print("=" * 60)


if __name__ == "__main__":
    main()
