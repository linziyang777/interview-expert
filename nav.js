// 统一导航：在所有工具页左下角注入一枚小胶囊，用来回总台 / 开倒计时。
// 不在总台页显示；倒计时页用更淡的样式，避免干扰极简界面。
(function () {
  if (location.pathname.replace(/\/+$/, "") === "/portal") return;
  if (location.pathname.indexOf("/docs/") === 0 && /timer\.html$/.test(location.pathname)) {
    // 倒计时页：只留一个极淡的返回按钮
  }

  var css = document.createElement("style");
  css.textContent = [
    "#wb-nav{position:fixed;left:14px;bottom:14px;z-index:99998;display:flex;gap:6px;",
    "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;",
    "opacity:.45;transition:opacity .2s;}",
    "#wb-nav:hover{opacity:1;}",
    "#wb-nav a{display:inline-flex;align-items:center;gap:5px;text-decoration:none;",
    "font-size:12px;line-height:1;padding:8px 11px;border-radius:99px;",
    "background:rgba(255,255,255,.94);color:#374151;border:1px solid #e5e7eb;",
    "box-shadow:0 2px 10px rgba(17,24,39,.10);backdrop-filter:blur(8px);white-space:nowrap;}",
    "#wb-nav a:hover{color:#111827;border-color:#d1d5db;background:#fff;}",
    "@media print{#wb-nav{display:none}}"
  ].join("");
  document.head.appendChild(css);

  var wrap = document.createElement("div");
  wrap.id = "wb-nav";
  wrap.innerHTML =
    '<a href="/portal" title="回到总台">总台</a>' +
    '<a href="/docs/timer.html" target="_blank" title="38 分钟群面倒计时">计时</a>';
  document.body.appendChild(wrap);

  // 延迟到 body 就绪
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", function () {
      if (!document.getElementById("wb-nav")) document.body.appendChild(wrap);
    });
  }
})();
