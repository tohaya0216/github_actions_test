// セラーウォッチ検出：検出履歴・候補一覧のリセット（ブックマークレット版・可読ソース）

(function () {
  if (confirm("追加済みリストと検出済み履歴を全て削除します。よろしいですか？")) {
    localStorage.removeItem("sw_watchlist");
    localStorage.removeItem("sw_seen");
    alert("リセットしました。");
  }
})();
