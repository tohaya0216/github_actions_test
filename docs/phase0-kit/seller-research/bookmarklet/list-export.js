// セラーウォッチ検出：候補一覧をCSVとして表示（ブックマークレット版・可読ソース）
//
// check.js で localStorage に溜めた候補一覧を、seller-watchlist-template.csv
// と同じ列構成のCSVテキストとして prompt() に表示する。prompt() のテキストは
// 全選択・コピーできるので、スマホでもクリップボード権限なしでコピーできる。

(function () {
  var watchlist = JSON.parse(localStorage.getItem("sw_watchlist") || "[]");
  if (watchlist.length === 0) {
    alert("追加済みの候補はまだありません。");
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

  var lines = [header.join(",")];
  watchlist.forEach(function (row) {
    lines.push(header.map(function (key) { return esc(row[key]); }).join(","));
  });

  var csv = lines.join("\r\n");
  prompt(
    watchlist.length + "件。下のテキストを全選択してコピーしてください（seller-watchlist.csvへの貼り付け用）:",
    csv
  );
})();
