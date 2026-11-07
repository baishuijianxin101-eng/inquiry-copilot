/* P1-17 第四阶段修复 C：竞品报价与拒绝价格混合、跨句指代保守（纯 Node，全部虚构数据）
   运行：node tests/test-price-role-phase4.js */
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

/* 竞品 + 拒绝组合组（任务书 C1 四例 + 副词变体） */
var c1 = P.extract('Another supplier quoted USD 100, but we cannot accept USD 95.');
ok('C1a. 竞品 100 保持竞品角色', roleOf(c1, 100) === 'COMPETITOR_QUOTE', roleOf(c1, 100));
ok('C1b. 被拒 95 判未知且不赋值', roleOf(c1, 95) === 'UNKNOWN_PRICE' && c1.fields.targetPriceUsd === 0, roleOf(c1, 95));
var c2 = P.extract('Another supplier offers USD 100. We cannot accept USD 95. Our target is USD 90.');
ok('C2. 跨句三价格：100 竞品 / 95 未知 / 90 目标', roleOf(c2, 100) === 'COMPETITOR_QUOTE' && roleOf(c2, 95) === 'UNKNOWN_PRICE' && c2.fields.targetPriceUsd === 90, JSON.stringify(c2.fields.priceMentions));
var c3 = P.extract('Your quoted price is USD 129, but we cannot accept USD 120. Our target price is USD 102.');
ok('C3. 我方 129 / 被拒 120 未知 / 目标 102', roleOf(c3, 129) === 'OUR_QUOTE' && roleOf(c3, 120) === 'UNKNOWN_PRICE' && c3.fields.targetPriceUsd === 102, JSON.stringify(c3.fields.priceMentions));
var c4 = P.extract('Another supplier offers USD 100, but we can accept USD 95.');
ok('C4. 可接受的 95 仍为目标价（否定规则不误伤）', roleOf(c4, 100) === 'COMPETITOR_QUOTE' && c4.fields.targetPriceUsd === 95, JSON.stringify(c4.fields.priceMentions));
var c5 = P.extract('Another supplier quoted USD 100, but we cannot possibly accept USD 95.');
ok('C5. cannot possibly accept 的 95 判未知（副词间隔）', roleOf(c5, 95) === 'UNKNOWN_PRICE' && c5.fields.targetPriceUsd === 0, roleOf(c5, 95));

/* 跨句指代保守组（3）：不强行建立指代关联 */
var x1 = P.extract('The competitor offers USD 100. It is too expensive. We can accept USD 90.');
ok('X1. 指代不明时只认明确目标 90，竞品 100 不变', roleOf(x1, 100) === 'COMPETITOR_QUOTE' && x1.fields.targetPriceUsd === 90, JSON.stringify(x1.fields.priceMentions));
var x2 = P.extract('Our target price is not USD 12. It is USD 10.');
ok('X2. 跨句指代的 10 保守不赋值（与第三阶段口径一致）', x2.fields.targetPriceUsd === 0 && roleOf(x2, 12) === 'UNKNOWN_PRICE', JSON.stringify(x2.fields.priceMentions));
var x3 = P.extract('Another supplier charges USD 50 for it. That price is too high for us.');
ok('X3. 无第二价格时不虚构目标价', x3.fields.targetPriceUsd === 0 && roleOf(x3, 50) === 'COMPETITOR_QUOTE', JSON.stringify(x3.fields.priceMentions));

console.log('== price-role-phase4: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
