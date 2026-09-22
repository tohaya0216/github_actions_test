#!/usr/bin/env python3
"""
セラー定点観測リストの鮮度チェック（`seller-watchlist.csv`用）

2段階の鮮度をチェックする:
  1. 品質評価（quality_rating）の再評価が必要なセラー
     → last_evaluated_date が古い（デフォルト90日=3ヶ月）全セラーが対象
  2. 新着出品の確認が必要なセラー
     → 継続監視対象（quality_ratingがS/A）のうち、last_checked_dateが古い
       （デフォルト14日）セラーが対象。B/C評価のセラーは定点観測の対象外なので
       ここではチェックしない

運用イメージ：
  - 初回は広くセラーを集めて評価する（quality_ratingを付ける）
  - 以降の定点観測はS/Aランクのセラーだけを対象にする（B/Cは追わない）
  - 評価そのものは数ヶ月に一度やり直し、リストを新鮮に保つ

外部ライブラリ不要（標準ライブラリのみ）。

使い方:
    python3 check_watchlist_freshness.py --watchlist seller-watchlist.csv
    python3 check_watchlist_freshness.py --watchlist seller-watchlist.csv \\
        --evaluation-interval-days 90 --check-interval-days 14
"""

import argparse
import csv
import sys
from datetime import date, datetime
from pathlib import Path

MONITORED_RATINGS = {"s", "a"}  # 継続監視の対象ランク（大文字小文字を区別しない）


def parse_date(value: str):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        print(f"警告: 日付形式が不正です（YYYY-MM-DD想定）: {value!r}")
        return None


def days_since(d) -> int:
    if d is None:
        return None
    return (date.today() - d).days


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--watchlist", type=Path, required=True,
                         help="seller-watchlist.csv")
    parser.add_argument("--evaluation-interval-days", type=int, default=90,
                         help="品質評価の再評価間隔（デフォルト90日=約3ヶ月）")
    parser.add_argument("--check-interval-days", type=int, default=14,
                         help="継続監視対象（S/Aランク）の新着出品チェック間隔（デフォルト14日）")
    args = parser.parse_args()

    if not args.watchlist.exists():
        sys.exit(f"エラー: ファイルが見つかりません: {args.watchlist}")

    with args.watchlist.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    if not rows:
        print("セラーリストが空です。")
        return

    rating_counts = {}
    needs_reevaluation = []
    needs_recheck = []

    for r in rows:
        seller_id = r.get("seller_id", "").strip()
        seller_name = r.get("seller_name", "").strip()
        rating = (r.get("quality_rating") or "").strip().upper()
        rating_counts[rating or "(未評価)"] = rating_counts.get(rating or "(未評価)", 0) + 1

        eval_days = days_since(parse_date(r.get("last_evaluated_date")))
        if eval_days is None or eval_days >= args.evaluation_interval_days:
            needs_reevaluation.append((seller_id, seller_name, rating, eval_days))

        if rating.lower() in MONITORED_RATINGS:
            check_days = days_since(parse_date(r.get("last_checked_date")))
            if check_days is None or check_days >= args.check_interval_days:
                needs_recheck.append((seller_id, seller_name, rating, check_days))

    print("=" * 60)
    print("セラー定点観測リスト 鮮度チェック")
    print("=" * 60)
    print(f"登録セラー数: {len(rows)}件")
    print("評価ランク内訳:")
    for rating, count in sorted(rating_counts.items()):
        print(f"  {rating}: {count}件")
    print()

    print(f"【品質の再評価が必要】（{args.evaluation_interval_days}日以上未評価、または未評価）:")
    if needs_reevaluation:
        for seller_id, seller_name, rating, eval_days in needs_reevaluation:
            days_str = "未評価" if eval_days is None else f"{eval_days}日経過"
            print(f"  - {seller_id} {seller_name}（現ランク:{rating or '未評価'}、{days_str}）")
    else:
        print("  なし")
    print()

    print(f"【新着出品の確認が必要】（S/Aランクで{args.check_interval_days}日以上未チェック）:")
    if needs_recheck:
        for seller_id, seller_name, rating, check_days in needs_recheck:
            days_str = "未チェック" if check_days is None else f"{check_days}日経過"
            print(f"  - {seller_id} {seller_name}（ランク:{rating}、{days_str}）")
    else:
        print("  なし")
    print("=" * 60)


if __name__ == "__main__":
    main()
