/* P1-23：全站框架骨架冒烟（DOM 桩级，非真实浏览器）。
   逐个路由独立启动应用，断言新页面渲染出预期标题、导航含八大模块入口、脚本零加载失败。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var srcs = [...html.matchAll(/<script[^>]* src="([^"]+)"/g)].map(function (m) { return m[1].split('?')[0]; });
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }
function El() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this._html = ''; this.files = [];
  this.parentNode = { removeChild: function () {}, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; } };
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }; }
El.prototype = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  appendChild: function (c) { this.children.push(c); return c; }, insertBefore: function (c) { this.children.push(c); return c; },
  get firstChild() { return this.children[0] || null; }, remove: function () {}, addEventListener: function () {}, removeEventListener: function () {},
  querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }, focus: function () {}, click: function () {} };
function boot(hash, store) {
  var els = new Map();
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
    createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
    addEventListener: function () {}, body: new El(), documentElement: new El() };
  var sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    Date: Date, Math: Math, JSON: JSON, Promise: Promise,
    localStorage: { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } },
    document: documentStub, location: { hash: hash, href: 'http://x/' }, navigator: { onLine: true },
    fetch: function () { return Promise.reject(new Error('no net')); }, URL: URL, Blob: function () {}, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    crypto: require('crypto').webcrypto, addEventListener: function () {}, removeEventListener: function () {},
    dispatchEvent: function () { return true; }, scrollTo: function () {}, scrollY: 0, innerWidth: 1280,
    history: { pushState: function () {}, replaceState: function () {} }, alert: function () {}, confirm: function () { return true; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  var fails = 0;
  srcs.forEach(function (s) { try { vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), sandbox, { filename: s }); } catch (e) { fails++; console.log('LOAD FAIL', s, e.message); } });
  return { sandbox: sandbox, document: documentStub, fails: fails };
}
(async function () {
  var store = new Map();
  var first = boot('#/dashboard', store);
  ok(first.fails === 0, 'F0 全部脚本加载无失败（' + srcs.length + ' 个）');
  await new Promise(function (r) { setTimeout(r, 200); });
  var routes = [
    ['#/customers', '客户中心', '尚无阿里买家稳定 ID'],
    ['#/analysis', '销售分析', '规则分析总览'],
    ['#/followups', '跟进管理', '跨询盘跟进清单'],
    ['#/sync', '数据同步与系统设置', '阿里官方接口尚未连接'],
    ['#/opps', '商机', null],
    ['#/catalog', '商品', null],
    ['#/analytics', '复盘', null],
    ['#/settings', '算价用的三个数', null]
  ];
  for (var i = 0; i < routes.length; i++) {
    var b = boot(routes[i][0], store);
    await new Promise(function (r) { setTimeout(r, 200); });
    var view = b.document.getElementById('view').innerHTML;
    ok(view.length > 200 && view.indexOf(routes[i][1]) >= 0, 'F' + (i + 1) + ' 路由 ' + routes[i][0] + ' 渲染含「' + routes[i][1] + '」');
    if (routes[i][2]) ok(view.indexOf(routes[i][2]) >= 0, 'F' + (i + 1) + 'b ' + routes[i][0] + ' 含状态说明「' + routes[i][2] + '」');
    var nav = b.document.getElementById('nav').innerHTML;
    if (i === 0) {
      ['工作台', '询盘中心', '客户中心', '销售分析', '商品与报价', '跟进管理', '经营分析', '同步与设置'].forEach(function (label, j) {
        ok(nav.indexOf(label) >= 0, 'N' + (j + 1) + ' 导航含「' + label + '」');
      });
    }
  }
  console.log('== site-framework: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
})();
