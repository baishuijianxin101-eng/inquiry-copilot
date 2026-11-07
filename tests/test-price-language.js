/* P1-17 修复 C：谈判话术口径保护测试（纯 Node，全部虚构数据）
   运行：node tests/test-price-language.js
   全部断言落在最终生成的草稿文本上，而非中间计算值。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
global.window = global;
require('../assets/reply-assistant.js');
var RA = global.ReplyAssistant;
var P = { title: 'TWS Bluetooth Earbuds', sku: 'EB-01', category: '耳机', specs: 'Bluetooth 5.3', specsEn: 'Bluetooth 5.3', certs: ['CE', 'FCC'], moq: 500, leadTimeDays: 20, priceUsd: 8.9 };
function eff(target) {
  return { productName: 'TWS bluetooth earbuds', models: ['EB-01'], types: ['earbuds'], specs: [], qty: 1200, targetPriceUsd: target,
    country: '德国', destination: '', leadTimeDays: 30, deadlineText: '', certs: ['CE'], incoterm: 'FOB', purpose: '零售转售' };
}
function opp(raw) { return { rawText: raw || '', buyer: { name: 'Anna Meyer', company: 'Meyer GmbH' }, status: 'new', followCount: 0 }; }
function nego(target, price) {
  return RA.generate({ opp: opp('Target price discussion.'), eff: eff(target), product: P, match: null, price: price, sellerName: 'Jack' });
}

/* 1. 案例 E 参数：保本 8.17 < 目标 10.5 < 底价 10.8 → 中性底线措辞，绝不提成本 */
var rE = nego(10.5, { unit: 12.5, floor: 10.8, breakEven: 8.17 });
ok('E1. 英文不出现 production cost', rE.en.indexOf('production cost') < 0, rE.en);
ok('E2. 中文不出现生产成本', (rE.zh || '').indexOf('生产成本') < 0, rE.zh);
ok('E3. 英文使用底线措辞', rE.en.indexOf('lowest price we can accept') >= 0, rE.en);
ok('E4. 内部提示注明未用成本理由', rE.warnings.some(function (w) { return /未使用成本理由/.test(w); }), rE.warnings.join(';'));

/* 2. 目标价真低于保本 → 允许成本措辞 */
var rBelow = nego(5.0, { unit: 7.2, floor: 6.0, breakEven: 5.5 });
ok('B1. 低于保本时英文可用成本措辞', rBelow.en.indexOf('below our production cost') >= 0, rBelow.en);
ok('B2. 低于保本时中文可用成本措辞', (rBelow.zh || '').indexOf('生产成本') >= 0, rBelow.zh);

/* 3. 目标价等于保本 → 不得说低于成本 */
var rEq = nego(5.5, { unit: 7.2, floor: 6.0, breakEven: 5.5 });
ok('Q1. 等于保本时不出现成本措辞', rEq.en.indexOf('production cost') < 0 && (rEq.zh || '').indexOf('生产成本') < 0, rEq.en);

/* 4. 介于保本与底价之间 → 中性措辞 + 明确拒绝 */
var rMid = nego(5.8, { unit: 7.2, floor: 6.0, breakEven: 5.5 });
ok('M1. 区间内不出现成本措辞', rMid.en.indexOf('production cost') < 0, rMid.en);
ok('M2. 区间内仍明确拒绝目标价', rMid.en.indexOf('cannot accept') >= 0, rMid.en);
ok('M3. 策略说明注明不声称低于成本', /不声称低于成本/.test(rMid.strategy || ''), rMid.strategy);

/* 5. 高于底价 → 条件换空间分支不变，无成本措辞 */
var rAbove = nego(6.5, { unit: 7.2, floor: 6.0, breakEven: 5.5 });
ok('A1. 高于底价走条件分支且亮现价', rAbove.en.indexOf('current best price is $7.20') >= 0 && rAbove.en.indexOf('production cost') < 0, rAbove.en);

