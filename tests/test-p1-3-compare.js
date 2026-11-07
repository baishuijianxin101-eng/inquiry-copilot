/* P1-3B-1 专项：前二候选独立护栏与差异对比（纯 Node，全部虚构数据）
   黄金基线来自改前生产代码（基线 485aeaa6）在本文件同款夹具上的实测输出：
   S1 unity/readiness/草稿全文、S3 unity、S4 certGuard 均逐字嵌入断言。
   运行：node tests/test-p1-3-compare.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function makeWorld(viewPref) {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  var m = {};
  sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  if (viewPref) m['ic_data_view'] = viewPref;
  var viewEl = { innerHTML: '' };
  sandbox.document = { getElementById: function (id) { return id === 'view' ? viewEl : null; } };
  vm.createContext(sandbox);
  ['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
   'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
   'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  return { sandbox: sandbox, C: sandbox.Core, D: sandbox.DecisionDesk, store: m };
}
var SETTINGS = { fxRate: 7.1, sellerName: 'Test Seller', defaultIncoterm: 'FOB Shenzhen', defaultLeadTimeDays: 15, quoteValidDays: 30 };
function P(o) { return Object.assign({ category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o); }
var A = function (extra) { return P(Object.assign({ id: 'g_a', sku: 'G-A', title: 'ZX900 Widget Gadget Pro', titleEn: 'ZX900 Widget Gadget Pro', keywords: ['zx900', 'widget', 'gadget'], specs: 'ZX900', priceUsd: 99, priceFloorUsd: 90, costRmb: 555 }, extra || {})); };
var B = function (extra) { return P(Object.assign({ id: 'g_b', sku: 'G-B', title: 'ZX900 Widget Gadget Lite', titleEn: 'ZX900 Widget Gadget Lite', keywords: ['zx900', 'widget', 'gadget'], specs: 'ZX900', priceUsd: 89, priceFloorUsd: 80, costRmb: 500 }, extra || {})); };
var TEXT = 'Hello, we need 200 pcs ZX900 widget gadget for resale, please quote.';
var GOLD = {
  s1Unity: { listUsd: 99, recommendUsd: 78.2, breakEvenUsd: 78.17, businessFloorUsd: 90, quoteFloorUsd: 90, negoFloorUsd: 84.5, minMarginPct: 8, unitUsd: 99, qty: 200, feeRate: 0, noCost: false, anomaly: false, quotable: true, blockReasons: [], warnings: ['系统建议价低于商品登记底价，按建议价报需走特批'] },
  s1Readiness: { key: 'can-quote', label: '可以进入报价', why: '成本、保本价与底价校验通过（演示数据口径）' },
  s1Draft: 'Hi,\n\nThanks for your inquiry about the ZX900 widget gadget for resale in Germany — the closest model in our range is the ZX900 Widget Gadget Pro (G-A).\nSo I can quote accurately instead of guessing, could you confirm a few points?\n- Could you confirm the destination port or country?\n- Could you confirm your expected delivery time?\nOnce I have these, I will send you a firm quotation rather than a rough estimate.\n\nBest regards,\nTest Seller',
  s3Unity: { listUsd: 99, recommendUsd: 0, breakEvenUsd: 0, businessFloorUsd: 90, quoteFloorUsd: 90, negoFloorUsd: null, minMarginPct: null, unitUsd: 99, qty: 200, feeRate: 0, noCost: true, anomaly: false, quotable: false, blockReasons: ['缺少采购成本，算不出保本价'], warnings: [] },
  s4Guard: { type: 'uncovered', names: ['CE'], why: '客户要求认证 CE，首选商品未登记该认证（未核实），需人工核实后再报价' }
};

/* ---------- 1+2. 第一名黄金基线 ---------- */
(function () {
  var w = makeWorld();
  var r1 = w.D.analyze('Hello, we need 200 pcs ZX900 widget gadget for resale in Germany, please quote.', [A()], SETTINGS, null);
  ok('1a. S1 第一名 unity 全字段与改前黄金一致', eq(r1.unity, GOLD.s1Unity), JSON.stringify(r1.unity));
  ok('1b. S1 readiness 与黄金一致', eq(r1.readiness, GOLD.s1Readiness));
  ok('1c. S1 certGuard 为空与黄金一致', r1.certGuard === null);
  ok('2a. S1 回复草稿全文与改前逐字一致', !!r1.reply && r1.reply.en === GOLD.s1Draft);
  var r3 = w.D.analyze(TEXT, [A({ costRmb: undefined })], SETTINGS, null);
  delete r3.unity; /* 占位避免误用 */
  var r3b = w.D.analyze(TEXT, [P({ id: 'g_a', sku: 'G-A', title: 'ZX900 Widget Gadget Pro', titleEn: 'ZX900 Widget Gadget Pro', keywords: ['zx900', 'widget', 'gadget'], specs: 'ZX900', priceUsd: 99, priceFloorUsd: 90 })], SETTINGS, null);
  ok('1d. S3 缺成本 unity 与黄金一致', eq(r3b.unity, GOLD.s3Unity), JSON.stringify(r3b.unity));
  var r4 = w.D.analyze('Hello, we need 200 pcs ZX900 widget gadget with CE certificate required, please quote.', [A()], SETTINGS, null);
  ok('1e. S4 certGuard 与黄金一致', eq(r4.certGuard, GOLD.s4Guard), JSON.stringify(r4.certGuard));
  var r2 = w.D.analyze(TEXT, [A(), B()], SETTINGS, null);
  ok('2b. S2 歧义场景第一名 unity 仍与黄金一致', eq(r2.unity, GOLD.s1Unity));
  ok('2c. S2 readiness 仍为歧义需核实', r2.readiness.key === 'need-verify' && r2.ambiguous === true);
})();

