/* 定价口径统一：单元测试（纯 Node）
   运行：node tests/test-pricing-unity.js
   全部虚构数字；只验证展示/判定层口径，不涉及真实成本。 */
'use strict';
global.window = global;
require('../assets/pricing-unity.js');
var PU = global.PricingUnity;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function ev(over) {
  var base = { listUsd: 15.43, recommendUsd: 15.48, floorUsd: 14.20, unitPriceUsd: 15.48, qty: 100, feeRate: 0.03, flags: { noCost: false, canQuote: true } };
  Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
  return base;
}
function prod(over) {
  var p = { priceUsd: 15.43, priceFloorUsd: 0 };
  Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
  return p;
}

/* 1. 正常情况：五价各归其位，可报价 */
var r1 = PU.resolve({ evaluate: ev(), product: prod({ priceFloorUsd: 13.5 }), unitUsd: 15.48 });
ok('参考售价=挂牌价', r1.listUsd === 15.43);
ok('保本价来自 evaluate.floorUsd', r1.breakEvenUsd === 14.20);
ok('报价底线=max(保本,登记)=14.20', r1.quoteFloorUsd === 14.20);
ok('可报价', r1.quotable === true && r1.blockReasons.length === 0);

/* 2. 登记底价更高时，报价底线取登记底价 */
var r2 = PU.resolve({ evaluate: ev(), product: prod({ priceFloorUsd: 16.8 }), unitUsd: 17.5 });
ok('报价底线取登记底价 16.8', r2.quoteFloorUsd === 16.8, String(r2.quoteFloorUsd));
ok('高于底线仍可报', r2.quotable === true);

/* 3. 线上同款矛盾：建议价 15.48 < 谈判底线 16.80 → 必须给出提示，且口径分开 */
var r3 = PU.resolve({ evaluate: ev(), product: prod(), unitUsd: 15.48, nego: { ok: true, floorUsd: 16.80, minMarginPct: 0.08 } });
ok('谈判底线单独成项 16.80', r3.negoFloorUsd === 16.80);
ok('谈判底线不冒充保本价（保本仍 14.20）', r3.breakEvenUsd === 14.20);
ok('低于谈判底线只警告不拦截（提示性质）', r3.quotable === true && r3.warnings.some(function (w) { return w.indexOf('谈判底线') >= 0; }), r3.warnings.join(';'));

/* 4. 缺成本：不可报价 */
var r4 = PU.resolve({ evaluate: ev({ floorUsd: 0, flags: { noCost: true } }), product: prod(), unitUsd: 15.48 });
ok('缺成本不可报', r4.quotable === false && r4.noCost === true);
ok('原因写明缺成本', r4.blockReasons.some(function (x) { return x.indexOf('缺少采购成本') >= 0; }));

/* 5. 低于保本价：不可报价 */
var r5 = PU.resolve({ evaluate: ev(), product: prod(), unitUsd: 13.00 });
ok('低于保本不可报', r5.quotable === false && r5.blockReasons.some(function (x) { return x.indexOf('低于保本价') >= 0; }));

/* 6. 低于登记底价（但高于保本）：不可报价，需特批口径 */
var r6 = PU.resolve({ evaluate: ev(), product: prod({ priceFloorUsd: 15.0 }), unitUsd: 14.60 });
ok('低于登记底价不可报', r6.quotable === false && r6.blockReasons.some(function (x) { return x.indexOf('登记底价') >= 0; }), r6.blockReasons.join(';'));

/* 7. 关键匹配冲突：价格再好也不可报价 */
var r7 = PU.resolve({ evaluate: ev(), product: prod(), unitUsd: 15.48, hardFail: true });
ok('关键冲突不可报', r7.quotable === false && r7.blockReasons.some(function (x) { return x.indexOf('关键冲突') >= 0; }));

/* 8. 定价异常：建议价低于保本价 → anomaly 标记 + 警告 */
var r8 = PU.resolve({ evaluate: ev({ recommendUsd: 13.5 }), product: prod(), unitUsd: 15.48 });
ok('建议价低于保本被标记异常', r8.anomaly === true && r8.warnings.some(function (w) { return w.indexOf('定价异常') >= 0; }));

/* 9. 买家目标价不干扰：resolve 根本不接收目标价，输出里也没有它 */
var r9a = PU.resolve({ evaluate: ev(), product: prod(), unitUsd: 15.48 });
ok('结果不含目标价字段', !('targetPriceUsd' in r9a) && !('targetUsd' in r9a));
ok('参考售价不会被当成底线（list≠quoteFloor 除非数值巧合）', r9a.listUsd === 15.43 && r9a.quoteFloorUsd === 14.20);

/* 10. 异常价格：单价为 0 / NaN 输入不崩溃且不可报 */
var r10 = PU.resolve({ evaluate: ev({ unitPriceUsd: 0 }), product: prod(), unitUsd: 0 });
ok('无有效报价不可报', r10.quotable === false && r10.blockReasons.some(function (x) { return x.indexOf('尚未形成有效报价') >= 0; }));
var r10b = PU.resolve({ evaluate: null, product: null, unitUsd: NaN });
ok('空输入不崩溃且不可报', r10b.quotable === false && r10b.noCost === true);

/* 11. 登记底价高于挂牌价：数据异常警告 */
var r11 = PU.resolve({ evaluate: ev(), product: prod({ priceFloorUsd: 99 }), unitUsd: 100 });
ok('登记底价高于挂牌价有警告', r11.warnings.some(function (w) { return w.indexOf('登记底价高于挂牌价') >= 0; }), r11.warnings.join(';'));

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
