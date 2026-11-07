/* P1-FIX-03 回归：「数据与安全」入口恒可达
   运行：node tests/test-fix03-topbar.js
   背景（Android A4 实测）：商机详情页点「数据与安全」曾无反应。静态审计
   结论：顶栏 z-index 20 低于随时翻译悬浮球/面板（900/901），悬浮球可
   拖动并持久化、可停在顶栏上遮挡入口；且该入口原本是纯锚点，弹窗
   遮罩打开时点击只会命中遮罩。本测试锁定三处修复的结构不变量，
   真实点击穿透由 Chromium 交互核验另行留证。 */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var css = fs.readFileSync(path.join(ROOT, 'assets/styles.css'), 'utf8');
var app = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');

var anchor = /<a[^>]*href="#\/settings"[^>]*>数据与安全<\/a>/.exec(html);
ok('顶栏「数据与安全」锚点存在', !!anchor);
ok('锚点带 data-action="goto-settings"（先关弹窗再跳转）', !!anchor && /data-action="goto-settings"/.test(anchor[0]), anchor && anchor[0]);

var topbar = /\.topbar\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
ok('.topbar 设有 z-index', !!topbar);
ok('.topbar z-index 高于悬浮球(900)与面板(901)', !!topbar && Number(topbar[1]) > 901, topbar && topbar[1]);
var fab = /#tr-fab\{[^}]*z-index:\s*(\d+)/.exec(css);
ok('悬浮球 z-index 仍为 900（未被反向抬高）', !!fab && Number(fab[1]) === 900, fab && fab[1]);

var gi = app.indexOf("case 'goto-settings':");
ok('app.js 存在 goto-settings 动作', gi >= 0);
ok('goto-settings 先 closeModal 再改 hash', gi >= 0 && app.slice(gi, gi + 80).indexOf('closeModal()') >= 0 && app.slice(gi, gi + 80).indexOf("location.hash = '#/settings'") > app.slice(gi, gi + 80).indexOf('closeModal()'), gi >= 0 ? app.slice(gi, gi + 80) : '');

var mask = app.indexOf("classList.contains('modal-mask')");
ok('点击遮罩空白处可关闭弹窗（既有行为未动）', mask >= 0);

/* P1-FIX-02：模态层级回归修复后的完整层叠序不变量：
   boot-error(1020) > toast(1010) > 遮罩(1000) > 顶栏(950) > 面板(901) > 悬浮球(900) */
function zOf(re) { var mm = re.exec(css); return mm ? Number(mm[1]) : -1; }
var zMask = zOf(/\.modal-mask\s*\{[^}]*z-index:\s*(\d+)/);
var zToast = zOf(/\.toast\s*\{[^}]*z-index:\s*(\d+)/);
var zBoot = zOf(/\.boot-error\s*\{[^}]*z-index:\s*(\d+)/);
var zPanel = zOf(/#tr-panel\s*\{[^}]*z-index:\s*(\d+)/);
ok('遮罩 z-index 高于顶栏（模态隔离恢复）', zMask > Number(topbar[1]), zMask + ' vs ' + topbar[1]);
ok('遮罩 z-index 高于悬浮球与面板', zMask > 901, String(zMask));
ok('toast 高于遮罩', zToast > zMask, zToast + ' vs ' + zMask);
ok('boot-error 为全站最高', zBoot > zToast && zBoot > zMask && zBoot > Number(topbar[1]), String(zBoot));

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
