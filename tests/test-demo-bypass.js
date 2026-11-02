/* 阶段六补充修复：绕过入口封堵测试（纯 Node + DOM 桩，全部虚构数据）
   运行：node tests/test-demo-bypass.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

/* ---------- A. workflow 待办/周汇总（模块级） ---------- */
(function () {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  var m = {};
  sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  vm.createContext(sandbox);
  ['assets/core.js', 'assets/pricing.js', 'assets/workflow.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  var W = sandbox.Workflow;
  var now = new Date().toISOString();
  var past = new Date(Date.now() - 86400000).toISOString();
  function opp(id, status, extra) {
    var o = { id: id, status: status, createdAt: now, updatedAt: now, buyer: { name: id, company: id, country: '德国', channel: 'RFQ' }, rawText: 'x', quote: { qty: 10 }, followLog: [], log: [] };
    Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  var state = { settings: {}, opportunities: [
    opp('r_new', 'new'), opp('d_new', 'new', { demo: true }),
    opp('r_over', 'quoted', { followUpAt: past }), opp('d_over', 'quoted', { demo: true, followUpAt: past }),
    opp('r_won', 'won', { deal: { netRmb: 100, closedAt: now } }), opp('d_won', 'won', { demo: true, deal: { netRmb: 999, closedAt: now } })
  ], orders: [], products: [] };
  var todos = W.todos(state);
  var reply = todos.filter(function (t) { return t.key === 'reply'; })[0];
  var follow = todos.filter(function (t) { return t.key === 'follow'; })[0];
  ok('1. 工作台待办「还没回的询盘」只数真实（1）', reply && reply.count === 1, reply && String(reply.count));
  ok('1b. 工作台待办「该跟进」只数真实逾期（1）', follow && follow.count === 1, follow && String(follow.count));
  var wk = W.weekSummary(state);
  ok('2. 周汇总本周询盘只数真实（3：new+over+won）', wk.weekIn === 3, String(wk.weekIn));
  ok('2b. 周汇总成交与利润只数真实（won 1 / ¥100）', wk.won === 1 && wk.netRmb === 100, JSON.stringify(wk));
})();

/* ---------- B. 快速示例的 core 契约 ---------- */
(function () {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  var m = {};
  sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
  var C = sandbox.Core;
  ok('3a. 固定 id opp_quick_demo 即使丢了标记也被识别为演示', C.isDemoOpp({ id: 'opp_quick_demo' }) === true);
  var nq = C.normalizeOpp({ id: 'opp_quick_demo', demo: true, buyer: { name: 'Laura Gómez' }, rawText: 'sample', quote: { qty: 3 } });
  ok('3b. normalize 后 id 与演示标记保留', nq.id === 'opp_quick_demo' && nq.demo === true);
  ok('3c. 同名用户真实商机不被误标', C.normalizeOpp({ buyer: { name: 'Laura Gómez', company: 'Outdoor Life S.L.' }, rawText: 'real' }).demo === false);
})();

/* ---------- C. DOM 桩整站渲染 ---------- */
function makeApp(preset) {
  var store = {};
  Object.keys(preset || {}).forEach(function (k) { store[k] = preset[k]; });
  var listeners = {};
  function El(tag) {
    this.tagName = (tag || 'div').toUpperCase(); this.children = []; this.style = {}; this.dataset = {};
    this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } };
    this._html = ''; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false;
    this.parentNode = { removeChild: function () {} };
  }
  Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this._html ? { __html: this._html } : (this.children[0] || null); } });
  El.prototype.insertBefore = function (node) { if (node && node.__html) this._prepended = (this._prepended || '') + node.__html; };
  Object.defineProperty(El.prototype, 'innerHTML', { get: function () { return this._html; }, set: function (v) { this._html = String(v); } });
  El.prototype.setAttribute = function () {}; El.prototype.getAttribute = function () { return null; };
  El.prototype.addEventListener = function () {}; El.prototype.removeEventListener = function () {};
  El.prototype.appendChild = function (c) { this.children.push(c); return c; };
  El.prototype.querySelector = function () { return null; }; El.prototype.querySelectorAll = function () { return []; };
  El.prototype.closest = function () { return null; }; El.prototype.focus = function () {}; El.prototype.select = function () {};
  var byId = {};
  var g = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval };
  g.window = g; g.globalThis = g;
  g.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
  g.document = {
    getElementById: function (id) { return byId[id] || (byId[id] = new El('div')); },
    createElement: function (t) { return new El(t); }, body: new El('body'),
    addEventListener: function (t, f) { listeners[t] = f; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    execCommand: function () { return true; }
  };
  g.addEventListener = function (t, f) { listeners[t] = f; };
  Object.defineProperty(g, 'navigator', { value: { clipboard: null }, configurable: true });
  g.location = { hash: '', reload: function () {} };
  g.scrollTo = function () {};
  g.history = { replaceState: function () {} };
  g.alert = function () {}; g.confirm = function () { return true; };
  g.Blob = function () {}; g.URL = { createObjectURL: function () { return ''; }, revokeObjectURL: function () {} };
  g.FileReader = function () {};
  vm.createContext(g);
  var files = ['assets/boot-error.js', 'assets/seed-state.js', 'assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js', 'assets/translate.js', 'assets/judge.js', 'assets/matching.js', 'assets/smart-match.js', 'assets/opp-score.js', 'assets/reply-assistant.js', 'assets/followup.js', 'assets/reply.js', 'assets/importer.js', 'assets/market-ref.js', 'assets/price-candidates.js', 'assets/p0-parse.js', 'assets/p0-match.js', 'assets/p0-quote.js', 'assets/p0-cost.js', 'assets/p0-cockpit.js', 'assets/p0-api.js', 'assets/app.js', 'assets/p0-ui.js'];
  files.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), g, { filename: f }); });
  if (listeners.DOMContentLoaded) listeners.DOMContentLoaded();
  return {
    g: g, C: g.Core, store: store,
    view: function () { var v = byId['view'] || {}; return (v._prepended || '') + (v.innerHTML || ''); },
    goto: function (h) { g.location.hash = h; if (listeners.hashchange) listeners.hashchange(); },
    clickAction: function (act) {
      var btn = { getAttribute: function (n) { return n === 'data-action' ? act : null; } };
      listeners.click({ target: { classList: { contains: function () { return false; } }, closest: function () { return btn; } } });
    }
  };
}
function addOpp(app, o) {
  var st = app.C.get();
  st.opportunities.push(app.C.normalizeOpp(o));
  return st;
}

