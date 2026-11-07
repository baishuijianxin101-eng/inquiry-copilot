/* P1-PERF-FIX-01 专项 1+4a：defer 启动时序与 IdentityTxn fail-closed（桩）。
   模拟 defer 语义：readyState 恒为 'interactive'，按 index 文档顺序执行
   全部脚本，最后才派发 DOMContentLoaded。断言：boot 在 DCL 前不运行、
   DCL 后只运行一次、32 个脚本的全局全部就位、P0Ui 已注册、工作台已渲染；
   变体：缺失 identity-txn.js 时 boot 抛 fail-closed 启动错误且不渲染。
   桩不是浏览器；p0-ui 顺序与门禁的真实浏览器验证在专项 2/3。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8'); }
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function memStorage() {
  var m = {};
  return { _m: m, getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
}
function El(tag) {
  this.tagName = tag || 'div'; this.children = []; this.dataset = {}; this.style = {};
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } };
  this._html = ''; this.value = ''; this.checked = false; this.textContent = ''; this.hidden = false;
}
Object.defineProperty(El.prototype, 'innerHTML', { get: function () { return this._html; }, set: function (v) { this._html = String(v); } });
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.children[0] || null; } });
El.prototype.appendChild = function (c) { this.children.push(c); return c; };
El.prototype.insertBefore = function (c) { this.children.push(c); return c; };
El.prototype.removeChild = function (c) { return c; };
El.prototype.remove = function () {};
El.prototype.setAttribute = function () {}; El.prototype.getAttribute = function () { return null; };
El.prototype.addEventListener = function () {}; El.prototype.focus = function () {}; El.prototype.click = function () {};
El.prototype.querySelector = function () { return new El('div'); };
El.prototype.querySelectorAll = function () { return []; };

var SCRIPTS = ['boot-error.js', 'seed-state.js', 'core.js', 'pricing.js', 'pricing-unity.js', 'workflow.js', 'tr-endpoint.js', 'translate.js', 'judge.js', 'matching.js', 'smart-match.js', 'opp-score.js', 'reply-assistant.js', 'sales-analysis.js', 'followup.js', 'reply.js', 'importer.js', 'market-ref.js', 'price-candidates.js', 'p0-parse.js', 'p0-match.js', 'p0-quote.js', 'p0-cost.js', 'p0-cockpit.js', 'p0-api.js', 'decision-desk.js', 'identity.js', 'identity-migration.js', 'identity-txn.js', 'app.js', 'p0-ui.js', 'tr-panel.js'];
var GLOBALS = ['SEED_STATE', 'Core', 'Pricing', 'PricingUnity', 'Workflow', 'TR_ENDPOINT', 'Translate', 'Judge', 'Matching', 'SmartMatch', 'OppScore', 'ReplyAssistant', 'SalesAnalysis', 'FollowUp', 'Reply', 'Importer', 'MARKET_REF', 'PRICE_CANDIDATES', 'P0Parse', 'P0Match', 'P0Api', 'DecisionDesk', 'Identity', 'IdentityMigration', 'IdentityTxn', 'P0Ui'];

function buildSandbox(skipFile) {
  var store = memStorage();
  var byId = {};
  var docHandlers = {};
  var winHandlers = {};
  var doc = {
    readyState: 'interactive',
    getElementById: function (id) { if (!byId[id]) byId[id] = new El('div'); return byId[id]; },
    createElement: function (t) { return new El(t); },
    querySelector: function () { return new El('div'); },
    querySelectorAll: function () { return []; },
    addEventListener: function (ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn); },
    body: new El('body'), documentElement: new El('html')
  };
  var sb = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sb.window = sb; sb.localStorage = store; sb.document = doc;
  sb.location = { hash: '', href: 'http://local/', reload: function () {}, protocol: 'http:' };
  sb.navigator = { userAgent: 'node-test' };
  sb.addEventListener = function (ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); };
  sb.matchMedia = function () { return { matches: false, addEventListener: function () {} }; };
  sb.fetch = function () { return Promise.reject(new Error('offline')); };
  sb.history = { pushState: function () {}, replaceState: function () {} };
  sb.scrollTo = function () {}; sb.requestAnimationFrame = function () { return 0; };
  sb.alert = function () {}; sb.confirm = function () { return true; };
  sb.MutationObserver = function () {}; sb.MutationObserver.prototype.observe = function () {}; sb.MutationObserver.prototype.disconnect = function () {};
  vm.createContext(sb);
  var loadErr = null;
  SCRIPTS.forEach(function (f) {
    if (f === skipFile) return;
    try { vm.runInContext(read(f), sb, { filename: f }); }
    catch (e) { if (f !== 'p0-ui.js' && !loadErr) loadErr = f + ': ' + (e && e.message); }
  });
  return { sb: sb, byId: byId, docHandlers: docHandlers, winHandlers: winHandlers, loadErr: loadErr };
}

/* ---------- 专项 1：defer 时序 ---------- */
var env = buildSandbox(null);
ok('1.0 全部脚本在 interactive 时序下加载无误', !env.loadErr, env.loadErr || '');
ok('1.1 DCL 触发前 boot 未运行（无 hashchange 监听、无首屏渲染）',
  (env.winHandlers['hashchange'] || []).length === 0 && !(env.byId['view'] && env.byId['view'].innerHTML));
var dclErr = null;
(env.docHandlers['DOMContentLoaded'] || []).slice().forEach(function (fn) { try { fn(); } catch (e) { dclErr = e; } });
ok('1.2 DCL 派发后 boot 无异常完成', !dclErr, dclErr && dclErr.message);
ok('1.3 boot 只执行一次（hashchange 监听恰好注册 1 个）', (env.winHandlers['hashchange'] || []).length === 1, 'count=' + (env.winHandlers['hashchange'] || []).length);
var missing = GLOBALS.filter(function (g) { return typeof env.sb[g] === 'undefined'; });
ok('1.4 关键全局全部就位（' + GLOBALS.length + ' 项）', missing.length === 0, 'missing: ' + missing.join(','));
ok('1.5 P0Ui 已注册且 mount 可用', !!(env.sb.P0Ui && typeof env.sb.P0Ui.mount === 'function'));
ok('1.6 首屏已渲染（#view 非空）', !!(env.byId['view'] && env.byId['view'].innerHTML.length > 50), 'len=' + (env.byId['view'] ? env.byId['view'].innerHTML.length : -1));

/* ---------- 专项 4a：identity-txn 缺失 → fail-closed ---------- */
var env2 = buildSandbox('identity-txn.js');
ok('4a.0 缺 identity-txn 时其余脚本加载无误', !env2.loadErr, env2.loadErr || '');
ok('4a.1 IdentityTxn 确实缺失', typeof env2.sb.IdentityTxn === 'undefined');
var thrown = null;
(env2.docHandlers['DOMContentLoaded'] || []).slice().forEach(function (fn) { try { fn(); } catch (e) { thrown = e; } });
ok('4a.2 boot 抛出 fail-closed 启动错误', !!thrown && /identity-txn\.js/.test(thrown.message) && /恢复门禁无法执行/.test(thrown.message), thrown && thrown.message);
ok('4a.3 中止启动：首屏未渲染', !(env2.byId['view'] && env2.byId['view'].innerHTML), 'view len=' + (env2.byId['view'] ? env2.byId['view'].innerHTML.length : -1));

setTimeout(function () {
  console.log('---');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  console.log('== b1-defer-boot: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
}, 80);
