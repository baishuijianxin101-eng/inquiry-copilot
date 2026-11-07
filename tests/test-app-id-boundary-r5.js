/* P1-23-R7-R2-R5 第五项：全站 ID 边界补强。
   在 R4 版整页桩（test-app-id-boundary-r4.js）基础上补：
   空 data-id、非法 data-opp/data-prod 的渲染形态、save-product
   新建/编辑分流、编辑商机空 ID 拒绝保存（R5 新增守卫）、非法动作
   不改变业务数据、路由异常不被静默吞掉（收集后断言为空）。
   本文件是 DOM 桩测试，不冒充真实浏览器；真机未验证项见
   R5-FINAL-REPORT 的未验证清单。 */
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
st.opportunities.push(C.normalizeOpp({ id: 'opp_ok_r5', status: 'new', buyer: { name: 'Normal Buyer', company: 'NB Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 300 pcs ELRS nano receiver. We need CE. Target USD 4.', quote: { qty: 300 }, followLog: [], log: [] }));
var evilOpp = C.normalizeOpp({ id: 'opp_evil_base', status: 'new', buyer: { name: 'Evil', company: 'E Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 100 pcs ELRS receiver.', quote: { qty: 100 }, followLog: [], log: [] });
evilOpp.id = EVIL;
st.opportunities.push(evilOpp);
var evilProd = C.normalizeProduct({ id: 'p_evil_base', title: 'Evil Widget', model: 'EW-1', priceUsd: 10, moq: 1 });
evilProd.id = EVIL;
st.products.push(evilProd);
st.products.push(C.normalizeProduct({ id: 'p_ok_r5', title: 'Good Widget', model: 'GW-1', priceUsd: 10, moq: 1 }));
st.orders.push({ id: EVIL, oppId: 'opp_ok_r5', buyerName: 'Evil', amountCents: 100, currency: 'USD', status: 'paid', createdAt: '2026-11-06' });
C.persist();

function gotoHash(h) {
  sb.location.hash = h;
  (handlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) { routeErrors.push(h + ': ' + String(e && e.message || e)); } });
  return byId['view'] ? byId['view'].innerHTML : '';
}
function clickAction(action, id, rid) {
  var btn = { getAttribute: function (k) { return k === 'data-action' ? action : (k === 'data-id' ? id : (k === 'data-rid' ? (rid === undefined ? null : rid) : null)); } };
  var ev = { target: { classList: { contains: function () { return false; } }, closest: function () { return btn; } } };
  (handlers['click'] || []).forEach(function (fn) { fn(ev); });
}
function toast() { return (byId['toast'] && byId['toast'].textContent) || ''; }
function setToast(v) { byId['toast'] = byId['toast'] || new El('div'); byId['toast'].textContent = v; }
function stateJson() { return JSON.stringify(C.get()); }
function modalHtml() {
  var out = '';
  Object.keys(byId).forEach(function (k) { if (byId[k]._html && byId[k]._html.indexOf('opp-id') >= 0) out += byId[k]._html; });
  return out;
}

gotoHash('#/dashboard');

/* Q01 空 data-id 的 open-opp：被中央守卫拦截、不改业务数据 */
var before1 = stateJson();
setToast('');
clickAction('open-opp', '');
ok('Q01 空 data-id 动作被守卫拦截且不改变业务数据', toast().indexOf('ID 异常') >= 0 && stateJson() === before1, toast());

/* Q02 非法 data-prod：商品页中恶意商品的编辑入口被收口为空，
   且 edit-product 空 ID 被中央守卫拦截（R5 新增守卫） */
var htmlProd = gotoHash('#/catalog');
ok('Q02a 商品页恶意商品编辑入口 data-id 被收口为空', htmlProd.indexOf('data-action="edit-product" data-id=""') >= 0, htmlProd.slice(0, 200));
setToast('');
var before2 = stateJson();
clickAction('edit-product', '');
ok('Q02b edit-product 空 ID 被拦截并提示、数据不变', toast().indexOf('ID 异常') >= 0 && stateJson() === before2, toast());

/* Q03 save-product 新建流程：空 ID 不被守卫拦截，分发到达 saveProduct
   （以其自身的必填校验提示为据），且不产生新商品 */
setToast('');
var prodCount = C.get().products.length;
clickAction('save-product', '');
ok('Q03 save-product 新建（空 ID）不被守卫拦截、到达业务校验', toast().indexOf('ID 异常') < 0 && toast().indexOf('商品名称必填') >= 0 && C.get().products.length === prodCount, toast());

