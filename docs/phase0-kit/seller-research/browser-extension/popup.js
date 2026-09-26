const DEFAULT_SETTINGS = { minRating: 50, maxRating: 400 };
const DEFAULT_AIRTABLE = { airtableBaseId: "", airtableToken: "" };
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("応答がJSONではありません（先頭200文字）: " + text.slice(0, 200));
  }
}

async function airtableRequest(baseId, token, method, table, { query, body } = {}) {
  let url = `${AIRTABLE_API_BASE}/${baseId}/${encodeURIComponent(table)}`;
  if (query) url += `?${query}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await parseJsonResponse(res);
  if (!res.ok) throw new Error("Airtable APIエラー: " + JSON.stringify(json));
  return json;
}

async function loadApiConfig() {
  const { airtableBaseId, airtableToken } = await chrome.storage.local.get(DEFAULT_AIRTABLE);
  document.getElementById("airtable-base-id").value = airtableBaseId;
  document.getElementById("airtable-token").value = airtableToken;
}

async function saveApiConfig() {
  const airtableBaseId = document.getElementById("airtable-base-id").value.trim();
  const airtableToken = document.getElementById("airtable-token").value.trim();
  await chrome.storage.local.set({ airtableBaseId, airtableToken });
  alert("保存しました。");
}

async function testConnection() {
  const statusEl = document.getElementById("connection-status");
  const airtableBaseId = document.getElementById("airtable-base-id").value.trim();
  const airtableToken = document.getElementById("airtable-token").value.trim();
  if (!airtableBaseId || !airtableToken) {
    statusEl.textContent = "Base IDとTokenを入力してください。";
    statusEl.style.color = "#a00";
    return;
  }
  statusEl.textContent = "確認中…";
  statusEl.style.color = "#555";
  try {
    const result = await airtableRequest(airtableBaseId, airtableToken, "GET", "Seen");
    const count = (result.records || []).length;
    statusEl.textContent = `接続成功（Seenテーブル${count}件を確認）`;
    statusEl.style.color = "#0a0";
  } catch (e) {
    statusEl.textContent = `接続できませんでした: ${e.message}`;
    statusEl.style.color = "#a00";
  }
}

async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  document.getElementById("min-rating").value = settings.minRating;
  document.getElementById("max-rating").value = settings.maxRating;
}

async function saveSettings() {
  const minRating =
    Number(document.getElementById("min-rating").value) ||
    DEFAULT_SETTINGS.minRating;
  const maxRating =
    Number(document.getElementById("max-rating").value) ||
    DEFAULT_SETTINGS.maxRating;
  await chrome.storage.local.set({ minRating, maxRating });
  alert("保存しました。");
}

async function resetSeen() {
  const { airtableBaseId, airtableToken } = await chrome.storage.local.get(DEFAULT_AIRTABLE);
  if (!airtableBaseId || !airtableToken) {
    alert("先に共有データストアを設定してください。");
    return;
  }
  if (!confirm("検出済み履歴を全てリセットします（共有データストア全体に反映されます）。よろしいですか？")) {
    return;
  }
  try {
    // 全レコードIDを集めてから、10件ずつ削除する（Airtableの削除APIの上限）。
    const ids = [];
    let offset;
    do {
      const data = await airtableRequest(airtableBaseId, airtableToken, "GET", "Seen", {
        query: offset ? `offset=${offset}` : undefined,
      });
      (data.records || []).forEach((r) => ids.push(r.id));
      offset = data.offset;
    } while (offset);

    for (let i = 0; i < ids.length; i += 10) {
      const chunk = ids.slice(i, i + 10);
      const query = chunk.map((id) => `records[]=${encodeURIComponent(id)}`).join("&");
      await airtableRequest(airtableBaseId, airtableToken, "DELETE", "Seen", { query });
    }
    alert(`リセットしました（${ids.length}件削除）。`);
  } catch (e) {
    alert(`リセットに失敗しました: ${e.message}`);
  }
}

// ---- 今日見るセラー（check_watchlist_freshness.py と同じ基準） ----
const EVALUATION_INTERVAL_DAYS = 90;
const CHECK_INTERVAL_DAYS = 14;
const MONITORED_RATINGS = ["S", "A"];

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysSince(dateStr, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "").trim())) return null;
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dateStr.trim()}T00:00:00Z`);
  return Math.floor(ms / 86400000);
}

function findDueSellers(records, today) {
  const recheck = [];
  const reevaluate = [];
  for (const r of records) {
    const f = r.fields || {};
    if (!f.seller_id) continue;
    const rating = String(f.quality_rating || "").trim().toUpperCase();
    const item = { id: r.id, sellerId: f.seller_id, name: f.seller_name || f.seller_id, rating };

    const evalDays = daysSince(f.last_evaluated_date, today);
    if (evalDays == null || evalDays >= EVALUATION_INTERVAL_DAYS) {
      reevaluate.push(Object.assign({ days: evalDays }, item));
    }
    if (MONITORED_RATINGS.includes(rating) && f.status !== "excluded") {
      const checkDays = daysSince(f.last_checked_date, today);
      if (checkDays == null || checkDays >= CHECK_INTERVAL_DAYS) {
        recheck.push(Object.assign({ days: checkDays }, item));
      }
    }
  }
  return { recheck, reevaluate };
}

