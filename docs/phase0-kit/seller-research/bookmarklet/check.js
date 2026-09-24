// セラーウォッチ検出（ブックマークレット版・可読ソース）
//
// browser-extension/content.js と同じ判定ロジックをブックマークレットとして
// 移植したもの。スマホのブラウザ（Android Chrome等）でも、拡張機能をインストール
// せずに同じ検出ができる。
//
// 判定履歴・監視リストは、PC/Kiwi拡張機能と共有するため、Airtable経由で
// 保存する（設定方法は ../airtable/README.md 参照。Google Apps Script版は
// Googleアカウントのセッション問題が解消できず廃止した）。
// Amazonへの追加通信は増えない。通信先はapi.airtable.comのみ。
// Base ID・Tokenは初回実行時にprompt()で尋ね、以後はこのAmazon.co.jpページの
// localStorageに保存して再利用する。
//
// このファイルは読みやすさのためのソース。実際にブックマークとして登録するのは
// README.md に載せてある1行に圧縮した javascript: 版。
//
// 注意：browser-extension/content.js と同様、実機でのAmazon動作は未確認。

(async function () {
  var VERSION = "0.5.0";
  var VENDOR_KEYWORDS = [
    "専門店", "代理店", "正規販売店", "正規取扱店",
    "オフィシャルショップ", "オフィシャルストア",
    "メーカー直営", "メーカー公式", "公式ショップ", "公式ストア", "特約店",
  ];
  var MIN_RATING = 50;
  var MAX_RATING = 400;
  var AIRTABLE_API_BASE = "https://api.airtable.com/v0";

  // 店名として明らかに誤りと分かる文言（2026-09-24追加）。
  // querySelectorにカンマ区切りで複数セレクタを渡すと「優先順位」ではなく
  // 「DOM上で先に現れた方」がマッチしてしまうため、同じ出品枠内に seller= を
  // 含む別リンク（「詳細を見る」等）が店名リンクより先にあると誤取得していた。
  var GENERIC_NAME_BLOCKLIST = [
    "詳細を見る", "もっと見る", "レビューを見る", "評価を見る", "出品者情報", "ストアの詳細",
  ];

  function sanitizeSellerName(name) {
    if (!name) return null;
    var trimmed = name.trim();
    if (!trimmed) return null;
    if (GENERIC_NAME_BLOCKLIST.indexOf(trimmed) > -1) return null;
    return trimmed;
  }

  function querySelectorInPriorityOrder(root, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function extractSellerNameFromTitle(title) {
    if (!title) return null;
    var parts = title.split(/[|:\-–—]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var candidate = null;
    for (var i = 0; i < parts.length; i++) {
      if (!/amazon/i.test(parts[i])) { candidate = parts[i]; break; }
    }
    return sanitizeSellerName(candidate);
  }

  function getSellerId(href) {
    try {
      return new URL(href, location.href).searchParams.get("seller");
    } catch (e) {
      return null;
    }
  }

  function extractRating(text) {
    if (!text) return null;
    var patterns = [
      /([\d,]+)\s*件の評価/,
      /([\d,]+)\s*個の評価/,
      /評価\s*([\d,]+)\s*件/,
      /評価数[:\s]*([\d,]+)/,
      /\(([\d,]+)\)/,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m) {
        var n = parseInt(m[1].replace(/,/g, ""), 10);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  }

  function vendorHit(name) {
    if (!name) return null;
    for (var i = 0; i < VENDOR_KEYWORDS.length; i++) {
      if (name.indexOf(VENDOR_KEYWORDS[i]) > -1) return VENDOR_KEYWORDS[i];
    }
    return null;
  }

  function collectCandidates() {
    var out = [];
    var offers = document.querySelectorAll(
      "#aod-offer-list #aod-offer, div[id^='aod-offer']"
    );
    offers.forEach(function (offer) {
      var link = querySelectorInPriorityOrder(offer, [
        "#aod-offer-soldBy a",
        "a[href*='seller=']",
      ]);
      if (!link) return;
      var id = getSellerId(link.href);
      if (!id) return;
      var name = sanitizeSellerName(link.textContent);
      out.push({
        id: id,
        name: name,
        rating: extractRating(offer.textContent),
        url: link.href,
        vendor: vendorHit(name),
      });
    });

    var sellerId = new URLSearchParams(location.search).get("seller");
    if (sellerId) {
      // titleタグはh1より当たり外れが少ないため先に試す
      var name = extractSellerNameFromTitle(document.title);
      if (!name) {
        var nameEl = querySelectorInPriorityOrder(document, [
          "#seller-name", "h1#title", ".a-spacing-small h1", "h1",
        ]);
        name = nameEl ? sanitizeSellerName(nameEl.textContent) : null;
      }
      out.push({
        id: sellerId,
        name: name,
        rating: extractRating(document.body.innerText),
        url: location.href,
        vendor: vendorHit(name),
      });
    }
    return out;
  }

  function getAirtableConfig() {
    var baseId = localStorage.getItem("sw_airtable_base_id");
    var token = localStorage.getItem("sw_airtable_token");
    if (!baseId) {
      baseId = prompt("【初回のみ】AirtableのBase IDを入力してください（appから始まる文字列）:", "");
      if (!baseId) return null;
    }
    if (!token) {
      token = prompt("【初回のみ】Personal Access Tokenを入力してください（patから始まる文字列）:", "");
      if (!token) return null;
    }
    localStorage.setItem("sw_airtable_base_id", baseId);
    localStorage.setItem("sw_airtable_token", token);
    return { baseId: baseId, token: token };
  }

  async function parseJsonResponse(res) {
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("応答がJSONではありません（先頭200文字）: " + text.slice(0, 200));
    }
  }

  async function airtableRequest(cfg, method, table, opts) {
    opts = opts || {};
    var url = AIRTABLE_API_BASE + "/" + cfg.baseId + "/" + encodeURIComponent(table);
    if (opts.query) url += "?" + opts.query;
    var res = await fetch(url, {
      method: method,
      headers: {
        Authorization: "Bearer " + cfg.token,
        "Content-Type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var json = await parseJsonResponse(res);
    if (!res.ok) throw new Error("Airtable APIエラー: " + JSON.stringify(json));
    return json;
  }

  async function getSeenMap(cfg) {
    var map = {};
    var offset;
    do {
      var data = await airtableRequest(cfg, "GET", "Seen", {
        query: offset ? "offset=" + offset : undefined,
      });
      (data.records || []).forEach(function (r) {
        if (r.fields && r.fields.seller_id) map[r.fields.seller_id] = r.fields.status;
      });
      offset = data.offset;
    } while (offset);
    return map;
  }

  async function markSeenBatch(cfg, items) {
    if (!items.length) return;
    for (var i = 0; i < items.length; i += 10) {
      var chunk = items.slice(i, i + 10);
      await airtableRequest(cfg, "PATCH", "Seen", {
        body: {
          performUpsert: { fieldsToMergeOn: ["seller_id"] },
          records: chunk.map(function (it) {
            return { fields: { seller_id: it.seller_id, status: it.status, checked_at: new Date().toISOString() } };
          }),
        },
      });
    }
  }

  async function addWatchlistRow(cfg, row) {
    await airtableRequest(cfg, "POST", "Watchlist", { body: { records: [{ fields: row }] } });
  }

  var config = getAirtableConfig();
  if (!config) {
    alert("Base ID・Tokenが未入力のため中止しました。もう一度実行してください。");
    return;
  }

  var candidates = collectCandidates();
  if (candidates.length === 0) {
    alert(
      "セラー情報が見つかりませんでした。「他の出品を見る」を開いた状態、または出品者ページで試してください。"
    );
    return;
  }

  var seen;
  try {
    seen = await getSeenMap(config);
  } catch (e) {
    alert("共有データストアに接続できませんでした: " + e.message);
    return;
  }

  // 同じセラーが1回のスキャンで複数回検出されることがある（出品パネル内の重複表示等）ため、
  // 同一seller_idを2回キューに入れないようにする。
  var seenInThisRun = {};
  var targets = [];
  var toMarkSeen = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (seen[c.id] || seenInThisRun[c.id]) continue;
    seenInThisRun[c.id] = true;
    if (c.rating == null) {
      toMarkSeen.push({ seller_id: c.id, status: "unknown_rating" });
      continue;
    }
    if (c.rating < MIN_RATING || c.rating > MAX_RATING) {
      toMarkSeen.push({ seller_id: c.id, status: "out_of_range" });
      continue;
    }
    targets.push(c);
  }
  if (toMarkSeen.length) {
    await markSeenBatch(config, toMarkSeen);
  }

  if (targets.length === 0) {
    alert("SW v" + VERSION + ": 条件に合う新規セラーは見つかりませんでした。");
    return;
  }

  // 2026-09-24：以前は最初の1件しか確認せず、残りは無視していた。
  // 条件に合う候補全員について、1件ずつ順番に確認する。
  var addedCount = 0;
  var skippedCount = 0;
  for (var j = 0; j < targets.length; j++) {
    var target = targets[j];
    var progress = targets.length > 1 ? "（" + (j + 1) + "/" + targets.length + "）" : "";
    var msg =
      "SW v" + VERSION + progress + "\n" +
      "店名: " + (target.name || "(不明)") + "\n評価数: " + target.rating + "件";
    if (target.vendor) {
      msg +=
        "\n\n⚠️ 店名に「" + target.vendor + "」を含みます。" +
        "メーカー・代理店の直接出品の可能性があります（楽天側に同一店舗がないか要確認）";
    }
    msg += "\n\n監視リストに追加しますか？";

    if (confirm(msg)) {
      var today = new Date().toISOString().slice(0, 10);
      var row = {
        seller_id: target.id,
        seller_name: target.name || "",
        seller_url: "https://www.amazon.co.jp/sp?seller=" + target.id,
        review_count: target.rating,
        category_tendency: "",
        quality_rating: "",
        first_checked_date: today,
        last_evaluated_date: "",
        last_checked_date: today,
        status: "new",
        notes:
          "ブックマークレットで検出（" + target.url + "）" +
          (target.vendor ? " ／ 要注意:店名に「" + target.vendor + "」を含む" : ""),
      };
      await addWatchlistRow(config, row);
      await markSeenBatch(config, [{ seller_id: target.id, status: "added" }]);
      addedCount++;
    } else {
      await markSeenBatch(config, [{ seller_id: target.id, status: "skipped" }]);
      skippedCount++;
    }
  }

  alert("完了しました（追加 " + addedCount + "件・スキップ " + skippedCount + "件）");
})();
