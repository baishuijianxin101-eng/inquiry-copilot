/* P1-3B-2 专项：决策台人工选品与保存落库（纯 Node，全部虚构数据）
   黄金基线与 test-p1-3-compare.js 同源（改前生产代码实测值）。
   运行：node tests/test-p1-3-manual-pick.js */
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
  sandbox.confirm = function () { return true; };
  var viewEl = { innerHTML: '' };
  sandbox.document = {
    getElementById: function (id) { return id === 'view' ? viewEl : null; },
    querySelectorAll: function () { return []; }
  };
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
var FULL = 'Hello, we need 200 pcs ZX900 widget gadget for resale in Germany, delivery to Hamburg port, needed within 20 days, please quote your price.';
var GOLD = {
  s1Unity: { listUsd: 99, recommendUsd: 78.2, breakEvenUsd: 78.17, businessFloorUsd: 90, quoteFloorUsd: 90, negoFloorUsd: 84.5, minMarginPct: 8, unitUsd: 99, qty: 200, feeRate: 0, noCost: false, anomaly: false, quotable: true, blockReasons: [], warnings: ['系统建议价低于商品登记底价，按建议价报需走特批'] },
  s1Draft: 'Hi,\n\nThanks for your inquiry about the ZX900 widget gadget for resale in Germany — the closest model in our range is the ZX900 Widget Gadget Pro (G-A).\nSo I can quote accurately instead of guessing, could you confirm a few points?\n- Could you confirm the destination port or country?\n- Could you confirm your expected delivery time?\nOnce I have these, I will send you a firm quotation rather than a rough estimate.\n\nBest regards,\nTest Seller'
};
function analyzeInto(w, text, products, settingsOpt) {
  var r = w.D.analyze(text, products, settingsOpt || SETTINGS, null);
  w.D._state.result = r; w.D._state.text = text;
  w.D._state.draft = r.reply ? r.reply.en : ''; w.D._state.baseDraft = w.D._state.draft;
  return r;
}

/* ---------- 1+2. 默认黄金基线与默认歧义门禁 ---------- */
(function () {
  var w = makeWorld();
  var r1 = analyzeInto(w, 'Hello, we need 200 pcs ZX900 widget gadget for resale in Germany, please quote.', [A()]);
  ok('1a. 默认 unity 与改前黄金逐字一致', eq(r1.unity, GOLD.s1Unity));
  ok('1b. 默认草稿全文与黄金一致且 draftPriced=false', r1.reply.en === GOLD.s1Draft && r1.draftPriced === false);
  ok('1c. 默认 selected=第一名、source=auto', r1.selected.product.id === 'g_a' && r1.selectionSource === 'auto' && r1.selectionAt === null);
  var r2 = analyzeInto(w, FULL, [A(), B()]);
  ok('2a. 默认歧义仍阻断带价（完整询盘也不带价）', r2.ambiguous === true && r2.readiness.key === 'need-verify' && r2.draftPriced === false && !/our price is \$/.test(r2.reply.en));
})();

/* ---------- 3+4. 选第二名同步 / 切回深相等 ---------- */
(function () {
  var w = makeWorld();
  var r = analyzeInto(w, FULL, [A(), B()]);
  var snapA = JSON.stringify({ u: r.unity, rd: r.readiness, cg: r.certGuard });
  ok('3a. 选第二名成功', w.D.applySelection('g_b') === true);
  ok('3b. 结论切到第二名（unitUsd=89、可报价、人工拍板解除歧义）', r.selected.product.id === 'g_b' && r.unity.unitUsd === 89 && r.readiness.key === 'can-quote');
  ok('3c. 草稿同步为第二名（标题+价格行、无第一名价格）', /our price is \$89\.00 per piece/.test(r.reply.en) && r.reply.en.indexOf('Lite') >= 0 && !/\$99\.00/.test(r.reply.en) && r.draftPriced === true);
  ok('3d. 台内草稿状态同步替换', w.D._state.draft === r.reply.en && w.D._state.baseDraft === r.reply.en);
  ok('3e. 来源标记 manual 且有 ISO 时间', r.selectionSource === 'manual' && /^\d{4}-\d{2}-\d{2}T/.test(r.selectionAt || ''));
  var w2 = makeWorld();
  /* 与真实 runAnalysis 同源：analyze 与 applySelection 共用 state().settings 同一对象 */
  var liveSettings = w2.C.get().settings;
  var rd = analyzeInto(w2, FULL, [A(), B()], liveSettings);
  w2.D.applySelection('g_b'); w2.D.applySelection('g_a');
  var wA = makeWorld();
  var ra = analyzeInto(wA, FULL, [A(), B()], wA.C.get().settings);
  ok('4. 切回第一名后 unity/readiness/certGuard/草稿与默认深相等（完整恢复原结果）',
    eq(rd.unity, ra.unity) && eq(rd.readiness, ra.readiness) && eq(rd.certGuard, ra.certGuard) &&
    rd.reply.en === ra.reply.en && rd.draftPriced === ra.draftPriced && rd.selected.product.id === 'g_a',
    'rd.u=' + JSON.stringify(rd.unity) + ' ra.u=' + JSON.stringify(ra.unity) + ' rd.rd=' + rd.readiness.key + ' ra.rd=' + ra.readiness.key);
  ok('4b. 切回后来源标记同步恢复 auto 且无人工时间', rd.selectionSource === 'auto' && rd.selectionAt === null);
  ok('4c. 第三名不可选', (function () {
    var w3 = makeWorld();
    var r3 = analyzeInto(w3, FULL, [A(), B(), P({ id: 'g_c', sku: 'G-C', title: 'ZX900 Widget Gadget Mini', keywords: ['zx900', 'widget', 'gadget'], specs: 'ZX900', priceUsd: 79, priceFloorUsd: 70, costRmb: 450 })]);
    return w3.D.applySelection('g_c') === false && r3.selected.product.id !== 'g_c';
  })());
})();

