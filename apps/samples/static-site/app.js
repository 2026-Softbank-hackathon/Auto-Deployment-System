(function () {
  var version = window.SITE_VERSION || "unknown";
  var versionEl = document.getElementById("version");
  versionEl.textContent = version;
  versionEl.classList.toggle("is-v2", version === "v2");
  document.getElementById("loaded-at").textContent = new Date().toLocaleTimeString();

  // 어디서 서빙되는지: S3 응답에는 x-amz-request-id 헤더가 붙는다 (Cloudflare 를 거쳐도 남는다)
  fetch(location.pathname, { method: "HEAD", cache: "no-store" })
    .then(function (response) {
      var servedBy = response.headers.get("x-amz-request-id")
        ? "AWS S3 웹사이트 (서버 없음)"
        : "nginx 컨테이너";
      document.getElementById("served-by").textContent = servedBy;
    })
    .catch(function () {
      document.getElementById("served-by").textContent = "알 수 없음";
    });

  // 새 버전이 배포되면 스스로 새로고침 (version.js 를 3초마다 확인)
  setInterval(function () {
    fetch("version.js?t=" + Date.now(), { cache: "no-store" })
      .then(function (response) { return response.ok ? response.text() : ""; })
      .then(function (text) {
        var match = /SITE_VERSION\s*=\s*"([^"]+)"/.exec(text);
        if (match && match[1] !== version) location.reload();
      })
      .catch(function () {});
  }, 3000);
})();