/* C1. 快速示例：双击只一条、带标记、不进真实、清除不残留 */
(function () {
  var app = makeApp();
  app.clickAction('quick-demo');
  app.clickAction('quick-demo');
  var st = app.C.get();
  var qds = st.opportunities.filter(function (o) { return o.id === 'opp_quick_demo'; });
  ok('3. 快速示例带演示标记', qds.length === 1 && app.C.isDemoOpp(qds[0]));
  ok('4. 快速示例不增加真实商机数量', app.C.visibleOpps(st, 'real').length === 0);
  ok('5. 连续触发不重复污染（仍只有 1 条）', qds.length === 1, String(qds.length));
  app.C.purgeDemo(st);
  ok('6. 清除演示后示例不残留', st.opportunities.filter(function (o) { return o.id === 'opp_quick_demo'; }).length === 0);
})();

/* C2. 汇总跟随视图（真实/演示各一份） */
(function () {
  function seedTwo(app) {
    addOpp(app, { id: 'opp_r_de', status: 'new', buyer: { name: 'RealDE', company: 'DE Co', country: '德国', channel: 'RFQ' }, rawText: 'real de', quote: { qty: 10 } });
    addOpp(app, { id: 'opp_d_es', status: 'new', demo: true, buyer: { name: 'DemoES', company: 'ES Co', country: '西班牙', channel: 'RFQ' }, rawText: 'demo es', quote: { qty: 20 } });
  }
  var appR = makeApp(); seedTwo(appR); appR.goto('#/opps');
  var htmlR = appR.view();
  ok('8a. 真实视图汇总/列表含德国不含西班牙演示', htmlR.indexOf('德国') >= 0 && htmlR.indexOf('西班牙') < 0);
  var appD = makeApp({ ic_data_view: 'demo' }); seedTwo(appD); appD.goto('#/opps');
  if (appD.g.P0Ui && appD.g.P0Ui.enhance) { try { appD.g.P0Ui.enhance(); } catch (e) { /* 沙箱无 fetch，paint 已在抛错前完成 */ } }
  var htmlD = appD.view();
  ok('8b. 演示视图含西班牙演示不含德国真实', htmlD.indexOf('西班牙') >= 0 && htmlD.indexOf('德国') < 0);
  ok('7. 演示视图今日行动区带演示标注', htmlD.indexOf('今日销售行动（演示）') >= 0);
})();

/* C3. 复盘丢单隔离 + 空状态 + 买家往来 */
(function () {
  var app = makeApp();
  addOpp(app, { id: 'opp_r_lost', status: 'lost', buyer: { name: 'RealLostZZ', company: 'RL Co', country: '德国', channel: 'RFQ' }, rawText: 'real lost', quote: { qty: 5 }, deal: { reason: '价格' } });
  addOpp(app, { id: 'opp_d_lost', status: 'lost', demo: true, buyer: { name: 'DemoLostZZ', company: 'DL Co', country: '法国', channel: 'RFQ' }, rawText: 'demo lost', quote: { qty: 5 }, deal: { reason: '价格' } });
  app.goto('#/analytics');
  var html = app.view();
  ok('9. 演示丢单不进真实复盘（真实丢单在、演示丢单不在）', html.indexOf('RealLostZZ') >= 0 && html.indexOf('DemoLostZZ') < 0);

  var app2 = makeApp();
  addOpp(app2, { id: 'opp_only_demo', status: 'new', demo: true, buyer: { name: 'OnlyDemo', company: 'OD Co', country: '法国', channel: 'RFQ' }, rawText: 'only demo', quote: { qty: 1 } });
  app2.goto('#/opps');
  ok('10a. 只有演示数据时真实视图显示空状态', app2.view().indexOf('还没有商机') >= 0);

  var app3 = makeApp();
  addOpp(app3, { id: 'opp_r_same', status: 'new', buyer: { name: 'Buyer One', company: 'SameCo', country: '德国', channel: 'RFQ' }, rawText: 'real same', quote: { qty: 11 } });
  addOpp(app3, { id: 'opp_d_same', status: 'won', demo: true, buyer: { name: 'Buyer One', company: 'SameCo', country: '德国', channel: 'RFQ' }, rawText: 'demo same', quote: { qty: 777 } });
  app3.goto('#/opp/opp_r_same');
  ok('10b. 同名买家往来不跨隔离聚合（真实商机显示第一次来）', app3.view().indexOf('第一次来') >= 0);
})();

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
