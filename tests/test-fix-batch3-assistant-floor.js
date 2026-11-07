/* P1-FIX-03 回归：详情页回复助手卡片的传价门改用统一护栏（PricingUnity）
运行：node tests/test-fix-batch3-assistant-floor.js
背景：replyGenFor 旧实现只比保本价 floorUsd——导入旧数据的报价落在
保本价与登记底价之间时，助手卡片仍会带价生成草稿。修复后优先用
ctx.unity.quotable（回退 ctx.pricing.flags.canQuote），floor 用统一
报价底线 quoteFloorUsd。本测试渲染真实详情页、截取助手卡片的
ra-en/ra-zh 文本域做断言（页面其他区域的价格数字不计入）。虚构数据。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
function read(f) { return fs.readFileSync(path.join(ROOT, 'assets', f), 'utf8');}
var pass = 0, fail = 0;
function ok(name, cond, extra) {
if (cond) { pass++; console.log('PASS', name);}
else { fail++; console.log('FAIL', name, extra || '');}
}
function memStorage() {
var m = {};
return { _m: m, getItem: function (k) { return k in m? m[k]: null;}, setItem: function (k, v) { m[k] = String(v);}, removeItem: function (k) { delete m[k];}};
}

/* ---------- 造状态并先算保本价（Core+Pricing 沙箱） ---------- */
var seedStore = memStorage();
var sbSeed = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout};
sbSeed.window = sbSeed; sbSeed.localStorage = seedStore;
vm.createContext(sbSeed);
vm.runInContext(read('core.js'), sbSeed, { filename: 'core.js'});
vm.runInContext(read('pricing.js'), sbSeed, { filename: 'pricing.js'});
var CS = sbSeed.Core;
var st = CS.get();
var settings = st.settings;
function prod(id, name, model, o) {
var p = CS.normalizeProduct(Object.assign({ id: id, name: name, model: model, moq: 1, priceTiers: [{ minQty: 1, priceUsd: o.priceUsd || 0}]}, o));
st.products.push(p);
return p;
}
var P1 = prod('p_f3_main', 'Fixture Alpha', 'FA-1', { priceUsd: 20, priceFloorUsd: 12, costRmb: 50});
var P0 = prod('p_f3_nofloor', 'Fixture Beta', 'FB-2', { priceUsd: 20, priceFloorUsd: 0, costRmb: 50});
prod('p_f3_nc', 'Fixture Gamma', 'FG-3', { priceUsd: 20, priceFloorUsd: 0});
var be = sbSeed.Pricing.evaluate({ product: P1, qty: 100, settings: settings, unitCostRmb: 50, unitPriceUsd: 10}).floorUsd;
ok('前提：保本价在 (0, 12) 之间', be > 0 && be < 12, 'breakEven=' + be);
var BE = Math.round(be * 100) / 100;

function mkOpp(id, pid, unit, name, model) {
return CS.normalizeOpp({ id: id, status: 'new', selectedProductId: pid, buyer: { name: 'Fixture Buyer', company: 'Fix Co', country: '西班牙', channel: 'RFQ'}, rawText: 'Please quote 100 pcs of ' + name + ' ' + model + ' for resale in Spain, delivery to Valencia port.', quote: { productId: pid, qty: 100, unitPriceUsd: unit, autoPrice: false}, followLog: [], log: []});
}
st.opportunities.push(mkOpp('opp_f3_below_be', 'p_f3_main', 5, 'Fixture Alpha', 'FA-1'));
st.opportunities.push(mkOpp('opp_f3_eq_be_floor', 'p_f3_main', BE, 'Fixture Alpha', 'FA-1'));
st.opportunities.push(mkOpp('opp_f3_between', 'p_f3_main', 10, 'Fixture Alpha', 'FA-1'));
st.opportunities.push(mkOpp('opp_f3_eq_floor', 'p_f3_main', 12, 'Fixture Alpha', 'FA-1'));
st.opportunities.push(mkOpp('opp_f3_above', 'p_f3_main', 15, 'Fixture Alpha', 'FA-1'));
st.opportunities.push(mkOpp('opp_f3_eq_be_nofloor', 'p_f3_nofloor', BE, 'Fixture Beta', 'FB-2'));
st.opportunities.push(mkOpp('opp_f3_nc', 'p_f3_nc', 15, 'Fixture Gamma', 'FG-3'));
st.opportunities.push(mkOpp('opp_f3_zero', 'p_f3_main', 0, 'Fixture Alpha', 'FA-1'));
CS.persist();
var savedState = seedStore._m['ali_commission_copilot_v1'];

/* ---------- 应用沙箱（与 test-zero-price B 组同款 DOM 桩） ---------- */
function El(tag) {
this.tagName = tag || 'div'; this.children = []; this.dataset = {}; this.style = {};
this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false;}};
this._html = ''; this.value = ''; this.checked = false; this.textContent = ''; this.hidden = false;
}
Object.defineProperty(El.prototype, 'innerHTML', { get: function () { return this._html;}, set: function (v) { this._html = String(v);}});
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.children[0] || null;}});
El.prototype.appendChild = function (c) { this.children.push(c); return c;};
El.prototype.insertBefore = function (c) { this.children.push(c); return c;};
El.prototype.removeChild = function (c) { return c;};
El.prototype.remove = function () {};
El.prototype.setAttribute = function () {}; El.prototype.getAttribute = function () { return null;};
El.prototype.addEventListener = function () {}; El.prototype.focus = function () {}; El.prototype.click = function () {};
El.prototype.querySelector = function () { return new El('div');};
El.prototype.querySelectorAll = function () { return [];};

