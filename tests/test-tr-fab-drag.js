/* P1-21 专项：翻译悬浮按钮 #tr-fab 可拖动。
   以最小 DOM 桩加载真实 assets/tr-panel.js，派发合成 Pointer Events 验证：
   点击/拖动区分、阈值、边缘约束、位置记忆与回退、异常中断、存储隔离、
   原有开关面板调用链不变。桩不是浏览器，真机验收另行执行。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tr-panel.js'), 'utf8');
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }

function El(id, env) {
  this.id = id; this.env = env; this.handlers = {}; this.style = {}; this.hidden = false;
  this.textContent = ''; this.value = ''; this._cls = {};
  var self = this;
  this.classList = {
    add: function (c) { self._cls[c] = 1; }, remove: function (c) { delete self._cls[c]; },
    contains: function (c) { return !!self._cls[c]; }
  };
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

function makeEnv(seed) {
  var store = Object.assign({}, seed || {});
  var env = { store: store };
  var sb = { console: { log: function () {} }, innerWidth: 400, innerHeight: 800, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; env.sb = sb;
  sb.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  sb.navigator = {}; sb.location = { protocol: 'http:' };
  var els = {};
  ['tr-fab', 'tr-panel', 'tr-input', 'tr-output', 'tr-panel-state', 'tr-engine', 'tr-panel-close', 'tr-copy', 'tr-clear'].forEach(function (id) { els[id] = new El(id, env); });
  els['tr-panel'].hidden = true;
  env.els = els;
  var docHandlers = {};
  sb.document = {
    getElementById: function (id) { return els[id] || null; },
    addEventListener: function (t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); }
  };
  env.docFire = function (t, ev) { (docHandlers[t] || []).forEach(function (fn) { fn(ev); }); };
  var winHandlers = {};
  sb.addEventListener = function (t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); };
  env.winFire = function (t, ev) { (winHandlers[t] || []).forEach(function (fn) { fn(ev || {}); }); };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'tr-panel.js' });
  return env;
}
function down(env, x, y) { env.els['tr-fab'].fire('pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 }); }
function move(env, x, y) { env.els['tr-fab'].fire('pointermove', { clientX: x, clientY: y, pointerId: 1 }); }
function up(env) { env.els['tr-fab'].fire('pointerup', { pointerId: 1 }); }
function click(env) { env.els['tr-fab'].fire('click', {}); }
function fabPos(env) { var r = env.els['tr-fab'].getBoundingClientRect(); return { x: r.left, y: r.top }; }

/* 1 普通点击开关面板（原调用链） */
var e1 = makeEnv();
click(e1); ok(e1.els['tr-panel'].hidden === false && e1.els['tr-fab'].classList.contains('active'), 'T1 点击打开面板');
click(e1); ok(e1.els['tr-panel'].hidden === true, 'T2 再点击关闭面板');
e1.docFire('keydown', { ctrlKey: true, shiftKey: true, key: 'T', preventDefault: function () {} });
ok(e1.els['tr-panel'].hidden === false, 'T3 Ctrl+Shift+T 快捷键仍可打开');

/* 2 小幅抖动仍算点击且不移位 */
var e2 = makeEnv();
var p0 = fabPos(e2);
down(e2, 300, 700); move(e2, 302, 702); up(e2); click(e2);
ok(e2.els['tr-panel'].hidden === false, 'T4 3px 抖动后点击仍触发翻译面板');
ok(!e2.els['tr-fab'].style.left, 'T5 小幅移动不改变按钮位置');

/* 3 真拖动：移位、类名、松手后 click 被吞、之后点击恢复 */
var e3 = makeEnv();
down(e3, 326, 662);
move(e3, 200, 500);
ok(e3.els['tr-fab'].classList.contains('dragging'), 'T6 拖动中带 dragging 样式');
var p3 = fabPos(e3);
ok(Math.abs(p3.x - (326 - 22 - 0) - (200 - 326)) < 200 && p3.x < 326 && p3.y < 662, 'T7 按钮跟随指针移动（' + p3.x + ',' + p3.y + '）');
up(e3);
ok(!e3.els['tr-fab'].classList.contains('dragging'), 'T8 松手移除 dragging 样式');
click(e3); ok(e3.els['tr-panel'].hidden === true, 'T9 拖动后紧跟的 click 不触发翻译');
down(e3, p3.x + 10, p3.y + 10); up(e3); click(e3);
ok(e3.els['tr-panel'].hidden === false, 'T10 拖动之后再次点击可正常打开');

/* 4 边缘约束（400x800 视口，按钮 52） */
var e4 = makeEnv();
down(e4, 326, 662); move(e4, -500, -500); up(e4);
var p4 = fabPos(e4); ok(p4.x === 4 && p4.y === 4, 'T11 拖到左上被约束在边缘内（' + p4.x + ',' + p4.y + '）');
down(e4, 10, 10); move(e4, 2000, 2000); up(e4);
var p4b = fabPos(e4); ok(p4b.x === 400 - 52 - 4 && p4b.y === 800 - 52 - 4, 'T12 拖到右下被约束在边缘内（' + p4b.x + ',' + p4b.y + '）');

/* 5 位置记忆与存储隔离 */
ok(!!e4.store['ic_tr_fab_pos_v1'], 'T13 拖动后位置写入独立键 ic_tr_fab_pos_v1');
var saved = JSON.parse(e4.store['ic_tr_fab_pos_v1']);
ok(saved.x === 344 && saved.y === 744, 'T14 保存坐标与最终位置一致');
var e5 = makeEnv(Object.assign({}, e4.store, { ali_commission_copilot_v1: '{"sentinel":1}' }));
var p5 = fabPos(e5);
ok(p5.x === 344 && p5.y === 744, 'T15 重新加载后恢复保存位置');
ok(e5.store['ali_commission_copilot_v1'] === '{"sentinel":1}', 'T16 业务存储键未被触碰');

/* 6 损坏/越界数据回退 */
var e6 = makeEnv({ ic_tr_fab_pos_v1: '{broken json' });
ok(!e6.els['tr-fab'].style.left, 'T17 损坏的位置数据回退默认位置且不抛错');
var e7 = makeEnv({ ic_tr_fab_pos_v1: JSON.stringify({ x: 99999, y: -50 }) });
var p7 = fabPos(e7);
ok(p7.x === 344 && p7.y === 4, 'T18 越界保存位置在恢复时被修正（' + p7.x + ',' + p7.y + '）');

/* 7 resize 重新约束 + pointercancel 中断恢复 */
var e8 = makeEnv({ ic_tr_fab_pos_v1: JSON.stringify({ x: 344, y: 744 }) });
e8.sb.innerWidth = 300;
e8.winFire('resize');
var p8 = fabPos(e8);
ok(p8.x === 300 - 52 - 4, 'T19 窗口变窄后按钮被拉回可视区（' + p8.x + '）');
var e9 = makeEnv();
down(e9, 326, 662); move(e9, 200, 500);
e9.els['tr-fab'].fire('pointercancel', { pointerId: 1 });
ok(!e9.els['tr-fab'].classList.contains('dragging'), 'T20 pointercancel 后拖动态清除');
down(e9, 200, 500); up(e9); click(e9);
ok(e9.els['tr-panel'].hidden === false, 'T21 cancel 后再次点击仍可打开面板');

console.log('== tr-fab-drag: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
