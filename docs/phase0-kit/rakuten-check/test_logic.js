// logic.js のテスト。実行: node test_logic.js（外部ライブラリ不要）
const assert = require("assert");
const L = require("./logic.js");

function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}`);
    throw e;
  }
}

const CSV_TEXT =
  "﻿ASIN,Title,Brand,Model,\"Buy Box 🚚: Current\",\"Amazon: Current\",\"New Offer Count: Current\"," +
  "\"New Offer Count: 90 days avg.\",Bought in past month,Referral Fee %,FBA Pick&Pack Fee,Product Codes: EAN\r\n" +
  "B000000001,\"エフェクター \"\"テスト\"\" OD-100\",NoBrand,OD-100,\"¥ 6,980\",,5,4,50,10 %,¥ 434,\"0012345678905, 4901234567894\"\r\n" +
  "B000000002,Apple AirPods XYZ12,Apple,XYZ12,\"¥ 20,000\",,8,8,300,8 %,¥ 500,\r\n" +
  "B000000003,工具セット TU-55,Foo,,\"¥ 3,000\",\"¥ 2,900\",6,6,20,10 %,¥ 400,\r\n" +
  "B000000004,型番なし商品,Foo,,\"¥ 3,000\",,6,6,20,10 %,¥ 400,\r\n" +
  "B000000005,型番なしJANあり,Foo,,\"¥ 3,000\",,6,6,20,10 %,¥ 400,4512345678901\r\n" +
  "B000000006,急増中 AB-12,Foo,AB-12,\"¥ 3,000\",,12,5,20,10 %,¥ 400,\r\n";

const { headers, records } = L.parseCSV(CSV_TEXT);
const mapping = L.detectColumns(headers);
const ps = records.map((r) => L.toProduct(r, mapping));
const opts = {
  famousBrands: ["Apple"],
  treatUnlistedBrandAsSafe: true,
  extraPointPct: 0,
  fallbackFbaFee: 500,
  sellerName: "",
};
const rakutenOD = {
  itemName: "新品 OD-100",
  itemPrice: 4000,
  availability: 1,
  pointRate: 5,
  shopName: "楽器屋A",
  postageFlag: 0,
  itemCaption: "",
};

test("CSVの引用符・改行・BOMを読める", () => {
  assert.strictEqual(records.length, 6);
  assert.strictEqual(records[0].Title, 'エフェクター "テスト" OD-100');
});

test("Keepaの列名を自動で対応づける", () => {
  assert.strictEqual(mapping.buyBoxPrice, "Buy Box 🚚: Current");
  assert.strictEqual(mapping.offerCountAvg90, "New Offer Count: 90 days avg.");
  assert.strictEqual(mapping.ean, "Product Codes: EAN");
});

test("数値・Amazon本体・手数料・急増を読み取る", () => {
  assert.strictEqual(ps[0].amazonPrice, 6980);
  assert.strictEqual(ps[0].amazonItselfSelling, false);
  assert.strictEqual(ps[0].referralFeeRate, 0.1);
  assert.strictEqual(ps[0].fbaFee, 434);
  assert.strictEqual(ps[0].sellerCountSpike, false);
  assert.strictEqual(ps[2].amazonItselfSelling, true);
  assert.strictEqual(ps[5].sellerCountSpike, true);
});

test("型番がない行は商品名から拾う・JANは日本のコードを優先", () => {
  assert.strictEqual(ps[2].model, "TU-55");
  assert.strictEqual(ps[3].model, null);
  assert.strictEqual(ps[0].jan, "4901234567894");
  assert.strictEqual(ps[4].jan, "4512345678901");
  assert.strictEqual(L.extractModelFromTitle("ＢＯＳＳ　ＤＳ－１Ｗ 技クラフト"), "DS-1W");
  assert.strictEqual(L.extractModelFromTitle("マキタ 充電式 TD173DRGX 18V"), "TD173DRGX");
});

test("Amazon側だけで不合格が決まる商品を先に弾く", () => {
  const f = (p) => L.amazonSideHardFails(p, L.isFamousBrand(p.brand, opts.famousBrands, true));
  assert.deepStrictEqual(f(ps[0]), []);
  assert.ok(f(ps[1]).some((r) => r.includes("有名ブランド")));
  assert.ok(f(ps[2]).some((r) => r.includes("Amazon本体")));
  assert.ok(f(ps[3]).some((r) => r.includes("型番もJANも")));
  assert.deepStrictEqual(f(ps[4]), []);
  assert.ok(f(ps[5]).some((r) => r.includes("急増")));
});

test("楽天の応答はformatVersion 1/2どちらも読める", () => {
  const v2 = { Items: [rakutenOD] };
  const v1 = { Items: [{ Item: rakutenOD }] };
  assert.deepStrictEqual(L.normalizeRakutenItems(v1), L.normalizeRakutenItems(v2));
});

test("型番一致：区切りの違いは許し、前後に続く英数字は別型番とみなす", () => {
  const items = [
    { itemName: "OD-1000 上位機種", itemPrice: 100 },
    { itemName: "XOD-100", itemPrice: 200 },
    { itemName: "OD-100 在庫なし", itemPrice: 250, availability: 0 },
    { itemName: "【新品】OD 100", itemPrice: 300 },
    { itemName: "OD100", itemPrice: 400 },
  ];
  const r = L.pickRakutenMatch(items, "OD-100");
  assert.strictEqual(r.match.itemPrice, 300);
  assert.strictEqual(r.matchedCount, 2);
  assert.strictEqual(r.cheapestAny.itemPrice, 100);
});

test("JAN一致：商品名か商品説明にJANが書かれているものだけ", () => {
  const items = [
    { itemName: "似た商品", itemPrice: 100, itemCaption: "JAN: 4999999999999" },
    { itemName: "本命", itemPrice: 500, itemCaption: "JANコード：4512345678901" },
  ];
  const r = L.pickRakutenMatchByJan(items, "4512345678901");
  assert.strictEqual(r.match.itemPrice, 500);
});

test("利益計算とA判定（analyze.pyと同じ式）", () => {
  const ev = L.evaluate(ps[0], rakutenOD, opts);
  // 実質仕入れ 4000×(1-5%)=3800、利益 6980-3800-698-434=2048
  assert.strictEqual(Math.round(ev.effectiveCost), 3800);
  assert.strictEqual(Math.round(ev.profit), 2048);
  assert.strictEqual(ev.category, "A");
});

test("転売表記・送料別・似た店名はA止めにする", () => {
  const item = Object.assign({}, rakutenOD, {
    itemCaption: "転売目的のご購入はお断り",
    postageFlag: 1,
    shopName: "テスト楽器店",
  });
  const ev = L.evaluate(ps[0], item, Object.assign({}, opts, { sellerName: "テスト楽器店" }));
  assert.strictEqual(ev.category, "B");
  assert.strictEqual(ev.reasons.length, 3);
});

test("赤字はC、C判定でも楽天側の警告は理由に残す", () => {
  const ev = L.evaluate(ps[0], Object.assign({}, rakutenOD, { itemPrice: 7000, postageFlag: 1 }), opts);
  assert.strictEqual(ev.category, "C");
  assert.ok(ev.reasons.some((r) => r.includes("送料別")));
});

test("FBA手数料がないときは仮の値で計算し、A止めにする", () => {
  const p = Object.assign({}, ps[0], { fbaFee: null });
  const ev = L.evaluate(p, rakutenOD, opts);
  assert.strictEqual(ev.fba, 500);
  assert.strictEqual(ev.category, "B");
});

test("セラー評価の目安", () => {
  const mk = (cats) => cats.map((c) => ({ category: c, modelMatch: true }));
  assert.strictEqual(L.suggestSellerRating(mk(["A", "A", "C"])).rating, "S");
  assert.strictEqual(L.suggestSellerRating(mk(["A", "C", "C"])).rating, "A");
  assert.strictEqual(L.suggestSellerRating(mk(["B", "B", "B"])).rating, "A");
  assert.strictEqual(L.suggestSellerRating(mk(["B", "C", "C"])).rating, "B");
  assert.strictEqual(L.suggestSellerRating(mk(["C", "C", "C"])).rating, "C");
  assert.strictEqual(L.suggestSellerRating(mk(["A", "A"])).rating, null);
  const withUnmatched = mk(["A", "A"]).concat([{ category: "C", modelMatch: false }]);
  assert.strictEqual(L.suggestSellerRating(withUnmatched).rating, null);
});

test("対応づけられなかった重要な列を知らせる", () => {
  assert.deepStrictEqual(L.missingImportantColumns(mapping), []);
  const partial = L.detectColumns(["ASIN", "商品名", "価格"]);
  const missing = L.missingImportantColumns(partial);
  assert.ok(missing.includes("Amazon価格"));
  assert.ok(missing.includes("型番・JAN（なければ商品名から推測）"));
  assert.ok(!missing.includes("商品名"));
});

test("複数セラーの結果を集計し、15-4の目安で判断する", () => {
  const rows = [];
  const add = (seller, n, cat, matched) => {
    for (let i = 0; i < n; i++) rows.push({ seller_name: seller, category: cat, rakuten_matched: matched });
  };
  add("店X", 2, "A", "yes");
  add("店X", 8, "C", "yes");
  add("店X", 100, "C", "no");
  add("店Y", 1, "B", "yes");
  add("店Y", 9, "C", "yes");
  const agg = L.aggregateResults(rows);
  const x = agg.sellers.find((s) => s.name === "店X");
  assert.strictEqual(x.total, 110);
  assert.strictEqual(x.matched, 10);
  assert.strictEqual(x.passRate, 0.2);
  assert.strictEqual(agg.overall.matched, 20);
  assert.strictEqual(agg.overall.A, 2);
  assert.strictEqual(agg.overall.passRate, 0.1);
  assert.ok(agg.verdict.startsWith("有望"));

  assert.ok(L.aggregateResults(rows.slice(0, 5)).verdict.includes("まだ判断できません"));
  const low = [];
  for (let i = 0; i < 50; i++) low.push({ seller_name: "Z", category: i === 0 ? "A" : "C", rakuten_matched: "yes" });
  assert.ok(L.aggregateResults(low).verdict.startsWith("効率化が前提"));
  const none = low.map((r) => Object.assign({}, r, { category: "C" }));
  assert.ok(L.aggregateResults(none).verdict.startsWith("厳しい"));
});

test("小口出品の基本成約料を利益から引く", () => {
  const ev = L.evaluate(ps[0], rakutenOD, Object.assign({}, opts, { perItemFee: 100 }));
  assert.strictEqual(Math.round(ev.profit), 2048 - 100);
  assert.strictEqual(ev.perItemFee, 100);
});

test("作業時間から1時間あたりの発見件数と見込み利益を出す", () => {
  const rows = [
    { seller_name: "X", category: "A", rakuten_matched: "yes", profit: "1500", research_minutes: "30" },
    { seller_name: "X", category: "A", rakuten_matched: "yes", profit: "2500", research_minutes: "" },
    { seller_name: "X", category: "C", rakuten_matched: "yes", profit: "-100", research_minutes: "" },
    { seller_name: "Y", category: "B", rakuten_matched: "yes", profit: "900", research_minutes: "30" },
  ];
  const agg = L.aggregateResults(rows);
  assert.strictEqual(agg.overall.minutes, 60);
  assert.strictEqual(agg.overall.aPerHour, 2);
  assert.strictEqual(agg.overall.profitPerHour, 4000);
  const y = agg.sellers.find((s) => s.name === "Y");
  assert.strictEqual(y.aPerHour, 0);
  assert.strictEqual(L.aggregateResults([{ seller_name: "Z", category: "A", rakuten_matched: "yes" }]).overall.aPerHour, null);
});

test("Amazonの手数料に消費税を上乗せする", () => {
  const ev = L.evaluate(ps[0], rakutenOD, Object.assign({}, opts, { perItemFee: 100, feeTaxRate: 0.1 }));
  // 手数料 698+434+100=1232 に10%上乗せ → 1355.2。利益 6980-3800-1355.2=1824.8
  assert.strictEqual(Math.round(ev.profit), 1825);
  assert.strictEqual(ev.feeTaxRate, 0.1);
});

test("容量・単位・寸法を型番と取り違えない", () => {
  assert.strictEqual(L.extractModelFromTitle("ステンレスボトル 500ml 保温"), null);
  assert.strictEqual(L.extractModelFromTitle("モバイルバッテリー 10000mAh 大容量"), null);
  assert.strictEqual(L.extractModelFromTitle("ラグ 130x190cm"), null);
  assert.strictEqual(L.extractModelFromTitle("象印 ステンレスマグ 360ml SM-ZB36-BA"), "SM-ZB36-BA");
  assert.strictEqual(L.extractModelFromTitle("タイガー 水筒 MMZ-K060 0.6L"), "MMZ-K060");
  assert.strictEqual(L.extractModelFromTitle("マキタ インパクトドライバ TD173DRGX 18V"), "TD173DRGX");
});

test("付属品・部品を本体と取り違えない（2026-09-25の実データ試験の再現）", () => {
  const f91 = [
    { itemName: "F-91W 交換バンド 互換品", itemPrice: 448, availability: 1 },
    { itemName: "CASIO F-91W-1JH デジタル腕時計", itemPrice: 1980, availability: 1 },
  ];
  const minF = L.minRakutenPrice(2500);
  assert.strictEqual(minF, 750);
  assert.strictEqual(L.pickRakutenMatch(f91, "F-91W", minF).match.itemPrice, 1980);

  const ds1 = [
    { itemName: "DS-1 対応 パッチケーブル", itemPrice: 500, availability: 1 },
    { itemName: "BOSS DS-1 Distortion ディストーション", itemPrice: 7480, availability: 1 },
  ];
  assert.strictEqual(L.pickRakutenMatch(ds1, "DS-1", L.minRakutenPrice(8000)).match.itemPrice, 7480);

  const jnl = [{ itemName: "サーモス JNL-506 専用 パッキンセット", itemPrice: 880, availability: 1 }];
  assert.strictEqual(L.pickRakutenMatch(jnl, "JNL-506", L.minRakutenPrice(3000)).match, null);

  assert.ok(L.looksLikeAccessory("F-91W 交換バンド"));
  assert.ok(!L.looksLikeAccessory("CASIO F-91W-1JH"));
});

test("楽天がAmazonの半額未満なら警告してA判定にしない", () => {
  const cheap = Object.assign({}, rakutenOD, { itemPrice: 3000 });
  const ev = L.evaluate(ps[0], cheap, opts);
  assert.strictEqual(ev.category, "B");
  assert.ok(ev.reasons.some((r) => r.includes("半額未満")));
});

test("画面とプログラムのバージョンがそろっている", () => {
  const html = require("fs").readFileSync(require("path").join(__dirname, "index.html"), "utf-8");
  const v = L.TOOL_VERSION;
  assert.ok(html.includes(`<meta name="tool-version" content="${v}">`), "index.htmlのmetaがTOOL_VERSIONと違う");
  assert.ok(html.includes(`logic.js?v=${v}`) && html.includes(`app.js?v=${v}`), "scriptの?v=がTOOL_VERSIONと違う");
});

console.log("すべて成功");
