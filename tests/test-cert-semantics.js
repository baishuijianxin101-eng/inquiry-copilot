/* P1-17 第四阶段修复 A/B：认证询问/强制/否定语境与多认证隔离（纯 Node，全部虚构数据）
   运行：node tests/test-cert-semantics.js */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function ctxOf(r, name) {
  var ms = (r.fields.certMentions || []).filter(function (c) { return c.name === name; });
  if (ms.length) return ms[0].context;
  var us = (r.fields.unrecognizedCertMentions || []).filter(function (u) { return u.token === name; });
  return us.length ? us[0].context : '(missing)';
}

/* 询问组（8）：疑问形式不得被 compliance/requirements 名词污染为强制 */
ok('Q1. Can you provide ATEX compliance → inquiry', ctxOf(P.extract('Can you provide ATEX compliance?'), 'ATEX') === 'inquiry');
ok('Q2. Do you have ATEX certification → inquiry', ctxOf(P.extract('Do you have ATEX certification?'), 'ATEX') === 'inquiry');
ok('Q3. Could you provide the IECEx certificate → inquiry（未识别留痕）', ctxOf(P.extract('Could you provide the IECEx certificate?'), 'IECEx') === 'inquiry');
ok('Q4. Is ATEX compliance available → inquiry', ctxOf(P.extract('Is ATEX compliance available?'), 'ATEX') === 'inquiry');
ok('Q5. Can your product meet ATEX requirements → inquiry', ctxOf(P.extract('Can your product meet ATEX requirements?'), 'ATEX') === 'inquiry');
ok('Q6. Can you supply CE certification → inquiry', ctxOf(P.extract('Can you supply CE certification for this model?'), 'CE') === 'inquiry');
ok('Q7. Could you confirm FCC compliance → inquiry', ctxOf(P.extract('Could you confirm whether the product has FCC compliance?'), 'FCC') === 'inquiry');
ok('Q8. 询问句中的 ATEX 不产生强制留痕误判', ctxOf(P.extract('Please let me know: can you provide ATEX compliance for the sensor?'), 'ATEX') === 'inquiry');

/* 强制组（8）：真正的要求语义保持 mandatory */
ok('M1. We require ATEX certification → mandatory', ctxOf(P.extract('We require ATEX certification.'), 'ATEX') === 'mandatory');
ok('M2. ATEX is mandatory → mandatory', ctxOf(P.extract('ATEX is mandatory for this order.'), 'ATEX') === 'mandatory');
ok('M3. Our market requires IECEx compliance → mandatory（未识别留痕）', ctxOf(P.extract('Our market requires IECEx compliance.'), 'IECEx') === 'mandatory');
ok('M4. must comply with ATEX → mandatory', ctxOf(P.extract('The product must comply with ATEX.'), 'ATEX') === 'mandatory');
ok('M5. cannot place an order without ATEX → mandatory', ctxOf(P.extract('We cannot place an order without ATEX certification.'), 'ATEX') === 'mandatory');
ok('M6. ATEX is required → mandatory', ctxOf(P.extract('ATEX is required.'), 'ATEX') === 'mandatory');
ok('M7. ATEX must be provided → mandatory', ctxOf(P.extract('ATEX must be provided with the goods.'), 'ATEX') === 'mandatory');
ok('M8. We need ATEX for this order → mandatory', ctxOf(P.extract('We need ATEX for this order.'), 'ATEX') === 'mandatory');

/* 否定组（8）：明确不需要不得判强制 */
ok('N1. ATEX isn\'t required → not-required', ctxOf(P.extract("ATEX isn't required."), 'ATEX') === 'not-required');
ok('N2. ATEX is not a requirement → not-required', ctxOf(P.extract('ATEX is not a requirement.'), 'ATEX') === 'not-required');
ok('N3. ATEX does not need to be provided → not-required', ctxOf(P.extract('ATEX does not need to be provided.'), 'ATEX') === 'not-required');
ok('N4. We don\'t need ATEX → not-required', ctxOf(P.extract("We don't need ATEX for this order."), 'ATEX') === 'not-required');
ok('N5. There is no ATEX requirement → not-required', ctxOf(P.extract('There is no ATEX requirement.'), 'ATEX') === 'not-required');
ok('N6. ATEX certification is unnecessary → not-required', ctxOf(P.extract('ATEX certification is unnecessary.'), 'ATEX') === 'not-required');
ok('N7. ATEX is optional → not-required', ctxOf(P.extract('ATEX is optional for this product.'), 'ATEX') === 'not-required');
ok('N8. We do not require ATEX certification → not-required', ctxOf(P.extract('We do not require ATEX certification.'), 'ATEX') === 'not-required');

/* 多认证语境隔离组（5） */
var x1 = P.extract('Can you provide ATEX compliance? We require CE certification.');
ok('X1. 询问 ATEX 与强制 CE 并存互不污染', ctxOf(x1, 'ATEX') === 'inquiry' && ctxOf(x1, 'CE') === 'mandatory', JSON.stringify(x1.fields.certMentions));
var x2 = P.extract('We require ATEX certification. Can you provide the certificate?');
ok('X2. 强制句不被后续询问句覆盖', ctxOf(x2, 'ATEX') === 'mandatory', JSON.stringify(x2.fields.certMentions));
var x3 = P.extract('ATEX is not required, but CE is mandatory.');
ok('X3. 不需要 ATEX 与强制 CE 同句隔离', ctxOf(x3, 'ATEX') === 'not-required' && ctxOf(x3, 'CE') === 'mandatory', JSON.stringify(x3.fields.certMentions));
var x4 = P.extract('We do not require ATEX for this model, but our customer requires CE.');
ok('X4. 长句中 ATEX/CE 分别判定', ctxOf(x4, 'ATEX') === 'not-required' && ctxOf(x4, 'CE') === 'mandatory', JSON.stringify(x4.fields.certMentions));
var x5 = P.extract('ATEX certification is required, can you send the certificate?');
ok('X5. 强制子句不被同句问句污染', ctxOf(x5, 'ATEX') === 'mandatory', JSON.stringify(x5.fields.certMentions));

console.log('== cert-semantics: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
