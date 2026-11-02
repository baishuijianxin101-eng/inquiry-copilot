/* 阶段一：询盘解析单元测试（纯 Node，无依赖）
   运行：node tests/test-inquiry-parse.js
   全部使用虚构询盘文本，只验证解析行为，不涉及任何真实数据。 */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;

var pass = 0, fail = 0;
function eq(name, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, '| got:', JSON.stringify(got), '| want:', JSON.stringify(want)); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

var DEMO = 'Dear Sales Manager,\n\nWe are a consumer electronics distributor based in Hamburg, Germany. ' +
  'We are looking for TWS bluetooth earbuds with charging case, in-ear type, for our retail chain (about 40 stores).\n\n' +
  'Quantity: 1,200 pcs for the first order\nTarget price: around USD 6.50 per piece, FOB\n' +
  'Requirement: CE, RoHS and FCC certificates, white and black colors\nLead time: within 30 days\n\n' +
  'Please send your best quotation and MOQ.';

/* 1. 完整询盘：既有字段不回归 + 新字段抽得准 */
var r = P.extract(DEMO);
eq('qty 不回归', r.fields.qty, 1200);
eq('USD 前置目标价', r.fields.targetPriceUsd, 6.5);
eq('认证不回归', r.fields.certs, ['CE', 'RoHS', 'FCC']);
eq('交期不回归', r.fields.deadlineDays, 30);
eq('商品名称', r.fields.productName, 'TWS bluetooth earbuds with charging case');
eq('用途=零售转售', r.fields.purpose, '零售转售');
ok('商品名带原文证据', !!r.evidence.productName);
ok('用途带原文证据', !!r.evidence.purpose);
ok('信息较全时 blocking 为空或不含 productName', r.blocking.indexOf('productName') < 0);

/* 2. 电商 + 电器规格 */
r = P.extract('Hi, we sell on Amazon US. Interested in your 220V 1500W electric kettle 1.8L, need 3000 units for our online store. Ship to Los Angeles port, CIF.');
eq('用途=电商销售', r.fields.purpose, '电商销售');
eq('商品名不被小数点切断', r.fields.productName, '220V 1500W electric kettle 1.8L');
eq('数量', r.fields.qty, 3000);
var specNames = r.fields.specs.map(function (s) { return s.name; });
ok('规格含电压/功率/容量', specNames.indexOf('电压') >= 0 && specNames.indexOf('功率') >= 0 && specNames.indexOf('容量') >= 0, specNames.join(','));
eq('目的地', r.fields.destination, 'Los Angeles');

/* 3. 工程项目 + "we need + 数量" 句式 */
r = P.extract('We need 5000 pcs LED strip lights for a construction project in Dubai. Delivery within 45 days.');
eq('用途=工程项目', r.fields.purpose, '工程项目');
eq('商品名不带用途尾巴', r.fields.productName, 'LED strip lights');
eq('数量', r.fields.qty, 5000);

/* 4. 信息稀薄：不编造，进待确认 */
r = P.extract('Hello, please quote price. We want to buy some products.');
eq('泛称不冒充商品名', r.fields.productName, '');
eq('没写用途就是空', r.fields.purpose, '');
ok('待确认含 productName', r.needsReview.some(function (x) { return x.field === 'productName'; }));
ok('待确认含 purpose', r.needsReview.some(function (x) { return x.field === 'purpose'; }));
ok('待确认含 qty（high 拦截项）', r.blocking.indexOf('qty') >= 0);

/* 5. 自用 / 定制品牌 */
r = P.extract('We are looking for 200 pcs office chairs for our own use in the new office.');
eq('用途=自用', r.fields.purpose, '自用');
r = P.extract('Please quote 10000 pcs water bottles with our logo, private label is required.');
eq('用途=定制品牌', r.fields.purpose, '定制品牌');

/* 6. 人工修正 applyEdits：覆盖字段并移出待确认 */
var base = P.extract(DEMO);
var ed = P.applyEdits(base, { purpose: '自用', qty: 2000, productName: 'TWS earbuds ANC' });
eq('修正用途生效', ed.fields.purpose, '自用');
eq('修正数量生效', ed.fields.qty, 2000);
eq('修正商品名生效', ed.fields.productName, 'TWS earbuds ANC');
ok('edited 标记齐全', ed.edited.indexOf('purpose') >= 0 && ed.edited.indexOf('qty') >= 0);
eq('applyEdits 不改原对象', base.fields.qty, 1200);

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