/* ---------- 5/6/7. 第二名三类门禁 ---------- */
(function () {
  var w = makeWorld();
  var bNoCost = B(); delete bNoCost.costRmb;
  var r = analyzeInto(w, FULL, [A(), bNoCost]);
  w.D.applySelection('g_b');
  ok('5. 第二名缺成本 → missing-cost 且草稿无价', r.readiness.key === 'missing-cost' && r.draftPriced === false && !/our price is \$/.test(r.reply.en));
  var w6 = makeWorld();
  var text = 'Hello, we need 200 pcs ZX900 widget gadget with CE certificate required, delivery to Hamburg port, needed within 20 days, please quote.';
  var r6 = analyzeInto(w6, text, [A({ certs: ['CE'] }), B({ certs: [] })]);
  w6.D.applySelection('g_b');
  ok('6. 第二名认证未登记 → certGuard 阻断且草稿无价', !!r6.certGuard && r6.certGuard.type === 'uncovered' && r6.readiness.key === 'need-verify' && !/our price is \$/.test(r6.reply.en));
  var w7 = makeWorld();
  var r7 = analyzeInto(w7, FULL, [A(), B({ moq: 500 })]);
  var unityBefore7 = JSON.stringify(r7.unity);
  ok('7a. MOQ 不满足在匹配层即被拦截（keyConflict、无护栏、不可选、第一名结论不变）',
    r7.candidates[1].keyConflict === true && !('guardrail' in r7.candidates[1]) &&
    w7.D.applySelection('g_b') === false && r7.selected.product.id === 'g_a' &&
    JSON.stringify(r7.unity) === unityBefore7);
  ok('7b. conclude 层 MOQ 硬门禁独立成立（绕过匹配层直测）', (function () {
    var fakeEntry = { product: B({ moq: 500 }), result: { score: 80, keyConflict: false, conflicts: [] } };
    var cc = w7.D.conclude(fakeEntry, { eff: r7.eff, settings: SETTINGS, text: FULL, ambiguous: false, noMatch: false });
    return !!cc.unity && cc.unity.quotable === false && cc.unity.blockReasons.join('；').indexOf('低于起订量') >= 0 && cc.draftPriced === false;
  })());
})();

