#!/usr/bin/env python3
"""
Phase 0 仕入れ候補分析ツール（docs/dennou-sedori-tips.md 15-4 のPhase 0用）

楽天で見つけた候補商品をCSVに記録すると、以下を自動計算する。
  - ポイント還元後の実質仕入れ値
  - 粗利・利益率
  - 価格下落ストレステスト（現在価格から-10%/-20%でも黒字か）
  - 損益分岐価格
  - 仕入れ基準（11-3）とストレステスト（15-3）に基づくA/B/C判定
  - 通過率・平均粗利などのサマリー

外部ライブラリ不要（標準ライブラリのみ）。

使い方:
    python3 analyze.py template.csv
    python3 analyze.py my_candidates.csv --out result.csv

CSVの列（ヘッダー名は固定。順不同で可）:
    asin                    商品識別子（ASINでなくても管理用の識別子でよい）
    product_name            商品名（メモ用）
    rakuten_price           楽天での購入価格（税込・円）
    point_rebate_rate       実質ポイント還元率（0〜1の小数。例: 10% なら 0.10）
    amazon_price            Amazonでの現在の販売価格（円）
    referral_fee_rate       Amazon販売手数料率（0〜1の小数。空欄なら0.15を仮置き。
                            実際の判定にはAmazon Revenue Calculatorの数値を使うこと）
    fba_fee                 FBA配送代行手数料（円。空欄なら0として計算）
    estimated_monthly_sales Keepaのランキング推移等から見積もった月間販売個数の目安
    seller_count_spike      出品者数が急増しているか（yes/no。空欄は「未確認」として扱われ、
                            自動的にB判定に留め置かれる。「no」と明記した場合のみ確認済み扱い）
    amazon_itself_selling   Amazon本体が出品しているか（yes/no。空欄の扱いは上記と同じ）
    is_famous_brand         真贋調査リスクの高い有名ブランド品か（yes/no。空欄の扱いは上記と同じ）
    research_minutes        この商品の調査にかかった時間（分）。任意項目
    notes                   自由記入欄。任意項目

注意: seller_count_spike / amazon_itself_selling / is_famous_brand は、空欄を
「no（安全）」とは解釈しない。未確認のまま安全側とみなすと、有名ブランド品などの
リスクを見逃したままA判定してしまう事故につながるため（実例はdocs/dennou-sedori-tips.md
の運用ログを参照）、空欄は必ず「要確認」としてB以上には進ませない設計にしている。

判定基準（変更する場合はCONFIGを編集する。根拠は docs/dennou-sedori-tips.md を参照）:
    MIN_PROFIT_MARGIN      11-3: 利益率20%以上
    MIN_PROFIT_YEN         15-2: 粗利1,000円以上（当初の1,500円は上振れケースとして扱う）
    MIN_MONTHLY_SALES      11-3: 月3個以上売れている実績
    STRESS_DROP_1 / 2      15-3: 現在価格から-10%/-20%の価格下落ストレステスト
"""

import argparse
import csv
import sys
from dataclasses import dataclass, field
from pathlib import Path

# ---- 判定基準の設定（根拠は docs/dennou-sedori-tips.md 11-3 / 15-2 / 15-3） ----
CONFIG = {
    "DEFAULT_REFERRAL_FEE_RATE": 0.15,  # 要確認: 実際はカテゴリにより5〜15.4%程度で変動する
    "MIN_PROFIT_MARGIN": 0.20,          # 11-3: 利益率20%以上
    "MIN_PROFIT_YEN": 1000,             # 15-2: 粗利1,000円を基準とする（1,500円は上振れケース）
    "MIN_MONTHLY_SALES": 3,             # 11-3: 月3個以上売れている実績
    "STRESS_DROP_1": 0.10,              # 15-3: -10%ストレステスト
    "STRESS_DROP_2": 0.20,              # 15-3: -20%ストレステスト
}

REQUIRED_COLUMNS = ["asin", "rakuten_price", "amazon_price"]

