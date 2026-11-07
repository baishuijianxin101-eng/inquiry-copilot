/* P1-17 第五阶段：认证否定表达回归（任务书第五节九种表达 + not only 反向 + 正向对照）
   纯 Node，全部虚构数据。运行：node tests/test-cert-negation-p5.js */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function ctx(text, name) {
  var ms = P.extract(text).fields.certMentions.filter(function (m) { return m.name === name; });
  return ms[0] ? ms[0].context : null;
}
var NOTREQ = [
  'ATEX does not need to be provided.',
  "ATEX doesn't need to be provided.",
  "We don't need ATEX for this order.",
  'We do not need ATEX for this order.',
  'ATEX is not a requirement.',
  'There is no requirement for ATEX.',
  "ATEX isn't required.",
  'ATEX is optional.',
  'ATEX is not mandatory.'
];
NOTREQ.forEach(function (t, i) {
  ok('N' + (i + 1) + '. 明确不需要不得判 mandatory：' + t, ctx(t, 'ATEX') === 'not-required', ctx(t, 'ATEX'));
});
var MAND = [
  'ATEX is required.',
  'ATEX must be provided.',
  'We need ATEX for this order.',
  'ATEX certification is compulsory.'
];
MAND.forEach(function (t, i) {
  ok('M' + (i + 1) + '. 真强制保持 mandatory：' + t, ctx(t, 'ATEX') === 'mandatory', ctx(t, 'ATEX'));
});
ok('R1. “not only … required” 是强调要求，不得判 not-required',
  ctx('ATEX is not only required, it is mandatory for our market.', 'ATEX') === 'mandatory',
  ctx('ATEX is not only required, it is mandatory for our market.', 'ATEX'));
ok('R2. 否定只作用于本子句：ATEX 不需要、CE 强制',
  ctx('ATEX is not required, but CE is mandatory.', 'ATEX') === 'not-required' &&
  ctx('ATEX is not required, but CE is mandatory.', 'CE') === 'mandatory', '');
ok('R3. 普通询问不被误判 not-required',
  ctx('Can you provide ATEX certification?', 'ATEX') === 'inquiry',
  ctx('Can you provide ATEX certification?', 'ATEX'));
console.log('== cert-negation-p5: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
