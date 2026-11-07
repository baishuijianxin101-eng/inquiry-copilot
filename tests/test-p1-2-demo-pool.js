/* DEMO-PRODUCT-ISOLATION-01：决策台商品池视图隔离测试（纯 Node，全部虚构数据）
   夹具用显著标识：真实商品 REALONLY（成本 555）/ 演示商品 DEMOONLY（成本 11，
   分别以 demo 标记与内置演示 ID 两种方式标识）。
   覆盖：poolForView 双向互斥 / runAnalysis 过滤发生在匹配与报价之前 /
   演示保本价只能来自演示成本 / 空池不回退 / 视图切换后旧结果不渲染。
   运行：node tests/test-p1-2-demo-pool.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

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
  var C = sandbox.Core, D = sandbox.DecisionDesk;
  var st = C.get();
  st.settings = Object.assign({}, st.settings, { fxRate: 7.1, sellerName: 'Test Seller', defaultIncoterm: 'FOB Shenzhen', defaultLeadTimeDays: 15, quoteValidDays: 30 });
  st.opportunities = [];
  return { sandbox: sandbox, C: C, D: D, st: st, store: m, viewEl: viewEl };
}
function P(o) { return Object.assign({ category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o); }
var REAL = P({ id: 'real_x9', sku: 'REAL-900', title: 'REALONLY ZX900 Industrial Widget', titleEn: 'REALONLY ZX900 Widget', keywords: ['zx900', 'widget', 'gadget'], specs: 'ZX900', priceUsd: 99, priceFloorUsd: 90, costRmb: 555 });
var DEMO_FLAG = P({ id: 'demo_flag_1', demo: true, sku: 'DEMO-100', title: 'DEMOONLY Alpha Gadget', titleEn: 'DEMOONLY Alpha Gadget', keywords: ['alpha', 'gadget'], specs: 'Alpha', priceUsd: 8, priceFloorUsd: 6, costRmb: 11 });
var DEMO_ID = P({ id: 'p_cup_500', sku: 'DEMO-200', title: 'DEMOID Beta Gadget', titleEn: 'DEMOID Beta Gadget', keywords: ['beta', 'gadget'], specs: 'Beta', priceUsd: 9, priceFloorUsd: 7, costRmb: 11 });
var ALL = [REAL, DEMO_FLAG, DEMO_ID];
var TEXT = 'Hello, we need 200 pcs gadget for resale, please quote your best price.';

/* ---------- 1. poolForView 双向互斥（02 起返回 { ok, products } 结构，断言内容不变并新增 ok 校验） ---------- */
(function () {
  var w = makeWorld();
  var demoR = w.D.poolForView(ALL, 'demo');
  var realR = w.D.poolForView(ALL, 'real');
  var demo = demoR.products, real = realR.products;
  ok('1a. 演示池只含演示商品（标记与内置 ID 两种）', demoR.ok === true && demo.length === 2 && demo.every(function (p) { return w.C.isDemoProduct(p); }), demo.map(function (p) { return p.id; }).join(','));
  ok('1b. 真实池只含真实商品', realR.ok === true && real.length === 1 && real[0].id === 'real_x9');
  ok('1c. 两池互斥且并集为全集', demo.every(function (p) { return real.indexOf(p) < 0; }) && demo.length + real.length === ALL.length);
  ok('1d. 不修改原数组', ALL.length === 3);
})();

