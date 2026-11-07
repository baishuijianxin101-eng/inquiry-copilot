/* P1-FIX-04 回归：.tbl 表格样式与窄屏最小宽度
   运行：node tests/test-fix04-tbl-css.js
   背景（Android A1 实测）：同步与设置的表格列宽过窄、表头逐字竖排。
   根因：.tbl 此前没有任何 CSS 规则，且 ≤560px 的最小宽度规则只覆盖
   .table 不覆盖 .tbl。本测试锁定样式结构；360/390/430px 的真实
   渲染（可横向滚动、表头单行、页面无横向溢出）由 Chromium 核验留证。 */
'use strict';
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var css = fs.readFileSync(path.join(ROOT, 'assets/styles.css'), 'utf8');

ok('.table-wrap 保持横向滚动', /\.table-wrap\s*\{\s*overflow-x:\s*auto/.test(css));
ok('.tbl 有基础规则（border-collapse）', /\.tbl\s*\{[^}]*border-collapse:\s*collapse/.test(css));
ok('.tbl th 不换行（nowrap，杜绝逐字竖排）', /\.tbl th\s*\{[^}]*white-space:\s*nowrap/.test(css));
ok('.tbl td 有内边距（与 .table 同口径）', /\.tbl td\s*\{[^}]*padding:/.test(css));

var mIdx = css.indexOf('@media (max-width: 560px)');
ok('存在 ≤560px 媒体查询', mIdx >= 0);
var mobile = mIdx >= 0 ? css.slice(mIdx) : '';
ok('窄屏 .table-wrap .tbl 有最小宽度（靠滚动不压列）', /\.table-wrap \.tbl\s*\{\s*min-width:\s*\d+px/.test(mobile));
var mw = /\.table-wrap \.tbl\s*\{\s*min-width:\s*(\d+)px/.exec(mobile);
ok('窄屏 .tbl 最小宽度在 480–640px 合理区间', !!mw && Number(mw[1]) >= 480 && Number(mw[1]) <= 640, mw && mw[1]);
ok('桌面 .table 规则未被改动', /\.table\s*\{\s*width:\s*100%;\s*border-collapse:\s*collapse/.test(css));
ok('窄屏 .table 既有最小宽度未被改动', /\.table-wrap \.table\s*\{\s*min-width:\s*620px/.test(mobile));

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
