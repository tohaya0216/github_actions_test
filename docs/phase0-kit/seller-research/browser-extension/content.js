// セラーウォッチ検出（個人用コンテンツスクリプト）
//
// 現在開いているAmazon商品ページ・出品者一覧パネル・出品者ストアページの
// DOM（表示中の内容）だけを読み取り、Amazonへの追加通信は一切行わない。
// 評価数が条件レンジ内かつ未チェックのセラーを見つけたら、画面右下に
// 確認バナーを出す。判定履歴・監視リストは、PC/Kiwi/ブックマークレットで
// 共有するため、Airtable経由で保存する（設定方法は ../airtable/README.md
// 参照。Amazonへの通信は増えない。通信先はapi.airtable.comのみ）。
//
// 注意：Amazonのページ構造（クラス名・id）は変わることがあり、この実装は
// ネットワークが使えない開発環境で作成したため実機での動作未確認。
// うまく検出できない場合はDevToolsのコンソールで [seller-watch] のログを確認し、
// 実際のレーティング表示テキストを教えてもらえれば抽出パターンを調整する。

(() => {
  // manifest.jsonのversionと手動で合わせる。画面上のステータス表示にも出すことで、
  // Kiwi Browser等で「再読み込みが本当に反映されたか」を拡張機能管理画面を
  // 開かずにその場で確認できるようにする（2026-09-23追加）。
  const VERSION = "0.5.1";
  const DEFAULT_SETTINGS = { minRating: 50, maxRating: 400 };
  const LOG_PREFIX = "[seller-watch]";

  // 店名として明らかに誤りと分かる文言（2026-09-24追加）。
  // 実機で「出品者名の代わりに『詳細を見る』が保存される」不具合が見つかった。
  // 原因は querySelector にカンマ区切りで複数セレクタを渡すと「優先順位」ではなく
  // 「DOM上で先に現れた方」がマッチしてしまうこと（同じ出品枠内に seller= を含む
  // 別リンクが店名リンクより先にあった場合、そちらが誤って採用されていた）。
  // セレクタ側は querySelectorInPriorityOrder で優先順位通りに直したが、それでも
  // 想定外のDOM構造で誤取得した場合に、明らかにおかしい文言だけは弾く保険。
  const GENERIC_NAME_BLOCKLIST = [
    "詳細を見る",
    "もっと見る",
    "レビューを見る",
    "評価を見る",
    "出品者情報",
    "ストアの詳細",
  ];

  function sanitizeSellerName(name) {
    if (!name) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (GENERIC_NAME_BLOCKLIST.includes(trimmed)) return null;
    return trimmed;
  }

  // querySelectorは複数セレクタをカンマ区切りで渡すと「DOM上の出現順」でマッチする。
  // 優先順位（先に書いたセレクタを優先）で試したい場合はこちらを使う。
  function querySelectorInPriorityOrder(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function extractSellerNameFromTitle(title) {
    if (!title) return null;
    const parts = title
      .split(/[|:\-–—]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const candidate = parts.find((p) => !/amazon/i.test(p));
    return sanitizeSellerName(candidate || null);
  }

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

  // ページの変化を監視するMutationObserver（下の方で初期化）。
  // ステータス表示・確認バナー自体もDOMを書き換えるため、何も対策しないと
  // 「自分の表示変更を検知して再スキャン→また表示変更→また検知…」という
  // 自己ループが発生する（2026-09-23、実機で「表示がちらつく」「本来新規のはずが
  // 既知と表示される」として発覚）。自分自身のDOM操作の間だけ監視を止めることで防ぐ。
  let observer;
  function withoutTriggeringRescan(fn) {
    if (observer) observer.disconnect();
    try {
      fn();
    } finally {
      if (observer) observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // 動作確認用の常時ステータス表示（2026-09-23追加）。
  // マッチの有無に関わらず、スクリプトが実行されたこと自体を画面上で
  // 分かるようにする（「動いているか分からない」問題への対応）。
  let statusHideTimer = null;
  function showStatus(text, kind) {
    withoutTriggeringRescan(() => {
      let el = document.getElementById("sw-status-indicator");
      if (!el) {
        el = document.createElement("div");
        el.id = "sw-status-indicator";
        document.body.appendChild(el);
      }
      el.textContent = `SW v${VERSION}: ${text}`;
      el.className = "sw-status-" + (kind || "info");
      el.style.display = "block";

      clearTimeout(statusHideTimer);
      statusHideTimer = setTimeout(() => {
        withoutTriggeringRescan(() => {
          el.style.display = "none";
        });
      }, 6000);
    });
  }

  // 商品ページの「他の出品」パネル（複数セラーがまとめて表示される）を走査
  function scanOfferListPanel() {
    const offers = document.querySelectorAll(
      "#aod-offer-list #aod-offer, div[id^='aod-offer']"
    );
    const candidates = [];
    offers.forEach((offer) => {
      const sellerLink = querySelectorInPriorityOrder(offer, [
        "#aod-offer-soldBy a",
        "a[href*='seller=']",
      ]);
      if (!sellerLink) return;
      const sellerId = getSellerIdFromHref(sellerLink.href);
      if (!sellerId) return;
      const sellerName = sanitizeSellerName(sellerLink.textContent);
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

    // titleタグ（例:「◯◯ストア | Amazon.co.jp」）はh1より当たり外れが少ないため先に試す。
    // それでも取れない場合のみ、より当たりやすい順にセレクタを試す
    // （querySelectorはカンマ区切りだと優先順位ではなくDOM出現順でマッチするため、
    // querySelectorInPriorityOrderで1つずつ順番に試す）。
    let sellerName = extractSellerNameFromTitle(document.title);
    if (!sellerName) {
      const nameEl = querySelectorInPriorityOrder(document, [
        "#seller-name",
        "h1#title",
        ".a-spacing-small h1",
        "h1",
      ]);
      if (nameEl) sellerName = sanitizeSellerName(nameEl.textContent);
    }
    log("出品者ストアページの店名抽出結果:", sellerName, "(title:", document.title, ")");

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
    return chrome.storage.local.get(DEFAULT_SETTINGS);
  }

  async function getAirtableConfig() {
    return chrome.storage.local.get({ airtableBaseId: "", airtableToken: "" });
  }

  // PC/Kiwi/ブックマークレットで判定履歴・監視リストを共有するための
  // Airtable API呼び出し（2026-09-23、Google Apps Script版から切替）。
  // Googleアカウントのセッション状態に依存する問題が実機で解消できなかった
  // ため、独立したAPIキー認証のAirtableに変更した。詳細は
  // ../airtable/README.md参照。通信先はapi.airtable.comのみで、
  // Amazonへの通信は増えない。
  const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

  async function airtableRequest(method, table, { query, body } = {}) {
    const { airtableBaseId, airtableToken } = await getAirtableConfig();
    if (!airtableBaseId || !airtableToken) return null;
    try {
      let url = `${AIRTABLE_API_BASE}/${airtableBaseId}/${encodeURIComponent(table)}`;
      if (query) url += `?${query}`;
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${airtableToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (parseErr) {
        log("Airtable応答がJSONではありません:", text.slice(0, 200));
        return null;
      }
      if (!res.ok) {
        log("Airtable APIエラー:", json);
        return null;
      }
      return json;
    } catch (e) {
      log("Airtable通信失敗:", e);
      return null;
    }
  }

  async function fetchSeenSellers() {
    const map = {};
    let offset;
    do {
      const data = await airtableRequest("GET", "Seen", {
        query: offset ? `offset=${offset}` : undefined,
      });
      if (!data) return null;
      (data.records || []).forEach((r) => {
        if (r.fields && r.fields.seller_id) {
          map[r.fields.seller_id] = {
            status: r.fields.status,
            checkedAt: r.fields.checked_at,
          };
        }
      });
      offset = data.offset;
    } while (offset);
    return map;
  }

  // Amazonの「他の出品を見る」パネルはスクロールに応じて出品が少しずつ非同期で
  // 追加され、そのたびにMutationObserverが再スキャンを起動する。毎回Seenテーブル
  // 全件を取得し直すと、読み込みが続く間ずっとステータス表示がちらつき続けて
  // しまう（2026-09-24、実機で「表示が不安になるほど切り替わる」として発覚）。
  // 短時間（15秒）はキャッシュを使い回すことで、同じページの読み込み中に
  // 何度も再スキャンが走っても通信・表示のちらつきを抑える。
  let seenSellersCache = null; // { map, fetchedAt }
  const SEEN_CACHE_TTL_MS = 15000;

  async function getSeenSellers() {
    const now = Date.now();
    if (seenSellersCache && now - seenSellersCache.fetchedAt < SEEN_CACHE_TTL_MS) {
      return seenSellersCache.map;
    }
    const map = await fetchSeenSellers();
    if (map === null) return null;
    seenSellersCache = { map, fetchedAt: now };
    return map;
  }

  async function markSeenBatch(items) {
    if (!items.length) return;
    const checkedAt = new Date().toISOString();
    // Airtableのupsertは1リクエストにつき最大10件まで。
    for (let i = 0; i < items.length; i += 10) {
      const chunk = items.slice(i, i + 10);
      await airtableRequest("PATCH", "Seen", {
        body: {
          performUpsert: { fieldsToMergeOn: ["seller_id"] },
          records: chunk.map((it) => ({
            fields: {
              seller_id: it.sellerId,
              status: it.status,
              checked_at: checkedAt,
            },
          })),
        },
      });
    }
    // キャッシュ済みのSeenマップにも即座に反映する。反映しないと、
    // キャッシュのTTL（15秒）以内に同じセラーを再スキャンした際、
    // Airtableにはもう書き込み済みなのにキャッシュ上は「未検出」のままで、
    // バナーが不要に再表示されてしまう。
    if (seenSellersCache) {
      for (const it of items) {
        seenSellersCache.map[it.sellerId] = { status: it.status, checkedAt };
      }
    }
  }

  async function addToWatchlist(row) {
    await airtableRequest("POST", "Watchlist", {
      body: { records: [{ fields: row }] },
    });
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

  // 第2引数のonDoneは、このセラーの処理（追加/スキップ）が終わった後に呼ばれる。
  // main()側でこれを使い、条件に合う候補が複数あれば1件ずつ順番にバナーを出す
  // （2026-09-24：以前は1回のスキャンで最初の1件しか表示せず、残りは無視していた）。
  function showConfirmBanner(candidate, progressText, onDone) {
    const warningHtml = candidate.vendorKeyword
      ? `<p class="sw-detector-warning">⚠️ 店名に「${escapeHtml(
          candidate.vendorKeyword
        )}」を含みます。メーカー・輸入代理店が自ら出品している可能性があります
        （楽天側に同一店舗がないか要確認。同一なら価格が仕入れ値と同期しており
        利益が出ない可能性が高い）</p>`
      : "";

    withoutTriggeringRescan(() => {
      const existing = document.getElementById("sw-detector-banner");
      if (existing) existing.remove();

      const banner = document.createElement("div");
      banner.id = "sw-detector-banner";
      banner.innerHTML = `
        <div class="sw-detector-box">
          <p class="sw-detector-title">条件に合致するストアが見つかりました${progressText}</p>
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

      const displayName = candidate.sellerName || "(店名不明)";

      document
        .getElementById("sw-detector-add")
        .addEventListener("click", async () => {
          await addToWatchlist(buildWatchlistRow(candidate));
          await markSeenBatch([{ sellerId: candidate.sellerId, status: "added" }]);
          withoutTriggeringRescan(() => banner.remove());
          log("追加しました:", candidate);
          showStatus(`「${displayName}」を監視リストに追加しました`, "success");
          onDone();
        });
      document
        .getElementById("sw-detector-skip")
        .addEventListener("click", async () => {
          await markSeenBatch([{ sellerId: candidate.sellerId, status: "skipped" }]);
          withoutTriggeringRescan(() => banner.remove());
          log("スキップしました:", candidate);
          showStatus(`「${displayName}」をスキップしました`, "info");
          onDone();
        });
    });
  }

  async function showConfirmBannersSequentially(queue) {
    for (let i = 0; i < queue.length; i++) {
      const progressText = queue.length > 1 ? `（${i + 1}/${queue.length}）` : "";
      await new Promise((resolve) => {
        showConfirmBanner(queue[i], progressText, resolve);
      });
    }
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

    if (seenSellers === null) {
      showStatus(
        "共有データストア未設定（ツールバーアイコン→ポップアップから設定してください）",
        "no-api"
      );
      return;
    }

    let newCount = 0;
    let outOfRangeCount = 0;
    let unknownCount = 0;
    let alreadySeenCount = 0;
    const toMarkSeen = [];
    const matched = [];
    // 同じセラーが1回のスキャンで複数回検出されることがある（出品パネル内の重複表示等）。
    // 同一seller_idを2回キューに入れてバナーを2回出さないようにする。
    const seenInThisScan = new Set();

    for (const c of candidates) {
      if (seenSellers[c.sellerId] || seenInThisScan.has(c.sellerId)) {
        alreadySeenCount++;
        continue;
      }
      seenInThisScan.add(c.sellerId);
      newCount++;

      if (c.ratingCount == null) {
        log("評価数を読み取れずスキップ:", c);
        toMarkSeen.push({ sellerId: c.sellerId, status: "unknown_rating" });
        unknownCount++;
        continue;
      }

      if (c.ratingCount < settings.minRating || c.ratingCount > settings.maxRating) {
        log("レンジ外のためスキップ:", c);
        toMarkSeen.push({ sellerId: c.sellerId, status: "out_of_range" });
        outOfRangeCount++;
        continue;
      }

      log("条件に合致する新規セラーを検出:", c);
      matched.push(c);
    }

    if (toMarkSeen.length) {
      await markSeenBatch(toMarkSeen);
    }

    if (matched.length) {
      await showConfirmBannersSequentially(matched);
    } else {
      showStatus(
        `${candidates.length}件検出（新規${newCount}・既知${alreadySeenCount}・` +
          `範囲外${outOfRangeCount}・評価数不明${unknownCount}）／条件合致なし`,
        "no-match"
      );
    }
  }

  // Amazonの「他の出品を見る」パネルはスクロール中、短時間に何度もDOMを
  // 書き換える（出品が少しずつ追加される）。デバウンスが短いと、その間ずっと
  // 「スキャン中…」の表示が点滅し続けてしまうため、少し長めに待つ
  // （2026-09-24、実機で表示のちらつきが気になるとの指摘を受けて調整）。
  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      main().catch((e) => console.error(LOG_PREFIX, e));
    }, 1200);
  }

  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleScan();
})();
