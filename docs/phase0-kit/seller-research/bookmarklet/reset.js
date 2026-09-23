// セラーウォッチ検出：検出済み履歴のリセット（ブックマークレット版・可読ソース）
//
// 共有データストア（Google Apps Script）のSeenシートを全消去する。
// PC/Kiwi/ブックマークレットいずれで実行しても、全端末に反映される。

(async function () {
  var apiUrl = localStorage.getItem("sw_api_url");
  var apiSecret = localStorage.getItem("sw_api_secret");
  if (!apiUrl || !apiSecret) {
    alert("共有データストアが未設定です。先にcheck.jsを一度実行して設定してください。");
    return;
  }
  if (!confirm("検出済み履歴を全てリセットします（共有データストア全体に反映されます）。よろしいですか？")) {
    return;
  }
  try {
    var res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "resetSeen", secret: apiSecret }),
    });
    var result = await res.json();
    if (result && result.ok) {
      alert("リセットしました。");
    } else {
      alert("応答が異常です: " + JSON.stringify(result));
    }
  } catch (e) {
    alert("リセットに失敗しました: " + e.message);
  }
})();
