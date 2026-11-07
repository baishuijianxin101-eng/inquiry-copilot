/* P1-21-R 扩展边界测试：拖动/点击阈值、多视口、位置数据异常、存储隔离与失败、
   翻译功能回归。与 test-tr-fab-drag.js 独立，不修改其任何断言。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tr-panel.js'), 'utf8');
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }

function El(id, env) {
  this.id = id; this.env = env; this.handlers = {}; this.style = {}; this.hidden = false;
  this.textContent = ''; this.value = ''; this._cls = {};
  var self = this;
  this.classList = { add: function (c) { self._cls[c] = 1; }, remove: function (c) { delete self._cls[c]; }, contains: function (c) { return !!self._cls[c]; } };
}
El.prototype.addEventListener = function (t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); };
El.prototype.fire = function (t, ev) { (this.handlers[t] || []).forEach(function (fn) { fn(ev || {}); }); };
El.prototype.focus = function () {};
El.prototype.setPointerCapture = function () {};
El.prototype.getBoundingClientRect = function () {
  if (this.id !== 'tr-fab') return { left: 0, top: 0, width: 0, height: 0 };
  var vw = this.env.sb.innerWidth, vh = this.env.sb.innerHeight;
  var left = this.style.left ? parseFloat(this.style.left) : vw - 22 - 52;
  var top = this.style.top ? parseFloat(this.style.top) : vh - 86 - 52;
  return { left: left, top: top, width: 52, height: 52 };
};
function makeEnv(seed, vw, vh, storageOverride) {
  var store = Object.assign({}, seed || {});
  var env = { store: store };
  var sb = { console: { log: function () {} }, innerWidth: vw || 400, innerHeight: vh || 800, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; env.sb = sb;
  sb.localStorage = storageOverride || { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  env.clipboard = [];
  sb.navigator = { clipboard: { writeText: function (t) { env.clipboard.push(t); return Promise.resolve(); } } };
  sb.location = { protocol: 'http:' };
  var els = {};
  ['tr-fab', 'tr-panel', 'tr-input', 'tr-output', 'tr-panel-state', 'tr-engine', 'tr-panel-close', 'tr-copy', 'tr-clear'].forEach(function (id) { els[id] = new El(id, env); });
  els['tr-panel'].hidden = true; env.els = els;
  var dh = {}, wh = {};
  sb.document = { getElementById: function (id) { return els[id] || null; }, addEventListener: function (t, fn) { (dh[t] = dh[t] || []).push(fn); } };
  sb.addEventListener = function (t, fn) { (wh[t] = wh[t] || []).push(fn); };
  env.docFire = function (t, ev) { (dh[t] || []).forEach(function (fn) { fn(ev); }); };
  env.winFire = function (t, ev) { (wh[t] || []).forEach(function (fn) { fn(ev || {}); }); };
  vm.createContext(sb); vm.runInContext(SRC, sb, { filename: 'tr-panel.js' });
  return env;
}
function down(e, x, y) { e.els['tr-fab'].fire('pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 }); }
function move(e, x, y) { e.els['tr-fab'].fire('pointermove', { clientX: x, clientY: y, pointerId: 1 }); }
function up(e) { e.els['tr-fab'].fire('pointerup', { pointerId: 1 }); }
function click(e) { e.els['tr-fab'].fire('click', {}); }
function tap(e) { var r = e.els['tr-fab'].getBoundingClientRect(); down(e, r.left + 26, r.top + 26); up(e); click(e); }
function dragBy(e, dx, dy) { var r = e.els['tr-fab'].getBoundingClientRect(); down(e, r.left + 26, r.top + 26); move(e, r.left + 26 + dx, r.top + 26 + dy); up(e); click(e); /* 浏览器在 pointerup 后必发合成 click */ }
function pos(e) { var r = e.els['tr-fab'].getBoundingClientRect(); return { x: r.left, y: r.top }; }
function clampExp(x, y, vw, vh) { return { x: Math.min(Math.max(x, 4), Math.max(4, vw - 56)), y: Math.min(Math.max(y, 4), Math.max(4, vh - 56)) }; }