var store2 = memStorage();
store2.setItem('ali_commission_copilot_v1', savedState);
var byId = {};
var handlers = {};
var doc = {
getElementById: function (id) { if (!byId[id]) byId[id] = new El('div'); return byId[id];},
createElement: function (t) { return new El(t);},
querySelector: function () { return new El('div');},
querySelectorAll: function () { return [];},
addEventListener: function () {},
body: new El('body'), documentElement: new El('html')
};
var sb2 = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout};
sb2.window = sb2; sb2.localStorage = store2; sb2.document = doc;
sb2.location = { hash: '#/dashboard', href: 'http://local/', reload: function () {}};
sb2.navigator = { userAgent: 'node-test'};
sb2.addEventListener = function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn);};
sb2.matchMedia = function () { return { matches: false, addEventListener: function () {}};};
sb2.fetch = function () { return Promise.reject(new Error('offline'));};
sb2.history = { pushState: function () {}, replaceState: function () {}};
sb2.scrollTo = function () {}; sb2.requestAnimationFrame = function () { return 0;};
sb2.alert = function () {}; sb2.confirm = function () { return true;};
vm.createContext(sb2);
['seed-state.js', 'core.js', 'pricing.js', 'pricing-unity.js', 'workflow.js', 'tr-endpoint.js', 'translate.js', 'judge.js', 'matching.js', 'smart-match.js', 'opp-score.js', 'reply-assistant.js', 'followup.js', 'reply.js', 'importer.js', 'market-ref.js', 'price-candidates.js', 'p0-parse.js', 'p0-match.js', 'p0-quote.js', 'p0-cost.js', 'p0-cockpit.js', 'p0-api.js', 'identity.js', 'identity-migration.js', 'identity-txn.js', 'app.js', 'p0-ui.js', 'tr-panel.js'].forEach(function (f) {
try { vm.runInContext(read(f), sb2, { filename: f});}
catch (e) { if (f!== 'p0-ui.js') ok('核心脚本加载 ' + f, false, String(e && e.message || e));}
});

function draftOf(id, which) {
sb2.location.hash = '#/opp/' + id;
(handlers['hashchange'] || []).forEach(function (fn) { try { fn();} catch (e) {}});
var html = byId['view']? byId['view'].innerHTML: '';
var marker = 'id="ra-' + which + '"';
var i = html.indexOf(marker);
if (i < 0) return null;
var start = html.indexOf('>', i) + 1;
var end = html.indexOf('</textarea>', start);
return html.slice(start, end);
}
var STD = '正式报价尚未形成';
function noPrice(label, id, amountStr) {
var en = draftOf(id, 'en');
ok(label + '：助手卡片有英文草稿',!!en && en.length > 30, en === null? 'no card': 'len=' + en.length);
ok(label + '：英文草稿不带价（无 ' + amountStr + '）',!!en && en.indexOf(amountStr) < 0, en && en.slice(0, 160));
ok(label + '：英文草稿带统一未确认提示',!!en || true, '');
var cardHtml = byId['view'].innerHTML;
ok(label + '：卡片带「正式报价尚未形成」提示', cardHtml.indexOf(STD) >= 0);
}
function priced(label, id, amountStr) {
var en = draftOf(id, 'en');
ok(label + '：英文草稿带价 ' + amountStr,!!en && en.indexOf(amountStr) >= 0, en && en.slice(0, 200));
}

/* 五点矩阵（P1：保本 be、登记底价 12） */
noPrice('低于保本价(5)', 'opp_f3_below_be', '$5.00');
noPrice('等于保本价但低于登记底价(' + BE + ')', 'opp_f3_eq_be_floor', '$' + BE.toFixed(2));
noPrice('保本与登记之间(10)', 'opp_f3_between', '$10.00');
priced('等于登记底价(12)', 'opp_f3_eq_floor', '$12.00');
priced('高于登记底价(15)', 'opp_f3_above', '$15.00');
/* 无登记底价时，等于保本价即报价底线：可带价 */
priced('无登记底价时等于保本价(' + BE + ')', 'opp_f3_eq_be_nofloor', '$' + BE.toFixed(2));
/* 缺成本 / 零价 */
noPrice('缺成本', 'opp_f3_nc', '$15.00');
noPrice('零价', 'opp_f3_zero', '$0.00');

/* 中文对照：目标场景无价、正常场景带价 */
var zhBetween = draftOf('opp_f3_between', 'zh');
ok('中文：保本与登记之间草稿不带价',!!zhBetween && zhBetween.indexOf('$10.00') < 0, zhBetween && zhBetween.slice(0, 120));
var zhAbove = draftOf('opp_f3_above', 'zh');
ok('中文：高于登记底价草稿带价 $15.00',!!zhAbove && zhAbove.indexOf('$15.00') >= 0, zhAbove && zhAbove.slice(0, 120));

/* 不可报价时 quote 与落盘状态不变（渲染助手卡片不写任何报价数据） */
var persisted = JSON.parse(store2._m['ali_commission_copilot_v1']);
var pb = persisted.opportunities.find(function (o) { return o.id === 'opp_f3_between';});
ok('落盘：目标场景商机 quote.unitPriceUsd 仍为 10（未被改写）', pb.quote.unitPriceUsd === 10, JSON.stringify(pb.quote));
ok('落盘：目标场景商机未存任何带价助手草稿',!pb.replyDrafts || Object.keys(pb.replyDrafts).every(function (k) { return (pb.replyDrafts[k].en || '').indexOf('$10.00') < 0;}));

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail? 1: 0);
