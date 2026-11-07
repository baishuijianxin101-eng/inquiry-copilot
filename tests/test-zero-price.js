/* 零价格误报修复测试（纯 Node，全部虚构数据）
   运行：node tests/test-zero-price.js
   背景：unit<=0 时 belowCost=false，定价提示曾落入「✓ 可以报」分支。
   修复：pricing.flags 新增 noPrice；app 定价提示在无有效报价时显示「无法报价」；
        统一口径判定（pricing-unity）对 unit<=0 本就拦截，本文件一并回归。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
function read(f) { return fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8'); }

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function memStorage() {
  var m = {};
  return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; }, _m: m };
}

/* ---------- A. 模块级：Pricing.evaluate + PricingUnity ---------- */
var sb = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sb.window = sb; sb.localStorage = memStorage();
vm.createContext(sb);
vm.runInContext(read('core.js'), sb, { filename: 'core.js' });
vm.runInContext(read('pricing.js'), sb, { filename: 'pricing.js' });
vm.runInContext(read('pricing-unity.js'), sb, { filename: 'pricing-unity.js' });
var C = sb.Core, P = sb.Pricing, PU = sb.PricingUnity;
var settings = C.get().settings;

/* 虚构商品：挂牌 $20、登记底价 $12；虚构进货价 ¥50 → 保本价约 $7.26（费率/汇率走默认设置） */
var prod = { id: 'p_fix', name: 'Fixture Widget', model: 'FW-1', priceUsd: 20, priceFloorUsd: 12, moq: 1, priceTiers: [{ minQty: 1, priceUsd: 20 }] };
function ev(unitPriceUsd, costRmb) {
  var o = { product: prod, qty: 100, settings: settings, unitCostRmb: costRmb };
  if (unitPriceUsd !== undefined) o.unitPriceUsd = unitPriceUsd;
  return P.evaluate(o);
}
function unity(r) { return PU.resolve({ evaluate: r, product: prod, nego: null }); }

/* 1. unit === 0 */
var r0 = ev(0, 50);
ok('unit=0：noPrice=true', r0.flags.noPrice === true);
ok('unit=0：belowCost=false（原误报来源）', r0.flags.belowCost === false);
ok('unit=0：canQuote=false', r0.flags.canQuote === false);
ok('unit=0：统一口径拦截（尚未形成有效报价）', unity(r0).quotable === false && unity(r0).blockReasons.join(' ').indexOf('尚未形成有效报价') >= 0, unity(r0).blockReasons.join('|'));

/* 2. unit < 0 */
var rNeg = ev(-5, 50);
ok('unit<0：noPrice=true 且 canQuote=false', rNeg.flags.noPrice === true && rNeg.flags.canQuote === false);
ok('unit<0：统一口径拦截', unity(rNeg).quotable === false);

/* 3. 缺少成本（有报价也不能算通过保本校验） */
var rNoCost = ev(15, null);
ok('缺成本：noCost=true 且 canQuote=false', rNoCost.flags.noCost === true && rNoCost.flags.canQuote === false);
ok('缺成本：统一口径拦截（缺少采购成本）', unity(rNoCost).quotable === false && unity(rNoCost).blockReasons.join(' ').indexOf('缺少采购成本') >= 0);

/* 4. 正常有效报价（高于保本与登记底价） */
var rOk = ev(15, 50);
ok('正常报价：noPrice=false、belowCost=false、canQuote=true', rOk.flags.noPrice === false && rOk.flags.belowCost === false && rOk.flags.canQuote === true);
ok('正常报价：统一口径可报价', unity(rOk).quotable === true, unity(rOk).blockReasons.join('|'));

/* 5. 低于保本价 */
var rBelow = ev(5, 50);
ok('低于保本：belowCost=true 且 canQuote=false', rBelow.flags.belowCost === true && rBelow.flags.canQuote === false);
ok('低于保本：统一口径拦截（低于保本价）', unity(rBelow).quotable === false && unity(rBelow).blockReasons.join(' ').indexOf('低于保本价') >= 0);

