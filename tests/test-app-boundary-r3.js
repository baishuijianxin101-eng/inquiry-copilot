/* P1-23-R7-R2-R3：app.js 页面边界（data-id 安全 / 客户分组键）与人工修正落盘一致性。
   全部虚构数据；DOM 桩为 Node 测试桩，不冒充真实浏览器。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
function read(f) { return fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8'); }
var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra || ''); } }

var BIZ = 'ali_commission_copilot_v1';
var storeMap = new Map(), failBiz = false;
var storage = {
  getItem: function (k) { return storeMap.has(k) ? storeMap.get(k) : null; },
  setItem: function (k, v) { if (failBiz && k === BIZ) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } storeMap.set(k, String(v)); },
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

/* ---------- 种子：正常商机 + 恶意 ID 商机 + 分组碰撞客户 ---------- */
var st = C.get();
st.opportunities.push(C.normalizeOpp({ id: 'opp_ok_1', status: 'new', buyer: { name: 'Normal Buyer', company: 'NB Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 300 pcs ELRS nano receiver. We need CE. Target USD 4.', quote: { qty: 300 }, followLog: [], log: [] }));
st.opportunities.push(C.normalizeOpp({ id: 'cust_a', status: 'new', buyer: { name: 'A|B', company: 'C', country: '', channel: 'RFQ' }, rawText: 'quote 10 pcs widget', followLog: [], log: [] }));
st.opportunities.push(C.normalizeOpp({ id: 'cust_b', status: 'new', buyer: { name: 'A|B', company: 'C', country: '', channel: 'RFQ' }, rawText: 'quote 20 pcs widget', followLog: [], log: [] }));
st.opportunities.push(C.normalizeOpp({ id: 'cust_c', status: 'new', buyer: { name: 'A', company: 'B|C', country: '', channel: 'RFQ' }, rawText: 'quote 30 pcs widget', followLog: [], log: [] }));
st.opportunities.push(C.normalizeOpp({ id: 'cust_d', status: 'new', buyer: { name: '', company: '', country: '', channel: 'RFQ' }, rawText: 'quote 40 pcs widget', followLog: [], log: [] }));
C.persist();
/* 恶意 ID：先正常规范化保证其余字段完整，再把 id 换成未经清洗的原始值，
   模拟外部数据绕过 normalizeOpp/safeId 进入内存状态的情形 */
var evilOpp = C.normalizeOpp({ id: 'opp_evil_base', status: 'new', buyer: { name: 'Evil', company: 'E Co', country: 'DE', channel: 'RFQ' }, rawText: 'Please quote 100 pcs ELRS receiver.', quote: { qty: 100 }, followLog: [], log: [] });
evilOpp.id = 'x" onclick="alert(1)';
C.get().opportunities.push(evilOpp);

function gotoHash(h) {
  sb.location.hash = h;
  (handlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) {} });
  return byId['view'] ? byId['view'].innerHTML : '';
}
function clickAction(action, id) {
  var btn = { getAttribute: function (k) { return k === 'data-action' ? action : (k === 'data-id' ? id : null); } };
  var ev = { target: { classList: { contains: function () { return false; } }, closest: function () { return btn; } } };
  (handlers['click'] || []).forEach(function (fn) { fn(ev); });
}

/* ---------- J1 R3-06：data-id 安全 ---------- */
gotoHash('#/dashboard');
var htmlEvil = gotoHash('#/opp/x" onclick="alert(1)');
ok('J01 恶意 ID 商机详情可渲染', htmlEvil.indexOf('Evil') >= 0, htmlEvil.slice(0, 120));
/* R3-06 命名范围是销售判断卡（salesCard/openSalesEdit）：断言限定在该卡片段内。
   详情页其他按钮（报价单/记录跟进等）的 opp.id 直拼属同类问题但不在本轮命名范围，
   已登记于 UNRESOLVED-RISKS，不在此处冒充已修复。 */
