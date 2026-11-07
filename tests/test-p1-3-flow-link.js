/* P1-3A 专项：决策台保存后衔接与买家身份补全（纯 Node，全部虚构数据）
   覆盖：保存成功生成准确商机入口 / 失败不显示入口 / 查重闸不回退 /
   买家称呼+公司三种填写组合落库 / 双空与旧版兼容 / XSS 转义 /
   反馈指引存在且不自动发送 / 落盘后新会话可读回。
   运行：node tests/test-p1-3-flow-link.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

function makeWorld(store, viewPref, skipSeed) {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  var m = store || {};
  sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  if (viewPref) m['ic_data_view'] = viewPref;
  var els = {
    view: { innerHTML: '' },
    'dd-save-status': { textContent: '', style: {} },
    'dd-open-opp': { innerHTML: '' }
  };
  sandbox.document = { getElementById: function (id) { return els[id] || null; } };
  vm.createContext(sandbox);
  ['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
   'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
   'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  var C = sandbox.Core, D = sandbox.DecisionDesk;
  var st = C.get();
  if (!skipSeed) {
    st.settings = Object.assign({}, st.settings, { fxRate: 7.1, sellerName: 'Test Seller', defaultIncoterm: 'FOB Shenzhen', defaultLeadTimeDays: 15, quoteValidDays: 30 });
    st.products = [{ id: 'real_x9', sku: 'REAL-900', title: 'REALONLY ZX900 Industrial Widget', titleEn: 'REALONLY ZX900 Widget', category: '', keywords: ['zx900', 'widget', 'gadget'], specs: 'ZX900', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货', priceUsd: 99, priceFloorUsd: 90, costRmb: 555 }];
    st.opportunities = [];
    C.persist();
  }
  return { sandbox: sandbox, C: C, D: D, st: st, store: m, els: els };
}
var TEXT = 'Hello, we need 200 pcs ZX900 widget gadget for resale, please quote.';

function analyzeAndSave(w) {
  w.D._state.text = TEXT;
  w.D.runAnalysis(null);
  return w.D.saveToOpp();
}

/* ---------- 1. 新建成功 → 准确入口 ---------- */
(function () {
  var w = makeWorld();
  var r = analyzeAndSave(w);
  var opp = w.st.opportunities[0];
  ok('1a. 新建保存成功', r.ok === true && r.stage === 'create' && !!opp);
  ok('1b. 入口指向本次商机的准确 ID', w.els['dd-open-opp'].innerHTML.indexOf('href="#/opp/' + opp.id + '"') >= 0 && w.D._state.lastSavedOppId === opp.id, w.els['dd-open-opp'].innerHTML);
  ok('1c. 视图重渲染后入口仍在（状态驱动）', w.D.view().indexOf('href="#/opp/' + opp.id + '"') >= 0);
  ok('1d. 反馈含下一步指引', w.els['dd-save-status'].textContent.indexOf('下一步：打开该商机核对回复草稿') >= 0 && w.els['dd-save-status'].textContent.indexOf('下一次跟进日期') >= 0);
  ok('1e. 保存不自动发送/不写跟进（followLog 为空、状态仍为新询盘）', (opp.followLog || []).length === 0 && opp.status === 'new');
})();

/* ---------- 2. 保存失败 → 无成功入口 ---------- */
(function () {
  var w = makeWorld();
  w.D._state.text = TEXT;
  w.D.runAnalysis(null);
  var good = w.D.saveToOpp();
  var id1 = good.oppId;
  /* 指向不存在的目标再保存 → target-missing 失败，入口必须消失 */
  w.D._state.targetOppId = 'opp_does_not_exist';
  var bad = w.D.saveToOpp();
  ok('2a. 失败返回 target-missing', good.ok === true && bad.ok === false && bad.stage === 'target-missing');
  ok('2b. 失败后成功入口被清除', w.D._state.lastSavedOppId === '' && w.els['dd-open-opp'].innerHTML === '' && w.D.view().indexOf('href="#/opp/' + id1 + '"') < 0);
})();

