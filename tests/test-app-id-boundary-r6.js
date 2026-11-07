/* P1-23-R7-R2-R6 第六项：全站 ID 守卫补全（data-opp / data-prod）。
   在 R5 版整页桩基础上补：中央点击守卫对 data-opp、data-prod 的
   校验（此前只有 case 内部靠查无此人兜底）、三属性分别覆盖空值/
   缺失/非法/超长、非法动作逐项验证业务数据不变（不只看最后一条
   toast）、字符串 'null' 与空串与缺失的区分、合法路径不误伤。
   本文件是 DOM 桩测试，不冒充真实浏览器；真机未验证项见
   R6-FINAL-REPORT 的未验证清单。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
function read(f) { return fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8'); }
var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra || ''); } }

var storeMap = new Map();
var storage = {
  getItem: function (k) { return storeMap.has(k) ? storeMap.get(k) : null; },
  setItem: function (k, v) { storeMap.set(k, String(v)); },
  removeItem: function (k) { storeMap.delete(k); }
};
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
var byId = {}, handlers = {}, routeErrors = [];
var doc = {
  getElementById: function (id) { if (!byId[id]) byId[id] = new El('div'); return byId[id]; },
  createElement: function (t) { return new El(t); },
  querySelector: function () { return new El('div'); },
  querySelectorAll: function () { return []; },
  addEventListener: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
  body: new El('body'), documentElement: new El('html')
};
var sb = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sb.window = sb; sb.localStorage = storage; sb.document = doc;
sb.location = { hash: '#/dashboard', href: 'http://local/', reload: function () {} };
sb.navigator = { userAgent: 'node-test' };
sb.addEventListener = function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); };
sb.matchMedia = function () { return { matches: false, addEventListener: function () {} }; };
sb.fetch = function () { return Promise.reject(new Error('offline')); };
sb.history = { pushState: function () {}, replaceState: function () {} };
sb.scrollTo = function () {}; sb.requestAnimationFrame = function () { return 0; };
sb.alert = function () {}; sb.confirm = function () { return true; };
vm.createContext(sb);
['seed-state.js', 'core.js', 'pricing.js', 'pricing-unity.js', 'workflow.js', 'tr-endpoint.js', 'translate.js', 'judge.js', 'matching.js', 'smart-match.js', 'opp-score.js', 'reply-assistant.js', 'sales-analysis.js', 'followup.js', 'reply.js', 'importer.js', 'market-ref.js', 'price-candidates.js', 'p0-parse.js', 'p0-match.js', 'p0-quote.js', 'p0-cost.js', 'p0-cockpit.js', 'p0-api.js', 'decision-desk.js', 'identity.js', 'identity-migration.js', 'identity-txn.js', 'app.js', 'p0-ui.js'].forEach(function (f) {
  try { vm.runInContext(read(f), sb, { filename: f }); }
  catch (e) { if (f !== 'p0-ui.js') ok('核心脚本加载 ' + f, false, String(e && e.message || e)); }
});
var C = sb.Core;
var EVIL = 'x" onclick="alert(1)';
var st = C.get();
st.opportunities.push(C.normalizeOpp({ id: 'opp_ok_r6', status: 'new', buyer: { name: 'Normal Buyer', company: 'NB Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 300 pcs ELRS nano receiver. We need CE. Target USD 4.', quote: { qty: 300 }, followLog: [], log: [] }));
st.products.push(C.normalizeProduct({ id: 'p_ok_r6', title: 'Good Widget', model: 'GW-1', priceUsd: 10, moq: 1 }));
st.products.push(C.normalizeProduct({ id: 'p_second_r6', title: 'Second Widget', model: 'SW-1', priceUsd: 12, moq: 1 }));
st.orders.push({ id: 'ord_ok_r6', oppId: 'opp_ok_r6', buyerName: 'Normal Buyer', amountCents: 100, currency: 'USD', status: 'paid', createdAt: '2026-11-06' });
C.persist();

function gotoHash(h) {
  sb.location.hash = h;
  (handlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) { routeErrors.push(h + ': ' + String(e && e.message || e)); } });
  return byId['view'] ? byId['view'].innerHTML : '';
}
/* attrs: {id, rid, opp, prod} 任一键缺失 = 属性不存在（getAttribute 返回 null） */
function clickAttrs(action, attrs) {
  var btn = { getAttribute: function (k) {
    if (k === 'data-action') return action;
    if (k === 'data-id') return ('id' in attrs) ? attrs.id : null;
    if (k === 'data-rid') return ('rid' in attrs) ? attrs.rid : null;
    if (k === 'data-opp') return ('opp' in attrs) ? attrs.opp : null;
    if (k === 'data-prod') return ('prod' in attrs) ? attrs.prod : null;
    return null;
  } };
  var ev = { target: { classList: { contains: function () { return false; } }, closest: function () { return btn; } } };
  (handlers['click'] || []).forEach(function (fn) { fn(ev); });
}
function toast() { return (byId['toast'] && byId['toast'].textContent) || ''; }
function setToast(v) { byId['toast'] = byId['toast'] || new El('div'); byId['toast'].textContent = v; }
function stateJson() { return JSON.stringify(C.get()); }
function oppOk() { return C.get().opportunities.filter(function (o) { return o.id === 'opp_ok_r6'; })[0]; }