/* ---------- A 阈值与交替 ---------- */
[1, 2, 3, 5].forEach(function (d) {
  var e = makeEnv(); var r = e.els['tr-fab'].getBoundingClientRect();
  down(e, r.left + 26, r.top + 26); move(e, r.left + 26 + d, r.top + 26); up(e); click(e);
  ok(e.els['tr-panel'].hidden === false && !e.els['tr-fab'].style.left, 'A' + d + ' 移动 ' + d + 'px 仍按点击（面板打开、未移位）');
});
(function () { /* 恰好 6px = 拖动 */
  var e = makeEnv(); var r = e.els['tr-fab'].getBoundingClientRect();
  down(e, r.left + 26, r.top + 26); move(e, r.left + 32, r.top + 26); up(e); click(e);
  ok(e.els['tr-panel'].hidden === true && !!e.els['tr-fab'].style.left, 'A6 移动恰好 6px 判定为拖动且 click 被吞');
})();
(function () { /* 连续拖动 + 交替 */
  var e = makeEnv();
  dragBy(e, -100, -100); dragBy(e, 50, 30); dragBy(e, -20, 80);
  var p = pos(e); var exp = clampExp(326 - 100 + 50 - 20, 662 - 100 + 30 + 80, 400, 800);
  ok(p.x === exp.x && p.y === exp.y, 'A7 连续三次拖动位置累计正确（' + p.x + ',' + p.y + '）');
  ok(e.els['tr-panel'].hidden === true, 'A8 三次拖动均未误开面板');
  tap(e); ok(e.els['tr-panel'].hidden === false, 'A9 拖动后点击打开');
  dragBy(e, 10, 10); ok(e.els['tr-panel'].hidden === false, 'A10 面板开着拖动不误关');
  tap(e); ok(e.els['tr-panel'].hidden === true, 'A11 再点击关闭');
})();
(function () { /* 快速按放 ×10 + 双 pointerdown */
  var e = makeEnv();
  for (var i = 0; i < 10; i++) tap(e);
  ok(e.els['tr-panel'].hidden === true, 'A12 快速点按 10 次后面板状态偶数回归（关）');
  var r = e.els['tr-fab'].getBoundingClientRect();
  down(e, r.left + 26, r.top + 26); down(e, r.left + 30, r.top + 30); move(e, r.left + 90, r.top + 90); up(e); click(e);
  tap(e); ok(e.els['tr-panel'].hidden === false, 'A13 重复 pointerdown 后无残留状态、点击正常');
})();
(function () { /* 拖出元素/窗口外 + blur 中断 + cancel 后残留标记救援 */
  var e = makeEnv();
  dragBy(e, -10000, -10000);
  var p = pos(e); ok(p.x === 4 && p.y === 4, 'A14 拖出窗口外仍被约束在左上（' + p.x + ',' + p.y + '）');
  var r = e.els['tr-fab'].getBoundingClientRect();
  down(e, r.left + 26, r.top + 26); move(e, r.left + 126, r.top + 126);
  e.winFire('blur');
  ok(!e.els['tr-fab'].classList.contains('dragging'), 'A15 blur 中断后拖动态清除');
  tap(e); ok(e.els['tr-panel'].hidden === false, 'A16 blur 后点击正常');
  var e2 = makeEnv();
  var r2 = e2.els['tr-fab'].getBoundingClientRect();
  down(e2, r2.left + 26, r2.top + 26); move(e2, r2.left + 126, r2.top + 126);
  e2.els['tr-fab'].fire('pointercancel', { pointerId: 1 });   /* cancel 后浏览器可能不发 click，标记残留 */
  tap(e2); ok(e2.els['tr-panel'].hidden === false, 'A17 cancel 残留标记被下一次 pointerdown 清除、点击正常');
})();

/* ---------- B 多视口边界 ---------- */
[[400, 800, '手机竖屏'], [800, 360, '手机横屏'], [1920, 1080, '桌面宽屏'], [120, 160, '极小视口']].forEach(function (v, i) {
  var e = makeEnv(null, v[0], v[1]);
  dragBy(e, 99999, 99999); var p = pos(e); var exp = clampExp(1e9, 1e9, v[0], v[1]);
  ok(p.x === exp.x && p.y === exp.y, 'B' + (i + 1) + ' ' + v[2] + ' ' + v[0] + 'x' + v[1] + ' 拖到右下角约束正确（' + p.x + ',' + p.y + '）');
  dragBy(e, -99999, -99999); var p2 = pos(e);
  ok(p2.x === 4 && p2.y === 4, 'B' + (i + 1) + 'b ' + v[2] + ' 拖到左上角约束正确');
});
(function () { /* 视口放大/缩小 + 拖后改视口 */
  var e = makeEnv(null, 400, 800);
  dragBy(e, 99999, 99999);
  e.sb.innerWidth = 200; e.winFire('resize');
  var p = pos(e); ok(p.x === 200 - 56, 'B5 窗口缩小后按钮回可视区（x=' + p.x + '）');
  e.sb.innerWidth = 1600; e.winFire('resize');
  var p2 = pos(e); ok(p2.x === 200 - 56, 'B6 窗口放大后位置保持（x=' + p2.x + '）');
})();