/* Q03b 新建商品完整流程：从真实渲染的弹窗按钮读取 data-id 再点击
   （R4 版 safeActionId 返回 null 时该值是字面量 "null"，新建保存
   会误入编辑分支并抛错——本用例即针对该回归） */
clickAction('new-product', null);
var prodModalHtml = '';
Object.keys(byId).forEach(function (k) { if (byId[k]._html && byId[k]._html.indexOf('save-product') >= 0) prodModalHtml += byId[k]._html; });
var mBtn = prodModalHtml.match(/data-action="save-product" data-id="([^"]*)"/);
ok('Q03b-1 新建商品弹窗保存按钮 data-id 为空串（非字面量 null）', !!mBtn && mBtn[1] === '', mBtn && mBtn[1]);
byId['f-title'].value = 'Brand New Widget';
byId['f-priceUsd'].value = '9.5';
clickAction('save-product', mBtn ? mBtn[1] : '');
var created = C.get().products.filter(function (p) { return p.title === 'Brand New Widget'; });
ok('Q03b-2 经渲染按钮值保存可成功新建商品', created.length === 1 && C.get().products.length === prodCount + 1, String(C.get().products.length));
prodCount = C.get().products.length;

/* Q04 save-product 编辑流程：正常 ID 保存生效 */
byId['f-title'].value = 'Renamed Widget';
byId['f-priceUsd'].value = '12';
clickAction('save-product', 'p_ok_r5');
var pOk = C.get().products.filter(function (p) { return p.id === 'p_ok_r5'; })[0];
ok('Q04 save-product 编辑正常 ID 生效', !!pOk && pOk.title === 'Renamed Widget' && C.get().products.length === prodCount, pOk && pOk.title);

/* Q05 编辑商机：隐藏域/按钮 ID 被收口为空时拒绝保存（R5 5.6）；
   新建商机（无 data-id）路径不受影响 */
var htmlEvil = gotoHash('#/opp/' + EVIL);
ok('Q05a 恶意商机详情的编辑入口 data-id 被收口为空', htmlEvil.indexOf('data-action="edit-opp" data-id=""') >= 0);
setToast('');
var oppCount = C.get().opportunities.length;
clickAction('save-opp', '');
ok('Q05b save-opp 空 ID 被拦截、不生成重复商机', toast().indexOf('ID 异常') >= 0 && C.get().opportunities.length === oppCount, toast());
setToast('');
clickAction('save-opp', null);
ok('Q05c 新建商机（无 data-id）不被守卫拦截、到达原文校验', toast().indexOf('ID 异常') < 0 && toast().indexOf('请先粘贴询盘原文') >= 0, toast());
byId['opp-raw'].value = 'Please quote 50 pcs widget for DE.';
byId['opp-name'].value = 'New Buyer';
clickAction('save-opp', null);
ok('Q05d 新建商机路径仍可创建', C.get().opportunities.length === oppCount + 1, String(C.get().opportunities.length));

/* Q06 正常商机编辑弹窗：隐藏域 opp-id 携带正确 ID */
clickAction('edit-opp', 'opp_ok_r5');
ok('Q06 正常编辑弹窗隐藏域 opp-id 为真实 ID', modalHtml().indexOf('id="opp-id" value="opp_ok_r5"') >= 0, modalHtml().slice(0, 200));

/* Q07 非法 ID 的破坏性动作被拦截后，业务数据逐字不变 */
gotoHash('#/dashboard');
var before7 = stateJson();
setToast('');
clickAction('delete-opp', EVIL);
clickAction('delete-order', EVIL);
clickAction('refund-order', EVIL);
clickAction('delete-product', EVIL);
ok('Q07 非法 ID 删除/退款类动作全部拦截且数据不变', toast().indexOf('ID 异常') >= 0 && stateJson() === before7, toast());

/* Q08 主要路由渲染无被吞异常（错误收集后统一断言） */
gotoHash('#/opps');
gotoHash('#/opp/opp_ok_r5');
gotoHash('#/catalog');
gotoHash('#/analytics');
gotoHash('#/dashboard');
ok('Q08 路由渲染无异常（未被测试桩静默吞掉）', routeErrors.length === 0, routeErrors.join(' | '));

console.log('== app-id-boundary-r5: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
