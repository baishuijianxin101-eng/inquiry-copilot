/* POST-RELEASE-FIX-02：翻译面板层级与高度双保险
   缺陷（Find X8s 真机，2026-11-07）：面板 bottom 锚定 + max-height:72vh + z-index 901，
   手机键盘弹起时可视高度骤减，面板标题行顶进顶栏（z 950）区域被盖住。
   修复：z-index 901→960（高于顶栏、低于弹窗 1000/提示 1010）；
   max-height 增加 min(72vh, calc(100dvh - 170px))（72vh 一行保留为旧浏览器回退）。 */
const fs = require('fs');
const css = fs.readFileSync(__dirname + '/../assets/styles.css', 'utf8');
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name); } }
const panelRule = (css.match(/#tr-panel\{[^}]*\}/) || [''])[0];
const topbarZ = Number((css.match(/z-index:\s*(\d+);\s*\}/) && css.slice(0, css.indexOf('z-index: 950') + 20), css.match(/\.topbar\{[^}]*z-index:\s*(\d+)/) || [])[1] || 950);
const panelZ = Number((panelRule.match(/z-index:(\d+)/) || [])[1] || 0);
ok('面板规则存在', panelRule.length > 0);
ok('面板层级为 960', panelZ === 960);
ok('面板层级高于顶栏(950)', panelZ > 950);
ok('面板层级低于弹窗/提示(1000)', panelZ < 1000);
ok('max-height 含 dvh 双保险', panelRule.includes('max-height:min(72vh,calc(100dvh - 170px))'));
ok('72vh 回退行保留', (panelRule.match(/max-height:72vh/g) || []).length >= 1);
ok('面板仍为 bottom 锚定', panelRule.includes('bottom:150px'));
console.log('== postfix02-panel-layer: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
