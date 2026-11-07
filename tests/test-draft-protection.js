/* P1-15 决策台草稿人工修改保护测试（纯 Node，全部虚构 DEMO 数据）
   运行：node tests/test-draft-protection.js
   验证的是实际状态变化（S.draft / S.result / baseDraft），不只验证提示文字。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var MODULES = ['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
  'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
  'assets/p0-parse.js', 'assets/decision-desk.js'];

function makeSandbox() {
  var sb = { console: console };
  sb.window = sb;
  var m = {};
  sb.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  sb.document = { getElementById: function () { return null; } };
  vm.createContext(sb);
  MODULES.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f }); });
  return sb;
}
function P(o) {
  return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o);
}
var products = [
  P({ sku: 'PA', title: 'RadioMaster XR4 ELRS Receiver 2.4GHz Dual Band', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 12, priceFloorUsd: 10, costRmb: 55, certs: ['CE'] }),
  P({ sku: 'PB', title: 'BAYCK ELRS Nano Receiver 2.4GHz 915MHz', titleEn: 'BAYCK ELRS Nano Receiver', keywords: ['elrs receiver', 'nano receiver', '2.4ghz receiver'], specs: '2.4GHz 915MHz ELRS', priceUsd: 4.18, priceFloorUsd: 0, costRmb: 20, certs: [] })
];
var settings = { fxRate: 7.1, sellerName: 'Test Seller' };
var TEXT = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days. Our target price is USD 11 per pc.';

/* ---------- 沙箱 A：保护机制行为 ---------- */
var sb = makeSandbox();
var D = sb.DecisionDesk;
sb.Core.get = function () { return { products: products, settings: settings }; };
var S = D._state;
var confirmCalls = [];
function confirmSpy(ret) { return function (msg) { confirmCalls.push(msg); return ret; }; }

ok('A0. DecisionDesk 暴露 runAnalysis/draftEdited', typeof D.runAnalysis === 'function' && typeof D.draftEdited === 'function');

/* 场景1：初次生成后直接重新分析，不警告 */
S.text = TEXT;
var r = D.runAnalysis(null, confirmSpy(true));
ok('A1. 初次分析执行成功', r === true && !!S.result);
var gen1 = S.draft;
ok('A2. 生成草稿非空且 baseDraft 与之一致', gen1.length > 0 && S.baseDraft === gen1);
confirmCalls = [];
r = D.runAnalysis(null, confirmSpy(true));
ok('A3. 未修改草稿重新分析不弹确认', r === true && confirmCalls.length === 0, 'calls=' + confirmCalls.length);
ok('A4. 重新分析后草稿仍为生成稿', S.draft === S.baseDraft && S.draft.length > 0);

/* 场景2+3：修改后重新分析→提示；选取消→原草稿与结果完整保留 */
S.draft = gen1 + '\n人工补充：请特别说明保修条款。';
ok('B1. 修改后 draftEdited 为真', D.draftEdited() === true);
var resultBefore = S.result;
confirmCalls = [];
r = D.runAnalysis(null, confirmSpy(false));
ok('B2. 修改后重新分析触发确认提示', confirmCalls.length === 1 && confirmCalls[0].indexOf('人工修改') >= 0, JSON.stringify(confirmCalls));
ok('B3. 取消后不执行分析（返回 false）', r === false);
ok('B4. 取消后人工草稿完整保留', S.draft === gen1 + '\n人工补充：请特别说明保修条款。');
ok('B5. 取消后分析结果对象未变', S.result === resultBefore);

/* 场景4：修改后选继续→正常重新分析，新草稿替换且可继续编辑 */
confirmCalls = [];
r = D.runAnalysis(null, confirmSpy(true));
ok('C1. 确认后执行重新分析', r === true && confirmCalls.length === 1);
ok('C2. 新草稿替换旧草稿且与 baseDraft 一致', S.draft === S.baseDraft && S.draft.indexOf('人工补充') < 0);
ok('C3. 替换后修改状态清除', D.draftEdited() === false);

/* 场景5：连续编辑以最新内容为准；改回原稿则不再算修改 */
S.draft = S.baseDraft + '第一处修改';
S.draft = S.baseDraft + '第二处修改（覆盖第一处）';
ok('D1. 连续编辑后仍识别为人工修改', D.draftEdited() === true);
confirmCalls = [];
r = D.runAnalysis(null, confirmSpy(false));
ok('D2. 取消保留的是最新人工内容', r === false && S.draft === S.baseDraft + '第二处修改（覆盖第一处）');
S.draft = S.baseDraft;
ok('D3. 改回与原稿完全一致后不再算修改', D.draftEdited() === false);
confirmCalls = [];
r = D.runAnalysis(null, confirmSpy(true));
ok('D4. 恢复原内容后重新分析不弹确认', r === true && confirmCalls.length === 0);

/* 场景6：删空草稿也算修改，取消后保留空草稿 */
S.draft = '';
ok('E1. 删空草稿识别为人工修改', D.draftEdited() === true);
r = D.runAnalysis(null, confirmSpy(false));
ok('E2. 取消后空草稿保留、分析未执行', r === false && S.draft === '' && S.result !== null);

/* 场景7：重新分析完成后再次编辑，保护仍然触发 */
r = D.runAnalysis(null, confirmSpy(true));
ok('F1. 确认后可再次完成分析', r === true && S.draft === S.baseDraft);
S.draft = S.draft + '再次人工修改';
confirmCalls = [];
r = D.runAnalysis(null, confirmSpy(false));
ok('F2. 再次编辑后保护再次触发且保留', confirmCalls.length === 1 && r === false && S.draft.indexOf('再次人工修改') >= 0);

/* 场景8：未传 confirmFn 时走全局 confirm（浏览器路径） */
S.draft = S.baseDraft + '全局路径修改';
var rootCalls = 0;
sb.confirm = function () { rootCalls++; return false; };
r = D.runAnalysis(null);
ok('G1. 无 confirmFn 时调用全局 confirm 并尊重取消', rootCalls === 1 && r === false && S.draft.indexOf('全局路径修改') >= 0);
delete sb.confirm;

/* ---------- 沙箱 B：不污染应用状态（商机草稿版本不受影响） ---------- */
var sb2 = makeSandbox();
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/seed-state.js'), 'utf8'), sb2, { filename: 'seed-state.js' });
var D2 = sb2.DecisionDesk;
var st = sb2.Core.get();
st.opps = st.opps || [];
st.opps.push({ id: 'test-opp-1', title: '虚构商机', replyDrafts: [{ v: 1, en: 'Original saved draft v1' }] });
sb2.Core.persist(st);
var snapshot = JSON.stringify(sb2.Core.get());
D2._state.text = TEXT;
D2.runAnalysis(null, function () { return true; });
D2._state.draft = D2._state.draft + '人工改动';
D2.runAnalysis(null, function () { return false; });
D2.runAnalysis(null, function () { return true; });
var after = sb2.Core.get();
ok('H1. 决策台全流程未改动应用状态', JSON.stringify(after) === snapshot);
ok('H2. 商机内草稿版本原样保留', after.opps.some(function (o) { return o.id === 'test-opp-1' && o.replyDrafts.length === 1 && o.replyDrafts[0].en === 'Original saved draft v1'; }));

console.log('== draft-protection: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
