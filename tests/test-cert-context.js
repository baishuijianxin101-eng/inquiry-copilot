/* P1-17 第三阶段修复 C：认证否定语境、同句多认证局部语境、未知认证召回与误报控制（纯 Node，全部虚构数据）
   运行：node tests/test-cert-context.js */
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
  return ms.length ? ms[0].context : '(missing)';
}
function unrecHas(r, token) {
  return (r.fields.unrecognizedCertMentions || []).some(function (u) { return u.token === token; });
}

/* C1. 否定语境不得判强制 */
ok('C1a. ATEX is not required → 非强制', ctxOf(P.extract('ATEX is not required.'), 'ATEX') === 'not-required', ctxOf(P.extract('ATEX is not required.'), 'ATEX'));
ok('C1b. do not require ATEX → 非强制', ctxOf(P.extract('We do not require ATEX certification.'), 'ATEX') === 'not-required');
ok('C1c. ATEX is optional → 非强制', ctxOf(P.extract('ATEX is optional for this order.'), 'ATEX') === 'not-required');
ok('C1d. ATEX is not mandatory → 非强制', ctxOf(P.extract('ATEX is not mandatory.'), 'ATEX') === 'not-required');

/* C1b. 同句两个认证各自局部语境 */
var mix = P.extract('We do not require ATEX, but CE is mandatory.');
ok('C1e. 同句 ATEX 非强制、CE 强制互不污染', ctxOf(mix, 'ATEX') === 'not-required' && ctxOf(mix, 'CE') === 'mandatory', JSON.stringify(mix.fields.certMentions));

/* C2. 未知认证召回：强制语境不再依赖 certification 一词 */
ok('C2a. We require IECEx → 留痕', unrecHas(P.extract('We require IECEx.'), 'IECEx'));
ok('C2b. Must comply with IECEx → 留痕', unrecHas(P.extract('Must comply with IECEx.'), 'IECEx'));
ok('C2c. Our market requires IECEx → 留痕', unrecHas(P.extract('Our market requires IECEx.'), 'IECEx'));
ok('C2d. IECEx is compulsory → 留痕', unrecHas(P.extract('IECEx is compulsory for our market.'), 'IECEx'));
ok('C2e. ISO13485 → 规范化留痕', unrecHas(P.extract('We require ISO13485 for this order.'), 'ISO13485'));
var iex = P.extract('We require IECEx.');
ok('C2f. IECEx 语境为强制且需核实', (iex.fields.unrecognizedCertMentions[0] || {}).context === 'mandatory' && (iex.fields.unrecognizedCertMentions[0] || {}).needsVerify === true, JSON.stringify(iex.fields.unrecognizedCertMentions));

/* C3. 误报控制：普通技术语境不产生未知认证 */
ok('C3a. 100 Mbps 不产生留痕', (P.extract('We need 100 Mbps internet connectivity.').fields.unrecognizedCertMentions || []).length === 0);
ok('C3b. WiFi 6 不产生留痕', (P.extract('Please support WiFi 6 on the device.').fields.unrecognizedCertMentions || []).length === 0);
ok('C3c. 型号句 XYZ-9000 不产生留痕', (P.extract('Model XYZ-9000 has a 4-20mA output.').fields.unrecognizedCertMentions || []).length === 0);
ok('C3d. 已识别 ATEX 不重复留痕', (P.extract('We need ATEX certification.').fields.unrecognizedCertMentions || []).length === 0);
ok('C3e. 常规询盘（2.4GHz/500Hz）不产生留痕', (P.extract('Need stable connection, 2.4GHz ELRS, 500Hz refresh rate, range over 3km.').fields.unrecognizedCertMentions || []).length === 0);

/* 既有语境不回归 */
ok('R1. 询问语境仍为 inquiry', ctxOf(P.extract('Do you have ATEX certification?'), 'ATEX') === 'inquiry');
ok('R2. 偏好语境仍为 preference', ctxOf(P.extract('ATEX preferred, if available.'), 'ATEX') === 'preference');
ok('R3. 强制+询问同询盘仍取强制', ctxOf(P.extract('We require ATEX. Can you provide the certificate?'), 'ATEX') === 'mandatory');

console.log('== cert-context: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
