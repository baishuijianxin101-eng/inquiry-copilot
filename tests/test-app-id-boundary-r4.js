/* P1-23-R7-R2-R4 第七项：全站 ID 属性边界。
   恶意 ID 实体渲染商机详情 / 商品页 / 订单页时，整页 HTML 不得出现
   属性逃逸（不只销售卡片段）；正常 ID 的业务按钮保持可用；
   中央点击守卫拦截非法 ID 的动作分发。DOM 桩测试，不冒充真实浏览器。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
function read(f) { return fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8'); }
var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra || ''); } }

var BIZ = 'ali_commission_copilot_v1';
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
var byId = {}, handlers = {};
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
st.opportunities.push(C.normalizeOpp({ id: 'opp_ok_r4', status: 'new', buyer: { name: 'Normal Buyer', company: 'NB Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 300 pcs ELRS nano receiver. We need CE. Target USD 4.', quote: { qty: 300 }, followLog: [], log: [] }));
var evilOpp = C.normalizeOpp({ id: 'opp_evil_base', status: 'new', buyer: { name: 'Evil', company: 'E Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 100 pcs ELRS receiver.', quote: { qty: 100 }, followLog: [], log: [] });
evilOpp.id = EVIL;
st.opportunities.push(evilOpp);
var evilProd = C.normalizeProduct({ id: 'p_evil_base', title: 'Evil Widget', model: 'EW-1', priceUsd: 10, moq: 1 });
evilProd.id = EVIL;
st.products.push(evilProd);
st.products.push(C.normalizeProduct({ id: 'p_ok_r4', title: 'Good Widget', model: 'GW-1', priceUsd: 10, moq: 1 }));
var evilOrder = { id: EVIL, oppId: 'opp_ok_r4', buyerName: 'Evil', amountCents: 100, currency: 'USD', status: 'paid', createdAt: '2026-11-06' };
st.orders.push(evilOrder);
C.persist();

function gotoHash(h) {
  sb.location.hash = h;
  (handlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) {} });
  return byId['view'] ? byId['view'].innerHTML : '';
}
function clickAction(action, id, rid) {
  var btn = { getAttribute: function (k) { return k === 'data-action' ? action : (k === 'data-id' ? id : (k === 'data-rid' ? (rid || null) : null)); } };
  var ev = { target: { classList: { contains: function () { return false; } }, closest: function () { return btn; } } };
  (handlers['click'] || []).forEach(function (fn) { fn(ev); });
}

/* 商机详情整页（不只销售卡片段） */
gotoHash('#/dashboard');
var htmlEvil = gotoHash('#/opp/' + EVIL);
ok('K01 恶意 ID 详情可渲染', htmlEvil.indexOf('Evil') >= 0);
ok('K02 整页无 alert(1) 属性逃逸', htmlEvil.indexOf('alert(1)') < 0, htmlEvil.slice(htmlEvil.indexOf('alert'), htmlEvil.indexOf('alert') + 60));
ok('K03 整页无未转义的恶意 ID 原文进入属性', htmlEvil.indexOf('data-id="x"') < 0 && htmlEvil.indexOf('data-opp="x"') < 0);
/* 正常商机详情：关键入口保持可用且带正确 ID */
var htmlOk = gotoHash('#/opp/opp_ok_r4');
ok('K04 正常详情保留报价单入口', htmlOk.indexOf('data-action="print-quote" data-id="opp_ok_r4"') >= 0);
ok('K05 正常详情保留记录跟进入口', htmlOk.indexOf('data-action="open-follow" data-id="opp_ok_r4"') >= 0);
ok('K06 正常详情保留删除入口', htmlOk.indexOf('data-action="delete-opp" data-id="opp_ok_r4"') >= 0);
ok('K07 正常详情报价字段 data-opp 正确', htmlOk.indexOf('data-opp="opp_ok_r4" data-field="qty"') >= 0);
/* 商品页（#/catalog）/ 订单区（#/analytics 经营分析） */
var htmlProd = gotoHash('#/catalog');
ok('K08 商品页无属性逃逸', htmlProd.indexOf('alert(1)') < 0);
ok('K09 商品页正常商品编辑入口保留', htmlProd.indexOf('data-action="edit-product" data-id="p_ok_r4"') >= 0, htmlProd.slice(0, 200));
var htmlOrders = gotoHash('#/analytics');
ok('K10 订单区无属性逃逸', htmlOrders.indexOf('alert(1)') < 0);
/* 商机列表页 */
var htmlList = gotoHash('#/opps');
ok('K11 商机列表页无属性逃逸', htmlList.indexOf('alert(1)') < 0);
ok('K12 商机列表正常打开入口保留', htmlList.indexOf('data-id="opp_ok_r4"') >= 0);
/* 中央守卫：非法 ID 的动作被拦截并提示 */
byId['toast'] = byId['toast'] || new El('div'); byId['toast'].textContent = '';
clickAction('print-quote', EVIL);
ok('K13 中央守卫拦截非法 ID 动作并提示', (byId['toast'].textContent || '').indexOf('ID 异常') >= 0, byId['toast'].textContent);
byId['toast'].textContent = '';
clickAction('follow-del', 'opp_ok_r4', EVIL);
ok('K14 中央守卫拦截非法 data-rid', (byId['toast'].textContent || '').indexOf('ID 异常') >= 0);
/* 正常点击不被守卫误拦（open-opp 跳转） */
clickAction('open-opp', 'opp_ok_r4');
ok('K15 正常 ID 动作正常分发（跳转详情）', sb.location.hash === '#/opp/opp_ok_r4', sb.location.hash);

console.log('== app-id-boundary-r4: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
