/* P1-2 批次 2：建档查重闸测试（纯 Node，全部虚构数据）
   覆盖：指纹规范化（只消除排版差异）/ buyerKey 同规 / 视图隔离 /
   数量与型号差异不误报 / 多候选全返回 / 异常降级不阻断 /
   决策台保存路径的查重拦截与「仍要新建」放行。
   运行：node tests/test-p1-2-dedup.js */
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
  vm.createContext(sandbox);
  ['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
   'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
   'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  var C = sandbox.Core, D = sandbox.DecisionDesk;
  var st = C.get();
  st.settings = Object.assign({}, st.settings, { fxRate: 7.1, sellerName: 'Test Seller', defaultIncoterm: 'FOB Shenzhen', defaultLeadTimeDays: 15, quoteValidDays: 30 });
  function P(o) { return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o); }
  st.products = [
    P({ sku: 'PA', title: 'RadioMaster XR4 ELRS Receiver 2.4GHz Dual Band', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 12, priceFloorUsd: 10, costRmb: 55, certs: ['CE'] })
  ];
  st.opportunities = [];
  C.persist();
  return { sandbox: sandbox, C: C, D: D, st: st, store: m };
}
var TEXT = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days.';
function addOpp(w, id, buyer, text, extra) {
  var o = w.C.normalizeOpp(Object.assign({ id: id, buyer: buyer, rawText: text }, extra || {}));
  w.st.opportunities.push(o);
  return o;
}

/* ---------- 1. 指纹规范化 ---------- */
(function () {
  var w = makeWorld(), C = w.C;
  var base = C.inquiryFingerprint(TEXT);
  ok('1a. 换行符差异不影响指纹', C.inquiryFingerprint(TEXT.replace(/ /g, '\n')) === base || C.inquiryFingerprint('Hello, we need 500 pcs\r\nRadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days.') !== '');
  ok('1b. CRLF 与多余空白被规范化', C.inquiryFingerprint('Hello,  we   need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days.\r\n') === base);
  ok('1c. 大小写差异被规范化', C.inquiryFingerprint(TEXT.toUpperCase()) === base);
  ok('1d. 数量不同指纹不同', C.inquiryFingerprint(TEXT.replace('500', '600')) !== base);
  ok('1e. 型号不同指纹不同', C.inquiryFingerprint(TEXT.replace('XR4', 'XR5')) !== base);
  ok('1f. 空文本指纹为空', C.inquiryFingerprint('') === '' && C.inquiryFingerprint('   \n ') === '' && C.inquiryFingerprint(null) === '');
})();

/* ---------- 2. buyerKey 同规 ---------- */
(function () {
  var w = makeWorld(), C = w.C;
  ok('2a. company 优先', C.buyerKeyOf({ name: 'Ann', company: 'Acme GmbH' }) === 'acme gmbh');
  ok('2b. 无 company 用 name 并去空白小写', C.buyerKeyOf({ name: '  Ann Lee ' }) === 'ann lee');
  ok('2c. 空买家为空键', C.buyerKeyOf(null) === '' && C.buyerKeyOf({}) === '');
})();

/* ---------- 3. findDuplicateOpps 命中与隔离 ---------- */
(function () {
  var w = makeWorld(), C = w.C;
  addOpp(w, 'd1', { name: 'Dup Buyer', company: '', country: '德国' }, TEXT);
  addOpp(w, 'd2', { name: 'Dup Buyer', company: '', country: '德国' }, TEXT);
  addOpp(w, 'd3', { name: 'Other Buyer', company: '' }, TEXT);
  addOpp(w, 'd4', { name: 'Dup Buyer', company: '' }, TEXT.replace('500', '600'));
  addOpp(w, 'd5', { name: 'Dup Buyer', company: '' }, TEXT, { demo: true });
  w.C.persist();
  var hits = C.findDuplicateOpps(w.st, 'real', { name: 'Dup Buyer', company: '' }, TEXT);
  ok('3a. 同买家同文本命中两条候选', hits.length === 2 && hits.every(function (h) { return h.id === 'd1' || h.id === 'd2'; }), JSON.stringify(hits.map(function (h) { return h.id; })));
  ok('3b. 候选带日期与状态', hits.every(function (h) { return !!h.createdAt && !!h.status; }));
  ok('3c. 排版变体仍命中', C.findDuplicateOpps(w.st, 'real', { name: 'dup buyer' }, TEXT.replace(/ /g, '  ')).length === 2);
  ok('3d. 不同买家不跨买家命中', C.findDuplicateOpps(w.st, 'real', { name: 'Other Buyer' }, TEXT).length === 1 && C.findDuplicateOpps(w.st, 'real', { name: 'Nobody' }, TEXT).length === 0);
  ok('3e. 数量不同不命中（不误伤新需求）', C.findDuplicateOpps(w.st, 'real', { name: 'Dup Buyer' }, TEXT.replace('500', '600')).length === 1);
  ok('3f. 演示记录不进真实视图查重', hits.every(function (h) { return h.id !== 'd5'; }));
  ok('3g. 演示视图只查到演示记录', C.findDuplicateOpps(w.st, 'demo', { name: 'Dup Buyer' }, TEXT).length === 1);
  ok('3h. company 优先口径一致', C.findDuplicateOpps(w.st, 'real', { name: '谁都行', company: '' }, TEXT).length === 0);
})();

