// セラーウォッチ検出：候補一覧をCSVとして表示（ブックマークレット版・可読ソース）
//
// 共有データストア（Google Apps Script）のWatchlistシートから現在の一覧を
// 取得し、seller-watchlist-template.csvと同じ列構成のCSVテキストとして
// prompt()に表示する。prompt()のテキストは全選択・コピーできるので、
// スマホでもクリップボード権限なしでコピーできる。
//
// 注：データはスプレッドシートを直接開いても確認できる。このスクリプトは
// 「開かずにその場でCSVとしてコピーしたい」場合の補助。

(async function () {
  var apiUrl = localStorage.getItem("sw_api_url");
  var apiSecret = localStorage.getItem("sw_api_secret");
  if (!apiUrl || !apiSecret) {
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

  var url =
    apiUrl + "?action=getWatchlist&secret=" + encodeURIComponent(apiSecret);
  var result;
  try {
    // credentials: "include" でscript.google.comのログインCookieを一緒に送る。
    var res = await fetch(url, { credentials: "include" });
    var text = await res.text();
    try {
      result = JSON.parse(text);
    } catch (parseErr) {
      throw new Error("応答がJSONではありません（先頭200文字）: " + text.slice(0, 200));
    }
  } catch (e) {
    alert("共有データストアに接続できませんでした: " + e.message);
    return;
  }
  if (!result || !result.ok) {
    alert("応答が異常です: " + JSON.stringify(result));
    return;
  }

  var rows = result.rows || [];
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
