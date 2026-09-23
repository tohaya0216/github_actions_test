const DEFAULT_SETTINGS = { minRating: 50, maxRating: 400 };
const DEFAULT_API = { apiUrl: "", apiSecret: "" };

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("応答がJSONではありません（先頭200文字）: " + text.slice(0, 200));
  }
}

async function apiPost(apiUrl, apiSecret, action, payload) {
  const res = await fetch(apiUrl, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, secret: apiSecret, ...payload }),
  });
  return parseJsonResponse(res);
}

async function apiGet(apiUrl, apiSecret, action) {
  const url = `${apiUrl}?action=${encodeURIComponent(action)}&secret=${encodeURIComponent(apiSecret)}`;
  const res = await fetch(url, { credentials: "include" });
  return parseJsonResponse(res);
}

async function loadApiConfig() {
  const { apiUrl, apiSecret } = await chrome.storage.local.get(DEFAULT_API);
  document.getElementById("api-url").value = apiUrl;
  document.getElementById("api-secret").value = apiSecret;
}

async function saveApiConfig() {
  const apiUrl = document.getElementById("api-url").value.trim();
  const apiSecret = document.getElementById("api-secret").value.trim();
  await chrome.storage.local.set({ apiUrl, apiSecret });
  alert("保存しました。");
}

async function testConnection() {
  const statusEl = document.getElementById("connection-status");
  const apiUrl = document.getElementById("api-url").value.trim();
  const apiSecret = document.getElementById("api-secret").value.trim();
  if (!apiUrl || !apiSecret) {
    statusEl.textContent = "URLとシークレットを入力してください。";
    statusEl.style.color = "#a00";
    return;
  }
  statusEl.textContent = "確認中…";
  statusEl.style.color = "#555";
  try {
    const result = await apiGet(apiUrl, apiSecret, "getSeen");
    if (result && result.ok) {
      const count = Object.keys(result.seen || {}).length;
      statusEl.textContent = `接続成功（検出済み${count}件を確認）`;
      statusEl.style.color = "#0a0";
    } else {
      statusEl.textContent = `接続はできましたが応答が異常です: ${JSON.stringify(result)}`;
      statusEl.style.color = "#a00";
    }
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
  const { apiUrl, apiSecret } = await chrome.storage.local.get(DEFAULT_API);
  if (!apiUrl || !apiSecret) {
    alert("先に共有データストアを設定してください。");
    return;
  }
  if (!confirm("検出済み履歴を全てリセットします（共有データストア全体に反映されます）。よろしいですか？")) {
    return;
  }
  try {
    await apiPost(apiUrl, apiSecret, "resetSeen", {});
    alert("リセットしました。");
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