/* 6. 低于登记底价但高于保本价 */
var rBelowReg = ev(10, 50);
ok('低于登记底价：belowCost=false（未跌破保本）', rBelowReg.flags.belowCost === false, 'floor=' + rBelowReg.floorUsd);
ok('低于登记底价：统一口径拦截（登记底价/特批）', unity(rBelowReg).quotable === false && unity(rBelowReg).blockReasons.join(' ').indexOf('登记底价') >= 0, unity(rBelowReg).blockReasons.join('|'));

/* 7. 正常通过报价校验（建议价路径，未手填报价） */
var rAuto = ev(undefined, 50);
ok('未手填报价走建议价：unitPriceUsd>0 且 canQuote=true', rAuto.unitPriceUsd > 0 && rAuto.flags.canQuote === true && rAuto.flags.noPrice === false);

/* ---------- B. 页面级：商机详情定价提示文案 ---------- */
function El(tag) {
  this.tagName = tag || 'div'; this.children = []; this.dataset = {}; this.style = {};
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } };
  this._html = ''; this.value = ''; this.checked = false; this.textContent = '';
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

/* 先用 core 造一份带虚构成本商品与两条商机的状态并落盘 */
var seedStore = memStorage();
var sbSeed = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sbSeed.window = sbSeed; sbSeed.localStorage = seedStore;
vm.createContext(sbSeed);
vm.runInContext(read('core.js'), sbSeed, { filename: 'core.js' });
var CS = sbSeed.Core;
var st = CS.get();
st.products.push(CS.normalizeProduct({ id: 'p_fix_cost', name: 'Fixture Widget', model: 'FW-1', priceUsd: 20, priceFloorUsd: 12, moq: 1, costRmb: 50, priceTiers: [{ minQty: 1, priceUsd: 20 }] }));
/* 无挂牌价商品：有成本但算不出建议价，unit 只能为 0——原误报的真实触发路径 */
st.products.push(CS.normalizeProduct({ id: 'p_fix_noprice', name: 'Fixture NoPrice', model: 'FW-2', priceUsd: 0, priceFloorUsd: 0, moq: 1, costRmb: 50, priceTiers: [] }));
function mkOpp(id, unit, pid) {
  var isNp = pid === 'p_fix_noprice';
  return CS.normalizeOpp({ id: id, status: 'new', selectedProductId: pid || 'p_fix_cost', buyer: { name: 'Fixture Buyer', company: 'Fix Co', country: '德国', channel: 'RFQ' }, rawText: isNp ? 'Please quote 100 pcs of Fixture NoPrice FW-2.' : 'Please quote 100 pcs of Fixture Widget FW-1.', quote: { productId: pid || 'p_fix_cost', qty: 100, unitPriceUsd: unit, autoPrice: false }, followLog: [], log: [] });
}
st.opportunities.push(mkOpp('opp_zero_price', 0, 'p_fix_noprice'));
st.opportunities.push(mkOpp('opp_valid_price', 15));
/* R3-09：真正进入页面级「无法报价」分支的用例。商品本身无挂牌价、无成本，
   成本只登记在商机 quote 上：prepareOpp 的建议价回填因商品无价无成本而算出 0、
   不回填；ctxFor 评估时 quote.costRmb 使 hasCost=true（不落 noCost 分支），
   unitPriceUsd=0 → noPrice=true → 页面必须直接出现「无法报价」提示。 */
st.products.push(CS.normalizeProduct({ id: 'p_fix_manual', name: 'Fixture Manual', model: 'FW-3', priceUsd: 0, priceFloorUsd: 0, moq: 1, priceTiers: [] }));
st.opportunities.push(CS.normalizeOpp({ id: 'opp_no_price_page', status: 'new', selectedProductId: 'p_fix_manual', buyer: { name: 'Fixture Buyer', company: 'Fix Co', country: '德国', channel: 'RFQ' }, rawText: 'Please quote 100 pcs of Fixture Manual FW-3.', quote: { productId: 'p_fix_manual', qty: 100, unitPriceUsd: 0, autoPrice: false, costRmb: 50 }, followLog: [], log: [] }));
CS.persist();
var savedState = seedStore._m['ali_commission_copilot_v1'];