/* ---------- 3. 查重闸仍拦截（双空买家与旧版一致） ---------- */
(function () {
  var w = makeWorld();
  var first = analyzeAndSave(w);
  var before = w.st.opportunities.length;
  w.D._state.targetOppId = '';
  var second = w.D.saveToOpp();
  ok('3a. 同文同买家（未知买家）第二次被查重拦截', first.ok === true && second.ok === false && second.stage === 'duplicate' && w.st.opportunities.length === before);
  ok('3b. 查重拦截时不显示新建成功入口', w.D._state.lastSavedOppId === '' && w.els['dd-open-opp'].innerHTML === '');
})();

/* ---------- 4-6. 买家填写组合落库 ---------- */
function buyerCase(name, bn, bc, expectName, expectCompany, expectKey) {
  var w = makeWorld();
  w.D._state.buyerName = bn; w.D._state.buyerCompany = bc;
  var r = analyzeAndSave(w);
  var opp = w.st.opportunities[0];
  ok(name + ' 保存成功', r.ok === true && !!opp);
  ok(name + ' buyer 落库正确', !!opp && opp.buyer.name === expectName && opp.buyer.company === expectCompany, opp && JSON.stringify(opp.buyer));
  ok(name + ' buyerKey 与商机页口径一致', !!opp && w.C.buyerKeyOf(opp.buyer) === expectKey, opp && w.C.buyerKeyOf(opp.buyer));
  ok(name + ' 买家信息未串入商品/报价字段', !!opp && opp.quote.unitPriceUsd === 0 && JSON.stringify(opp.matches || []).indexOf(expectCompany || '###') < 0);
}
buyerCase('4. 称呼+公司都填', 'Ahmed Noor', 'Al Noor Trading LLC', 'Ahmed Noor', 'Al Noor Trading LLC', 'al noor trading llc');
buyerCase('5. 只填称呼', 'Ahmed Noor', '', 'Ahmed Noor', '', 'ahmed noor');
buyerCase('6. 只填公司', '', 'Al Noor Trading LLC', '未知买家', 'Al Noor Trading LLC', 'al noor trading llc');

/* ---------- 7. 双空兼容：查重能抓到手工建档的未知买家商机 ---------- */
(function () {
  var w = makeWorld();
  /* 模拟商机页旧路径建的未知买家商机（同文） */
  var pre = w.C.normalizeOpp({ buyer: { name: '未知买家', company: '', country: '', channel: '询盘' }, rawText: TEXT, quote: { qty: 100, unitPriceUsd: 0 } });
  w.st.opportunities.unshift(pre); w.C.persist();
  var r = analyzeAndSave(w);
  ok('7. 双空时查重桶与旧版一致（命中已有未知买家商机）', r.ok === false && r.stage === 'duplicate' && r.oppId === '');
})();

/* ---------- 8. XSS：输入只作数据存储与转义渲染 ---------- */
(function () {
  var w = makeWorld();
  var evil = '<img src=x onerror=alert(1)>';
  w.D._state.buyerName = evil;
  var r = analyzeAndSave(w);
  var opp = w.st.opportunities[0];
  var html = w.D.view();
  ok('8a. 恶意字符串按原文存为数据（未被篡改）', r.ok === true && !!opp && opp.buyer.name === evil);
  ok('8b. 渲染结果中无未转义注入', html.indexOf('<img src=x') < 0 && html.indexOf('&lt;img src=x') >= 0);
})();

/* ---------- 9. 刷新后可读回并打开 ---------- */
(function () {
  var w = makeWorld();
  var r = analyzeAndSave(w);
  var id = r.oppId;
  var w2 = makeWorld(w.store, null, true); /* 同一 localStorage 后备存储的新会话，不重播种 */
  var back = null;
  w2.st.opportunities.forEach(function (o) { if (o.id === id) back = o; });
  ok('9. 新会话读回该商机（详情页打开的数据前提成立）', !!back && back.id === id && !!back.replyDrafts && Object.keys(back.replyDrafts).length >= 0);
})();

console.log('== p1-3-flow-link: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
