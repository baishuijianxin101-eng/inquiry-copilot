/* P1-17 第四阶段：认证护栏回归（任务书第七节十项，全部直接断言 certGuard 对象；纯 Node，全部虚构数据）
   运行：node tests/test-cert-guard-phase4.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var sandbox = { console: console };
sandbox.window = sandbox;
var m = {};
sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
vm.createContext(sandbox);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
 'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var D = sandbox.DecisionDesk;
function SP(o) {
  return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '' }, o);
}
var settings = { fxRate: 7.1, sellerName: 'Test Seller' };
var caseD = 'We need pressure sensors that must have ATEX certification for use in chemical plants. Housing must be 316L stainless steel, IP67, range 0-10 bar, output 4-20mA. Quantity 200 pcs. Please quote your best price.';
var sensorNoCert = SP({ sku: 'S1', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: [] });
var sensorAtex = SP({ sku: 'S2', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['ATEX', 'CE'] });
var unrel = SP({ sku: 'U1', title: 'LED Strip Light 5m', titleEn: 'LED Strip', keywords: ['led strip', 'light'], specs: '5m 12V', priceUsd: 9, priceFloorUsd: 7, costRmb: 30, certs: [] });

ok('G1. noMatch 时护栏仍存在', (function () { var r = D.analyze(caseD, [unrel], settings, null); return r.noMatch && !!r.certGuard && r.certGuard.names.indexOf('ATEX') >= 0; })());
ok('G2. 空商品池认证风险仍保留', (function () { var r = D.analyze(caseD, [], settings, null); return !!r.certGuard && r.certGuard.names.indexOf('ATEX') >= 0; })());
ok('G3. 有效匹配但认证未核实仍阻止报价', (function () { var r = D.analyze(caseD, [sensorNoCert], settings, null); return !r.noMatch && !!r.certGuard && r.readiness.key !== 'can-quote'; })());
ok('G4. 已登记具备认证不误拦截', (function () { var r = D.analyze(caseD, [sensorAtex], settings, null); return !r.certGuard && r.readiness.key === 'can-quote'; })());
ok('G5. 单纯询问认证不触发护栏', (function () { var r = D.analyze('Can you provide ATEX compliance for the PS-900 pressure sensor? We need 200 pcs, please quote.', [sensorNoCert], settings, null); return !r.certGuard; })());
ok('G6. 明确不需要认证不触发护栏', (function () { var r = D.analyze('We need 200 pcs PS-900 pressure sensors, 316L IP67 4-20mA. ATEX is not required. Please quote your best price.', [sensorNoCert], settings, null); return !r.certGuard; })());
ok('G7. 多认证不同语境互不污染（CE 强制未登记仍拦，ATEX 不需要不拦）', (function () {
  var r = D.analyze('We need 200 pcs PS-900 pressure sensors. ATEX is not required, but CE is mandatory.', [sensorNoCert], settings, null);
  return !!r.certGuard && r.certGuard.names.indexOf('CE') >= 0 && r.certGuard.names.indexOf('ATEX') < 0;
})());
ok('G8. 未知认证继续留痕并触发护栏', (function () { var r = D.analyze('We need 100 pcs PS-900 pressure sensors. We require IECEx. Please quote.', [sensorNoCert], settings, null); return (r.eff.unrecognizedCertMentions || []).length > 0 && !!r.certGuard && r.certGuard.type === 'unrecognized'; })());
ok('G9. 护栏触发时草稿不含我方价格', (function () { var r = D.analyze(caseD, [sensorNoCert], settings, null); return ((r.reply && r.reply.en) || '').indexOf('$46') < 0; })());
ok('G10. 下一步保留人工核实事项', (function () { var r = D.analyze(caseD, [sensorNoCert], settings, null); return D.nextSteps(r).some(function (s) { return /认证/.test(s.action); }); })());

console.log('== cert-guard-phase4: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