YES_VALUES = {"yes", "y", "true", "1", "はい"}
NO_VALUES = {"no", "n", "false", "0", "いいえ"}


def to_tri_bool(value: str):
    """yes -> True / no -> False / 空欄・不明な値 -> None（未確認）"""
    v = str(value or "").strip().lower()
    if v in YES_VALUES:
        return True
    if v in NO_VALUES:
        return False
    return None


def to_float(value: str, default: float = 0.0) -> float:
    value = (value or "").strip()
    if value == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


def to_float_optional(value: str):
    """空欄なら None（未確認）、それ以外は数値に変換する"""
    value = (value or "").strip()
    if value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


@dataclass
class Candidate:
    asin: str
    product_name: str
    rakuten_price: float
    point_rebate_rate: float
    amazon_price: float
    referral_fee_rate: float
    fba_fee: float
    estimated_monthly_sales: object  # float または None（未確認）
    seller_count_spike: object       # bool または None（未確認）
    amazon_itself_selling: object    # bool または None（未確認）
    is_famous_brand: object          # bool または None（未確認）
    research_minutes: float
    notes: str

    effective_cost: float = field(init=False, default=0.0)
    profit: float = field(init=False, default=0.0)
    profit_margin: float = field(init=False, default=0.0)
    stress10_profit: float = field(init=False, default=0.0)
    stress20_profit: float = field(init=False, default=0.0)
    break_even_price: float = field(init=False, default=0.0)
    category: str = field(init=False, default="")
    reasons: list = field(init=False, default_factory=list)

    def compute(self) -> None:
        self.effective_cost = self.rakuten_price * (1 - self.point_rebate_rate)

        def profit_at(price: float) -> float:
            return price - self.effective_cost - price * self.referral_fee_rate - self.fba_fee

        self.profit = profit_at(self.amazon_price)
        self.profit_margin = self.profit / self.amazon_price if self.amazon_price else 0.0
        self.stress10_profit = profit_at(self.amazon_price * (1 - CONFIG["STRESS_DROP_1"]))
        self.stress20_profit = profit_at(self.amazon_price * (1 - CONFIG["STRESS_DROP_2"]))

        denom = 1 - self.referral_fee_rate
        self.break_even_price = (self.effective_cost + self.fba_fee) / denom if denom > 0 else float("inf")

        self._judge()

    def _judge(self) -> None:
        hard_fail_reasons = []
        unknown_reasons = []

        # 即座に見送り（9-2 真贋調査リスク、9-3 出品者急増、7-2 Amazon本体出品）
        # True/False が明示されている場合のみ判定する。空欄（None）は「安全」とは解釈しない。
        if self.amazon_itself_selling is True:
            hard_fail_reasons.append("Amazon本体が出品している")
        elif self.amazon_itself_selling is None:
            unknown_reasons.append("Amazon本体の出品有無が未確認")

        if self.is_famous_brand is True:
            hard_fail_reasons.append("有名ブランド品（真贋調査リスク）")
        elif self.is_famous_brand is None:
            unknown_reasons.append("有名ブランド品かどうかが未確認（真贋調査リスクの見落とし注意）")

        if self.seller_count_spike is True:
            hard_fail_reasons.append("出品者数が急増している（値崩れの波を警戒）")
        elif self.seller_count_spike is None:
            unknown_reasons.append("出品者数の急増有無が未確認")

        if self.estimated_monthly_sales is None:
            unknown_reasons.append("月間販売数が未確認")
        elif self.estimated_monthly_sales < CONFIG["MIN_MONTHLY_SALES"]:
            hard_fail_reasons.append(
                f"月間販売数が基準未満（{self.estimated_monthly_sales} < {CONFIG['MIN_MONTHLY_SALES']}）"
            )

        if self.profit < 0:
            hard_fail_reasons.append("現在価格でも赤字")
        if self.profit_margin < CONFIG["MIN_PROFIT_MARGIN"]:
            hard_fail_reasons.append(
                f"利益率が基準未満（{self.profit_margin:.1%} < {CONFIG['MIN_PROFIT_MARGIN']:.0%}）"
            )
        if self.profit < CONFIG["MIN_PROFIT_YEN"]:
            hard_fail_reasons.append(
                f"粗利が基準未満（{self.profit:.0f}円 < {CONFIG['MIN_PROFIT_YEN']}円）"
            )

        if hard_fail_reasons:
            self.category = "C"
            self.reasons = hard_fail_reasons
            return

        # ここまで通過 → 15-3の価格下落ストレステスト
        if self.stress20_profit < 0:
            self.category = "B"
            self.reasons = ["基本基準は満たすが、-20%の価格下落で赤字化する（要再確認）"]
            return

        # 明確な不合格理由はないが、リスクフラグが未確認のまま → Aにはしない
        if unknown_reasons:
            self.category = "B"
            self.reasons = unknown_reasons
            return

        self.category = "A"
        self.reasons = ["基本基準・-20%ストレステストともに通過（リスクフラグも確認済み）"]