/* 6. 保本未知（旧调用方不传 breakEven）→ 保守中性措辞 */
var rNoBe = nego(5.0, { unit: 7.2, floor: 6.0 });
ok('U1. 保本未知时不出现成本措辞', rNoBe.en.indexOf('production cost') < 0 && (rNoBe.zh || '').indexOf('生产成本') < 0, rNoBe.en);

/* 7. 保本显式为 null → 同样中性 */
var rNullBe = nego(5.0, { unit: 7.2, floor: 6.0, breakEven: null });
ok('U2. 保本为 null 时不出现成本措辞', rNullBe.en.indexOf('production cost') < 0, rNullBe.en);

/* 8. 成本缺失（无安全价）→ 不承诺、不提成本 */
var rNoPrice = nego(6.5, null);
ok('N1. 无安全价时不出现成本措辞', rNoPrice.en.indexOf('production cost') < 0, rNoPrice.en);
ok('N2. 无安全价时明确不构成接受', rNoPrice.en.indexOf('do not treat this as acceptance') >= 0, rNoPrice.en);

/* 9. 底价缺失（floor=0 被 RA 校验拒绝为无价）→ 同无安全价处理 */
var rNoFloor = nego(5.0, { unit: 7.2, floor: 0, breakEven: 5.5 });
ok('F1. 底价缺失时不虚构底线、不出现成本措辞', rNoFloor.en.indexOf('production cost') < 0 && rNoFloor.en.indexOf('lowest price we can accept') < 0, rNoFloor.en);

/* 10. 成本与底价相等：目标低于该值即低于保本 → 成本措辞成立 */
var rEqBF = nego(5.5, { unit: 7.2, floor: 6.0, breakEven: 6.0 });
ok('S1. 成本=底价且目标更低时可用成本措辞', rEqBF.en.indexOf('below our production cost') >= 0, rEqBF.en);

/* 11. 数字溯源：客户可见文本只出现目标价与我方现价，保本/底价不外泄 */
ok('T1. 草稿含目标价 $10.50 与现价 $12.50', rE.en.indexOf('$10.50') >= 0 && rE.en.indexOf('$12.50') >= 0, rE.en);
ok('T2. 草稿不外泄保本 $8.17 与底价 $10.80', rE.en.indexOf('$8.17') < 0 && rE.en.indexOf('$10.80') < 0, rE.en);

/* 12. 决策台端到端（案例 E）：safePrice 已把保本传进 RA */
var sandbox = { console: console };
sandbox.window = sandbox;
var mm = {};
sandbox.localStorage = { getItem: function (k) { return k in mm ? mm[k] : null; }, setItem: function (k, v) { mm[k] = String(v); }, removeItem: function (k) { delete mm[k]; } };
vm.createContext(sandbox);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
 'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var D = sandbox.DecisionDesk;
var rxProd = { id: 'A1', sku: 'A1', title: 'RadioMaster XR4 Pro Receiver', titleEn: 'XR4 Pro Receiver', category: '', keywords: ['radiomaster xr4', 'xr4 pro', 'receiver'], specs: '2.4GHz', specsEn: '', certs: ['CE', 'FCC'], moq: 100, leadTimeDays: 15, stock: '', priceUsd: 12.5, priceFloorUsd: 10.8, costRmb: 58 };
var rDeskE = D.analyze('Hello, we bought your XR4 receiver before and it sold well. Please quote your best price for 2,000 pcs, target USD 10.5 per pc, FCC required.', [rxProd], { fxRate: 7.1, sellerName: 'Test' }, null);
var dEn = (rDeskE.reply && rDeskE.reply.en) || '', dZh = (rDeskE.reply && rDeskE.reply.zh) || '';
ok('D1. 端到端草稿不出现失实成本表述', dEn.indexOf('production cost') < 0 && dZh.indexOf('生产成本') < 0, dEn);
ok('D2. 端到端目标价引用正确（$10.50）', dEn.indexOf('target price of $10.50') >= 0, dEn.split('\n')[2]);

console.log('== price-language: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
