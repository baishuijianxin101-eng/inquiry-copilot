/* P1-17 修复 A：价格角色识别测试（纯 Node，全部虚构数据）
   运行：node tests/test-price-roles.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var sandbox = { console: console };
sandbox.window = sandbox;
var m = {};
sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
vm.createContext(sandbox);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
 'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var P = sandbox.P0Parse, D = sandbox.DecisionDesk;
function roleOf(r, v) {
  var ms = (r.fields.priceMentions || []).filter(function (x) { return x.value === v; });
  return ms.length ? ms[0].role : '(missing)';
}

/* 1. 案例 C：三价格同场，角色各归其位，目标价=102 */
var caseC = 'Your Vortex 3 drone price USD 129 is too high for us. Another supplier offers a similar drone at USD 100. We can order 300 pcs if you can meet USD 102 per pc.';
var rC = P.extract(caseC);
ok('C1. 目标价取 102（客户目标价）', rC.fields.targetPriceUsd === 102, String(rC.fields.targetPriceUsd));
ok('C2. 129 标为我方报价', roleOf(rC, 129) === 'OUR_QUOTE', roleOf(rC, 129));
ok('C3. 100 标为竞品报价', roleOf(rC, 100) === 'COMPETITOR_QUOTE', roleOf(rC, 100));
ok('C4. 102 标为客户目标价', roleOf(rC, 102) === 'CUSTOMER_TARGET', roleOf(rC, 102));

/* 2. 只有我方报价：不写入目标价 */
var rOur = P.extract('Your price is USD 25 per pc for the pump. Please give a better price.');
ok('O1. 只有我方报价时目标价为 0', rOur.fields.targetPriceUsd === 0, String(rOur.fields.targetPriceUsd));
ok('O2. 25 标为我方报价', roleOf(rOur, 25) === 'OUR_QUOTE', roleOf(rOur, 25));

/* 3. 只有竞品报价：不写入目标价 */
var rComp = P.extract('Another supplier quoted USD 8.5 for the same item. Can you do better?');
ok('P1. 只有竞品报价时目标价为 0', rComp.fields.targetPriceUsd === 0, String(rComp.fields.targetPriceUsd));
ok('P2. 8.5 标为竞品报价', roleOf(rComp, 8.5) === 'COMPETITOR_QUOTE', roleOf(rComp, 8.5));

/* 4. 只有客户目标价：正常写入（旧行为保留） */
var rTgt = P.extract('Our target price is USD 6.2 per pc for 800 pcs earbuds.');
ok('T1. 单一目标价写入 6.2', rTgt.fields.targetPriceUsd === 6.2, String(rTgt.fields.targetPriceUsd));

/* 5. 预算与目标价同场：预算不冒充目标价 */
var rBud = P.extract('Our budget is USD 5 per pc, but our target price is USD 4.6. Please check.');
ok('B1. 目标价取 4.6 而非预算 5', rBud.fields.targetPriceUsd === 4.6, String(rBud.fields.targetPriceUsd));
ok('B2. 5 标为客户预算', roleOf(rBud, 5) === 'CUSTOMER_BUDGET', roleOf(rBud, 5));

/* 6. 角色无法判断：UNKNOWN，不写入 */
var rUnk = P.extract('This item sells for USD 30 in local shops here. What is your wholesale price?');
ok('U1. 无语义价格不写入目标价', rUnk.fields.targetPriceUsd === 0, String(rUnk.fields.targetPriceUsd));
ok('U2. 30 标为角色未定', roleOf(rUnk, 30) === 'UNKNOWN_PRICE', roleOf(rUnk, 30));

/* 7. 多个候选目标价：不自动赋值，列入候选并提示确认 */
var rMulti = P.extract('Our target price is USD 9. If not possible, we can accept USD 9.5 per pc.');
ok('M1. 多候选时目标价为 0', rMulti.fields.targetPriceUsd === 0, String(rMulti.fields.targetPriceUsd));
ok('M2. 候选清单含 9 与 9.5', rMulti.fields.priceTargetCandidates.length === 2, JSON.stringify(rMulti.fields.priceTargetCandidates));
ok('M3. 解析提示要求确认目标价', (rMulti.needsReview || []).some(function (n) { return n.field === 'targetPriceUsd' && /多个/.test(n.why); }), JSON.stringify(rMulti.needsReview));

/* 8. 非 USD 目标价：不伪装成 USD 目标价 */
var rEur = P.extract('Our target price is EUR 10 per pc for 500 pcs.');
ok('E1. EUR 目标价不写入 USD 目标价', rEur.fields.targetPriceUsd === 0, String(rEur.fields.targetPriceUsd));
ok('E2. 提及保留币种 EUR 与目标角色', (function () { var ms = rEur.fields.priceMentions.filter(function (x) { return x.value === 10; }); return ms.length && ms[0].currency === 'EUR' && ms[0].role === 'CUSTOMER_TARGET'; })(), JSON.stringify(rEur.fields.priceMentions));

/* 9. 否定语境：被拒绝的价格不是目标价 */
var rNeg = P.extract('We cannot pay USD 12, we can do USD 10 per pc for 500 pcs receivers.');
ok('N1. 被拒的 12 不作目标价', roleOf(rNeg, 12) === 'UNKNOWN_PRICE', roleOf(rNeg, 12));
ok('N2. 可接受的 10 成为目标价', rNeg.fields.targetPriceUsd === 10 && roleOf(rNeg, 10) === 'CUSTOMER_TARGET', String(rNeg.fields.targetPriceUsd));

/* 10. 总价语境：总价不作单价目标价（G1） */
var rTot = P.extract('Total USD 5,000 for 1,000 pcs receivers, please confirm.');
ok('G1a. 总价 5000 标为角色未定', roleOf(rTot, 5000) === 'UNKNOWN_PRICE', roleOf(rTot, 5000));
ok('G1b. 总价不写入目标价', rTot.fields.targetPriceUsd === 0, String(rTot.fields.targetPriceUsd));

/* 11. 区间价：不自动赋值（G1） */
var rRange = P.extract('Our target is USD 4.5-5 per pc for 1000 pcs receivers.');
ok('G1c. 区间价标记 range 且不写入目标价', rRange.fields.targetPriceUsd === 0 && (rRange.fields.priceMentions[0] || {}).range === true, JSON.stringify(rRange.fields.priceMentions));

/* 12. 端到端：决策台草稿引用正确的目标价，绝不把我方报价说成目标价 */
var prods = [{ id: 'PX', sku: 'PX', title: 'Generic Drone X1', titleEn: 'Generic Drone X1', category: '', keywords: ['drone'], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '', priceUsd: 150, priceFloorUsd: 0, costRmb: 800 }];
var rDesk = D.analyze(caseC, prods, { fxRate: 7.1, sellerName: 'Test' }, null);
var draftEn = (rDesk.reply && rDesk.reply.en) || '';
ok('D1. 决策台 eff 目标价为 102', rDesk.eff.targetPriceUsd === 102, String(rDesk.eff.targetPriceUsd));
ok('D2. 草稿不出现「target price of $129」', draftEn.indexOf('target price of $129') < 0, draftEn.split('\n')[2]);
ok('D3. 草稿如引用目标价只能是 102', draftEn.indexOf('target price of') < 0 || draftEn.indexOf('target price of $102.00') >= 0, draftEn.split('\n')[2]);

console.log('== price-roles: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
