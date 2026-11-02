/* 阶段三：商机价值评分单元测试（纯 Node，无依赖）
   运行：node tests/test-opp-score.js
   全部虚构数据；只验证规则行为，不涉及真实经营数据与成本。 */
'use strict';
global.window = global;
require('../assets/opp-score.js');
var OS = global.OppScore;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function dimOf(r, key) { return r.dims.filter(function (d) { return d.key === key; })[0]; }
function effFull() {
  return { productName: 'TWS bluetooth earbuds', models: ['EB-01'], types: ['earbuds'], specs: [{ name: '颜色', value: 'black' }, { name: '材质', value: 'ABS' }],
    qty: 1200, targetPriceUsd: 6.5, country: '德国', destination: 'Hamburg', leadTimeDays: 30, deadlineText: '', certs: ['CE'], incoterm: 'FOB', purpose: '零售转售', edited: {} };
}
function effEmpty() {
  return { productName: '', models: [], types: [], specs: [], qty: 0, targetPriceUsd: 0, country: '', destination: '', leadTimeDays: 0, deadlineText: '', certs: [], incoterm: '', purpose: '', edited: {} };
}
function oppBase(raw) {
  return { status: 'new', rawText: raw || '', drafts: {}, followCount: 0, followLog: [], log: [] };
}

/* 1. 信息完整但采购意向不明确 → 不能进高优先级 */
var r1 = OS.score({ opp: oppBase('Hello, we saw this product on your page. Please send information about it.'), eff: effFull(), match: { score: 90, keyConflict: false }, moq: 500 });
ok('意向维度低（只有询盘本身）', dimOf(r1, 'intent').score <= 6, 'intent=' + dimOf(r1, 'intent').score);
ok('总分不低但被意向门槛挡住，不是高优先级', r1.level !== 'high', 'level=' + r1.level + ' total=' + r1.total);
ok('理由写明未见明确采购信号', dimOf(r1, 'intent').reasons.some(function (x) { return x.indexOf('未见明确采购信号') >= 0; }));

/* 2. 信息不完整但采购信号明确 → 高优先级 */
var eff2 = effEmpty(); eff2.qty = 3000; eff2.productName = 'electric kettle';
var r2 = OS.score({ opp: oppBase('Please quote your best price for the kettle. We will place an order this week, need 3000 pcs.'), eff: eff2, match: { score: 70, keyConflict: false }, moq: 500 });
ok('意向信号被识别（报价+下单）', r2.intentSignals.length >= 2, r2.intentSignals.join(','));
ok('意向维度高', dimOf(r2, 'intent').score >= 18, 'intent=' + dimOf(r2, 'intent').score);
ok('信息不全仍进高优先级', r2.level === 'high', 'level=' + r2.level + ' total=' + r2.total);
ok('行动建议是今天内处理', r2.action.indexOf('今天内') >= 0);

/* 3. 商品型号/规格关键冲突 → 匹配维度封顶，且列入可改变因素 */
var r3 = OS.score({ opp: oppBase('Please quote. We will place an order.'), eff: effFull(), match: { score: 49, keyConflict: true }, moq: 500 });
ok('冲突时匹配维度 ≤4', dimOf(r3, 'match').score <= 4, 'match=' + dimOf(r3, 'match').score);
ok('改变因素包含解决冲突', r3.changeFactors.some(function (x) { return x.text.indexOf('冲突') >= 0; }));

/* 4. 数量低于 MOQ → 数量维度只给部分分且写明原因 */
var eff4 = effFull(); eff4.qty = 100;
var r4 = OS.score({ opp: oppBase('Please quote.'), eff: eff4, match: { score: 80, keyConflict: false }, moq: 500 });
ok('低于 MOQ 数量维度=10', dimOf(r4, 'qty').score === 10, 'qty=' + dimOf(r4, 'qty').score);
ok('原因写明低于 MOQ', dimOf(r4, 'qty').reasons.some(function (x) { return x.indexOf('低于起订量') >= 0; }));
ok('改变因素提示提到 MOQ', r4.changeFactors.some(function (x) { return x.text.indexOf('MOQ') >= 0; }));

/* 5. 买家明确要求报价 → 意向信号与分数到位 */
var r5 = OS.score({ opp: oppBase('Hi, please quote for 500 pcs and send your price list.'), eff: effEmpty(), match: null, moq: 0 });
ok('识别出明确要求报价', r5.intentSignals.indexOf('明确要求报价') >= 0, r5.intentSignals.join(','));
ok('意向维度 ≥13', dimOf(r5, 'intent').score >= 13, 'intent=' + dimOf(r5, 'intent').score);

/* 6. 修正解析后评分变化：补上数量与型号，总分明显上升 */
var before = OS.score({ opp: oppBase('Please quote your best price.'), eff: effEmpty(), match: { score: 60, keyConflict: false }, moq: 500 });
var eff6 = effEmpty(); eff6.qty = 2000; eff6.models = ['EB-01']; eff6.productName = 'TWS earbuds';
var after = OS.score({ opp: oppBase('Please quote your best price.'), eff: eff6, match: { score: 60, keyConflict: false }, moq: 500 });
ok('修正后总分上升 ≥15', after.total - before.total >= 15, before.total + ' → ' + after.total);

/* 7. 已完成商机 → closed，不占优先级 */
var o7 = oppBase('Please quote.'); o7.status = 'won';
var r7 = OS.score({ opp: o7, eff: effFull(), match: { score: 90, keyConflict: false }, moq: 500 });
ok('已成交为 closed', r7.level === 'closed' && r7.closed === true);
var o7b = oppBase('Please quote.'); o7b.status = 'lost';
ok('已丢单为 closed', OS.score({ opp: o7b, eff: effFull(), match: null, moq: 0 }).level === 'closed');

/* 8. 目标价再低也不扣价值分（同等条件下总分一致） */
var eff8a = effFull(); eff8a.targetPriceUsd = 0.5;
var eff8b = effFull(); eff8b.targetPriceUsd = 50;
var t8a = OS.score({ opp: oppBase('Please quote.'), eff: eff8a, match: { score: 80, keyConflict: false }, moq: 500 }).total;
var t8b = OS.score({ opp: oppBase('Please quote.'), eff: eff8b, match: { score: 80, keyConflict: false }, moq: 500 }).total;
ok('目标价高低不影响总分', t8a === t8b, t8a + ' vs ' + t8b);

/* 9. 长询盘不加意向分：长但无信号 vs 短而明确 */
var longText = ('We are a trading company based in Europe. ' +
  'Our company was founded many years ago and we have many clients in different countries. ' +
  'We are writing to learn more about your company and your product range in general. ').repeat(3);
var r9 = OS.score({ opp: oppBase(longText), eff: effEmpty(), match: null, moq: 0 });
ok('长文本无信号时意向仍只有基线分', dimOf(r9, 'intent').score === 3, 'intent=' + dimOf(r9, 'intent').score);

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
