// セラーウォッチ検出：候補一覧をCSVとして表示（ブックマークレット版・可読ソース）
//
// 共有データストア（Airtable）のWatchlistテーブルから現在の一覧を取得し、
// seller-watchlist-template.csvと同じ列構成のCSVテキストとしてprompt()に
// 表示する。prompt()のテキストは全選択・コピーできるので、スマホでも
// クリップボード権限なしでコピーできる。
//
// 注：データはAirtableのベースを直接開いても確認できる。このスクリプトは
// 「開かずにその場でCSVとしてコピーしたい」場合の補助。

(async function () {
  var AIRTABLE_API_BASE = "https://api.airtable.com/v0";
  var baseId = localStorage.getItem("sw_airtable_base_id");
  var token = localStorage.getItem("sw_airtable_token");
  if (!baseId || !token) {
    alert("共有データストアが未設定です。先にcheck.jsを一度実行して設定してください。");
    return;
  }

  var header = [
    "seller_id", "seller_name", "seller_url", "review_count", "category_tendency",
    "quality_rating", "first_checked_date", "last_evaluated_date", "last_checked_date",
    "status", "notes",
  ];

  function esc(v) {
    var s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async function parseJsonResponse(res) {
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("応答がJSONではありません（先頭200文字）: " + text.slice(0, 200));
    }
  }

  var rows = [];
  try {
    var offset;
    do {
      var url = AIRTABLE_API_BASE + "/" + baseId + "/Watchlist" + (offset ? "?offset=" + offset : "");
      var res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      var data = await parseJsonResponse(res);
      if (!res.ok) throw new Error("Airtable APIエラー: " + JSON.stringify(data));
      (data.records || []).forEach(function (r) { rows.push(r.fields); });
      offset = data.offset;
    } while (offset);
  } catch (e) {
    alert("共有データストアに接続できませんでした: " + e.message);
    return;
  }

  if (rows.length === 0) {
    alert("追加済みの候補はまだありません。");
    return;
  }

  var lines = [header.join(",")];
  rows.forEach(function (row) {
    lines.push(header.map(function (key) { return esc(row[key]); }).join(","));
  });

  var csv = lines.join("\r\n");
  prompt(
    rows.length + "件。下のテキストを全選択してコピーしてください（seller-watchlist.csvへの貼り付け用）:",
    csv
  );
})();