/* ---------- C 位置数据异常 ---------- */
var payloads = [
  ['', false, '空字符串'], ['null', false, 'null 字面量'], ['"just a string"', false, '纯字符串'],
  ['{"x":"50","y":"60"}', true, '字符串坐标可强制转换'], ['{"x":50}', false, '缺 y'], ['{"y":60}', false, '缺 x'],
  ['{"x":50,"y":60,"extra":1}', true, '额外字段'], ['{"x":null,"y":0}', 'clamp', 'x 为 null'],
  ['[]', false, '数组'], ['{"x":-999,"y":99999}', 'clamp', '负/超大坐标']
];
payloads.forEach(function (pl, i) {
  var e = makeEnv({ ic_tr_fab_pos_v1: pl[0] });
  var p = pos(e);
  if (pl[1] === true) ok(p.x === 50 && p.y === 60, 'C' + (i + 1) + ' ' + pl[2] + ' → 恢复（50,60）');
  else if (pl[1] === 'clamp') { var ex = clampExp(pl[0].indexOf('-999') >= 0 ? -999 : 0, pl[0].indexOf('99999') >= 0 ? 99999 : 0, 400, 800); ok(p.x === ex.x && p.y === ex.y, 'C' + (i + 1) + ' ' + pl[2] + ' → 约束到（' + p.x + ',' + p.y + '）'); }
  else ok(!e.els['tr-fab'].style.left, 'C' + (i + 1) + ' ' + pl[2] + ' → 回退默认位置');
});

/* ---------- D 存储隔离与失败 ---------- */
(function () {
  var seed = { ali_commission_copilot_v1: '{"keep":1}', other_key: 'zzz', ic_tr_fab_pos_v1: '{"x":10,"y":10}' };
  var e = makeEnv(seed);
  dragBy(e, 100, 100); dragBy(e, -30, -30);
  var keys = Object.keys(e.store).sort();
  ok(e.store['ali_commission_copilot_v1'] === '{"keep":1}' && e.store['other_key'] === 'zzz', 'D1 其他键值未被改动');
  ok(keys.length === 3, 'D2 未新增/删除任何键（仅更新位置键）');
  var throwing = { getItem: function () { throw new Error('denied'); }, setItem: function () { throw new Error('denied'); }, removeItem: function () {} };
  var e2 = makeEnv(null, 400, 800, throwing);
  dragBy(e2, -80, -80);
  var p = pos(e2); ok(p.x === 246 && p.y === 582, 'D3 存储抛错时拖动仍生效（' + p.x + ',' + p.y + '）');
  tap(e2); ok(e2.els['tr-panel'].hidden === false, 'D4 存储抛错时点击仍可打开面板');
})();

/* ---------- E 翻译功能回归（桩级） ---------- */
(function () {
  var e = makeEnv();
  tap(e); ok(e.els['tr-panel'].hidden === false, 'E1 单击打开面板');
  e.docFire('keydown', { key: 'Escape' });
  ok(e.els['tr-panel'].hidden === true, 'E2 Esc 关闭面板');
  tap(e);
  e.els['tr-input'].value = 'hello world';
  e.els['tr-output'].textContent = '你好世界';
  e.els['tr-copy'].fire('click', {});
  ok(e.clipboard.length === 1 && e.clipboard[0] === '你好世界', 'E3 复制按钮把译文写入剪贴板');
  e.els['tr-clear'].fire('click', {});
  ok(e.els['tr-input'].value === '' && e.els['tr-output'].textContent === '', 'E4 清空按钮清掉输入与译文');
  dragBy(e, -120, -200);   /* 面板开着拖动按钮 */
  ok(e.els['tr-panel'].hidden === false, 'E5 面板打开时拖动按钮不误关面板');
  e.els['tr-panel-close'].fire('click', {});
  ok(e.els['tr-panel'].hidden === true, 'E6 面板关闭按钮正常');
})();

console.log('== tr-fab-drag-boundary: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
