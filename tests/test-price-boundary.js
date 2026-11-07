/* P1-17 第三阶段修复 A/B：小数句界、同句多价格局部角色、否定与历史价格（纯 Node，全部虚构数据）
   运行：node tests/test-price-boundary.js */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function roleOf(r, v) {
  var ms = (r.fields.priceMentions || []).filter(function (x) { return x.value === v; });
  return ms.length ? ms[0].role : '(missing)';
}
function snipOf(r, v) {
  var ms = (r.fields.priceMentions || []).filter(function (x) { return x.value === v; });
  return ms.length ? ms[0].snippet : '';
}

/* A1. 小数点不截断句子：四条任务书原文 */
var a1 = P.extract('Our target price is USD 10.50 per pc.');
ok('A1a. 10.50 数值完整且为目标价', a1.fields.targetPriceUsd === 10.5 && roleOf(a1, 10.5) === 'CUSTOMER_TARGET', JSON.stringify(a1.fields.priceMentions));
ok('A1b. 10.50 证据片段含完整小数', /10\.50/.test(snipOf(a1, 10.5)), snipOf(a1, 10.5));
var a2 = P.extract('Another supplier offers USD 8.17. Our target is USD 7.90.');
ok('A2a. 8.17 为竞品报价（句号后不串句）', roleOf(a2, 8.17) === 'COMPETITOR_QUOTE', roleOf(a2, 8.17));
ok('A2b. 7.90 为目标价并写入', a2.fields.targetPriceUsd === 7.9 && roleOf(a2, 7.9) === 'CUSTOMER_TARGET', JSON.stringify(a2.fields.priceMentions));
var a3 = P.extract('Our price is USD 129.99, but your target is USD 120.00.');
ok('A3a. 129.99 为我方报价', roleOf(a3, 129.99) === 'OUR_QUOTE', roleOf(a3, 129.99));
ok('A3b. 120.00 为目标价并写入', a3.fields.targetPriceUsd === 120 && roleOf(a3, 120) === 'CUSTOMER_TARGET', JSON.stringify(a3.fields.priceMentions));
var a4 = P.extract('USD 10.50 is too expensive. We can accept USD 9.80.');
ok('A4a. 被斥贵的 10.50 不作目标价', roleOf(a4, 10.5) === 'UNKNOWN_PRICE', roleOf(a4, 10.5));
ok('A4b. 可接受的 9.80 写入目标价', a4.fields.targetPriceUsd === 9.8, String(a4.fields.targetPriceUsd));

/* A2. 边界组合：换行分隔、中文标点、多句多价格 */
var a5 = P.extract('Your price is USD 30.\nOur target price is USD 25.');
ok('A5. 换行分句：30 我方 / 25 目标', roleOf(a5, 30) === 'OUR_QUOTE' && roleOf(a5, 25) === 'CUSTOMER_TARGET' && a5.fields.targetPriceUsd === 25, JSON.stringify(a5.fields.priceMentions));
var a6 = P.extract('你们的报价是 USD 40。我们的目标价是 USD 35。');
ok('A6. 中文句号分句：40 我方 / 35 目标', roleOf(a6, 40) === 'OUR_QUOTE' && a6.fields.targetPriceUsd === 35, JSON.stringify(a6.fields.priceMentions));

/* B1. 同句多价格局部归属（任务书原文两例） */
var b1 = P.extract('Another supplier offers USD 100, but our target price is USD 95.');
ok('B1a. 同句竞品 100 不污染目标 95', roleOf(b1, 100) === 'COMPETITOR_QUOTE' && roleOf(b1, 95) === 'CUSTOMER_TARGET' && b1.fields.targetPriceUsd === 95, JSON.stringify(b1.fields.priceMentions));
var b2 = P.extract('Your quoted price is USD 129. Our target is USD 102, while another supplier offers USD 100.');
ok('B1b. 三价格同段各归其位', roleOf(b2, 129) === 'OUR_QUOTE' && roleOf(b2, 102) === 'CUSTOMER_TARGET' && roleOf(b2, 100) === 'COMPETITOR_QUOTE' && b2.fields.targetPriceUsd === 102, JSON.stringify(b2.fields.priceMentions));

/* B3. 否定、拒绝、历史与现付（任务书八例） */
var n1 = P.extract('We cannot pay USD 12, but we can do USD 10 per pc.');
ok('N1. cannot pay 的 12 未知 / can do 的 10 目标', roleOf(n1, 12) === 'UNKNOWN_PRICE' && n1.fields.targetPriceUsd === 10, JSON.stringify(n1.fields.priceMentions));
var n2 = P.extract('USD 12 cannot be accepted.');
ok('N2. 后置 cannot be accepted → 未知', roleOf(n2, 12) === 'UNKNOWN_PRICE' && n2.fields.targetPriceUsd === 0, roleOf(n2, 12));
var n3 = P.extract('USD 12 is not acceptable.');
ok('N3. not acceptable → 未知', roleOf(n3, 12) === 'UNKNOWN_PRICE', roleOf(n3, 12));
var n4 = P.extract('USD 12 is too expensive.');
ok('N4. too expensive → 未知', roleOf(n4, 12) === 'UNKNOWN_PRICE', roleOf(n4, 12));
var n5 = P.extract('We are currently paying USD 12 for this item.');
ok('N5. 当前支付价 → 未知（非目标价）', roleOf(n5, 12) === 'UNKNOWN_PRICE' && n5.fields.targetPriceUsd === 0, roleOf(n5, 12));
var n6 = P.extract('We used to buy this at USD 12.');
ok('N6. 历史成交价 → 未知', roleOf(n6, 12) === 'UNKNOWN_PRICE', roleOf(n6, 12));
var n7 = P.extract('Our target price is not USD 12. It is USD 10.');
ok('N7. 被否定的 12 不作目标价；跨句指代的 10 保守未知', roleOf(n7, 12) === 'UNKNOWN_PRICE' && n7.fields.targetPriceUsd === 0, JSON.stringify(n7.fields.priceMentions));
var n8 = P.extract('We can accept USD 10, but USD 12 is too high.');
ok('N8. 接受的 10 为目标 / 太高的 12 未知', n8.fields.targetPriceUsd === 10 && roleOf(n8, 12) === 'UNKNOWN_PRICE', JSON.stringify(n8.fields.priceMentions));

console.log('== price-boundary: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
