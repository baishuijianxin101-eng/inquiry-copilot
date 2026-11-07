/* P1-POST-RELEASE-FIX-01 专项 A：翻译球拖动上界不得进入顶栏区域。
   桩加载真实 assets/tr-panel.js（桩口径沿用 test-tr-fab-drag.js）：
   querySelector('.topbar') 返回可配置实测高度的假顶栏，验证：
   顶部/左右/底部边界按视口+顶栏实测钳制、恢复位置同样钳制、
   resize 后再钳制、无顶栏时退回边缘留白、松手不误开、点击正常。
   桩不是浏览器，真实浏览器验证另行执行。 */
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

function makeEnv(opt) {
  opt = opt || {};
  var store = Object.assign({}, opt.seed || {});
  var env = { store: store, topBottom: opt.topBottom != null ? opt.topBottom : 57, hasTopbar: opt.hasTopbar !== false };
  var sb = { console: { log: function () {} }, innerWidth: opt.vw || 1280, innerHeight: opt.vh || 900, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; env.sb = sb;
  sb.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  sb.navigator = {}; sb.location = { protocol: 'http:' };
  var els = {};
  ['tr-fab', 'tr-panel', 'tr-input', 'tr-output', 'tr-panel-state', 'tr-engine', 'tr-panel-close', 'tr-copy', 'tr-clear'].forEach(function (id) { els[id] = new El(id, env); });
  els['tr-panel'].hidden = true;
  env.els = els;
  var topbarEl = { getBoundingClientRect: function () { return { top: 0, bottom: env.topBottom, left: 0, right: sb.innerWidth, width: sb.innerWidth, height: env.topBottom }; } };
  env.topbarEl = topbarEl;
  var docHandlers = {};
  sb.document = {
    getElementById: function (id) { return els[id] || null; },
    querySelector: function (sel) { return (sel === '.topbar' && env.hasTopbar) ? topbarEl : null; },
    addEventListener: function (t, fn) { (docHandlers[t] = docHandlers[t] || []).push(fn); }
  };
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
function pos(env) { var r = env.els['tr-fab'].getBoundingClientRect(); return { x: r.left, y: r.top }; }
function dragTo(env, tx, ty) { var p = pos(env); down(env, p.x + 26, p.y + 26); move(env, tx + 26, ty + 26); up(env); }

/* ---------- 桌面 1280×900、顶栏高 57 ---------- */
var d1 = makeEnv({ vw: 1280, vh: 900, topBottom: 57 });
dragTo(d1, 600, -800);
ok(pos(d1).y === 57, 'A1 桌面拖到顶部：球顶停在顶栏下沿 y=57，不被遮挡');
ok(pos(d1).x === 600, 'A2 顶部钳制不影响横坐标');
dragTo(d1, -900, 300);
ok(pos(d1).x === 4 && pos(d1).y === 300, 'A3 左边界钳制 x=4');
dragTo(d1, 5000, 300);
ok(pos(d1).x === 1280 - 52 - 4, 'A4 右边界钳制 x=1224');
dragTo(d1, 300, 5000);
ok(pos(d1).y === 900 - 52 - 4, 'A5 底边界钳制 y=844');
dragTo(d1, 300, 300);
ok(pos(d1).x === 300 && pos(d1).y === 300, 'A6 允许区域内自由拖动落点精确');
click(d1);
ok(d1.els['tr-panel'].hidden === true, 'A7 拖动后紧随的 click 被吞，面板不误开');
click(d1);
ok(d1.els['tr-panel'].hidden === false, 'A8 之后正常点击仍可打开面板');
var saved = JSON.parse(d1.store['ic_tr_fab_pos_v1']);
ok(saved && saved.y === 300, 'A9 拖动落点照旧存入独立位置键');

/* ---------- 移动端 390×844、顶栏高 52 ---------- */
var m1 = makeEnv({ vw: 390, vh: 844, topBottom: 52 });
dragTo(m1, 100, -500);
ok(pos(m1).y === 52, 'A10 窄屏拖到顶部：停在 y=52');
dragTo(m1, 100, 5000);
ok(pos(m1).y === 844 - 52 - 4, 'A11 窄屏底边界 y=788');
dragTo(m1, 5000, 200);
ok(pos(m1).x === 390 - 52 - 4, 'A12 窄屏右边界 x=334');

/* ---------- 恢复位置同样钳制（修复前停进顶栏的存量位置） ---------- */
var r1 = makeEnv({ vw: 1280, vh: 900, topBottom: 57, seed: { ic_tr_fab_pos_v1: JSON.stringify({ x: 100, y: 0 }) } });
ok(pos(r1).y === 57 && pos(r1).x === 100, 'A13 存量位置 y=0 恢复时被钳到顶栏下沿 57');

/* ---------- resize 后顶栏变高（换行/缩放）自动再钳制 ---------- */
var z1 = makeEnv({ vw: 1280, vh: 900, topBottom: 57 });
dragTo(z1, 200, 100);
ok(pos(z1).y === 100, 'A14 钳制前置断言：y=100 在允许区');
z1.topBottom = 140;
z1.winFire('resize');
ok(pos(z1).y === 140, 'A15 顶栏变高后 resize 触发再钳制 y=140');

/* ---------- 无顶栏元素时退回原边缘留白 ---------- */
var n1 = makeEnv({ vw: 800, vh: 600, hasTopbar: false });
dragTo(n1, 100, -500);
ok(pos(n1).y === 4, 'A16 无顶栏：上界退回 EDGE=4，不报错');

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('== postfix01-fab-clamp: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
