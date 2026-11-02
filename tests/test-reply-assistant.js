/* 阶段四：AI 回复助手单元测试（纯 Node，无依赖）
   运行：node tests/test-reply-assistant.js
   全部虚构数据；重点验证不编造、不乱承诺、价格护栏与场景判定。 */
'use strict';
global.window = global;
require('../assets/reply-assistant.js');
var RA = global.ReplyAssistant;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var P = { title: 'TWS Bluetooth Earbuds', sku: 'EB-01', category: '耳机', specs: 'Bluetooth 5.3, battery 30h', specsEn: 'Bluetooth 5.3, 30h playtime', certs: ['CE', 'FCC'], moq: 500, leadTimeDays: 20, priceUsd: 8.9 };
var P_BARE = { title: 'Simple Water Bottle', sku: 'WB-1', category: '水杯', specs: '', specsEn: '', certs: [], moq: 100, leadTimeDays: 0, priceUsd: 0 };
function effFull() {
  return { productName: 'TWS bluetooth earbuds', models: ['EB-01'], types: ['earbuds'], specs: [], qty: 1200, targetPriceUsd: 0,
    country: '德国', destination: '', leadTimeDays: 30, deadlineText: '', certs: ['CE'], incoterm: 'FOB', purpose: '零售转售' };
}
function effEmpty() {
  return { productName: '', models: [], types: [], specs: [], qty: 0, targetPriceUsd: 0, country: '', destination: '', leadTimeDays: 0, deadlineText: '', certs: [], incoterm: '', purpose: '' };
}
function opp(raw, extra) {
  var o = { rawText: raw || '', buyer: { name: 'Anna Meyer', company: 'Meyer GmbH' }, status: 'new', followCount: 0 };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}

/* 1. 首次回复：信息较全 + 有安全价 → 直接给价，写到的规格/认证都来自商品 */
var r1 = RA.generate({ opp: opp('Please quote for 1200 pcs earbuds.'), eff: effFull(), product: P, match: { score: 90, keyConflict: false, conflicts: [] }, price: { unit: 7.2, floor: 6.0 }, sellerName: 'Jack' });
ok('场景=首次回复', r1.scenario === 'first', r1.scenario);
ok('英文含安全价', r1.en.indexOf('$7.20') >= 0);
ok('英文含已登记规格', r1.en.indexOf('Bluetooth 5.3') >= 0);
ok('英文含已登记认证', r1.en.indexOf('CE') >= 0);
ok('中文对照非空且含价格', r1.zh.length > 50 && r1.zh.indexOf('$7.20') >= 0);
ok('目的与策略齐全', !!r1.purpose && !!r1.strategy && !!r1.strategyLabel);

/* 2. 防编造：裸商品（无认证/无交期/无规格）不能写出这些信息 */
var r2 = RA.generate({ opp: opp('Hi, interested in your bottle.'), eff: effEmpty(), product: P_BARE, match: null, price: null, scenario: 'spec' });
ok('不编造认证', !/CE|FCC|RoHS/.test(r2.en), r2.en);
ok('不编造交期天数', !/\d+\s*days/.test(r2.en), r2.en);
ok('不声称有库存', !/in stock/i.test(r2.en));
ok('未确认清单含规格未登记', r2.unconfirmed.some(function (x) { return x.indexOf('规格未') >= 0 || x.indexOf('规格未在') >= 0; }), r2.unconfirmed.join(','));

/* 3. 报价前确认：缺数量与目的地 → 自动判定 prequote 并发问 */
var r3 = RA.generate({ opp: opp('Hello, I like this product.'), eff: effEmpty(), product: P, match: null, price: null });
ok('场景=报价前确认', r3.scenario === 'prequote', r3.scenario);
ok('英文问了数量', /quantity/.test(r3.en));
ok('英文问了目的地', /destination/.test(r3.en));
ok('没有乱报价格', !/\$\d/.test(r3.en), r3.en);

/* 4. 规格解释：买家问 specifications → spec 场景，内容来自商品登记 */
var r4 = RA.generate({ opp: opp('Please send the full specifications.'), eff: effFull(), product: P, match: null, price: null });
ok('场景=规格解释', r4.scenario === 'spec', r4.scenario);
ok('英文给出登记规格', r4.en.indexOf('30h playtime') >= 0);