gotoHash('#/dashboard');

/* W01 select-product：data-id 合法但 data-opp 非法 → 中央守卫拦截、
   商机选择不被改动（R6 前仅靠 case 内 oppById 查无此人静默返回） */
var beforeW1 = stateJson();
setToast('');
clickAttrs('select-product', { id: 'p_second_r6', opp: EVIL });
ok('W01 data-opp 非法被中央守卫拦截且数据不变', toast().indexOf('ID 异常') >= 0 && stateJson() === beforeW1, toast());

/* W02 select-product 合法路径：data-id + data-opp 均合法 → 正常生效 */
setToast('');
clickAttrs('select-product', { id: 'p_second_r6', opp: 'opp_ok_r6' });
ok('W02 合法 select-product 生效（selectedProductId 已切换）', oppOk().selectedProductId === 'p_second_r6' && toast().indexOf('ID 异常') < 0, toast());

/* W03 data-opp 为空串（属性存在但被收口）→ 拦截 */
var beforeW3 = stateJson();
setToast('');
clickAttrs('select-product', { id: 'p_ok_r6', opp: '' });
ok('W03 data-opp 空串被拦截且数据不变', toast().indexOf('ID 异常') >= 0 && stateJson() === beforeW3, toast());

/* W04 data-prod 非法：按钮同时携带 data-prod 时同样受守卫
   （edit-product 本身不读 data-prod，但属性非法即拦截） */
var beforeW4 = stateJson();
setToast('');
clickAttrs('edit-product', { id: 'p_ok_r6', prod: EVIL });
ok('W04 data-prod 非法被中央守卫拦截且数据不变', toast().indexOf('ID 异常') >= 0 && stateJson() === beforeW4, toast());

/* W05 超长与边界长度：65 字符合法字符集但超长 → 拦截；
   64 字符合法 ID（不存在的实体）→ 守卫放行、case 查无此人静默返回 */
var longId = 'a'.repeat(65), edgeId = 'a'.repeat(64);
var beforeW5 = stateJson();
setToast('');
clickAttrs('select-product', { id: 'p_ok_r6', opp: longId });
ok('W05a data-opp 超长（65）被拦截且数据不变', toast().indexOf('ID 异常') >= 0 && stateJson() === beforeW5, toast());
setToast('');
clickAttrs('select-product', { id: 'p_ok_r6', opp: edgeId });
ok('W05b data-opp 64 字符合法格式不被守卫拦截（查无此人、无副作用）', toast().indexOf('ID 异常') < 0 && stateJson() === beforeW5, toast());

/* W06 字符串 'null' 与空串、缺失的区分：'null' 是格式合法的普通
   ID 字符串，守卫不拦截（查无此人静默返回）；空串才拦截 */
var beforeW6 = stateJson();
setToast('');
clickAttrs('open-opp', { id: 'null' });
ok('W06a data-id 为字符串 null 不被守卫误拦、无副作用', toast().indexOf('ID 异常') < 0 && stateJson() === beforeW6, toast());
setToast('');
clickAttrs('open-opp', { id: '' });
ok('W06b data-id 空串被拦截', toast().indexOf('ID 异常') >= 0 && stateJson() === beforeW6, toast());

/* W07 逐项验证：每个破坏性动作携带非法 data-opp 时，逐个点击、
   逐个断言 toast 与数据不变（不只检查最后一条） */
var actionsW7 = ['delete-opp', 'delete-order', 'refund-order', 'delete-product'];
var w7All = true, w7Detail = '';
actionsW7.forEach(function (act) {
  var before = stateJson();
  setToast('');
  clickAttrs(act, { id: 'ord_ok_r6', opp: EVIL });
  if (!(toast().indexOf('ID 异常') >= 0 && stateJson() === before)) { w7All = false; w7Detail += act + ' '; }
});
ok('W07 破坏性动作逐项被 data-opp 守卫拦截且数据逐项不变', w7All, w7Detail);

/* W08 data-opp/data-prod 缺失（属性不存在）→ 不拦截，合法动作照常
   （open-opp 只带 data-id 的常规按钮形态） */
setToast('');
clickAttrs('open-opp', { id: 'opp_ok_r6' });
ok('W08 无 data-opp/data-prod 属性时不误伤合法动作', toast().indexOf('ID 异常') < 0, toast());

/* W09 路由渲染无被吞异常 */
gotoHash('#/opps');
gotoHash('#/opp/opp_ok_r6');
gotoHash('#/catalog');
gotoHash('#/dashboard');
ok('W09 路由渲染无异常（未被测试桩静默吞掉）', routeErrors.length === 0, routeErrors.join(' | '));

console.log('== app-id-boundary-r6: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