/* ---------- 3. 第二名缺成本 ---------- */
(function () {
  var w = makeWorld();
  var bNoCost = B(); delete bNoCost.costRmb;
  var r = w.D.analyze(TEXT, [A(), bNoCost], SETTINGS, null);
  var g = r.candidates[1] && r.candidates[1].guardrail;
  ok('3a. 第二名拿到独立护栏且标缺成本', !!g && !!g.unity && g.unity.noCost === true && g.unity.quotable === false);
  ok('3b. 第一名护栏不受影响（仍可报价）', r.unity.quotable === true && eq(r.unity, GOLD.s1Unity));
  w.D._state.result = r; w.D._state.text = TEXT;
  var html = w.D.view();
  ok('3c. 对比区显示第二名缺成本原因', html.indexOf('前二候选对比') >= 0 && html.indexOf('缺少采购成本') >= 0);
})();

/* ---------- 4. 第二名认证未登记 ---------- */
(function () {
  var w = makeWorld();
  var text = 'Hello, we need 200 pcs ZX900 widget gadget with CE certificate required, please quote.';
  var r = w.D.analyze(text, [A({ certs: ['CE'] }), B({ certs: [] })], SETTINGS, null);
  var g = r.candidates[1] && r.candidates[1].guardrail;
  ok('4a. 第二名 certGuard 为未登记（uncovered）', !!g && !!g.certGuard && g.certGuard.type === 'uncovered');
  ok('4b. 第一名认证已覆盖（certGuard 为空）', r.certGuard === null);
  w.D._state.result = r; w.D._state.text = text;
  var html = w.D.view();
  ok('4c. 对比区第二名显示未核实', html.indexOf('未核实') >= 0 && html.indexOf('买家要求的认证已登记') >= 0);
})();

/* ---------- 5. 第二名护栏抛错隔离 ---------- */
(function () {
  var w = makeWorld();
  var origEval = w.sandbox.Pricing.evaluate;
  w.sandbox.Pricing.evaluate = function (opts) {
    if (opts && opts.product && opts.product.id === 'g_b') throw new Error('boom for B');
    return origEval(opts);
  };
  var r = w.D.analyze(TEXT, [A(), B()], SETTINGS, null);
  ok('5a. analyze 正常完成、第一名 unity 与黄金一致', !!r && eq(r.unity, GOLD.s1Unity));
  var g = r.candidates[1] && r.candidates[1].guardrail;
  ok('5b. 第二名护栏 unity 为空（未取得结果）', !!g && g.unity === null);
  w.D._state.result = r; w.D._state.text = TEXT;
  ok('5c. 对比区显示护栏未取得结果', w.D.view().indexOf('护栏未取得结果') >= 0);
})();

