/* P1-21-R 随机压力测试：固定种子 LCG，全部虚构数据，结果可复现。
   五组：1000 随机拖动 / 500 点击拖动交替（带状态预言机）/ 500 视口恢复 /
   500 保存-恢复 / 500 异常中断。失败记录轮次参数供最小复现。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'tr-panel.js'), 'utf8');
var SEED = 20261105;
var s = SEED;
function rnd() { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }
function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

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
function makeEnv(seedStore, vw, vh) {
  var store = Object.assign({}, seedStore || {});
  var env = { store: store };
  var sb = { console: { log: function () {} }, innerWidth: vw, innerHeight: vh, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; env.sb = sb;
  sb.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  sb.navigator = {}; sb.location = { protocol: 'http:' };
  var els = {};
  ['tr-fab', 'tr-panel', 'tr-input', 'tr-output', 'tr-panel-state', 'tr-engine', 'tr-panel-close', 'tr-copy', 'tr-clear'].forEach(function (id) { els[id] = new El(id, env); });
  els['tr-panel'].hidden = true; env.els = els;
  var wh = {};
  sb.document = { getElementById: function (id) { return els[id] || null; }, addEventListener: function () {} };
  sb.addEventListener = function (t, fn) { (wh[t] = wh[t] || []).push(fn); };
  env.winFire = function (t, ev) { (wh[t] || []).forEach(function (fn) { fn(ev || {}); }); };
  vm.createContext(sb); vm.runInContext(SRC, sb, { filename: 'tr-panel.js' });
  return env;
}
function down(e, x, y) { e.els['tr-fab'].fire('pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 }); }
function move(e, x, y) { e.els['tr-fab'].fire('pointermove', { clientX: x, clientY: y, pointerId: 1 }); }
function up(e) { e.els['tr-fab'].fire('pointerup', { pointerId: 1 }); }
function click(e) { e.els['tr-fab'].fire('click', {}); }
function pos(e) { var r = e.els['tr-fab'].getBoundingClientRect(); return { x: r.left, y: r.top }; }
function clamp(x, y, vw, vh) { return { x: Math.min(Math.max(x, 4), Math.max(4, vw - 56)), y: Math.min(Math.max(y, 4), Math.max(4, vh - 56)) }; }
function dragBy(e, dx, dy) { var r = e.els['tr-fab'].getBoundingClientRect(); down(e, r.left + 26, r.top + 26); move(e, r.left + 26 + dx, r.top + 26 + dy); up(e); click(e); }
function tap(e) { var r = e.els['tr-fab'].getBoundingClientRect(); down(e, r.left + 26, r.top + 26); up(e); click(e); }

var VPS = [[400, 800], [800, 360], [1920, 1080], [360, 740], [768, 1024], [1366, 768]];
var failures = [];
function record(suite, round, detail) { if (failures.length < 10) failures.push({ suite: suite, round: round, detail: detail }); }

/* S1 1000 随机拖动 */
var s1fail = 0;
for (var i = 0; i < 1000; i++) {
  var vp = pick(VPS), dx = ri(-2500, 2500), dy = ri(-2500, 2500);
  var e = makeEnv(null, vp[0], vp[1]);
  var start = pos(e);
  dragBy(e, dx, dy);
  var exp = clamp(start.x + dx, start.y + dy, vp[0], vp[1]);
  var got = pos(e);
  var saved = null; try { saved = JSON.parse(e.store['ic_tr_fab_pos_v1']); } catch (err) {}
  if (got.x !== exp.x || got.y !== exp.y || e.els['tr-panel'].hidden !== true || !saved || saved.x !== exp.x || saved.y !== exp.y) {
    s1fail++; record('S1-drag', i, { vp: vp, dx: dx, dy: dy, start: start, exp: exp, got: got, saved: saved, hidden: e.els['tr-panel'].hidden });
  }
}
console.log('S1 random-drag: ' + (1000 - s1fail) + '/1000 passed');