/* ---------- 2. runAnalysis：过滤发生在匹配/报价之前 ---------- */
(function () {
  var w = makeWorld('demo');
  w.st.products = ALL.slice();
  w.C.persist();
  /* 监视 SmartMatch.rank 实际收到的商品池 */
  var seenIds = null;
  var origRank = w.sandbox.SmartMatch.rank;
  w.sandbox.SmartMatch.rank = function (eff, text, pool) {
    seenIds = pool.map(function (x) { return x.product.id; });
    return origRank(eff, text, pool);
  };
  w.D._state.text = TEXT;
  var ran = w.D.runAnalysis(null);
  ok('2a. runAnalysis 在演示视图执行成功', ran === true && !!w.D._state.result);
  ok('2b. 匹配入口收到的只有演示商品', !!seenIds && seenIds.indexOf('real_x9') < 0 && seenIds.length === 2, JSON.stringify(seenIds));
  ok('2c. 结果记录 poolView=demo 且 poolEmpty=false', w.D._state.result.poolView === 'demo' && w.D._state.result.poolEmpty === false);
  var candIds = w.D._state.result.candidates.map(function (c) { return c.product.id; });
  ok('2d. 候选不含真实商品', candIds.indexOf('real_x9') < 0, candIds.join(','));
  var blob = JSON.stringify(w.D._state.result.candidates) + JSON.stringify(w.D._state.result.unity || {});
  ok('2e. 候选与报价结果中无真实商品标题/ID/挂牌价', blob.indexOf('REALONLY') < 0 && blob.indexOf('real_x9') < 0);
})();

/* ---------- 3. 演示视图保本价只能来自演示成本 ---------- */
(function () {
  var w = makeWorld('demo');
  w.st.products = ALL.slice();
  w.C.persist();
  w.D._state.text = 'Please quote 200 pcs DEMOONLY Alpha gadget for resale.';
  w.D.runAnalysis(null);
  var r = w.D._state.result;
  ok('3a. 演示池命中演示商品', !!r.top && r.top.product.id === 'demo_flag_1', r.candidates.map(function (c) { return c.product.id; }).join(','));
  /* 演示成本 11 元 → 保本约 11/7.1≈1.55 美元量级；真实成本 555 → 约 78 美元量级 */
  ok('3b. 保本价来自演示成本（小量级）', !!r.unity && r.unity.breakEvenUsd > 0 && r.unity.breakEvenUsd < 5, r.unity && String(r.unity.breakEvenUsd));
})();

/* ---------- 4. 真实视图行为不变 ---------- */
(function () {
  var w = makeWorld('real');
  w.st.products = ALL.slice();
  w.C.persist();
  w.D._state.text = 'Please quote 200 pcs REALONLY ZX900 widget for resale.';
  w.D.runAnalysis(null);
  var r = w.D._state.result;
  ok('4a. 真实池命中真实商品', !!r.top && r.top.product.id === 'real_x9', r.candidates.map(function (c) { return c.product.id; }).join(','));
  ok('4b. poolView=real 且候选无演示商品', r.poolView === 'real' && r.candidates.every(function (c) { return !w.C.isDemoProduct(c.product); }));
  ok('4c. 真实保本价来自真实成本（大量级）', !!r.unity && r.unity.breakEvenUsd > 50, r.unity && String(r.unity.breakEvenUsd));
})();

/* ---------- 5. 空池不回退 ---------- */
(function () {
  var w = makeWorld('demo');
  w.st.products = [REAL]; /* 只有真实商品 */
  w.C.persist();
  w.D._state.text = TEXT;
  w.D.runAnalysis(null);
  var r = w.D._state.result;
  ok('5a. 演示视图无演示商品时 poolEmpty=true', r.poolEmpty === true && r.poolView === 'demo');
  ok('5b. 空池零候选、无匹配（未回退真实池）', r.candidates.length === 0 && r.noMatch === true);
  var html = w.D.view();
  ok('5c. 页面明确提示不使用另一视图商品', html.indexOf('当前视图没有可用商品，不会使用另一视图的商品') >= 0);
})();

