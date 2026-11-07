/* P1-21-R7 专项：键盘误吞修复验证（B'：document keydown 首行清残留标记）。
   局限如实声明：本桩以事件派发顺序模拟按钮键盘激活（keydown →（keyup）→ click），
   不等同于真实浏览器键盘验收；真实浏览器中 Enter 于 keydown 后派发 click、
   Space 于 keyup 派发 click，本测试按该公开时序构造序列。 */
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
  return { left: this.style.left ? parseFloat(this.style.left) : vw - 74, top: this.style.top ? parseFloat(this.style.top) : vh - 138, width: 52, height: 52 };
};
function makeEnv() {
  var store = {};
  var env = { store: store };
  var sb = { console: { log: function () {} }, innerWidth: 400, innerHeight: 800, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; env.sb = sb;
  sb.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  sb.navigator = {}; sb.location = { protocol: 'http:' };
  var els = {};
  ['tr-fab', 'tr-panel', 'tr-input', 'tr-output', 'tr-panel-state', 'tr-engine', 'tr-panel-close', 'tr-copy', 'tr-clear'].forEach(function (id) { els[id] = new El(id, env); });
  els['tr-panel'].hidden = true; env.els = els;
  var dh = {}, wh = {};
  sb.document = { getElementById: function (id) { return els[id] || null; }, addEventListener: function (t, fn) { (dh[t] = dh[t] || []).push(fn); } };
  sb.addEventListener = function (t, fn) { (wh[t] = wh[t] || []).push(fn); };
  env.key = function (key, extra) { var ev = Object.assign({ key: key, preventDefault: function () {} }, extra || {}); (dh['keydown'] || []).forEach(function (fn) { fn(ev); }); };
  env.winFire = function (t, ev) { (wh[t] || []).forEach(function (fn) { fn(ev || {}); }); };
  vm.createContext(sb); vm.runInContext(SRC, sb, { filename: 'tr-panel.js' });
  return env;
}
function down(e, x, y) { e.els['tr-fab'].fire('pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 }); }
function move(e, x, y) { e.els['tr-fab'].fire('pointermove', { clientX: x, clientY: y, pointerId: 1 }); }
function up(e) { e.els['tr-fab'].fire('pointerup', { pointerId: 1 }); }
function cancel(e) { e.els['tr-fab'].fire('pointercancel', { pointerId: 1 }); }
function click(e) { e.els['tr-fab'].fire('click', {}); }
function dragNoClick(e, dx, dy) { var r = e.els['tr-fab'].getBoundingClientRect(); down(e, r.left + 26, r.top + 26); move(e, r.left + 26 + dx, r.top + 26 + dy); up(e); /* 故意不发 click：构造残留标记 */ }
function dragFull(e, dx, dy) { dragNoClick(e, dx, dy); click(e); }
function tap(e) { var r = e.els['tr-fab'].getBoundingClientRect(); down(e, r.left + 26, r.top + 26); up(e); click(e); }

/* A Enter 激活 */
(function () {
  var e = makeEnv();
  dragNoClick(e, -100, -100);
  ok(e.els['tr-panel'].hidden === true, 'A1 前置：拖动结束且无 click 时面板未打开（标记残留中）');
  e.key('Enter'); click(e);
  ok(e.els['tr-panel'].hidden === false, 'A2 Enter keydown 后键盘 click 未被吞，面板打开');
  e.key('Enter'); click(e);
  ok(e.els['tr-panel'].hidden === true, 'A3 再次 Enter 激活正常关闭（标记未残留）');
})();
/* B Space 激活（keydown → keyup → click 时序） */
(function () {
  var e = makeEnv();
  dragNoClick(e, -100, -100);
  e.key(' '); /* Space keydown；桩无 keyup 监听，keyup 不影响状态 */
  click(e);
  ok(e.els['tr-panel'].hidden === false, 'B1 Space 激活的 click 未被吞，面板打开');
})();
/* C 原有拖动吞 click 不变 */
(function () {
  var e = makeEnv();
  dragFull(e, -100, -100);
  ok(e.els['tr-panel'].hidden === true, 'C1 真实拖动后的合成 click 仍被吞，面板未误开');
  tap(e);
  ok(e.els['tr-panel'].hidden === false, 'C2 吞一次后标记已复位，下一次点击正常打开');
})();
/* D 普通操作与快捷键 */
(function () {
  var e = makeEnv();
  tap(e); ok(e.els['tr-panel'].hidden === false, 'D1 普通点击打开');
  tap(e); ok(e.els['tr-panel'].hidden === true, 'D2 连续普通点击关闭');
  e.key('T', { ctrlKey: true, shiftKey: true });
  ok(e.els['tr-panel'].hidden === false, 'D3 Ctrl+Shift+T 打开面板');
  e.key('Escape');
  ok(e.els['tr-panel'].hidden === true, 'D4 Escape 关闭面板');
  e.els['tr-input'].value = 'abc';
  e.key('x'); e.key('a');
  ok(e.els['tr-panel'].hidden === true && e.els['tr-input'].value === 'abc', 'D5 非相关按键不改变面板与输入');
})();
/* E 边界 */
(function () {
  var e = makeEnv();
  var r = e.els['tr-fab'].getBoundingClientRect();
  down(e, r.left + 26, r.top + 26); move(e, r.left - 74, r.top - 74);
  e.key('x');                       /* 拖动中 keydown：此时标记尚未置位 */
  up(e); click(e);                  /* endDrag 在 keydown 之后才置位，合成 click 仍应被吞 */
  ok(e.els['tr-panel'].hidden === true, 'E1 拖动中 keydown 不影响随后合成 click 被吞');
  var e2 = makeEnv();
  var r2 = e2.els['tr-fab'].getBoundingClientRect();
  down(e2, r2.left + 26, r2.top + 26); move(e2, r2.left - 74, r2.top - 74); cancel(e2);  /* cancel 后残留标记、无 click */
  e2.key('Enter'); click(e2);
  ok(e2.els['tr-panel'].hidden === false, 'E2 pointercancel 残留标记下 Enter 激活不被误吞');
  var e3 = makeEnv();
  e3.winFire('blur');
  e3.key('Enter'); click(e3);
  ok(e3.els['tr-panel'].hidden === false, 'E3 blur 后无残留时键盘激活正常');
  var e4 = makeEnv();
  e4.key('Enter'); click(e4); e4.key('Enter'); click(e4); e4.key('Enter'); click(e4);
  ok(e4.els['tr-panel'].hidden === false, 'E4 连续键盘激活状态一致（开-关-开）');
  dragFull(e4, -60, -60);
  ok(e4.els['tr-panel'].hidden === false, 'E5 键盘操作后拖动功能仍正常（拖动 click 被吞、面板保持开）');
})();

console.log('== tr-fab-keyboard-suppression: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
