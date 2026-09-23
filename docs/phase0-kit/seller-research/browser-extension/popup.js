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

document.getElementById("save-api").addEventListener("click", saveApiConfig);
document.getElementById("test-api").addEventListener("click", testConnection);
document
  .getElementById("save-settings")
  .addEventListener("click", saveSettings);
document.getElementById("reset-seen").addEventListener("click", resetSeen);

loadApiConfig();
loadSettings();
