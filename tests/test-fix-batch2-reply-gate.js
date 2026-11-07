/* P1-FIX-02（批次二）回归：商机详情旧入口 generate-reply/gen-reply 的统一护栏闸
   运行：node tests/test-fix-batch2-reply-gate.js
   背景：该入口曾只查 quoteBlock（型号冲突），不查 PricingUnity——缺成本
   商机生成回复时，replyEn 无条件价格行产出「Unit price: USD 0.00」。
   修复后：不可报价一律改走回复助手无价谈判草稿（强制 price=null），
   草稿只写 drafts、永不写 quote 正式报价字段。全部虚构数据。
   手法与 test-zero-price.js B 组一致（DOM 桩 + 捕获 document 点击处理器
   并派发合成点击，走的是 app.js 真实动作分发链）。 */
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
prod('p_f2_nc', 'Fixture Alpha', 'FA-1', { priceUsd: 20, priceFloorUsd: 0 });                    // 缺成本（未登记）
prod('p_f2_zc', 'Fixture Beta', 'FB-2', { priceUsd: 20, priceFloorUsd: 0, costRmb: 0 });        // 成本明确为零
prod('p_f2_r0', 'Fixture Gamma', 'FG-3', { priceUsd: 0, priceFloorUsd: 0, priceTiers: [] }); // 商品无价无成本：对商品算推荐价为零
prod('p_f2_bp', 'Fixture Delta', 'FD-4', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50 });     // 低于保本用
prod('p_f2_ok', 'Fixture Epsilon', 'FE-5', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50 });   // 正常可报价用
prod('p_f2_cf', 'Fixture Zeta', 'FZ-6', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50, moq: 200 }); // 冲突用：MOQ 200
function mkOpp(id, pid, unit, raw, quoteExtra) {
  return CS.normalizeOpp({ id: id, status: 'new', selectedProductId: pid, buyer: { name: 'Fixture Buyer', company: 'Fix Co', country: '德国', channel: 'RFQ' }, rawText: raw, quote: Object.assign({ productId: pid, qty: 100, unitPriceUsd: unit, autoPrice: false }, quoteExtra || {}), followLog: [], log: [] });
}
st.opportunities.push(mkOpp('opp_f2_nc', 'p_f2_nc', 0, 'Please quote 100 pcs of Fixture Alpha FA-1 for resale.'));
st.opportunities.push(mkOpp('opp_f2_zc', 'p_f2_zc', 0, 'Please quote 100 pcs of Fixture Beta FB-2 for resale.'));
/* 推荐价为零：成本只登记在商机 quote 上——prepareOpp 按商品回填推荐价时
   商品无价无成本、推荐价算出 0 不回填；ctxFor 计入 quote 成本后 unit 仍 0 */
st.opportunities.push(mkOpp('opp_f2_r0', 'p_f2_r0', 0, 'Please quote 100 pcs of Fixture Gamma FG-3 for resale.', { costRmb: 50 }));
st.opportunities.push(mkOpp('opp_f2_bp', 'p_f2_bp', 5, 'Please quote 100 pcs of Fixture Delta FD-4 for resale.'));
st.opportunities.push(mkOpp('opp_f2_ok', 'p_f2_ok', 15, 'Please quote 100 pcs of Fixture Epsilon FE-5 for resale.'));
/* 冲突：数量 100 低于所选商品 MOQ 200（quoteBlock 的起订量硬冲突），价格本身有效 */
st.opportunities.push(mkOpp('opp_f2_cf', 'p_f2_cf', 15, 'Please quote 100 pcs of Fixture Zeta FZ-6 for resale.'));
CS.persist();
var savedState = seedStore._m['ali_commission_copilot_v1'];

/* ---------- 应用沙箱（DOM 桩 + 捕获点击处理器） ---------- */
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
vm.createContext(sb2);
['seed-state.js', 'core.js', 'pricing.js', 'pricing-unity.js', 'workflow.js', 'tr-endpoint.js', 'translate.js', 'judge.js', 'matching.js', 'smart-match.js', 'opp-score.js', 'reply-assistant.js', 'followup.js', 'reply.js', 'importer.js', 'market-ref.js', 'price-candidates.js', 'p0-parse.js', 'p0-match.js', 'p0-quote.js', 'p0-cost.js', 'p0-cockpit.js', 'p0-api.js', 'app.js', 'p0-ui.js', 'tr-panel.js'].forEach(function (f) {
  try { vm.runInContext(read(f), sb2, { filename: f }); }
  catch (e) { if (f !== 'p0-ui.js') ok('核心脚本加载 ' + f, false, String(e && e.message || e)); }
});
ok('0. 点击处理器已注册', (docHandlers['click'] || []).length > 0);

