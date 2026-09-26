// 楽天照合ツールの計算・判定ロジック（画面から切り離し、Node.jsでもテストできるようにしている）。
// 判定基準は ../analyze.py の CONFIG / _judge と揃えること。
(function (root) {
  // 画面に表示するバージョン。変更したら index.html の meta と script の ?v= も同じ値にする
  // （test_logic.js が食い違いを検出する）。
  const TOOL_VERSION = "2026.09.26-1";

  const CONFIG = {
    DEFAULT_REFERRAL_FEE_RATE: 0.15,
    MIN_PROFIT_MARGIN: 0.2,
    MIN_PROFIT_YEN: 1000,
    MIN_MONTHLY_SALES: 3,
    STRESS_DROP_1: 0.1,
    STRESS_DROP_2: 0.2,
    LOW_SELLER_COUNT_THRESHOLD: 2,
    // 出品者数の急増判定：現在値が90日平均の1.5倍以上、かつ3人以上増えている
    SPIKE_RATIO: 1.5,
    SPIKE_MIN_INCREASE: 3,
    // 楽天で探すときの価格の下限（Amazon価格に対する比率）。型番の入った安い付属品・部品が
    // 検索結果の上位を埋めて本体が見つからなくなるのを防ぐ（2026-09-25、実データの試験で発覚）。
    MIN_RAKUTEN_PRICE_RATIO: 0.3,
    // 楽天の価格がAmazonのこの比率未満なら、別商品・付属品・セット数違いを疑ってA判定にしない。
    SUSPICIOUS_PRICE_RATIO: 0.5,
    // Amazon価格より高い楽天の商品は仕入れても利益が出ないので、検索の段階で除く。
    MAX_RAKUTEN_PRICE_RATIO: 1.0,
  };

  // 楽天の商品名にこれらがあり、Amazonの商品名にはない場合は、型番が一致しても
  // 本体ではなく付属品・部品とみなす（例：「Boss DS-1用 電源アダプタ」。2026-09-25の実データで発覚）。
  // Amazon側の商品名にも同じ言葉があるなら、その商品自体がアダプター等なので除外しない。
  const ACCESSORY_WORDS = [
    "互換", "交換", "替え", "替芯", "替刃", "部品", "パーツ", "専用", "対応",
    "バンド", "ベルト", "パッキン", "フィルム", "保護", "カバー", "ケース",
    "アダプタ", "充電器", "電源", "ケーブル", "コード", "ストラップ", "スタンド",
    "収納", "リモコン", "電池", "バッテリー",
  ];
  // 本体かどうかに関係なく、状態の理由で仕入れに使わないもの
  const CONDITION_WORDS = ["中古", "ジャンク", "訳あり", "アウトレット"];

  function looksLikeAccessory(itemName, amazonTitle) {
    const name = String(itemName || "").normalize("NFKC");
    const title = String(amazonTitle || "").normalize("NFKC");
    if (CONDITION_WORDS.some((w) => name.includes(w))) return true;
    if (ACCESSORY_WORDS.some((w) => name.includes(w) && !title.includes(w))) return true;
    // 「for Roland Boss DS-1」のような英語の「〜用」
    return /\bfor\b/i.test(name) && !/\bfor\b/i.test(title);
  }

  // 楽天の結果のうち、候補にしてよいもの（在庫あり・価格が下限以上・付属品らしくない）を安い順に並べる。
  function usableItems(items, minPrice, amazonTitle) {
    return items
      .filter((it) => it.availability == null || Number(it.availability) === 1)
      .filter((it) => !minPrice || Number(it.itemPrice) >= minPrice)
      .filter((it) => !looksLikeAccessory(it.itemName, amazonTitle))
      .sort((a, b) => Number(a.itemPrice) - Number(b.itemPrice));
  }

  function maxRakutenPrice(amazonPrice) {
    return amazonPrice ? Math.ceil(amazonPrice * CONFIG.MAX_RAKUTEN_PRICE_RATIO) : 0;
  }

  // 楽天で検索する語の順番。型番だけだと楽天が「DS」「1」のように細かく分けて検索し、
  // 無関係な商品で結果が埋まる（2026-09-25、BOSS DS-1・CASIO F-91Wで発覚）。
  // まずブランド名＋型番で探し、見つからなければ型番だけで探す。
  const GENERIC_BRANDS = ["ノーブランド", "ノーブランド品", "generic", "unbranded", "no brand", "nobrand", "no-brand"];
  function buildSearchKeywords(p) {
    const keywords = [];
    const brand = String(p.brand || "").normalize("NFKC").trim();
    const model = String(p.model || "").trim();
    if (!model) return keywords;
    const brandUsable =
      brand && !GENERIC_BRANDS.includes(brand.toLowerCase()) &&
      !normalizeForMatch(model).includes(normalizeForMatch(brand));
    if (brandUsable) keywords.push(`${brand} ${model}`);
    keywords.push(model);
    return keywords;
  }

  function minRakutenPrice(amazonPrice) {
    return amazonPrice ? Math.floor(amazonPrice * CONFIG.MIN_RAKUTEN_PRICE_RATIO) : 0;
  }

  // 商品説明にこれらが含まれていたら「転売お断り」の可能性として警告する。
  // 「転売品ではありません」のような無関係な用例も拾うため、C判定にはせずA止めにする。
  const RESALE_KEYWORDS = ["転売", "業者様", "同業者", "営利目的"];

  // 海外からの発送・並行輸入品は、真贋調査・PSE・到着までの日数のリスクが高い。
  // 本体として一致していても、仕入れる前に目で確かめるためA止めにする。
  const IMPORT_KEYWORDS = ["並行輸入", "海外輸入", "輸入品", "海外発送", "海外から発送", "海外直送", "海外倉庫", "取り寄せ"];

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const s = text.replace(/^﻿/, "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
    if (!nonEmpty.length) return { headers: [], records: [] };
    const headers = nonEmpty[0].map((h) => h.trim());
    const records = nonEmpty.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, idx) => (obj[h] = (r[idx] || "").trim()));
      return obj;
    });
    return { headers, records };
  }

  function toCSV(headers, rows) {
    const esc = (v) => {
      const str = v == null ? "" : String(v);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    return [headers.map(esc).join(",")]
      .concat(rows.map((r) => headers.map((h) => esc(r[h])).join(",")))
      .join("\r\n");
  }

  // Keepaのエクスポート列名は言語設定やバージョンで揺れるため、候補を部分一致で探す。
  // 見つからない列は画面上で手動で選び直せる。
  const FIELD_CANDIDATES = {
    asin: ["asin"],
    title: ["title", "商品名", "タイトル"],
    model: ["model", "モデル", "型番"],
    partNumber: ["part number", "部品番号", "品番"],
    brand: ["brand", "ブランド"],
    buyBoxPrice: ["buy box: current", "buy box 🚚: current", "カート: 現在", "buy box current", "buy box: 現在"],
    newPrice: ["new: current", "新品: 現在"],
    amazonPrice: ["amazon: current", "amazon: 現在"],
    offerCount: ["new offer count: current", "新品出品者数: 現在", "offer count: current", "新品アイテム数: 現在"],
    offerCountAvg90: ["new offer count: 90 days avg", "新品出品者数: 90日平均", "新品アイテム数: 90 日平均"],
    boughtPastMonth: ["bought in past month", "過去1か月の購入数", "過去1ヶ月", "先月の購入"],
    referralFeePct: ["referral fee %", "販売手数料 %", "referral fee"],
    fbaFee: ["fba pick&pack fee", "fba fee", "fba手数料", "fba pick"],
    ean: ["product codes: ean", "ean", "jan"],
  };

  // KeepaのEAN列は「4901234567890, 0012345678905」のように複数入ることがある。
  // 13桁のうち、日本のJAN（45/49で始まる）を優先して1つ選ぶ。
  function parseJan(value) {
    const codes = String(value || "")
      .normalize("NFKC")
      .split(/[,\s;|]+/)
      .filter((c) => /^\d{13}$/.test(c));
    return codes.find((c) => /^4[59]/.test(c)) || codes[0] || null;
  }

  function detectColumns(headers) {
    const lower = headers.map((h) => h.toLowerCase());
    const mapping = {};
    for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
      let found = null;
      for (const cand of candidates) {
        const idx = lower.findIndex((h) => h === cand);
        if (idx >= 0) {
          found = headers[idx];
          break;
        }
      }
      if (!found) {
        for (const cand of candidates) {
          const idx = lower.findIndex((h) => h.includes(cand));
          if (idx >= 0) {
            found = headers[idx];
            break;
          }
        }
      }
      mapping[field] = found;
    }
    return mapping;
  }

  // 判定に効く列のうち、自動で対応づけられなかったものを画面に出す名前で返す。
  function missingImportantColumns(mapping) {
    const groups = [
      [["title"], "商品名"],
      [["buyBoxPrice", "newPrice"], "Amazon価格"],
      [["model", "partNumber", "ean"], "型番・JAN（なければ商品名から推測）"],
      [["amazonPrice"], "Amazon本体の価格"],
      [["offerCount"], "新品出品者数"],
      [["boughtPastMonth"], "過去1か月の購入数"],
      [["referralFeePct"], "販売手数料率"],
      [["fbaFee"], "FBA手数料"],
    ];
    return groups.filter(([fields]) => !fields.some((f) => mapping[f])).map(([, label]) => label);
  }

  // "¥ 1,234" "1,234円" "10.5 %" "-" などから数値を取り出す。取れなければnull。
  function parseNumber(value) {
    if (value == null) return null;
    const str = String(value).normalize("NFKC").replace(/[,¥円%\s]/g, "");
    if (str === "" || str === "-") return null;
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeForMatch(str) {
    return String(str || "")
      .normalize("NFKC")
      .toUpperCase()
      .replace(/[\s\-_/.・]/g, "");
  }

  // 商品名から型番らしき文字列（英字と数字を両方含む4文字以上の塊）を拾う。最長のものを採用。
  function extractModelFromTitle(title) {
    const tokens = String(title || "")
      .normalize("NFKC")
      .match(/[A-Za-z0-9][A-Za-z0-9\-/.]{3,}/g);
    if (!tokens) return null;
    // 「500ml」「1000mAh」「30x40」のような容量・単位・寸法は型番ではない。これを型番として
    // 楽天を検索すると、別の商品を「一致」と判断してしまうので除く（取り違えるより見送る方が安全）。
    const looksLikeUnitOrSize = (t) =>
      /^\d+(\.\d+)?[a-z]{1,3}$/i.test(t) || /^\d+(\.\d+)?[x×]\d+/i.test(t);
    const candidates = tokens
      .map((t) => t.replace(/[\-/.]+$/, ""))
      .filter((t) => /[A-Za-z]/.test(t) && /[0-9]/.test(t) && t.length >= 4)
      .filter((t) => !looksLikeUnitOrSize(t));
    if (!candidates.length) return null;
    return candidates.sort((a, b) => b.length - a.length)[0];
  }

  function toProduct(record, mapping) {
    const get = (field) => (mapping[field] ? record[mapping[field]] : undefined);
    const title = get("title") || "";
    const model =
      (get("model") && get("model").trim()) ||
      (get("partNumber") && get("partNumber").trim()) ||
      extractModelFromTitle(title);

    const amazonPrice = parseNumber(get("buyBoxPrice")) ?? parseNumber(get("newPrice"));

    let amazonItselfSelling = null;
    if (mapping.amazonPrice) {
      const p = parseNumber(get("amazonPrice"));
      amazonItselfSelling = p != null && p > 0;
    }

    const offerCount = parseNumber(get("offerCount"));
    const offerAvg = parseNumber(get("offerCountAvg90"));
    let sellerCountSpike = null;
    if (offerCount != null && offerAvg != null) {
      sellerCountSpike =
        offerCount >= offerAvg * CONFIG.SPIKE_RATIO &&
        offerCount - offerAvg >= CONFIG.SPIKE_MIN_INCREASE;
    }

    const refPct = parseNumber(get("referralFeePct"));
    return {
      asin: get("asin") || "",
      title,
      brand: get("brand") || "",
      model: model || null,
      jan: parseJan(get("ean")),
      amazonPrice,
      amazonItselfSelling,
      sellerCount: offerCount,
      sellerCountSpike,
      monthlySales: parseNumber(get("boughtPastMonth")),
      referralFeeRate: refPct != null ? refPct / 100 : null,
      fbaFee: parseNumber(get("fbaFee")),
    };
  }

  function isFamousBrand(brand, famousBrandList, treatUnlistedAsSafe) {
    const b = normalizeForMatch(brand);
    if (!b) return treatUnlistedAsSafe ? false : null;
    const hit = famousBrandList.some((f) => {
      const n = normalizeForMatch(f);
      return n && (b === n || b.includes(n));
    });
    if (hit) return true;
    return treatUnlistedAsSafe ? false : null;
  }

  // 楽天で検索する前に、Amazon側の情報だけで不合格が確定する理由を返す（楽天APIの呼び出しを節約）。
  function amazonSideHardFails(p, famous) {
    const reasons = [];
    if (p.amazonPrice == null) reasons.push("Amazon価格が取れない");
    if (p.amazonItselfSelling === true) reasons.push("Amazon本体が出品している");
    if (famous === true) reasons.push("有名ブランド品（真贋調査リスク）");
    if (p.sellerCountSpike === true) reasons.push("出品者数が急増している（値崩れの波を警戒）");
    if (p.sellerCount != null && p.sellerCount <= CONFIG.LOW_SELLER_COUNT_THRESHOLD) {
      reasons.push(
        `出品者数が少なすぎる（${p.sellerCount}人。メーカー/ブランド直接出品の可能性）`
      );
    }
    if (p.monthlySales != null && p.monthlySales < CONFIG.MIN_MONTHLY_SALES) {
      reasons.push(`月間販売数が基準未満（${p.monthlySales} < ${CONFIG.MIN_MONTHLY_SALES}）`);
    }
    if (!p.model && !p.jan) reasons.push("型番もJANも分からず楽天で同じ商品を探せない");
    return reasons;
  }

  // 楽天APIのレスポンス（formatVersion 1/2どちらも）を商品配列にそろえる。
  function normalizeRakutenItems(json) {
    const items = (json && json.Items) || [];
    return items.map((it) => (it && it.Item ? it.Item : it));
  }

  // 型番の一致判定。区切り文字（- や空白）の有無は無視するが、前後に英数字が続く場合は
  // 別型番とみなす（OD-100 が OD-1000 や XOD-100 に一致しないように）。
  function modelMatcher(model) {
    const chars = normalizeForMatch(model).split("");
    if (!chars.length) return () => false;
    const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const body = chars.map(esc).join("[\\s\\-_/.・]*");
    const re = new RegExp(`(?<![A-Z0-9])${body}(?![A-Z0-9])`);
    return (name) => re.test(String(name || "").normalize("NFKC").toUpperCase());
  }

  // 別メーカーが同じ型番を使っていることがある（例：BOSS DS-1 と サンカ ドラム缶オープナー DS-1。
  // 2026-09-25の実データで発覚）。KeepaのBrand列と、Amazonの商品名の先頭の語（「サーモス」
  // 「マキタ(Makita)」など）をブランド名の候補にし、楽天の商品名に含まれるかを見る。
  function brandCandidates(p) {
    const out = new Set();
    const add = (s) => {
      const n = normalizeForMatch(s);
      if (n.length >= 2 && !/AMAZON|限定|GENERIC|ノーブランド/.test(n)) out.add(n);
    };
    const brand = String(p.brand || "").normalize("NFKC").trim();
    // ブランドが不明・ノーブランドなら、商品名の先頭の語もブランドとは限らないので使わない
    if (!brand || GENERIC_BRANDS.includes(brand.toLowerCase())) return [];
    add(brand);
    const firstChunk = String(p.title || "").normalize("NFKC").trim().split(/\s+/)[0] || "";
    firstChunk.split(/[()（）\[\]【】「」]/).forEach(add);
    return [...out];
  }

  // 型番が一致したもののうち、ブランド名も商品名にあるものを優先する。
  // brandVerified: true=ブランドも一致 / false=型番だけ一致（別メーカーの疑い）/ null=ブランド不明で確認できない
  function pickRakutenMatch(items, model, minPrice, amazonTitle, brands) {
    const isMatch = modelMatcher(model);
    const sorted = usableItems(items, minPrice, amazonTitle);
    const matched = sorted.filter((it) => isMatch(it.itemName));
    const brandList = brands || [];
    const withBrand = brandList.length
      ? matched.filter((it) => brandList.some((b) => normalizeForMatch(it.itemName).includes(b)))
      : [];
    const match = withBrand[0] || matched[0] || null;
    return {
      match,
      cheapestAny: sorted[0] || null,
      matchedCount: matched.length,
      brandVerified: !match || !brandList.length ? null : withBrand.length > 0,
    };
  }

  // 照合のしかたから分かる注意点を判定結果に足す（A判定を取り消してBにする）。
  function applyMatchWarnings(ev, found) {
    if (found.brandVerified !== false) return ev;
    const warning = "楽天の商品名にブランド名がない（別メーカーの同じ型番の可能性。必ず目で確認）";
    const reasons = ev.category === "B" || ev.category === "C" ? [warning].concat(ev.reasons) : [warning];
    return Object.assign({}, ev, { category: ev.category === "A" ? "B" : ev.category, reasons });
  }

  // JANで検索した結果から、商品名か商品説明に同じJANが書かれているものを採用する。
  function pickRakutenMatchByJan(items, jan, minPrice, amazonTitle) {
    const sorted = usableItems(items, minPrice, amazonTitle);
    const matched = sorted.filter((it) =>
      `${it.itemName || ""} ${it.itemCaption || ""}`.normalize("NFKC").includes(jan)
    );
    return { match: matched[0] || null, cheapestAny: sorted[0] || null, matchedCount: matched.length };
  }

  // 1セラー分の照合結果から、Watchlistに書き戻すquality_ratingの目安を出す。
  // 照合できた（楽天で同じ商品が見つかった）件数が少なすぎるときは判断しない。
  function suggestSellerRating(results) {
    const checked = results.filter((r) => r.modelMatch === true);
    const a = checked.filter((r) => r.category === "A").length;
    const b = checked.filter((r) => r.category === "B").length;
    let rating;
    let why;
    if (checked.length < 3) {
      rating = null;
      why = `楽天で同じ商品が見つかったのが${checked.length}件だけなので判断できない`;
    } else if (a >= 2) {
      rating = "S";
      why = `A判定が${a}件ある`;
    } else if (a === 1 || b >= 3) {
      rating = "A";
      why = a === 1 ? "A判定が1件ある" : `B判定が${b}件ある`;
    } else if (b >= 1) {
      rating = "B";
      why = `A判定はなく、B判定が${b}件`;
    } else {
      rating = "C";
      why = "A判定・B判定がない";
    }
    return { rating, why, checked: checked.length, a, b };
  }

  // 保存した結果CSV（複数セラー分）をまとめ、手法の通過率を出す。
  // 通過率は「A判定 ÷ 楽天で同じ商品が見つかった件数」。dennou-sedori-tips.md 15-4 の
  // 通過率は「両モールの価格が分かった候補」が分母なので、それに揃えている
  // （Amazon側だけで弾いた商品まで分母に入れると、数百件のカタログで極端に小さくなる）。
  // 15-4の目安（15%前後=有望／3%前後=効率化が前提／0〜1%=手法を再考）の中間で区切る。
  function aggregateResults(rows) {
    const bySeller = new Map();
    const blank = () => ({ total: 0, matched: 0, A: 0, B: 0, C: 0, minutes: 0, profitA: 0 });
    const overall = blank();
    for (const r of rows) {
      const name = r.seller_name || "（セラー名なし）";
      if (!bySeller.has(name)) bySeller.set(name, blank());
      const minutes = parseNumber(r.research_minutes);
      const profit = parseNumber(r.profit);
      for (const agg of [bySeller.get(name), overall]) {
        agg.total++;
        if (minutes != null) agg.minutes += minutes;
        if (r.rakuten_matched === "yes" && r.category === "A" && profit != null) agg.profitA += profit;
        if (r.rakuten_matched === "yes") {
          agg.matched++;
          if (agg[r.category] != null) agg[r.category]++;
        }
      }
    }
    // 15-5の先行指標：作業1時間あたりに見つかったA判定の件数と、その見込み利益の合計
    const withRate = (agg) =>
      Object.assign(agg, {
        passRate: agg.matched ? agg.A / agg.matched : null,
        aPerHour: agg.minutes ? agg.A / (agg.minutes / 60) : null,
        profitPerHour: agg.minutes ? agg.profitA / (agg.minutes / 60) : null,
      });
    const sellers = [...bySeller.entries()].map(([name, agg]) =>
      Object.assign({ name }, withRate(agg))
    );
    withRate(overall);
    let verdict;
    if (overall.matched < 20) {
      verdict = `楽天で照合できた商品が${overall.matched}件と少ないため、まだ判断できません（20件以上を目安に）`;
    } else if (overall.passRate >= 0.08) {
      verdict = "有望（15-4の「15%前後」の水準）。この手法で仕入れ（Phase 1）に進む価値があります";
    } else if (overall.passRate >= 0.02) {
      verdict = "効率化が前提（15-4の「3%前後」の水準）。候補の母数を増やす工夫やツール導入が必要です";
    } else {
      verdict = "厳しい（15-4の「0〜1%」の水準）。手法そのものを見直す段階です";
    }
    return { sellers, overall, verdict };
  }

  function sellerNameLooksSame(shopName, sellerName) {
    const a = normalizeForMatch(shopName);
    const b = normalizeForMatch(sellerName);
    if (a.length < 3 || b.length < 3) return false;
    return a.includes(b) || b.includes(a);
  }

  function evaluate(p, rakutenItem, opts) {
    const famous = isFamousBrand(p.brand, opts.famousBrands, opts.treatUnlistedBrandAsSafe);
    const pointPct = (Number(rakutenItem.pointRate) || 1) + (Number(opts.extraPointPct) || 0);
    const rakutenPrice = Number(rakutenItem.itemPrice);
    const effectiveCost = rakutenPrice * (1 - pointPct / 100);
    const referral = p.referralFeeRate ?? CONFIG.DEFAULT_REFERRAL_FEE_RATE;
    const fbaFeeKnown = p.fbaFee != null;
    const fba = fbaFeeKnown ? p.fbaFee : Number(opts.fallbackFbaFee) || 0;

    // 小口出品は1個売れるごとに基本成約料（100円）がかかる。大口出品なら0。
    const perItemFee = Number(opts.perItemFee) || 0;
    // Amazonの手数料は税抜表示で、実際には消費税10%が上乗せされて差し引かれる
    // （免税事業者は取り戻せないのでそのまま費用になる）。0にすれば上乗せしない。
    const feeTax = 1 + (Number(opts.feeTaxRate) || 0);
    const profitAt = (price) =>
      price - effectiveCost - (price * referral + fba + perItemFee) * feeTax;
    const profit = profitAt(p.amazonPrice);
    const margin = p.amazonPrice ? profit / p.amazonPrice : 0;
    const stress20 = profitAt(p.amazonPrice * (1 - CONFIG.STRESS_DROP_2));

    const hard = amazonSideHardFails(p, famous);
    const unknown = [];
    const warnings = [];

    if (p.amazonItselfSelling == null) unknown.push("Amazon本体の出品有無が未確認");
    if (famous == null) unknown.push("有名ブランド品かどうかが未確認");
    if (p.sellerCountSpike == null) unknown.push("出品者数の急増有無が未確認");
    if (p.sellerCount == null) unknown.push("出品者数が未確認");
    if (p.monthlySales == null) unknown.push("月間販売数が未確認");
    if (p.referralFeeRate == null) unknown.push("販売手数料率が未確認（15%で仮計算）");
    if (!fbaFeeKnown) unknown.push(`FBA手数料が未確認（${fba}円で仮計算）`);

    if (profit < 0) hard.push("現在価格でも赤字");
    if (margin < CONFIG.MIN_PROFIT_MARGIN) {
      hard.push(`利益率が基準未満（${(margin * 100).toFixed(1)}% < 20%）`);
    }
    if (profit < CONFIG.MIN_PROFIT_YEN) {
      hard.push(`粗利が基準未満（${Math.round(profit)}円 < ${CONFIG.MIN_PROFIT_YEN}円）`);
    }

    const caption = String(rakutenItem.itemCaption || "");
    const resaleHit = RESALE_KEYWORDS.find((k) => caption.includes(k));
    if (resaleHit) warnings.push(`楽天の商品説明に「${resaleHit}」の記載あり（転売お断りでないか要確認）`);
    const itemText = `${rakutenItem.itemName || ""} ${caption}`.normalize("NFKC");
    const importHit = IMPORT_KEYWORDS.find((k) => itemText.includes(k));
    if (importHit) {
      warnings.push(`楽天の商品に「${importHit}」の記載あり（並行輸入品・海外発送の可能性。真贋調査・PSE・到着日数に注意）`);
    }
    if (Number(rakutenItem.postageFlag) === 1) warnings.push("楽天側は送料別（送料分だけ利益が減る）");
    if (rakutenPrice < p.amazonPrice * CONFIG.SUSPICIOUS_PRICE_RATIO) {
      warnings.push("楽天の価格がAmazonの半額未満（別の商品・付属品・セット数違いの可能性が高い。必ず目で確認）");
    }
    if (opts.sellerName && sellerNameLooksSame(rakutenItem.shopName, opts.sellerName)) {
      warnings.push(`楽天の店名「${rakutenItem.shopName}」がAmazonのセラー名と似ている（価格同期の可能性）`);
    }

    let category;
    let reasons;
    if (hard.length) {
      category = "C";
      reasons = hard.concat(warnings);
    } else if (stress20 < 0) {
      category = "B";
      reasons = ["基本基準は満たすが、-20%の価格下落で赤字化する"].concat(warnings);
    } else if (unknown.length || warnings.length) {
      category = "B";
      reasons = warnings.concat(unknown);
    } else {
      category = "A";
      reasons = ["基本基準・-20%ストレステストともに通過"];
    }

    return {
      category,
      reasons,
      rakutenPrice,
      pointPct,
      effectiveCost,
      referral,
      fba,
      perItemFee,
      feeTaxRate: Number(opts.feeTaxRate) || 0,
      profit,
      margin,
      stress20,
    };
  }

  const api = {
    TOOL_VERSION,
    CONFIG,
    parseCSV,
    toCSV,
    detectColumns,
    missingImportantColumns,
    parseNumber,
    normalizeForMatch,
    extractModelFromTitle,
    toProduct,
    isFamousBrand,
    amazonSideHardFails,
    normalizeRakutenItems,
    pickRakutenMatch,
    pickRakutenMatchByJan,
    looksLikeAccessory,
    minRakutenPrice,
    maxRakutenPrice,
    buildSearchKeywords,
    brandCandidates,
    applyMatchWarnings,
    parseJan,
    suggestSellerRating,
    aggregateResults,
    sellerNameLooksSame,
    evaluate,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SWLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