/* ---------- 6-9. 不凑数四情形 ---------- */
function noCompareCase(name, products, text) {
  var w = makeWorld();
  var r = w.D.analyze(text || TEXT, products, SETTINGS, null);
  w.D._state.result = r; w.D._state.text = text || TEXT;
  var html = w.D.view();
  ok(name, !r.noMatch && html.indexOf('暂无第二个可信候选') >= 0 && html.indexOf('第二候选') < 0,
    'cands=' + r.candidates.map(function (c) { return c.product.id + ':' + Math.round(c.score) + (c.keyConflict ? '!' : ''); }).join(','));
}
noCompareCase('6. 无第二名时不展示对比列', [A()]);
noCompareCase('7. 第二名分数不足（<40）不展示', [A(), P({ id: 'g_x', sku: 'G-X', title: 'Electric Kettle Steel', titleEn: 'Electric Kettle', keywords: ['kettle'], specs: '1.8L', priceUsd: 12, priceFloorUsd: 9, costRmb: 40 })]);
noCompareCase('8. 第二名关键冲突（型号不符）不展示', [A(), P({ id: 'g_y', sku: 'G-Y', title: 'AB123 Widget Gadget', titleEn: 'AB123 Widget Gadget', keywords: ['widget', 'gadget'], specs: 'AB123', priceUsd: 50, priceFloorUsd: 40, costRmb: 200 })]);
noCompareCase('9. 与第一名同 ID 不展示', [A(), A({ title: 'ZX900 Widget Gadget Pro Copy' })]);

/* ---------- 10. 同名不同 ID 正常比较 ---------- */
(function () {
  var w = makeWorld();
  var twin = B({ title: 'ZX900 Widget Gadget Pro', sku: 'G-B2' });
  var r = w.D.analyze(TEXT, [A(), twin], SETTINGS, null);
  var g = r.candidates[1] && r.candidates[1].guardrail;
  ok('10. 同名不同 ID/SKU 正常进入对比', !!g && !!g.unity && r.candidates[1].product.id === 'g_b');
})();

/* ---------- 11. 第二名残缺字段安全降级 ---------- */
(function () {
  var w = makeWorld();
  var bare = { id: 'g_bare', title: 'ZX900 Widget Gadget Bare', keywords: ['zx900', 'widget', 'gadget'] };
  var r = w.D.analyze(TEXT, [A(), bare], SETTINGS, null);
  w.D._state.result = r; w.D._state.text = TEXT;
  var html = w.D.view();
  ok('11a. 残缺第二名不抛错且进入对比', !!r.candidates[1] && ('guardrail' in r.candidates[1]));
  ok('11b. 缺失字段显示未提供（交期/MOQ/挂牌价）', html.indexOf('前二候选对比') >= 0 && (html.match(/未提供/g) || []).length >= 3);
})();

/* ---------- 12. 演示池 fail-closed 不回退 ---------- */
(function () {
  var w = makeWorld('demo');
  var st = w.C.get();
  st.products = [A(), B()];
  st.opportunities = [];
  w.C.persist();
  w.C.isDemoProduct = null;
  w.D._state.text = TEXT;
  var ran = w.D.runAnalysis(null);
  ok('12. 判据失效时分析被拒且无对比内容', ran === false && w.D._state.result === null && w.D.view().indexOf('前二候选对比') < 0);
})();

/* ---------- 13. 不修改原对象 ---------- */
(function () {
  var w = makeWorld();
  var products = [A(), B()];
  var before = JSON.stringify(products);
  var r = w.D.analyze(TEXT, products, SETTINGS, null);
  ok('13a. 商品对象未被分析修改', JSON.stringify(products) === before);
  ok('13b. 第一名候选未被附加 guardrail（只第二名有）', !('guardrail' in r.candidates[0]) && ('guardrail' in r.candidates[1]));
  ok('13c. 第一名结果对象独立（改第二名护栏不影响第一名 unity）', (function () {
    if (r.candidates[1].guardrail) r.candidates[1].guardrail.unity = 'tampered';
    return eq(r.unity, GOLD.s1Unity);
  })());
})();

/* ---------- 14. 对比区不出现第二名成本派生数字 ---------- */
(function () {
  var w = makeWorld();
  var bExp = B({ costRmb: 4321 });
  var r = w.D.analyze(TEXT, [A(), bExp], SETTINGS, null);
  var g = r.candidates[1].guardrail;
  w.D._state.result = r; w.D._state.text = TEXT;
  var html = w.D.view();
  ok('14a. 第二名护栏已算出保本（内部值存在）', !!g && g.unity.breakEvenUsd > 100);
  ok('14b. 页面不出现第二名保本价/报价底线/成本原值', html.indexOf(String(g.unity.breakEvenUsd)) < 0 && html.indexOf(String(g.unity.quoteFloorUsd)) < 0 && html.indexOf('4321') < 0,
    'be=' + g.unity.breakEvenUsd + ' floor=' + g.unity.quoteFloorUsd);
})();

console.log('== p1-3-compare: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
