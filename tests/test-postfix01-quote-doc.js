/* P1-POST-RELEASE-FIX-01 专项 B：无有效报价时 QUOTATION 报价单不得出现金额。
   手法与 test-fix-batch2 一致（Core 造状态 + DOM 桩 + 真实动作分发）：
   走 print-quote 入口捕获新窗口写出的报价单文档，覆盖缺成本/成本为零/
   低于保本/低于登记底价/等于底价/高于底线六种状态与两种数量总额，
   并核对详情页报价单标签的预览口径一致、全程不改 quote。
   桩不是浏览器，真实浏览器验证另行执行。全部虚构数据。 */
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

/* ---------- 造状态（Core 沙箱） ---------- */
var seedStore = memStorage();
var sbSeed = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sbSeed.window = sbSeed; sbSeed.localStorage = seedStore;
vm.createContext(sbSeed);
vm.runInContext(read('core.js'), sbSeed, { filename: 'core.js' });
var CS = sbSeed.Core;
var st = CS.get();
function prod(id, name, model, o) {
  st.products.push(CS.normalizeProduct(Object.assign({ id: id, name: name, model: model, moq: 1, priceTiers: [{ minQty: 1, priceUsd: o.priceUsd || 0 }] }, o)));
}
prod('pq_nc', 'Doc Alpha', 'DA-1', { priceUsd: 20, priceFloorUsd: 0 });                          // 缺成本
prod('pq_zc', 'Doc Beta', 'DB-2', { priceUsd: 20, priceFloorUsd: 0, costRmb: 0 });              // 成本为零
prod('pq_be', 'Doc Gamma', 'DG-3', { priceUsd: 20, priceFloorUsd: 0, costRmb: 50 });            // 保本≈10.80
prod('pq_fl', 'Doc Delta', 'DD-4', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50 });           // 登记底价 12
prod('pq_at', 'Doc Epsilon', 'DE-5', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50 });         // 等于底价用
prod('pq_ab', 'Doc Zeta', 'DZ-6', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50 });            // 高于底线用
function mkOpp(id, pid, unit, qty, raw) {
  return CS.normalizeOpp({ id: id, status: 'new', selectedProductId: pid, buyer: { name: 'Fixture Buyer', company: 'Fix Co', country: '德国', channel: 'RFQ' }, rawText: raw, quote: { productId: pid, qty: qty, unitPriceUsd: unit, autoPrice: false }, followLog: [], log: [] });
}
st.opportunities.push(mkOpp('oq_nc', 'pq_nc', 0, 100, 'Please quote 100 pcs of Doc Alpha DA-1 for resale.'));
st.opportunities.push(mkOpp('oq_zc', 'pq_zc', 0, 100, 'Please quote 100 pcs of Doc Beta DB-2 for resale.'));
st.opportunities.push(mkOpp('oq_be', 'pq_be', 5, 100, 'Please quote 100 pcs of Doc Gamma DG-3 for resale.'));
st.opportunities.push(mkOpp('oq_fl', 'pq_fl', 11, 100, 'Please quote 100 pcs of Doc Delta DD-4 for resale.'));
st.opportunities.push(mkOpp('oq_at', 'pq_at', 12, 100, 'Please quote 100 pcs of Doc Epsilon DE-5 for resale.'));
st.opportunities.push(mkOpp('oq_ab', 'pq_ab', 15, 300, 'Please quote 300 pcs of Doc Zeta DZ-6 for resale.'));
CS.persist();
var savedState = seedStore._m['ali_commission_copilot_v1'];

/* ---------- 应用沙箱 ---------- */
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

var store2 = memStorage();
store2.setItem('ali_commission_copilot_v1', savedState);
var byId = {};
var docHandlers = {};
var winHandlers = {};
var doc = {
  readyState: 'complete',
  getElementById: function (id) { if (!byId[id]) byId[id] = new El('div'); return byId[id]; },
  createElement: function (t) { return new El(t); },
  querySelector: function () { return new El('div'); },
  querySelectorAll: function () { return []; },
  addEventListener: function (ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn); },
  body: new El('body'), documentElement: new El('html')
};
var sb2 = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sb2.window = sb2; sb2.localStorage = store2; sb2.document = doc;
sb2.location = { hash: '#/dashboard', href: 'http://local/', reload: function () {} };
sb2.navigator = { userAgent: 'node-test' };
sb2.addEventListener = function (ev, fn) { (winHandlers[ev] = winHandlers[ev] || []).push(fn); };
sb2.matchMedia = function () { return { matches: false, addEventListener: function () {} }; };
sb2.fetch = function () { return Promise.reject(new Error('offline')); };
sb2.history = { pushState: function () {}, replaceState: function () {} };
sb2.scrollTo = function () {}; sb2.requestAnimationFrame = function () { return 0; };
sb2.alert = function () {}; sb2.confirm = function () { return true; };
var capturedDoc = null;
sb2.open = function () {
  return { opener: {}, print: function () {}, document: { open: function () {}, write: function (s) { capturedDoc = String(s); }, close: function () {} } };
};
vm.createContext(sb2);
['seed-state.js', 'core.js', 'pricing.js', 'pricing-unity.js', 'workflow.js', 'tr-endpoint.js', 'translate.js', 'judge.js', 'matching.js', 'smart-match.js', 'opp-score.js', 'reply-assistant.js', 'followup.js', 'reply.js', 'importer.js', 'market-ref.js', 'price-candidates.js', 'p0-parse.js', 'p0-match.js', 'p0-quote.js', 'p0-cost.js', 'p0-cockpit.js', 'p0-api.js', 'identity.js', 'identity-migration.js', 'identity-txn.js', 'app.js', 'p0-ui.js', 'tr-panel.js'].forEach(function (f) {
  try { vm.runInContext(read(f), sb2, { filename: f }); }
  catch (e) { if (f !== 'p0-ui.js') ok('核心脚本加载 ' + f, false, String(e && e.message || e)); }
});
ok('B0 点击处理器已注册', (docHandlers['click'] || []).length > 0);