/* S2 500 点击/拖动交替（预言机） */
var s2fail = 0;
for (var j = 0; j < 500; j++) {
  var vp2 = pick(VPS);
  var e2 = makeEnv(null, vp2[0], vp2[1]);
  var mPos = pos(e2), mHidden = true, ops = [], n = ri(3, 8), bad = null;
  for (var k = 0; k < n; k++) {
    if (rnd() < 0.5) { ops.push('tap'); tap(e2); mHidden = !mHidden; }
    else { var ddx = ri(-900, 900), ddy = ri(-900, 900); if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) ddx = 120; ops.push('drag(' + ddx + ',' + ddy + ')'); dragBy(e2, ddx, ddy); mPos = clamp(mPos.x + ddx, mPos.y + ddy, vp2[0], vp2[1]); }
    var gp = pos(e2);
    if (gp.x !== mPos.x || gp.y !== mPos.y || e2.els['tr-panel'].hidden !== mHidden) { bad = { atOp: k, ops: ops, expPos: mPos, gotPos: gp, expHidden: mHidden, gotHidden: e2.els['tr-panel'].hidden }; break; }
  }
  if (bad) { s2fail++; record('S2-alternate', j, bad); }
}
console.log('S2 alternate-oracle: ' + (500 - s2fail) + '/500 passed');

/* S3 500 视口×旧坐标恢复 */
var s3fail = 0;
for (var a = 0; a < 500; a++) {
  var vp3 = pick(VPS);
  var sx = ri(-500, 3000), sy = ri(-500, 3000);
  var e3 = makeEnv({ ic_tr_fab_pos_v1: JSON.stringify({ x: sx, y: sy }) }, vp3[0], vp3[1]);
  var exp3 = clamp(sx, sy, vp3[0], vp3[1]); var got3 = pos(e3);
  if (got3.x !== exp3.x || got3.y !== exp3.y) { s3fail++; record('S3-restore-clamp', a, { vp: vp3, saved: [sx, sy], exp: exp3, got: got3 }); }
}
console.log('S3 restore-clamp: ' + (500 - s3fail) + '/500 passed');

/* S4 500 保存→重载恢复 */
var s4fail = 0;
for (var b = 0; b < 500; b++) {
  var vp4 = pick(VPS);
  var e4 = makeEnv(null, vp4[0], vp4[1]);
  dragBy(e4, ri(-2000, 2000), ri(-2000, 2000));
  var before = pos(e4);
  var e4b = makeEnv(e4.store, vp4[0], vp4[1]);
  var after = pos(e4b);
  if (before.x !== after.x || before.y !== after.y) { s4fail++; record('S4-save-reload', b, { vp: vp4, before: before, after: after }); }
}
console.log('S4 save-reload: ' + (500 - s4fail) + '/500 passed');

/* S5 500 异常中断后可用性 */
var s5fail = 0;
for (var c = 0; c < 500; c++) {
  var vp5 = pick(VPS);
  var e5 = makeEnv(null, vp5[0], vp5[1]);
  var r5 = e5.els['tr-fab'].getBoundingClientRect();
  down(e5, r5.left + 26, r5.top + 26); move(e5, r5.left + ri(-600, 600), r5.top + ri(-600, 600));
  var mode = pick(['cancel', 'blur', 'up-outside']);
  if (mode === 'cancel') e5.els['tr-fab'].fire('pointercancel', { pointerId: 1 });
  else if (mode === 'blur') e5.winFire('blur');
  else up(e5);
  var stuck = e5.els['tr-fab'].classList.contains('dragging');
  tap(e5);
  if (stuck || e5.els['tr-panel'].hidden !== false) { s5fail++; record('S5-interrupt', c, { vp: vp5, mode: mode, stuck: stuck, hidden: e5.els['tr-panel'].hidden }); }
}
console.log('S5 interrupt-recovery: ' + (500 - s5fail) + '/500 passed');

var totalFail = s1fail + s2fail + s3fail + s4fail + s5fail;
console.log('== tr-fab-stress (seed ' + SEED + '): 3000 rounds, ' + totalFail + ' failures ==');
if (failures.length) console.log('FAILURE REPROS: ' + JSON.stringify(failures, null, 1));
process.exit(totalFail ? 1 : 0);