def load_candidates(path: Path) -> list:
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            sys.exit(f"エラー: 必須列が見つかりません: {missing}\n"
                     f"CSVのヘッダーを確認してください（template.csv を参照）。")

        candidates = []
        skipped = 0
        for i, row in enumerate(reader, start=2):  # 2行目からデータ（1行目はヘッダー）
            try:
                c = Candidate(
                    asin=row.get("asin", "").strip(),
                    product_name=row.get("product_name", "").strip(),
                    rakuten_price=to_float(row.get("rakuten_price")),
                    point_rebate_rate=to_float(row.get("point_rebate_rate"), 0.0),
                    amazon_price=to_float(row.get("amazon_price")),
                    referral_fee_rate=to_float(
                        row.get("referral_fee_rate"), CONFIG["DEFAULT_REFERRAL_FEE_RATE"]
                    ),
                    fba_fee=to_float(row.get("fba_fee"), 0.0),
                    estimated_monthly_sales=to_float_optional(row.get("estimated_monthly_sales")),
                    seller_count_spike=to_tri_bool(row.get("seller_count_spike")),
                    amazon_itself_selling=to_tri_bool(row.get("amazon_itself_selling")),
                    is_famous_brand=to_tri_bool(row.get("is_famous_brand")),
                    research_minutes=to_float(row.get("research_minutes"), 0.0),
                    notes=row.get("notes", "").strip(),
                )
                if not c.asin or c.rakuten_price <= 0 or c.amazon_price <= 0:
                    print(f"警告: {i}行目はasin/rakuten_price/amazon_priceが不正なためスキップします")
                    skipped += 1
                    continue
                c.compute()
                candidates.append(c)
            except Exception as e:  # noqa: BLE001
                print(f"警告: {i}行目の読み込みに失敗したためスキップします（{e}）")
                skipped += 1
        if skipped:
            print(f"-> 合計 {skipped} 行をスキップしました\n")
        return candidates


def tri_bool_str(value) -> str:
    if value is True:
        return "yes"
    if value is False:
        return "no"
    return "未確認"


def write_result(candidates: list, out_path: Path) -> None:
    fieldnames = [
        "asin", "product_name", "rakuten_price", "point_rebate_rate", "amazon_price",
        "referral_fee_rate", "fba_fee", "estimated_monthly_sales",
        "seller_count_spike", "amazon_itself_selling", "is_famous_brand",
        "effective_cost", "profit", "profit_margin",
        "stress10_profit", "stress20_profit", "break_even_price",
        "category", "reasons", "research_minutes", "notes",
    ]
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for c in candidates:
            writer.writerow({
                "asin": c.asin,
                "product_name": c.product_name,
                "rakuten_price": c.rakuten_price,
                "point_rebate_rate": c.point_rebate_rate,
                "amazon_price": c.amazon_price,
                "referral_fee_rate": c.referral_fee_rate,
                "fba_fee": c.fba_fee,
                "estimated_monthly_sales": c.estimated_monthly_sales if c.estimated_monthly_sales is not None else "未確認",
                "seller_count_spike": tri_bool_str(c.seller_count_spike),
                "amazon_itself_selling": tri_bool_str(c.amazon_itself_selling),
                "is_famous_brand": tri_bool_str(c.is_famous_brand),
                "effective_cost": round(c.effective_cost),
                "profit": round(c.profit),
                "profit_margin": f"{c.profit_margin:.1%}",
                "stress10_profit": round(c.stress10_profit),
                "stress20_profit": round(c.stress20_profit),
                "break_even_price": round(c.break_even_price),
                "category": c.category,
                "reasons": " / ".join(c.reasons),
                "research_minutes": c.research_minutes,
                "notes": c.notes,
            })