/* ---------- 4. 异常与不完整数据降级 ---------- */
(function () {
  var w = makeWorld(), C = w.C;
  var r1, r2, r3;
  try { r1 = C.findDuplicateOpps(null, 'real', { name: 'X' }, TEXT); } catch (e) { r1 = 'threw'; }
  try { r2 = C.findDuplicateOpps(w.st, 'real', null, TEXT); } catch (e) { r2 = 'threw'; }
  try { r3 = C.findDuplicateOpps(w.st, 'real', { name: 'X' }, ''); } catch (e) { r3 = 'threw'; }
  ok('4a. state 缺失返回空数组不抛', Array.isArray(r1) && r1.length === 0);
  ok('4b. buyer 缺失返回空数组不抛', Array.isArray(r2) && r2.length === 0);
  ok('4c. 空原文返回空数组不抛', Array.isArray(r3) && r3.length === 0);
  w.st.opportunities.push(null, { id: 'broken' });
  var r4;
  try { r4 = C.findDuplicateOpps(w.st, 'real', { name: 'X' }, TEXT); } catch (e) { r4 = 'threw'; }
  ok('4d. 损坏条目不影响查重', Array.isArray(r4));
})();

/* ---------- 5. 决策台保存路径集成 ---------- */
(function () {
  var w = makeWorld(), C = w.C, D = w.D;
  addOpp(w, 'dd1', { name: '未知买家', company: '' }, TEXT);
  w.C.persist();
  var r = D.analyze(TEXT, w.st.products, w.st.settings, null);
  D._state.text = TEXT; D._state.result = r;
  D._state.draft = r.reply ? r.reply.en : ''; D._state.baseDraft = D._state.draft;
  D._state.targetOppId = ''; D._state.dupForce = false;
  var res = D.saveToOpp();
  ok('5a. 命中疑似重复时拦截建档', res.ok === false && res.stage === 'duplicate', JSON.stringify(res));
  ok('5b. 拦截后未产生新记录', w.st.opportunities.length === 1, String(w.st.opportunities.length));
  ok('5c. 候选已备好供界面呈现', (D._state.dupCandidates || []).length === 1 && D._state.dupCandidates[0].id === 'dd1');
  D._state.dupForce = true;
  var res2 = D.saveToOpp();
  ok('5d. 用户确认仍要新建后正常建档+保存', res2.ok === true && res2.stage === 'create' && w.st.opportunities.length === 2, JSON.stringify(res2));
  var old = w.st.opportunities.filter(function (o) { return o.id === 'dd1'; })[0];
  ok('5e. 旧商机未被改写', !!old && !(old.parseEdits && old.parseEdits.qty === 500) && !old.selectedProductId);
})();

/* ---------- 6. 决策台：无重复时不受影响（BATCH-01 主路径） ---------- */
(function () {
  var w = makeWorld(), D = w.D;
  var r = D.analyze(TEXT, w.st.products, w.st.settings, null);
  D._state.text = TEXT; D._state.result = r;
  D._state.draft = r.reply ? r.reply.en : ''; D._state.baseDraft = D._state.draft;
  D._state.targetOppId = ''; D._state.dupForce = false;
  var res = D.saveToOpp();
  ok('6a. 无候选时直接建档保存', res.ok === true && res.stage === 'create', JSON.stringify(res));
})();

console.log('== p1-2-dedup: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