/* ---------- 6. 视图切换后旧结果不渲染 ---------- */
(function () {
  var w = makeWorld('demo');
  w.st.products = ALL.slice();
  w.C.persist();
  w.D._state.text = 'Please quote 200 pcs DEMOONLY Alpha gadget for resale.';
  w.D.runAnalysis(null);
  var before = w.D.view();
  ok('6a. 同视图时结果正常渲染（含演示商品）', before.indexOf('DEMOONLY') >= 0);
  w.store['ic_data_view'] = 'real'; /* 模拟用户切换到真实视图 */
  var after = w.D.view();
  /* 输入框里保留用户原文（含 DEMOONLY 字样）是设计行为；断言只看输入卡之后的结果区 */
  var afterResults = after.split('</textarea>')[1] || '';
  ok('6b. 切换后旧候选/草稿不渲染', afterResults.indexOf('DEMOONLY') < 0 && afterResults.indexOf('推荐哪个商品') < 0 && afterResults.indexOf('回复草稿') < 0);
  ok('6c. 切换后显示重新分析提示', after.indexOf('视图已切换，请重新分析') >= 0);
  w.D.runAnalysis(null); /* 重新分析后按新视图出结果 */
  var again = w.D.view();
  var againResults = again.split('</textarea>')[1] || '';
  ok('6d. 重新分析后渲染新视图结果且结果区无旧演示商品', again.indexOf('视图已切换') < 0 && againResults.indexOf('DEMOONLY') < 0 && w.D._state.result.poolView === 'real');
})();

/* ---------- 7. Fail-closed：判据故障时拒绝分析（DEMO-PRODUCT-ISOLATION-02） ---------- */
function brokenScenario(name, view, breakFn) {
  var w = makeWorld(view);
  w.st.products = ALL.slice();
  w.C.persist();
  var origIsDemo = w.C.isDemoProduct;
  var rankCalls = 0;
  var origRank = w.sandbox.SmartMatch.rank;
  w.sandbox.SmartMatch.rank = function (e, t, p) { rankCalls++; return origRank(e, t, p); };
  w.D._state.text = 'Please quote 200 pcs DEMOONLY Alpha gadget for resale.';
  var firstOk = w.D.runAnalysis(null);
  ok('7-' + name + ' 前置正常分析成功（' + view + '）', firstOk === true && !!w.D._state.result);
  rankCalls = 0;
  breakFn(w.C);
  var ran = w.D.runAnalysis(null);
  var html = w.D.view();
  var results = html.split('</textarea>')[1] || '';
  ok('7-' + name + ' 判据故障时 runAnalysis 拒绝（' + view + '）', ran === false);
  ok('7-' + name + ' analyze 未被调用（rank 计数为 0）', rankCalls === 0);
  ok('7-' + name + ' 旧结果已作废（result 为空）', w.D._state.result === null);
  ok('7-' + name + ' 旧候选/报价/草稿不展示', results.indexOf('推荐哪个商品') < 0 && results.indexOf('回复草稿') < 0 && results.indexOf('DEMOONLY') < 0);
  ok('7-' + name + ' 显示分类失败专属提示且不伪装成空池', html.indexOf('商品分类校验失败，已停止分析') >= 0 && html.indexOf('当前视图没有可用商品') < 0);
  w.C.isDemoProduct = origIsDemo;
  rankCalls = 0;
  var again = w.D.runAnalysis(null);
  ok('7-' + name + ' 恢复判据后可正常分析（' + view + '）', again === true && !!w.D._state.result && rankCalls > 0);
}
['demo', 'real'].forEach(function (view) {
  brokenScenario('缺失-' + view, view, function (C) { C.isDemoProduct = undefined; });
  brokenScenario('非函数-' + view, view, function (C) { C.isDemoProduct = 'not-a-function'; });
  brokenScenario('抛错-' + view, view, function (C) { C.isDemoProduct = function () { throw new Error('boom'); }; });
  brokenScenario('单个商品判定失败-' + view, view, function (C) {
    var orig = C.isDemoProduct;
    C.isDemoProduct = function (p) { if (p && p.id === 'demo_flag_1') throw new Error('bad item'); return orig(p); };
  });
});
(function () {
  var w = makeWorld('demo');
  var r1 = w.D.poolForView(ALL, 'demo');
  w.C.isDemoProduct = null;
  var r2 = w.D.poolForView(ALL, 'demo');
  ok('7-结构 判据缺失时返回 ok:false 且空池（绝不返回原始池）', r1.ok === true && r2.ok === false && r2.products.length === 0 && typeof r2.reason === 'string');
})();

console.log('== p1-2-demo-pool: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
