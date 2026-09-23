// セラーウォッチ検出（個人用コンテンツスクリプト）
//
// 現在開いているAmazon商品ページ・出品者一覧パネル・出品者ストアページの
// DOM（表示中の内容）だけを読み取り、追加の通信は一切行わない。
// 評価数が条件レンジ内かつ未チェックのセラーを見つけたら、画面右下に
// 確認バナーを出し、「監視リストに追加」ボタンでchrome.storage.localに保存する。
//
// 注意：Amazonのページ構造（クラス名・id）は変わることがあり、この実装は
// ネットワークが使えない開発環境で作成したため実機での動作未確認。
// うまく検出できない場合はDevToolsのコンソールで [seller-watch] のログを確認し、
// 実際のレーティング表示テキストを教えてもらえれば抽出パターンを調整する。

(() => {
  const DEFAULT_SETTINGS = { minRating: 50, maxRating: 400 };
  const LOG_PREFIX = "[seller-watch]";

  // メーカー・輸入代理店の直接出品を示唆する店名キーワード（2026-09-23追加）。
  // バッチ3で「エフェクター専門店ナインボルト」が楽天・Amazon両方に自ら出品し、
  // 価格を同期させていた実例が見つかったことを踏まえた早期警告。
  // 追加の通信は発生させず、既に読み取り済みの店名テキストを見るだけ。
  const VENDOR_KEYWORDS = [
    "専門店",
    "代理店",
    "正規販売店",
    "正規取扱店",
    "オフィシャルショップ",
    "オフィシャルストア",
    "メーカー直営",
    "メーカー公式",
    "公式ショップ",
    "公式ストア",
    "特約店",
  ];

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function matchedVendorKeyword(sellerName) {
    if (!sellerName) return null;
    return VENDOR_KEYWORDS.find((kw) => sellerName.includes(kw)) || null;
  }

  function getSellerIdFromHref(href) {
    try {
      const url = new URL(href, location.href);
      return url.searchParams.get("seller") || null;
    } catch {
      return null;
    }
  }

  // 評価数の表示形式はページ・時期によって揺れがあるため、複数パターンを順に試す。
  // 例: 「1,234件の評価」「評価1,234件」「(1,234)」など
  function extractRatingCount(text) {
    if (!text) return null;
    const patterns = [
      /([\d,]+)\s*件の評価/,
      /([\d,]+)\s*個の評価/,
      /評価\s*([\d,]+)\s*件/,
      /評価数[:\s]*([\d,]+)/,
      /\(([\d,]+)\)/, // フォールバック：星評価の直後にある丸括弧内の数字
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        if (!Number.isNaN(n)) return n;
      }
    }
    return null;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // 動作確認用の常時ステータス表示（2026-09-23追加）。
  // マッチの有無に関わらず、スクリプトが実行されたこと自体を画面上で
  // 分かるようにする（「動いているか分からない」問題への対応）。
  let statusHideTimer = null;
  function showStatus(text, kind) {
    let el = document.getElementById("sw-status-indicator");
    if (!el) {
      el = document.createElement("div");
      el.id = "sw-status-indicator";
      document.body.appendChild(el);
    }
    el.textContent = "SW: " + text;
    el.className = "sw-status-" + (kind || "info");
    el.style.display = "block";

    clearTimeout(statusHideTimer);
    statusHideTimer = setTimeout(() => {
      el.style.display = "none";
    }, 6000);
  }

  // 商品ページの「他の出品」パネル（複数セラーがまとめて表示される）を走査
  function scanOfferListPanel() {
    const offers = document.querySelectorAll(
      "#aod-offer-list #aod-offer, div[id^='aod-offer']"
    );
    const candidates = [];
    offers.forEach((offer) => {
      const sellerLink = offer.querySelector(
        "#aod-offer-soldBy a, a[href*='seller=']"
      );
      if (!sellerLink) return;
      const sellerId = getSellerIdFromHref(sellerLink.href);
      if (!sellerId) return;
      const sellerName = sellerLink.textContent.trim();
      candidates.push({
        sellerId,
        sellerName,
        ratingCount: extractRatingCount(offer.textContent),
        sourceUrl: sellerLink.href,
        vendorKeyword: matchedVendorKeyword(sellerName),
      });
    });
    return candidates;
  }

  // 出品者ストアページ（URLに ?seller=... を含むページ）を走査
  function scanSellerStorefrontPage() {
    const params = new URLSearchParams(location.search);
    const sellerId = params.get("seller");
    if (!sellerId) return [];

    let sellerName = null;
    const nameEl = document.querySelector(
      "#seller-name, h1#title, .a-spacing-small h1, h1"
    );
    if (nameEl) sellerName = nameEl.textContent.trim();
    if (!sellerName && document.title) {
      sellerName = document.title.split("|")[0].trim();
    }

    return [
      {
        sellerId,
        sellerName,
        ratingCount: extractRatingCount(document.body.innerText),
        sourceUrl: location.href,
        vendorKeyword: matchedVendorKeyword(sellerName),
      },
    ];
  }

  async function getSettings() {
    return chrome.storage.sync.get(DEFAULT_SETTINGS);
  }

  async function getSeenSellers() {
    const { seenSellers } = await chrome.storage.local.get({
      seenSellers: {},
    });
    return seenSellers;
  }

  async function markSeen(sellerId, status) {
    const seenSellers = await getSeenSellers();
    seenSellers[sellerId] = { status, checkedAt: new Date().toISOString() };
    await chrome.storage.local.set({ seenSellers });
  }

  async function addToWatchlist(entry) {
    const { watchlistEntries = [] } = await chrome.storage.local.get({
      watchlistEntries: [],
    });
    watchlistEntries.push(entry);
    await chrome.storage.local.set({ watchlistEntries });
  }

  function buildWatchlistRow(candidate) {
    const today = todayStr();
    const vendorWarning = candidate.vendorKeyword
      ? ` ／ 要注意:店名に「${candidate.vendorKeyword}」を含む（メーカー・代理店の直接出品の可能性。楽天側に同一店舗がないか要確認）`
      : "";
    return {
      seller_id: candidate.sellerId,
      seller_name: candidate.sellerName || "",
      seller_url: `https://www.amazon.co.jp/sp?seller=${candidate.sellerId}`,
      review_count: candidate.ratingCount,
      category_tendency: "",
      quality_rating: "",
      first_checked_date: today,
      last_evaluated_date: "",
      last_checked_date: today,
      status: "new",
      notes: `拡張機能が自動検出（検出元: ${candidate.sourceUrl}）${vendorWarning}`,
    };
  }

  function showConfirmBanner(candidate) {
    const existing = document.getElementById("sw-detector-banner");
    if (existing) existing.remove();

    const warningHtml = candidate.vendorKeyword
      ? `<p class="sw-detector-warning">⚠️ 店名に「${escapeHtml(
          candidate.vendorKeyword
        )}」を含みます。メーカー・輸入代理店が自ら出品している可能性があります
        （楽天側に同一店舗がないか要確認。同一なら価格が仕入れ値と同期しており
        利益が出ない可能性が高い）</p>`
      : "";

    const banner = document.createElement("div");
    banner.id = "sw-detector-banner";
    banner.innerHTML = `
      <div class="sw-detector-box">
        <p class="sw-detector-title">条件に合致するストアが見つかりました</p>
        <p class="sw-detector-body">${escapeHtml(
          candidate.sellerName || "(店名不明)"
        )}（評価 ${candidate.ratingCount}件）</p>
        ${warningHtml}
        <p class="sw-detector-body">監視リストに追加しますか？</p>
        <div class="sw-detector-actions">
          <button id="sw-detector-add">追加する</button>
          <button id="sw-detector-skip">今回は追加しない</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);

    document
      .getElementById("sw-detector-add")
      .addEventListener("click", async () => {
        await addToWatchlist(buildWatchlistRow(candidate));
        await markSeen(candidate.sellerId, "added");
        banner.remove();
        log("追加しました:", candidate);
      });
    document
      .getElementById("sw-detector-skip")
      .addEventListener("click", async () => {
        await markSeen(candidate.sellerId, "skipped");
        banner.remove();
        log("スキップしました:", candidate);
      });
  }

  async function main() {
    showStatus("スキャン中…", "scanning");

    if (document.getElementById("sw-detector-banner")) return; // 表示中は再スキャンしない

    const candidates = [
      ...scanOfferListPanel(),
      ...scanSellerStorefrontPage(),
    ];
    if (candidates.length === 0) {
      showStatus("このページではセラー情報が見つかりませんでした", "empty");
      return;
    }

    const settings = await getSettings();
    const seenSellers = await getSeenSellers();

    let matchedAny = false;
    let newCount = 0;
    let outOfRangeCount = 0;
    let unknownCount = 0;
    let alreadySeenCount = 0;

    for (const c of candidates) {
      if (seenSellers[c.sellerId]) {
        alreadySeenCount++;
        continue;
      }
      newCount++;

      if (c.ratingCount == null) {
        log("評価数を読み取れずスキップ:", c);
        await markSeen(c.sellerId, "unknown_rating");
        unknownCount++;
        continue;
      }

      if (c.ratingCount < settings.minRating || c.ratingCount > settings.maxRating) {
        log("レンジ外のためスキップ:", c);
        await markSeen(c.sellerId, "out_of_range");
        outOfRangeCount++;
        continue;
      }

      log("条件に合致する新規セラーを検出:", c);
      showConfirmBanner(c);
      matchedAny = true;
      break; // 1回のスキャンで1件だけ表示する
    }

    if (!matchedAny) {
      showStatus(
        `${candidates.length}件検出（新規${newCount}・既知${alreadySeenCount}・` +
          `範囲外${outOfRangeCount}・評価数不明${unknownCount}）／条件合致なし`,
        "no-match"
      );
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      main().catch((e) => console.error(LOG_PREFIX, e));
    }, 500);
  }

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleScan();
})();
