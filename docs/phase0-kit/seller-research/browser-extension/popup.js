const DEFAULT_SETTINGS = { minRating: 50, maxRating: 400 };

const CSV_HEADER = [
  "seller_id",
  "seller_name",
  "seller_url",
  "review_count",
  "category_tendency",
  "quality_rating",
  "first_checked_date",
  "last_evaluated_date",
  "last_checked_date",
  "status",
  "notes",
];

function toCsvRow(values) {
  return values
    .map((v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

async function loadPending() {
  const { watchlistEntries = [] } = await chrome.storage.local.get({
    watchlistEntries: [],
  });
  const container = document.getElementById("pending-list");
  if (watchlistEntries.length === 0) {
    container.textContent = "追加済みのセラーはまだありません。";
    return;
  }
  const rows = watchlistEntries
    .map(
      (e, i) =>
        `<tr><td>${e.seller_name}</td><td>${e.review_count}</td><td><button data-i="${i}" class="remove-btn">✕</button></td></tr>`
    )
    .join("");
  container.innerHTML = `<table><tr><th>店名</th><th>評価数</th><th></th></tr>${rows}</table>`;
  container.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.dataset.i);
      const { watchlistEntries: current = [] } = await chrome.storage.local.get({
        watchlistEntries: [],
      });
      current.splice(i, 1);
      await chrome.storage.local.set({ watchlistEntries: current });
      loadPending();
    });
  });
}

async function exportCsv() {
  const { watchlistEntries = [] } = await chrome.storage.local.get({
    watchlistEntries: [],
  });
  if (watchlistEntries.length === 0) {
    alert("エクスポートする候補がありません。");
    return;
  }
  const lines = [toCsvRow(CSV_HEADER)];
  for (const e of watchlistEntries) {
    lines.push(toCsvRow(CSV_HEADER.map((k) => e[k])));
  }
  const csv = "﻿" + lines.join("\r\n"); // BOM付き（Excelでの文字化け対策）
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `seller-watchlist-detected-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
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
  await chrome.storage.sync.set({ minRating, maxRating });
  alert("保存しました。");
}

async function resetSeen() {
  await chrome.storage.local.set({ seenSellers: {} });
  alert("検出済み履歴をリセットしました。次回から同じセラーも再検出されます。");
}

async function clearWatchlist() {
  if (!confirm("追加済みのセラー一覧をすべて削除します。よろしいですか？")) return;
  await chrome.storage.local.set({ watchlistEntries: [] });
  loadPending();
}

document.getElementById("export-csv").addEventListener("click", exportCsv);
document
  .getElementById("save-settings")
  .addEventListener("click", saveSettings);
document.getElementById("reset-seen").addEventListener("click", resetSeen);
document
  .getElementById("clear-watchlist")
  .addEventListener("click", clearWatchlist);

loadPending();
loadSettings();
