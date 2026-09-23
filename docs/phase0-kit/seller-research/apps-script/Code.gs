/**
 * セラーウォッチ検出：共有データストア（Google Apps Script）
 *
 * PC拡張機能・Kiwi Browser拡張機能・スマホのブックマークレットが、それぞれ
 * ローカルストレージ（chrome.storage / localStorage）に別々にデータを持って
 * いたため、PCとスマホを並行して使うと「既にチェック済みのセラーを別の端末で
 * また検出してしまう」等の不便があった。これを解消するため、Googleスプレッド
 * シートを全端末共通の保存先にする。
 *
 * このファイルをGoogleスプレッドシートのApps Scriptエディタに貼り付けて使う。
 * セットアップ手順は ../apps-script/README.md 参照。
 *
 * シート構成（初回アクセス時に自動作成される）：
 *   - "Seen"      : seller_id, status, checked_at（検出済みセラーの判定履歴）
 *   - "Watchlist" : seller-watchlist.csv と同じ列（監視リストに追加されたセラー）
 */

// 【要変更】自分だけが知っている適当な文字列に変更すること。
// デプロイURLが漏れても、このシークレットを知らない限り書き込み・閲覧できない
// ようにするための簡易的な保護（本格的な認証ではない点に注意）。
var SHARED_SECRET = 'CHANGE_ME_TO_YOUR_OWN_SECRET';

var SEEN_SHEET_NAME = 'Seen';
var WATCHLIST_SHEET_NAME = 'Watchlist';
var SEEN_HEADER = ['seller_id', 'status', 'checked_at'];
var WATCHLIST_HEADER = [
  'seller_id', 'seller_name', 'seller_url', 'review_count', 'category_tendency',
  'quality_rating', 'first_checked_date', 'last_evaluated_date', 'last_checked_date',
  'status', 'notes',
];

function doGet(e) {
  var params = e.parameter || {};
  if (params.secret !== SHARED_SECRET) {
    return jsonResponse({ ok: false, error: 'unauthorized' });
  }

  if (params.action === 'getSeen') {
    return jsonResponse({ ok: true, seen: getSeenMap() });
  }
  if (params.action === 'getWatchlist') {
    return jsonResponse({ ok: true, rows: getWatchlistRows() });
  }
  return jsonResponse({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'invalid JSON body' });
  }

  if (body.secret !== SHARED_SECRET) {
    return jsonResponse({ ok: false, error: 'unauthorized' });
  }

  if (body.action === 'markSeen') {
    markSeenBatch(body.items || []);
    return jsonResponse({ ok: true });
  }
  if (body.action === 'addWatchlist') {
    appendWatchlistRow(body.row || {});
    return jsonResponse({ ok: true });
  }
  if (body.action === 'resetSeen') {
    resetSeen();
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ ok: false, error: 'unknown action' });
}

function getOrCreateSheet(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  ensureHeader(sheet, header);
  return sheet;
}

function ensureHeader(sheet, header) {
  var firstRow = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  var isEmpty = firstRow.every(function (v) { return v === ''; });
  if (isEmpty) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function getSeenMap() {
  var sheet = getOrCreateSheet(SEEN_SHEET_NAME, SEEN_HEADER);
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;
  var data = sheet.getRange(2, 1, lastRow - 1, SEEN_HEADER.length).getValues();
  data.forEach(function (row) {
    var sellerId = row[0];
    if (!sellerId) return;
    map[sellerId] = { status: row[1], checkedAt: row[2] };
  });
  return map;
}

function markSeenBatch(items) {
  if (!items.length) return;
  var sheet = getOrCreateSheet(SEEN_SHEET_NAME, SEEN_HEADER);
  var existing = getSeenMap();
  items.forEach(function (item) {
    if (!item.seller_id) return;
    existing[item.seller_id] = {
      status: item.status || '',
      checkedAt: item.checked_at || new Date().toISOString(),
    };
  });
  var rows = Object.keys(existing).map(function (id) {
    return [id, existing[id].status, existing[id].checkedAt];
  });
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, SEEN_HEADER.length).clearContent();
  }
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, SEEN_HEADER.length).setValues(rows);
  }
}

function resetSeen() {
  var sheet = getOrCreateSheet(SEEN_SHEET_NAME, SEEN_HEADER);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, SEEN_HEADER.length).clearContent();
  }
}

function appendWatchlistRow(row) {
  var sheet = getOrCreateSheet(WATCHLIST_SHEET_NAME, WATCHLIST_HEADER);
  sheet.appendRow(WATCHLIST_HEADER.map(function (key) {
    return row[key] != null ? row[key] : '';
  }));
}

function getWatchlistRows() {
  var sheet = getOrCreateSheet(WATCHLIST_SHEET_NAME, WATCHLIST_HEADER);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, WATCHLIST_HEADER.length).getValues();
  return data.map(function (row) {
    var obj = {};
    WATCHLIST_HEADER.forEach(function (key, i) { obj[key] = row[i]; });
    return obj;
  });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