var store2 = memStorage();
store2.setItem('ali_commission_copilot_v1', savedState);
var byId = {};
var handlers = {};
var doc = {
  getElementById: function (id) { if (!byId[id]) byId[id] = new El('div'); return byId[id]; },
  createElement: function (t) { return new El(t); },
  querySelector: function () { return new El('div'); },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
  body: new El('body'), documentElement: new El('html')
};
var sb2 = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sb2.window = sb2; sb2.localStorage = store2; sb2.document = doc;
sb2.location = { hash: '#/dashboard', href: 'http://local/', reload: function () {} };
sb2.navigator = { userAgent: 'node-test' };
sb2.addEventListener = function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); };
sb2.matchMedia = function () { return { matches: false, addEventListener: function () {} }; };
sb2.fetch = function () { return Promise.reject(new Error('offline')); };
sb2.history = { pushState: function () {}, replaceState: function () {} };
sb2.scrollTo = function () {}; sb2.requestAnimationFrame = function () { return 0; };
sb2.alert = function () {}; sb2.confirm = function () { return true; };
vm.createContext(sb2);
['seed-state.js', 'core.js', 'pricing.js', 'pricing-unity.js', 'workflow.js', 'tr-endpoint.js', 'translate.js', 'judge.js', 'matching.js', 'smart-match.js', 'opp-score.js', 'reply-assistant.js', 'followup.js', 'reply.js', 'importer.js', 'market-ref.js', 'price-candidates.js', 'p0-parse.js', 'p0-match.js', 'p0-quote.js', 'p0-cost.js', 'p0-cockpit.js', 'p0-api.js', 'app.js', 'p0-ui.js', 'tr-panel.js'].forEach(function (f) {
  /* R3-09：核心脚本加载异常不得吞掉。只有 p0-ui.js 的已知非致命异常
     （fetch 兜底）允许单独忽略；其余任何脚本加载失败都使本测试失败。 */
  try { vm.runInContext(read(f), sb2, { filename: f }); }
  catch (e) { if (f !== 'p0-ui.js') ok('核心脚本加载 ' + f, false, String(e && e.message || e)); }
});
function gotoOpp(id) {
  sb2.location.hash = '#/opp/' + id;
  (handlers['hashchange'] || []).forEach(function (fn) { try { fn(); } catch (e) {} });
  return byId['view'] ? byId['view'].innerHTML : '';
}
var htmlZero = '';
var htmlValid = '';
var htmlNp = '';
try { htmlZero = gotoOpp('opp_zero_price'); } catch (e) { ok('零报价商机详情可渲染', false, String(e && e.message)); }
try { htmlValid = gotoOpp('opp_valid_price'); } catch (e) { ok('正常报价商机详情可渲染', false, String(e && e.message)); }
try { htmlNp = gotoOpp('opp_no_price_page'); } catch (e) { ok('无有效报价商机详情可渲染', false, String(e && e.message)); }

/* 说明：详情页渲染前 analyzeOpp 会把空报价自动回填建议价（既有行为），
   因此页面级只守两条底线：绝不把 $0.00 显示成可报；正常报价仍可报。
   「无法报价」分支本身由 A 组模块级用例（noPrice / 统一口径拦截）锁定。 */
ok('页面：零报价绝不以 $0.00 显示「可以报」', !(htmlZero.indexOf('可以报') >= 0 && htmlZero.indexOf('你报 $0.00') >= 0));
ok('页面：零报价商机详情可正常渲染', htmlZero.length > 1000);
ok('页面：正常报价仍显示「可以报」', htmlValid.indexOf('可以报') >= 0);
/* R3-09：页面级直接断言「无法报价」分支真实呈现（不是模块级冒充） */
ok('页面：无有效报价直接显示「无法报价」提示', htmlNp.indexOf('无法报价') >= 0 && htmlNp.indexOf('当前没有有效报价') >= 0);
ok('页面：无有效报价不落「先填采购成本」分支', htmlNp.indexOf('先填采购成本') < 0);
ok('页面：无有效报价不显示「可以报」', htmlNp.indexOf('可以报') < 0);

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