/* ---------- 8/9/10/11/12. 保存、还原、兼容、查重 ---------- */
function saveWorld() {
  var w = makeWorld();
  var st = w.C.get();
  st.products = [A(), B()];
  st.opportunities = [];
  st.settings = Object.assign({}, st.settings, SETTINGS);
  w.C.persist();
  w.D._state.text = FULL;
  w.D._state.targetOppId = '';
  w.D._state.buyerName = 'Buyer One'; w.D._state.buyerCompany = '';
  return w;
}
(function () {
  var w = saveWorld();
  var ran = w.D.runAnalysis(null);
  w.D.applySelection('g_b');
  var r = w.D._state.result;
  var payload = w.D.buildSavePayload(r, null, w.D._state.draft, w.D._state.baseDraft);
  ok('8. 保存 payload 的 selectedProductId 来自人工选品', ran === true && payload.selectedProductId === 'g_b');
  ok('9. selectionSource=manual 且 selectionAt 为 ISO', payload.selectionSource === 'manual' && /^\d{4}-\d{2}-\d{2}T/.test(payload.selectionAt || ''));
  var res = w.D.saveToOpp();
  var opp = w.C.get().opportunities[0];
  ok('10a. 保存成功且商机落库第二名与来源', res.ok === true && !!opp && opp.selectedProductId === 'g_b' && opp.selectionSource === 'manual' && !!opp.selectionAt);
  var w2 = makeWorld();
  Object.keys(w.store).forEach(function (k) { w2.store[k] = w.store[k]; });
  var opp2 = null;
  w2.C.get().opportunities.forEach(function (o) { if (o.id === opp.id) opp2 = o; });
  ok('10b. 跨会话读回选择不丢失', !!opp2 && opp2.selectedProductId === 'g_b' && opp2.selectionSource === 'manual');
  w.D._state.targetOppId = ''; /* 模拟新会话对同一询盘再次走建档路径（保存成功后目标已回绑，走更新路径不查是既有设计） */
  var res2 = w.D.saveToOpp();
  ok('12. 选品后同文再存仍被查重拦截（不绕过）', !!res2 && res2.stage === 'duplicate' && w.C.get().opportunities.length === 1);
  var w3 = saveWorld();
  w3.D.runAnalysis(null);
  var resD = w3.D.saveToOpp();
  var oppD = w3.C.get().opportunities[0];
  ok('11a. 默认保存与现版一致（第一名 + auto + 无时间）', resD.ok === true && oppD.selectedProductId === 'g_a' && oppD.selectionSource === 'auto' && !oppD.selectionAt);
  ok('11b. 旧商机（无新字段）经台内更新保存不报错', (function () {
    var w4 = saveWorld();
    var st4 = w4.C.get();
    var legacy = { id: 'opp_legacy_pick', rawText: FULL, buyer: { name: 'Legacy', company: '', country: '', channel: '' }, status: 'new', quote: {}, matches: null, selectedProductId: null, replyDrafts: {}, followLog: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
    st4.opportunities = [legacy]; w4.C.persist();
    w4.D._state.targetOppId = 'opp_legacy_pick';
    w4.D.runAnalysis(null);
    var rr = w4.D.saveToOpp();
    var after = w4.C.get().opportunities[0];
    return rr.ok === true && after.selectedProductId === 'g_a';
  })());
})();

/* ---------- 13. 不修改商品与候选 ---------- */
(function () {
  var w = makeWorld();
  var products = [A(), B()];
  var before = JSON.stringify(products);
  var r = analyzeInto(w, FULL, products);
  var candBefore = JSON.stringify(r.candidates.map(function (c) { return { id: c.product.id, score: c.score }; }));
  w.D.applySelection('g_b');
  ok('13a. 商品池对象未被修改', JSON.stringify(products) === before);
  ok('13b. 候选分数构成未被修改', JSON.stringify(r.candidates.map(function (c) { return { id: c.product.id, score: c.score }; })) === candBefore);
})();

/* ---------- 14. 第二名护栏失败不可选 ---------- */
(function () {
  var w = makeWorld();
  var origEval = w.sandbox.Pricing.evaluate;
  w.sandbox.Pricing.evaluate = function (opts) {
    if (opts && opts.product && opts.product.id === 'g_b') throw new Error('boom');
    return origEval(opts);
  };
  var r = analyzeInto(w, FULL, [A(), B()]);
  ok('14a. 第二名护栏 unity 为空时选择被拒绝', w.D.applySelection('g_b') === false && r.selected.product.id === 'g_a' && r.selectionSource === 'auto');
  ok('14b. 页面明确提示不可选原因', w.D.view().indexOf('暂不能选为最终商品') >= 0);
})();

/* ---------- 15+16. conclude 异常时清旧价且不落半成品 ---------- */
(function () {
  var w = saveWorld();
  w.D.runAnalysis(null);
  var storeBefore = w.store['ali_commission_copilot_v1'];
  var r = w.D._state.result;
  r.eff.certMentions = [{ name: { toString: function () { throw new Error('bad name'); } }, context: 'mandatory', conflict: false }];
  var picked = w.D.applySelection('g_b');
  ok('15a. 异常时选品动作完成但进入安全阻断态', picked === true && r.readiness.key === 'need-verify' && /计算失败/.test(r.readiness.why));
  ok('15b. 旧草稿与旧价格被清除（草稿无第一名价格行）', r.draftPriced === false && !/our price is \$/.test(w.D._state.draft || '') && w.D._state.draft === (r.reply ? r.reply.en : ''));
  ok('15c. 选品记录与报价状态分离（selected 已切、unity 为空）', r.selected.product.id === 'g_b' && r.unity === null && r.selectionSource === 'manual');
  ok('16. 异常选品过程零持久化写入', w.store['ali_commission_copilot_v1'] === storeBefore);
})();

/* ---------- 17. 演示池 fail-closed ---------- */
(function () {
  var w = makeWorld('demo');
  var st = w.C.get();
  st.products = [A(), B()];
  st.opportunities = [];
  w.C.persist();
  w.C.isDemoProduct = null;
  w.D._state.text = FULL;
  var ran = w.D.runAnalysis(null);
  ok('17. 判据失效时分析被拒且无从选品', ran === false && w.D._state.result === null && w.D.applySelection('g_b') === false);
})();

/* ---------- 18. 旧商机无新字段：载入→保存→再载入全周期 ---------- */
(function () {
  var w = saveWorld();
  var st = w.C.get();
  var legacy = { id: 'opp_legacy_nofields', rawText: FULL, buyer: { name: 'Legacy', company: '', country: '', channel: '' }, status: 'new', quote: {}, matches: null, selectedProductId: null, replyDrafts: {}, followLog: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
  st.opportunities = [legacy]; w.C.persist();
  var wLoad = makeWorld();
  Object.keys(w.store).forEach(function (k) { wLoad.store[k] = w.store[k]; });
  var loaded = null, loadErr = null;
  try { loaded = wLoad.C.get().opportunities.filter(function (o) { return o.id === 'opp_legacy_nofields'; })[0]; } catch (e) { loadErr = e; }
  ok('18a. 无新字段旧商机载入不报错且字段归 null', !loadErr && !!loaded && loaded.selectionSource === null && loaded.selectionAt === null);
  wLoad.D._state.text = FULL; wLoad.D._state.targetOppId = 'opp_legacy_nofields';
  wLoad.D._state.buyerName = ''; wLoad.D._state.buyerCompany = '';
  var ranL = wLoad.D.runAnalysis(null);
  var resL = ranL ? wLoad.D.saveToOpp() : { ok: false };
  var afterSave = wLoad.C.get().opportunities.filter(function (o) { return o.id === 'opp_legacy_nofields'; })[0];
  ok('18b. 旧商机经台内保存不报错且写入选品', resL.ok === true && !!afterSave && afterSave.selectedProductId === 'g_a' && afterSave.selectionSource === 'auto');
  var wRe = makeWorld();
  Object.keys(wLoad.store).forEach(function (k) { wRe.store[k] = wLoad.store[k]; });
  var reloaded = null, reErr = null;
  try { reloaded = wRe.C.get().opportunities.filter(function (o) { return o.id === 'opp_legacy_nofields'; })[0]; } catch (e) { reErr = e; }
  ok('18c. 再次载入不报错且选品与来源保留', !reErr && !!reloaded && reloaded.selectedProductId === 'g_a' && reloaded.selectionSource === 'auto');
})();

/* ---------- 19. 非法 selectionSource/selectionAt 防污染 ---------- */
(function () {
  function worldWithOpp(oppExtra) {
    var w = makeWorld();
    var st = w.C.get();
    var opp = { id: 'opp_poison', rawText: 'x', buyer: { name: 'P', company: '', country: '', channel: '' }, status: 'new', quote: {}, matches: [], selectedProductId: 'g_a', replyDrafts: {}, followLog: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
    Object.keys(oppExtra).forEach(function (k) { opp[k] = oppExtra[k]; });
    st.opportunities = [opp]; w.C.persist();
    var w2 = makeWorld();
    Object.keys(w.store).forEach(function (k) { w2.store[k] = w.store[k]; });
    return w2.C.get().opportunities.filter(function (o) { return o.id === 'opp_poison'; })[0];
  }
  var bad1 = worldWithOpp({ selectionSource: 'hacked', selectionAt: 12345 });
  ok('19a. 非法 source 与数字型 at 均归 null', !!bad1 && bad1.selectionSource === null && bad1.selectionAt === null);
  var bad2 = worldWithOpp({ selectionSource: 'MANUAL', selectionAt: 'not-a-date' });
  ok('19b. 大小写变体与伪日期均归 null', !!bad2 && bad2.selectionSource === null && bad2.selectionAt === null);
  var good = worldWithOpp({ selectionSource: 'manual', selectionAt: '2026-11-07T03:00:00.000Z' });
  ok('19c. 合法 manual + ISO 时间完整保留（正对照）', !!good && good.selectionSource === 'manual' && good.selectionAt === '2026-11-07T03:00:00.000Z');
})();

console.log('== p1-3-manual-pick: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