async function patchWatchlist(recordId, fields) {
  const { airtableBaseId, airtableToken } = await chrome.storage.local.get(DEFAULT_AIRTABLE);
  await airtableRequest(airtableBaseId, airtableToken, "PATCH", "Watchlist", {
    body: { records: [{ id: recordId, fields }] },
  });
}

function renderDueList(title, items, makeActions) {
  const wrap = document.createElement("div");
  const h = document.createElement("div");
  h.style.fontWeight = "bold";
  h.style.fontSize = "12px";
  h.textContent = `${title}（${items.length}件）`;
  wrap.appendChild(h);
  const ul = document.createElement("ul");
  ul.className = "due-list";
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "なし";
    ul.appendChild(li);
  }
  for (const it of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `https://www.amazon.co.jp/s?me=${encodeURIComponent(it.sellerId)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = it.name;
    const meta = document.createElement("div");
    meta.className = "due-meta";
    meta.textContent = `ランク:${it.rating || "未評価"}・${it.days == null ? "記録なし" : `${it.days}日経過`}`;
    const actions = document.createElement("div");
    actions.className = "due-actions";
    makeActions(it, actions, li);
    li.append(a, meta, actions);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  return wrap;
}

function markDone(li, text) {
  li.style.opacity = "0.5";
  li.querySelector(".due-actions").textContent = text;
}

async function loadDueSellers() {
  const statusEl = document.getElementById("due-status");
  const listsEl = document.getElementById("due-lists");
  const { airtableBaseId, airtableToken } = await chrome.storage.local.get(DEFAULT_AIRTABLE);
  if (!airtableBaseId || !airtableToken) {
    statusEl.textContent = "先に共有データストアを設定してください。";
    return;
  }
  statusEl.textContent = "読み込み中…";
  listsEl.textContent = "";
  try {
    const records = [];
    let offset;
    do {
      const data = await airtableRequest(airtableBaseId, airtableToken, "GET", "Watchlist", {
        query: offset ? `offset=${offset}` : undefined,
      });
      records.push(...(data.records || []));
      offset = data.offset;
    } while (offset);

    const today = todayStr();
    const { recheck, reevaluate } = findDueSellers(records, today);
    statusEl.textContent = `Watchlist ${records.length}件を確認しました。`;

    listsEl.appendChild(
      renderDueList("新着出品を確認する（S/Aランク）", recheck, (it, actions, li) => {
        const btn = document.createElement("button");
        btn.textContent = "確認した";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await patchWatchlist(it.id, { last_checked_date: today });
            markDone(li, `記録しました（last_checked_date=${today}）`);
          } catch (e) {
            btn.disabled = false;
            alert(`記録できませんでした: ${e.message}`);
          }
        });
        actions.appendChild(btn);
      })
    );

    listsEl.appendChild(
      renderDueList("評価し直す（照合ツールで判定してから）", reevaluate, (it, actions, li) => {
        const sel = document.createElement("select");
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "選ぶ";
        sel.appendChild(placeholder);
        ["S", "A", "B", "C"].forEach((r) => {
          const opt = document.createElement("option");
          opt.value = r;
          opt.textContent = r;
          if (r === it.rating) opt.selected = true;
          sel.appendChild(opt);
        });
        const btn = document.createElement("button");
        btn.textContent = "評価を記録";
        btn.addEventListener("click", async () => {
          const rating = sel.value;
          if (!rating) {
            alert("評価（S/A/B/C）を選んでください。");
            return;
          }
          // B/Cは定点観測の対象外にする（seller-research/README.md の質による絞り込み運用）
          const fields = {
            quality_rating: rating,
            last_evaluated_date: today,
            status: MONITORED_RATINGS.includes(rating) ? "active" : "excluded",
          };
          btn.disabled = true;
          try {
            await patchWatchlist(it.id, fields);
            markDone(li, `記録しました（${rating}・${fields.status}）`);
          } catch (e) {
            btn.disabled = false;
            alert(`記録できませんでした: ${e.message}`);
          }
        });
        actions.append(sel, btn);
      })
    );
  } catch (e) {
    statusEl.textContent = `読み込めませんでした: ${e.message}`;
  }
}

document.getElementById("load-due").addEventListener("click", loadDueSellers);
document.getElementById("save-api").addEventListener("click", saveApiConfig);
document.getElementById("test-api").addEventListener("click", testConnection);
document
  .getElementById("save-settings")
  .addEventListener("click", saveSettings);
document.getElementById("reset-seen").addEventListener("click", resetSeen);

loadApiConfig();
loadSettings();
