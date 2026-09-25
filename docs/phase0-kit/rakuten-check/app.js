(function () {
  const L = window.SWLogic;
  const RAKUTEN_ENDPOINT =
    "https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701";
  const REQUEST_INTERVAL_MS = 1100;
  const STORAGE_KEY = "sw-rakuten-check";

  const $ = (id) => document.getElementById(id);

  const MAPPING_LABELS = {
    asin: "ASIN",
    title: "商品名",
    model: "型番（Model）",
    partNumber: "品番（Part Number）",
    brand: "ブランド",
    buyBoxPrice: "Amazon価格（カート）",
    newPrice: "Amazon価格（新品最安）",
    amazonPrice: "Amazon本体の価格",
    offerCount: "新品出品者数（現在）",
    offerCountAvg90: "新品出品者数（90日平均）",
    boughtPastMonth: "過去1か月の購入数",
    referralFeePct: "販売手数料率（%）",
    fbaFee: "FBA手数料",
    ean: "JAN/EAN",
  };

  let csv = null;
  let mapping = {};
  let results = [];
  let stopRequested = false;

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveStore(patch) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign(loadStore(), patch)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function setStatus(el, text, isError) {
    el.textContent = text;
    el.classList.toggle("err", !!isError);
  }

  function readPrefs() {
    return {
      sellerName: $("sellerName").value.trim(),
      extraPointPct: parseFloat($("extraPoint").value) || 0,
      fallbackFbaFee: parseFloat($("fallbackFba").value) || 0,
      famousBrands: $("famousBrands").value.split("\n").map((s) => s.trim()).filter(Boolean),
      treatUnlistedBrandAsSafe: $("unlistedSafe").checked,
      maxRows: parseInt($("maxRows").value, 10) || 100,
    };
  }

  function restore() {
    const s = loadStore();
    if (s.appId) $("appId").value = s.appId;
    if (s.accessKey) $("accessKey").value = s.accessKey;
    if (s.prefs) {
      const p = s.prefs;
      if (p.extraPointPct != null) $("extraPoint").value = p.extraPointPct;
      if (p.fallbackFbaFee != null) $("fallbackFba").value = p.fallbackFbaFee;
      if (p.famousBrands) $("famousBrands").value = p.famousBrands.join("\n");
      if (p.treatUnlistedBrandAsSafe != null) $("unlistedSafe").checked = p.treatUnlistedBrandAsSafe;
      if (p.maxRows) $("maxRows").value = p.maxRows;
    }
  }

  async function searchRakuten(keyword) {
    const appId = $("appId").value.trim();
    const accessKey = $("accessKey").value.trim();
    if (!appId || !accessKey) throw new Error("アプリケーションIDとアクセスキーを入力してください");
    const params = new URLSearchParams({
      applicationId: appId,
      accessKey,
      keyword,
      sort: "+itemPrice",
      availability: "1",
      hits: "30",
      format: "json",
      formatVersion: "2",
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${RAKUTEN_ENDPOINT}?${params}`, { mode: "cors" });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new Error(`楽天APIの応答を読めませんでした（HTTP ${res.status}）: ${text.slice(0, 150)}`);
      }
      if (res.status === 429 && attempt === 0) {
        await sleep(3000);
        continue;
      }
      if (res.status === 404) return [];
      if (!res.ok) {
        const msg = json.error_description || json.error || JSON.stringify(json).slice(0, 200);
        throw new Error(`楽天APIエラー（HTTP ${res.status}）: ${msg}`);
      }
      return L.normalizeRakutenItems(json);
    }
    throw new Error("楽天APIの呼び出し回数制限に達しました。少し待ってから再実行してください");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function onCsvText(text, sourceLabel) {
    const parsed = L.parseCSV(text);
    if (!parsed.headers.length || !parsed.records.length) {
      setStatus($("csvStatus"), "CSVにデータ行が見つかりませんでした", true);
      return;
    }
    csv = parsed;
    mapping = L.detectColumns(parsed.headers);
    renderMapping();
    setStatus($("csvStatus"), `${sourceLabel}：${parsed.records.length}件の商品を読み込みました`);
    $("run").disabled = false;
  }

  function renderMapping() {
    const container = $("mappingRows");
    container.textContent = "";
    for (const [field, label] of Object.entries(MAPPING_LABELS)) {
      const row = document.createElement("div");
      row.className = "map-row";
      const lab = document.createElement("span");
      lab.textContent = label;
      const sel = document.createElement("select");
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "（なし）";
      sel.appendChild(none);
      csv.headers.forEach((h) => {
        const opt = document.createElement("option");
        opt.value = h;
        opt.textContent = h;
        if (mapping[field] === h) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => (mapping[field] = sel.value || null));
      row.append(lab, sel);
      container.appendChild(row);
    }
    $("mapping").hidden = false;
  }

  async function run() {
    const prefs = readPrefs();
    stopRequested = false;
    $("run").disabled = true;
    $("stop").disabled = false;
    results = [];

    const products = csv.records.map((r) => L.toProduct(r, mapping));
    let apiCalls = 0;
    let checkedProducts = 0;
    let lastCallAt = 0;

    async function throttledSearch(keyword, i) {
      const wait = REQUEST_INTERVAL_MS - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
      setStatus($("runStatus"), `照合中… ${i + 1}/${products.length}件目（楽天API ${apiCalls + 1}回目）`);
      lastCallAt = Date.now();
      apiCalls++;
      return searchRakuten(keyword);
    }

    for (let i = 0; i < products.length; i++) {
      if (stopRequested) break;
      const p = products[i];
      const famous = L.isFamousBrand(p.brand, prefs.famousBrands, prefs.treatUnlistedBrandAsSafe);
      const preFails = L.amazonSideHardFails(p, famous);
      if (preFails.length) {
        results.push({ product: p, category: "C", reasons: preFails, skippedRakuten: true });
        continue;
      }
      if (checkedProducts >= prefs.maxRows) {
        results.push({
          product: p,
          category: "-",
          reasons: [`楽天で調べる最大件数（${prefs.maxRows}件）を超えたため未照合`],
          skippedRakuten: true,
        });
        continue;
      }
      checkedProducts++;

      // まず型番で探し、見つからなければJANで探し直す
      let found = { match: null, cheapestAny: null, matchedCount: 0 };
      let matchedBy = null;
      try {
        if (p.model) {
          found = L.pickRakutenMatch(await throttledSearch(p.model, i), p.model);
          if (found.match) matchedBy = "型番";
        }
        if (!found.match && p.jan) {
          const byJan = L.pickRakutenMatchByJan(await throttledSearch(p.jan, i), p.jan);
          if (byJan.match) {
            found = byJan;
            matchedBy = "JAN";
          } else if (!found.cheapestAny) {
            found.cheapestAny = byJan.cheapestAny;
          }
        }
      } catch (e) {
        setStatus($("runStatus"), e.message, true);
        results.push({ product: p, category: "-", reasons: [e.message], skippedRakuten: true });
        break;
      }

      const { match, cheapestAny, matchedCount } = found;
      if (!match) {
        results.push({
          product: p,
          category: "C",
          reasons: [
            cheapestAny
              ? "楽天で型番が一致する在庫ありの商品が見つからない（似た別商品のみ）"
              : "楽天で在庫ありの商品が見つからない",
          ],
          rakutenItem: cheapestAny,
          modelMatch: false,
        });
        continue;
      }
      const ev = L.evaluate(p, match, prefs);
      results.push(Object.assign({ product: p, rakutenItem: match, modelMatch: true, matchedCount, matchedBy }, ev));
    }

    $("run").disabled = false;
    $("stop").disabled = true;
    if (!$("runStatus").classList.contains("err")) {
      setStatus(
        $("runStatus"),
        `${stopRequested ? "中断しました" : "完了しました"}（楽天APIの呼び出し ${apiCalls}回）`
      );
    }
    renderResults();
  }

  function yen(n) {
    return n == null || !Number.isFinite(n) ? "" : `${Math.round(n).toLocaleString("ja-JP")}円`;
  }

  function safeLink(url, text) {
    if (!/^https?:\/\//.test(String(url || ""))) {
      const span = document.createElement("span");
      span.textContent = text;
      return span;
    }
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    return a;
  }

  function cell(tr, content, cls) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content == null ? "" : content;
    tr.appendChild(td);
    return td;
  }

  const ORDER = { A: 0, B: 1, C: 2, "-": 3 };

  function renderResults() {
    const body = $("resultBody");
    body.textContent = "";
    const sorted = results.slice().sort((a, b) => ORDER[a.category] - ORDER[b.category] || (b.profit || -1e9) - (a.profit || -1e9));
    const counts = { A: 0, B: 0, C: 0, "-": 0 };
    sorted.forEach((r) => (counts[r.category] = (counts[r.category] || 0) + 1));

    const summary = $("summary");
    summary.textContent = "";
    [["A", "A（有望）"], ["B", "B（要確認）"], ["C", "C（見送り）"], ["-", "未照合"]].forEach(([k, label]) => {
      const s = document.createElement("span");
      s.className = k === "-" ? "cat-C" : `cat-${k}`;
      s.textContent = `${label} ${counts[k] || 0}件`;
      summary.appendChild(s);
    });

    const sr = L.suggestSellerRating(results);
    const ratingBox = $("sellerRating");
    ratingBox.textContent = sr.rating
      ? `このセラーの評価の目安：${sr.rating}（${sr.why}。楽天で同じ商品が見つかった${sr.checked}件のうち）。` +
        "AirtableのWatchlistで quality_rating と last_evaluated_date を更新してください。" +
        (sr.rating === "S" || sr.rating === "A" ? "今後も定点観測する対象です。" : "定点観測の対象外（status を excluded）にしてよいです。")
      : `このセラーの評価の目安：判断できません（${sr.why}）。`;

    for (const r of sorted) {
      const p = r.product;
      const tr = document.createElement("tr");
      const badge = document.createElement("span");
      badge.className = `badge cat-${r.category === "-" ? "C" : r.category}`;
      badge.textContent = r.category;
      cell(tr, badge);
      const amazonUrl = p.asin ? `https://www.amazon.co.jp/dp/${encodeURIComponent(p.asin)}` : "";
      cell(tr, safeLink(amazonUrl, p.title || p.asin || "(商品名なし)"));
      cell(tr, p.model || "");
      cell(tr, yen(p.amazonPrice), "num");
      if (r.rakutenItem) {
        const wrap = document.createElement("div");
        wrap.appendChild(safeLink(r.rakutenItem.itemUrl, yen(Number(r.rakutenItem.itemPrice))));
        const shop = document.createElement("div");
        shop.className = "hint";
        shop.textContent = r.modelMatch === false
          ? "型番不一致（参考価格）"
          : `${r.rakutenItem.shopName || ""}${r.matchedBy === "JAN" ? "（JANで一致）" : ""}`;
        wrap.appendChild(shop);
        cell(tr, wrap, "num");
      } else {
        cell(tr, r.skippedRakuten ? "（省略）" : "", "num");
      }
      cell(tr, yen(r.effectiveCost), "num");
      cell(tr, yen(r.profit), "num");
      cell(tr, r.margin != null ? `${(r.margin * 100).toFixed(1)}%` : "", "num");
      cell(tr, yen(r.stress20), "num");
      cell(tr, p.monthlySales ?? "", "num");
      cell(tr, p.sellerCount ?? "", "num");
      const ul = document.createElement("ul");
      ul.className = "reasons";
      (r.reasons || []).forEach((reason) => {
        const li = document.createElement("li");
        li.textContent = reason;
        ul.appendChild(li);
      });
      cell(tr, ul);
      body.appendChild(tr);
    }
    $("resultSection").hidden = false;
  }

  function exportCsv() {
    const headers = [
      "category", "asin", "product_name", "model", "amazon_price", "rakuten_price", "rakuten_shop",
      "rakuten_url", "point_pct", "effective_cost", "referral_fee_rate", "fba_fee", "profit",
      "profit_margin", "stress20_profit", "monthly_sales", "seller_count", "reasons",
    ];
    const rows = results.map((r) => ({
      category: r.category,
      asin: r.product.asin,
      product_name: r.product.title,
      model: r.product.model,
      amazon_price: r.product.amazonPrice,
      rakuten_price: r.rakutenItem ? r.rakutenItem.itemPrice : "",
      rakuten_shop: r.rakutenItem ? r.rakutenItem.shopName : "",
      rakuten_url: r.rakutenItem ? r.rakutenItem.itemUrl : "",
      point_pct: r.pointPct ?? "",
      effective_cost: r.effectiveCost != null ? Math.round(r.effectiveCost) : "",
      referral_fee_rate: r.referral ?? "",
      fba_fee: r.fba ?? "",
      profit: r.profit != null ? Math.round(r.profit) : "",
      profit_margin: r.margin != null ? r.margin.toFixed(3) : "",
      stress20_profit: r.stress20 != null ? Math.round(r.stress20) : "",
      monthly_sales: r.product.monthlySales ?? "",
      seller_count: r.product.sellerCount ?? "",
      reasons: (r.reasons || []).join(" / "),
    }));
    const blob = new Blob(["﻿" + L.toCSV(headers, rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rakuten-check-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $("saveKeys").addEventListener("click", () => {
    const ok = saveStore({ appId: $("appId").value.trim(), accessKey: $("accessKey").value.trim() });
    setStatus($("keyStatus"), ok ? "保存しました" : "このブラウザでは保存できませんでした（入力は今回だけ有効です）", !ok);
  });

  $("testKeys").addEventListener("click", async () => {
    setStatus($("keyStatus"), "接続テスト中…");
    try {
      const items = await searchRakuten("ボールペン");
      setStatus($("keyStatus"), `接続成功（テスト検索で${items.length}件取得）`);
    } catch (e) {
      setStatus($("keyStatus"), e.message, true);
    }
  });

  $("savePrefs").addEventListener("click", () => {
    const prefs = readPrefs();
    delete prefs.sellerName;
    const ok = saveStore({ prefs });
    $("savePrefs").textContent = ok ? "保存しました" : "保存できませんでした";
    setTimeout(() => ($("savePrefs").textContent = "前提を保存"), 2000);
  });

  $("csvFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onCsvText(String(reader.result), file.name);
    reader.readAsText(file, "utf-8");
  });

  $("loadPasted").addEventListener("click", () => onCsvText($("csvText").value, "貼り付けたCSV"));
  $("run").addEventListener("click", () => {
    setStatus($("runStatus"), "");
    run();
  });
  $("stop").addEventListener("click", () => (stopRequested = true));
  $("exportCsv").addEventListener("click", exportCsv);

  restore();
})();