/* 5. MOQ 沟通：数量 100 < MOQ 500 → moq 场景，给台阶不承诺同价 */
var eff5 = effFull(); eff5.qty = 100; eff5.targetPriceUsd = 0;
var r5 = RA.generate({ opp: opp('We need 100 pcs first.'), eff: eff5, product: P, match: null, price: null });
ok('场景=MOQ沟通', r5.scenario === 'moq', r5.scenario);
ok('英文写明 MOQ 500', r5.en.indexOf('500') >= 0);
ok('给了样品台阶', /sample/i.test(r5.en));

/* 6. 谈判（底价之上）：亮现价、给条件，不承诺接受目标价 */
var eff6 = effFull(); eff6.targetPriceUsd = 6.5;
var r6 = RA.generate({ opp: opp('Your price is high. Our target is USD 6.50.'), eff: eff6, product: P, match: null, price: { unit: 7.2, floor: 6.0 } });
ok('场景=价格谈判', r6.scenario === 'negotiation', r6.scenario);
ok('策略=以条件换让步', r6.strategyLabel.indexOf('条件') >= 0, r6.strategyLabel);
ok('亮明我方现价', r6.en.indexOf('$7.20') >= 0);
ok('未承诺接受目标价', !/we (accept|agree to|can do)\s*(\$|your target)/i.test(r6.en), r6.en);

/* 7. 谈判（低于底价）：守底价 + 警告，绝不按目标价承诺 */
var eff7 = effFull(); eff7.targetPriceUsd = 5.0;
var r7 = RA.generate({ opp: opp('We can only pay USD 5.00.'), eff: eff7, product: P, match: null, price: { unit: 7.2, floor: 6.0 } });
ok('策略=守底价', r7.strategyLabel.indexOf('守底价') >= 0, r7.strategyLabel);
ok('给出卖家警告（低于底价）', r7.warnings.some(function (w) { return w.indexOf('低于') >= 0 && w.indexOf('底价') >= 0; }), r7.warnings.join(';'));
ok('正文未承诺目标价', !/accept[^.]*\$5\.00/i.test(r7.en) && r7.en.indexOf('cannot accept') >= 0, r7.en.split('\n')[2]);

/* 8. 谈判（无安全价）：一个数字都不报我方价格 */
var r8 = RA.generate({ opp: opp('Target USD 6.50, please confirm.'), eff: eff6, product: P, match: null, price: null });
ok('无价谈判不出现我方报价', r8.en.indexOf('$7.20') < 0, '');
ok('策略=先稳住不承诺', r8.strategyLabel.indexOf('不承诺') >= 0, r8.strategyLabel);
ok('警告说明未写价格', r8.warnings.length >= 1);

/* 9. 样品：索样 → sample 场景，确认地址，不承诺免费/时效 */
var r9 = RA.generate({ opp: opp('Please send samples for testing.'), eff: effFull(), product: P, match: null, price: null });
ok('场景=样品', r9.scenario === 'sample', r9.scenario);
ok('英文请确认地址', /address/i.test(r9.en));
ok('不承诺免费样品', !/free sample/i.test(r9.en));

/* 10. 关键冲突：强制 clarify，即使手动指定 first；不把错商品当确定推荐 */
var r10 = RA.generate({ opp: opp('Need the ES900 receiver.'), eff: effFull(), product: P, match: { score: 40, keyConflict: true, conflicts: ['型号不符：买家要 ES900，商品是 EB-01'] }, price: { unit: 7.2, floor: 6.0 }, scenario: 'first' });
ok('冲突强制切核实场景', r10.scenario === 'clarify', r10.scenario);
ok('警告写明关键冲突', r10.warnings.some(function (w) { return w.indexOf('关键冲突') >= 0; }));
ok('正文要求核实确认', /double-check|confirm/i.test(r10.en));
ok('正文不出现推荐话术', !/we recommend/i.test(r10.en));
ok('正文不报价格', !/\$7\.20/.test(r10.en));

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
