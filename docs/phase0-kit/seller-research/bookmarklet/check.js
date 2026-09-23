// セラーウォッチ検出（ブックマークレット版・可読ソース）
//
// browser-extension/content.js と同じ判定ロジックをブックマークレットとして
// 移植したもの。スマホのブラウザ（Android Chrome等）でも、拡張機能をインストール
// せずに同じ検出ができる。
//
// 判定履歴・監視リストは、PC/Kiwi拡張機能と共有するため、Google Apps Script
// 経由でスプレッドシートに保存する（設定方法は ../apps-script/README.md 参照）。
// Amazonへの追加通信は増えない。通信先はscript.google.comのみ。
// ウェブアプリURL・シークレットは初回実行時にprompt()で尋ね、以後は
// このAmazon.co.jpページのlocalStorageに保存して再利用する。
//
// このファイルは読みやすさのためのソース。実際にブックマークとして登録するのは
// README.md に載せてある1行に圧縮した javascript: 版。
//
// 注意：browser-extension/content.js と同様、実機でのAmazon動作は未確認。

(async function () {
  var VERSION = "0.3.1";
  var VENDOR_KEYWORDS = [
    "専門店", "代理店", "正規販売店", "正規取扱店",
    "オフィシャルショップ", "オフィシャルストア",
    "メーカー直営", "メーカー公式", "公式ショップ", "公式ストア", "特約店",
  ];
  var MIN_RATING = 50;
  var MAX_RATING = 400;

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
      var link = offer.querySelector("#aod-offer-soldBy a, a[href*='seller=']");
      if (!link) return;
      var id = getSellerId(link.href);
      if (!id) return;
      var name = link.textContent.trim();
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
      var nameEl = document.querySelector(
        "#seller-name, h1#title, .a-spacing-small h1, h1"
      );
      var name = nameEl
        ? nameEl.textContent.trim()
        : (document.title.split("|")[0] || "").trim();
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

  function getApiConfig() {
    var apiUrl = localStorage.getItem("sw_api_url");
    var apiSecret = localStorage.getItem("sw_api_secret");
    if (!apiUrl) {
      apiUrl = prompt(
        "【初回のみ】Google Apps ScriptのウェブアプリURLを入力してください:",
        ""
      );
      if (!apiUrl) return null;
    }
    if (!apiSecret) {
      apiSecret = prompt(
        "【初回のみ】シークレットを入力してください（Code.gsのSHARED_SECRETと同じ値）:",
        ""
      );
      if (!apiSecret) return null;
    }
    localStorage.setItem("sw_api_url", apiUrl);
    localStorage.setItem("sw_api_secret", apiSecret);
    return { apiUrl: apiUrl, apiSecret: apiSecret };
  }

  async function parseJsonResponse(res) {
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("応答がJSONではありません（先頭200文字）: " + text.slice(0, 200));
    }
  }

  async function apiGet(cfg, action) {
    var url =
      cfg.apiUrl +
      "?action=" + encodeURIComponent(action) +
      "&secret=" + encodeURIComponent(cfg.apiSecret);
    // credentials: "include" でscript.google.comのログインCookieを一緒に送る。
    var res = await fetch(url, { credentials: "include" });
    return parseJsonResponse(res);
  }

  async function apiPost(cfg, action, payload) {
    var body = Object.assign({ action: action, secret: cfg.apiSecret }, payload);
    // text/plainにすることでCORSプリフライト（OPTIONS）を回避する。
    var res = await fetch(cfg.apiUrl, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    return parseJsonResponse(res);
  }

  var config = getApiConfig();
  if (!config) {
    alert("URL・シークレットが未入力のため中止しました。もう一度実行してください。");
    return;
  }

  var candidates = collectCandidates();
  if (candidates.length === 0) {
    alert(
      "セラー情報が見つかりませんでした。「他の出品を見る」を開いた状態、または出品者ページで試してください。"
    );
    return;
  }

  var seenResult;
  try {
    seenResult = await apiGet(config, "getSeen");
  } catch (e) {
    alert("共有データストアに接続できませんでした: " + e.message);
    return;
  }
  if (!seenResult || !seenResult.ok) {
    alert(
      "共有データストアの応答が異常です。URL・シークレットを確認してください（" +
        JSON.stringify(seenResult) + "）"
    );
    return;
  }
  var seen = seenResult.seen || {};

  var target = null;
  var toMarkSeen = [];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (seen[c.id]) continue;
    if (c.rating == null) {
      toMarkSeen.push({ seller_id: c.id, status: "unknown_rating" });
      continue;
    }
    if (c.rating < MIN_RATING || c.rating > MAX_RATING) {
      toMarkSeen.push({ seller_id: c.id, status: "out_of_range" });
      continue;
    }
    target = c;
    break;
  }
  if (toMarkSeen.length) {
    await apiPost(config, "markSeen", { items: toMarkSeen });
  }

  if (!target) {
    alert("SW v" + VERSION + ": 条件に合う新規セラーは見つかりませんでした。");
    return;
  }

  var msg = "店名: " + (target.name || "(不明)") + "\n評価数: " + target.rating + "件";
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
    await apiPost(config, "addWatchlist", { row: row });
    await apiPost(config, "markSeen", { items: [{ seller_id: target.id, status: "added" }] });
    alert("追加しました。");
  } else {
    await apiPost(config, "markSeen", { items: [{ seller_id: target.id, status: "skipped" }] });
  }
})();
