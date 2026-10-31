/* boot-error.js — 启动期错误捕获。
   原本是 index.html 里的一段内联 <script>；为了让 index.html 能上严格 CSP
   （script-src 'self'，不留 'unsafe-inline'），搬到这里作为外部文件。
   必须在其它 assets/*.js 之前加载：任何脚本语法错都要能显示在页面上。 */
window.addEventListener('error', function (e) {
  var el = document.getElementById('boot-error');
  if (!el) return;
  el.hidden = false;
  el.textContent = '启动错误：' + (e.message || e) + '  @' + (e.filename || '') + ':' + (e.lineno || '');
});