def print_summary(candidates: list) -> None:
    total = len(candidates)
    if total == 0:
        print("有効なデータがありませんでした。")
        return

    by_cat = {"A": [], "B": [], "C": []}
    for c in candidates:
        by_cat[c.category].append(c)

    a, b, c_ = by_cat["A"], by_cat["B"], by_cat["C"]
    pass_rate = len(a) / total

    print("=" * 60)
    print("Phase 0 分析結果サマリー")
    print("=" * 60)
    print(f"調査件数: {total}件")
    print(f"  A（仕入れ候補）: {len(a)}件")
    print(f"  B（要確認）    : {len(b)}件")
    print(f"  C（見送り）    : {len(c_)}件")
    print()
    print(f"仕入れ基準通過率（A ÷ 総数）: {pass_rate:.1%}")
    print()

    # 15-4の判断目安をそのまま表示
    print("判断目安（docs/dennou-sedori-tips.md 15-4）:")
    print("  15%前後（100件中15件）が通過 → 手法として有望")
    print("  3%前後（100件中3件）        → 効率化（ツール導入）が前提になる")
    print("  0〜1%（100件中0〜1件）      → この手法自体を再考する")
    print()

    if a:
        avg_profit_a = sum(c.profit for c in a) / len(a)
        avg_margin_a = sum(c.profit_margin for c in a) / len(a)
        print(f"A評価の平均粗利: {avg_profit_a:.0f}円")
        print(f"A評価の平均利益率: {avg_margin_a:.1%}")
        print()

    total_minutes = sum(c.research_minutes for c in candidates)
    if total_minutes > 0:
        minutes_per_item = total_minutes / total
        print(f"1件あたりの平均調査時間: {minutes_per_item:.1f}分")
        if a:
            expected_profit_per_hour = (sum(c.profit for c in a) / total_minutes) * 60
            print(f"リサーチ1時間あたりの期待利益額（A評価の合計粗利ベース）: "
                  f"約{expected_profit_per_hour:.0f}円/時")
            print("  ※ 15-5の先行指標（1時間あたりに発見できた利益商品の期待利益額）に対応")
        print()

    print("見送り理由の内訳（Cのみ集計）:")
    reason_counts = {}
    for c in c_:
        for r in c.reasons:
            reason_counts[r] = reason_counts.get(r, 0) + 1
    for reason, count in sorted(reason_counts.items(), key=lambda x: -x[1]):
        print(f"  {count:3d}件: {reason}")
    print("=" * 60)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input_csv", type=Path, help="候補商品を記録したCSVファイル")
    parser.add_argument("--out", type=Path, default=None, help="判定結果を書き出すCSVファイル（省略時は <input>_result.csv）")
    args = parser.parse_args()

    if not args.input_csv.exists():
        sys.exit(f"エラー: ファイルが見つかりません: {args.input_csv}")

    candidates = load_candidates(args.input_csv)
    print_summary(candidates)

    out_path = args.out or args.input_csv.with_name(args.input_csv.stem + "_result.csv")
    write_result(candidates, out_path)
    print(f"\n詳細な判定結果を書き出しました: {out_path}")


if __name__ == "__main__":
    main()