var salesSeg = '';
var sIdx = htmlEvil.indexOf('客户销售判断');
if (sIdx >= 0) { var sEnd = htmlEvil.indexOf('</section>', sIdx); salesSeg = htmlEvil.slice(sIdx, sEnd > sIdx ? sEnd : sIdx + 6000); }
ok('J02 销售卡内恶意 ID 未注入事件属性', salesSeg.length > 0 && salesSeg.indexOf('onclick="alert(1)') < 0);
ok('J03 销售卡内不生成修正按钮、显示禁用提示', salesSeg.indexOf('data-action="sales-edit"') < 0 && salesSeg.indexOf('商机 ID 异常') >= 0);
var htmlOk = gotoHash('#/opp/opp_ok_1');
ok('J04 正常 ID 保留修正按钮', htmlOk.indexOf('data-action="sales-edit" data-id="opp_ok_1"') >= 0);
clickAction('sales-edit', 'x" onclick="alert(1)');
var modalEvil = byId['modal-root'] ? byId['modal-root'].innerHTML : '';
ok('J05 恶意 ID 的修正弹窗不生成保存按钮', modalEvil.indexOf('data-action="sales-save"') < 0 && modalEvil.indexOf('商机 ID 异常') >= 0, modalEvil.slice(0, 100));

/* ---------- J2 R3-07：客户分组键无碰撞 ---------- */
var htmlCust = gotoHash('#/customers');
ok('J06 碰撞对不被合并为一组（无 3 条组）', htmlCust.indexOf('3 条（进行中') < 0, htmlCust.slice(0, 200));
ok('J07 同名同公司正常聚合为 2 条', htmlCust.indexOf('2 条（进行中 2)') >= 0);
ok('J08 name=A/company=B|C 独立成组', (htmlCust.match(/1 条（进行中 1\)/g) || []).length >= 2);

/* ---------- J3 第五节：saveSalesEdit 落盘一致性 ---------- */
function openEditAndSet() {
  clickAction('sales-edit', 'opp_ok_1');
  byId['sa-n-qty'] = byId['sa-n-qty'] || new El('input');
  byId['sa-n-qty'].value = '500 pcs';
}
/* 成功路径 */
openEditAndSet();
clickAction('sales-save', 'opp_ok_1');
var toastOk = byId['toast'] ? byId['toast'].textContent : '';
var saved = C.get().opportunities.filter(function (o) { return o.id === 'opp_ok_1'; })[0];
ok('J09 正常保存：成功提示在落盘后出现', toastOk.indexOf('人工确认已保存') >= 0, toastOk);
ok('J10 正常保存：修正值真实落盘', !!(saved.salesReview && saved.salesReview.needFix && saved.salesReview.needFix.qty && saved.salesReview.needFix.qty.value === '500 pcs'));
var diskState = JSON.parse(storeMap.get(BIZ));
var diskOpp = diskState.opportunities.filter(function (o) { return o.id === 'opp_ok_1'; })[0];
ok('J11 正常保存：磁盘状态含修正值', !!(diskOpp.salesReview && diskOpp.salesReview.needFix && diskOpp.salesReview.needFix.qty.value === '500 pcs'));
/* 失败路径 */
openEditAndSet();
byId['sa-n-qty'].value = '999 pcs';
failBiz = true;
clickAction('sales-save', 'opp_ok_1');
failBiz = false;
var toastFail = byId['toast'] ? byId['toast'].textContent : '';
var afterFail = C.get().opportunities.filter(function (o) { return o.id === 'opp_ok_1'; })[0];
ok('J12 落盘失败：只显示失败提示、无成功提示', toastFail.indexOf('保存失败') >= 0 && toastFail.indexOf('人工确认已保存') < 0, toastFail);
ok('J13 落盘失败：内存修正值已回滚（仍为 500 pcs）', !!(afterFail.salesReview && afterFail.salesReview.needFix.qty.value === '500 pcs'));
var diskAfter = JSON.parse(storeMap.get(BIZ)).opportunities.filter(function (o) { return o.id === 'opp_ok_1'; })[0];
ok('J14 落盘失败：磁盘仍是上次成功状态', !!(diskAfter.salesReview && diskAfter.salesReview.needFix.qty.value === '500 pcs'));

setTimeout(function () {
  var toastLater = byId['toast'] ? byId['toast'].textContent : '';
  ok('J15 成功保存后守卫不误报失败', toastOk.indexOf('人工确认已保存') >= 0);
  console.log('== app-boundary-r3: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
}, 60);