function clickAction(action, id, extra) {
  sb2.location.hash = '#/opp/' + id;
  (winHandlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) {} });
  var attrs = Object.assign({ 'data-action': action, 'data-id': id }, extra || {});
  var btn = {
    classList: { contains: function () { return false; } },
    closest: function () { return btn; },
    getAttribute: function (n) { return attrs[n] !== undefined ? attrs[n] : null; },
    dataset: { action: action, id: id, tab: (extra && extra['data-tab']) || undefined }
  };
  var ev = { target: btn, preventDefault: function () {}, stopPropagation: function () {} };
  (docHandlers['click'] || []).forEach(function (fn) { fn(ev); });
}
function getOpp(id) { return sb2.Core.get().opportunities.find(function (o) { return o.id === id; }); }
function quoteDocFor(id) {
  capturedDoc = null;
  clickAction('print-quote', id);
  return capturedDoc;
}
function expectTBD(label, id) {
  var q0 = JSON.stringify(getOpp(id).quote);
  var d = quoteDocFor(id);
  ok(label + '：报价单生成', typeof d === 'string' && d.length > 200, d === null ? 'null（可能被 quoteBlock 拦截）' : 'len=' + (d || '').length);
  if (typeof d !== 'string') return;
  ok(label + '：总额区显示「价格待定 (Price to be confirmed)」', d.indexOf('价格待定 (Price to be confirmed)') >= 0);
  ok(label + '：单价/金额列显示 To be confirmed', d.indexOf('To be confirmed') >= 0);
  ok(label + '：无 USD 0.00', d.indexOf('USD 0.00') < 0, d.slice(d.indexOf('TOTAL'), d.indexOf('TOTAL') + 90));
  ok(label + '：TOTAL 不带任何金额', !/TOTAL:\s*<span>USD/.test(d));
  ok(label + '：生成报价单不改 quote', JSON.stringify(getOpp(id).quote) === q0);
}
expectTBD('B1 缺成本', 'oq_nc');
expectTBD('B2 成本为零', 'oq_zc');
expectTBD('B3 低于保本（5 < 约10.80）', 'oq_be');
expectTBD('B4 低于登记底价（11 < 12，高于保本）', 'oq_fl');

var dAt = quoteDocFor('oq_at');
ok('B5 等于登记底价：单价 USD 12.00 照常', typeof dAt === 'string' && dAt.indexOf('USD 12.00') >= 0, (dAt || '').slice(0, 80));
ok('B6 数量 100：总额 USD 1,200.00 正确', typeof dAt === 'string' && /USD 1,?200\.00/.test(dAt));
ok('B7 有效报价不出现待定文案', typeof dAt === 'string' && dAt.indexOf('价格待定') < 0);

var dAb = quoteDocFor('oq_ab');
ok('B8 高于底线：单价 USD 15.00', typeof dAb === 'string' && dAb.indexOf('USD 15.00') >= 0);
ok('B9 数量 300：总额 USD 4,500.00 正确', typeof dAb === 'string' && /USD 4,?500\.00/.test(dAb));

/* 另一入口：详情页「报价单」标签预览，与 print-quote 共用 quoteDocument */
sb2.location.hash = '#/opp/oq_nc';
(winHandlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) {} });
clickAction('tab', 'oq_nc', { 'data-tab': 'quote' });
var viewHtml = byId['view'] ? byId['view'].innerHTML : '';
ok('B10 详情页报价单预览同样价格待定、无 USD 0.00',
  viewHtml.indexOf('价格待定') >= 0 && viewHtml.indexOf('USD 0.00') < 0,
  'view 前 120 字: ' + viewHtml.slice(0, 120));

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('== postfix01-quote-doc: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