function clickAction(action, id, lang) {
  sb2.location.hash = '#/opp/' + id;
  var attrs = { 'data-action': action, 'data-id': id, 'data-lang': lang || null };
  var btn = {
    classList: { contains: function () { return false; } },
    closest: function () { return btn; },
    getAttribute: function (n) { return attrs[n] !== undefined ? attrs[n] : null; }
  };
  var ev = { target: btn, preventDefault: function () {}, stopPropagation: function () {} };
  (docHandlers['click'] || []).forEach(function (fn) { fn(ev); });
}
function getOpp(id) {
  return sb2.Core.get().opportunities.find(function (o) { return o.id === id; });
}
var PRICE_LINE = /\$0\.00|USD 0\.00|Unit price|Total amount/;

function noPriceCase(label, id, action) {
  var before = getOpp(id);
  var quoteBefore = JSON.stringify(before.quote);
  clickAction(action || 'gen-reply', id, 'en');
  var o = getOpp(id);
  var d = (o.drafts || {}).en || '';
  ok(label + '：生成了草稿', d.length > 40, 'len=' + d.length);
  ok(label + '：草稿无任何价格行（无 $0.00/Unit price/Total amount）', !PRICE_LINE.test(d), d.slice(0, 160));
  ok(label + '：正式报价字段未被写入', JSON.stringify(o.quote) === quoteBefore, JSON.stringify(o.quote));
  ok(label + '：商机状态未被标为已报价', o.status !== 'quoted', o.status);
}

/* 1-4. 不可报价四场景（英文） */
noPriceCase('缺成本', 'opp_f2_nc');
noPriceCase('成本为零', 'opp_f2_zc');
noPriceCase('推荐价为零', 'opp_f2_r0');
noPriceCase('低于保本价', 'opp_f2_bp');

/* 5. 中文无价草稿 */
clickAction('gen-reply', 'opp_f2_nc', 'zh');
var zh = (getOpp('opp_f2_nc').drafts || {}).zh || '';
ok('中文：生成了无价草稿', zh.length > 30, 'len=' + zh.length);
ok('中文：草稿不含 0.00 价格', zh.indexOf('0.00') < 0 && !PRICE_LINE.test(zh), zh.slice(0, 120));

/* 6. 正常可报价：走原 replyEn 带价路径（用 generate-reply 拼写覆盖别名） */
clickAction('generate-reply', 'opp_f2_ok', 'en');
var okDraft = (getOpp('opp_f2_ok').drafts || {}).en || '';
ok('正常可报价：草稿带护栏价 Unit price: USD 15.00', okDraft.indexOf('Unit price: USD 15.00') >= 0, okDraft.slice(0, 200));

/* 7. quoteBlock 冲突：价格有效也必须先拦截、不产草稿 */
byId['modal-root'] = new El('div');
clickAction('gen-reply', 'opp_f2_cf', 'en');
var cf = getOpp('opp_f2_cf');
ok('冲突：未生成草稿（quoteBlock 先行拦截）', !((cf.drafts || {}).en), JSON.stringify(cf.drafts || {}));
ok('冲突：弹出了拦截说明弹窗', (byId['modal-root'].innerHTML || '').length > 50);

/* 8. 持久化层复核：落盘状态里缺成本商机的 quote 仍为 0、无报价记录字段被改 */
var persisted = JSON.parse(store2._m['ali_commission_copilot_v1']);
var pnc = persisted.opportunities.find(function (o) { return o.id === 'opp_f2_nc'; });
ok('落盘：缺成本商机 unitPriceUsd 仍为 0', pnc.quote.unitPriceUsd === 0, JSON.stringify(pnc.quote));
ok('落盘：缺成本商机 drafts 已存无价草稿', !!((pnc.drafts || {}).en) && !PRICE_LINE.test(pnc.drafts.en));

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
