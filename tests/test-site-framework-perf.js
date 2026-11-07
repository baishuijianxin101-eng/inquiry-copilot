/* P1-23-R3：viewAnalysis 性能测量（Node + DOM 桩环境，非真实手机浏览器性能）。
   构造 100/500/1000 条虚构询盘，测 #/analysis 渲染耗时与 analyze 调用次数，
   并对照客户中心/跟进管理在 1000 条时的耗时。只测量、不断言性能达标。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var srcs = [...html.matchAll(/<script[^>]* src="([^"]+)"/g)].map(function (m) { return m[1].split('?')[0]; });
function El() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this._html = ''; this.files = []; this.textContent = '';
  this.parentNode = { removeChild: function () {}, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; } };
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }; }
El.prototype = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  appendChild: function (c) { this.children.push(c); return c; }, insertBefore: function (c) { this.children.push(c); return c; },
  get firstChild() { return this.children[0] || null; }, remove: function () {}, addEventListener: function () {}, removeEventListener: function () {},
  querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }, focus: function () {}, click: function () {} };
function boot(store) {
  var els = new Map(), winL = {};
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
    createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
    addEventListener: function () {}, body: new El(), documentElement: new El() };
  var sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    Date: Date, Math: Math, JSON: JSON, Promise: Promise,
    localStorage: { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } },
    document: documentStub, location: { hash: '#/dashboard', href: 'http://x/' }, navigator: { onLine: true },
    fetch: function () { return Promise.reject(new Error('no net')); }, URL: URL, Blob: function () {}, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    crypto: require('crypto').webcrypto, addEventListener: function (ev, fn) { (winL[ev] = winL[ev] || []).push(fn); }, removeEventListener: function () {},
    dispatchEvent: function () { return true; }, scrollTo: function () {}, scrollY: 0, innerWidth: 1280,
    history: { pushState: function () {}, replaceState: function () {} }, alert: function () {}, confirm: function () { return true; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  srcs.forEach(function (s) { vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), sandbox, { filename: s }); });
  return { sb: sandbox, doc: documentStub, goto: function (hash) { sandbox.location.hash = hash; (winL['hashchange'] || []).forEach(function (f) { f(); }); } };
}
var TEXT = 'Hi, we need 800 pcs of AeroLink XR4 Pro ELRS 2.4GHz receivers for our FPV racing drones. CE and FCC certification required. Please quote CIF Hamburg, Germany. Delivery within 25 days.';
(async function () {
  var fail = 0;
  for (const n of [100, 500, 1000]) {
    var store = new Map();
    var b = boot(store);
    await new Promise(function (r) { setTimeout(r, 100); });
    var C = b.sb.Core, opps = [];
    for (var i = 0; i < n; i++) opps.push(C.normalizeOpp({ id: 'opp_p' + i, status: 'new', createdAt: '2026-11-01', buyer: { name: 'Buyer' + (i % 50), company: 'Co' + (i % 50), country: 'Germany' }, rawText: TEXT, quote: {}, followLog: [{ at: '2026-11-02', note: 'called' }] }));
    var st = C.get(); st.opportunities = opps; st.products = []; C.persist();
    var calls = 0, orig = b.sb.SalesAnalysis.analyze;
    b.sb.SalesAnalysis.analyze = function (x) { calls++; return orig(x); };
    var t0 = Date.now(); b.goto('#/analysis'); var dt = Date.now() - t0;
    var len = b.doc.getElementById('view').innerHTML.length;
    console.log('PERF analysis n=' + n + ' render=' + dt + 'ms analyzeCalls=' + calls + ' htmlLen=' + len);
    if (!(len > 1000 && calls === n)) { fail++; console.log('FAIL perf-completeness n=' + n); }
    if (n === 1000) {
      t0 = Date.now(); b.goto('#/customers'); console.log('PERF customers n=1000 render=' + (Date.now() - t0) + 'ms');
      t0 = Date.now(); b.goto('#/followups'); console.log('PERF followups n=1000 render=' + (Date.now() - t0) + 'ms');
    }
  }
  console.log('== site-framework-perf: ' + (fail ? 'FAIL' : 'DONE') + ' (timings are Node stub measurements, not device performance) ==');
  process.exit(fail ? 1 : 0);
})();
