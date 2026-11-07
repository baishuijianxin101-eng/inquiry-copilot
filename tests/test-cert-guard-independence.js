/* P1-17 第三阶段修复 D：认证护栏独立于商品匹配结果（纯 Node，全部虚构数据）
   运行：node tests/test-cert-guard-independence.js */
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

/* D2. 完全不匹配的商品：noMatch 与护栏同时成立 */
var unrel = SP({ sku: 'U1', title: 'LED Strip Light 5m', titleEn: 'LED Strip', keywords: ['led strip', 'light'], specs: '5m 12V', priceUsd: 9, priceFloorUsd: 7, costRmb: 30, certs: [] });
var rNM = D.analyze(caseD, [unrel], settings, null);
ok('D2a. 无匹配成立', rNM.noMatch === true, 'noMatch=' + rNM.noMatch);
ok('D2b. noMatch 时护栏仍存在且类型为未覆盖', !!rNM.certGuard && rNM.certGuard.type === 'uncovered', JSON.stringify(rNM.certGuard));
ok('D2c. 护栏点名 ATEX', !!rNM.certGuard && rNM.certGuard.names.indexOf('ATEX') >= 0, JSON.stringify(rNM.certGuard));
ok('D2d. 就绪不允许报价', rNM.readiness.key !== 'can-quote', rNM.readiness.key);
ok('D2e. 下一步保留认证核实事项', D.nextSteps(rNM).some(function (s) { return /认证/.test(s.action) && /ATEX/.test(s.why); }), JSON.stringify(D.nextSteps(rNM)));

/* D2b. 空商品池同样保留护栏 */
var rEmpty = D.analyze(caseD, [], settings, null);
ok('D2f. 空商品池护栏仍存在', !!rEmpty.certGuard && rEmpty.certGuard.names.indexOf('ATEX') >= 0, JSON.stringify(rEmpty.certGuard));

/* D3. 有效匹配 + 部分认证缺失：护栏是唯一拦截者（直接断言护栏对象，不接受 issues 文本替代） */
var boosted = SP({ sku: 'S4', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor', 'pressure sensors', 'chemical plant'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['CE'] });
var rP = D.analyze(caseD, [boosted], settings, null);
ok('D3a. 存在有效匹配（分数达标、非 noMatch）', !rP.noMatch && rP.top && rP.top.score >= 40, 'score=' + (rP.top && rP.top.score));
ok('D3b. 价格口径本身可报价（排除其他拦截）', !!(rP.unity && rP.unity.quotable), JSON.stringify(rP.unity && rP.unity.blockReasons));
ok('D3c. 护栏对象存在、类型 uncovered、点名 ATEX', !!rP.certGuard && rP.certGuard.type === 'uncovered' && rP.certGuard.names.indexOf('ATEX') >= 0, JSON.stringify(rP.certGuard));
ok('D3d. 就绪被护栏降级', rP.readiness.key === 'need-verify' && /ATEX/.test(rP.readiness.why), rP.readiness.key + '/' + rP.readiness.why);
ok('D3e. 下一步含认证核实', D.nextSteps(rP).some(function (s) { return /认证/.test(s.action); }), JSON.stringify(D.nextSteps(rP).map(function (s) { return s.action; })));
ok('D3f. 护栏触发时草稿不带我方价格', ((rP.reply && rP.reply.en) || '').indexOf('$46') < 0, (rP.reply && rP.reply.en) || '');

/* D-neg. 明确不需要认证时不得触发护栏（修复 C1 与护栏联动） */
var noCert = SP({ sku: 'S1', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: [] });
var rNeg = D.analyze('We need 200 pcs PS-900 pressure sensors, 316L IP67 4-20mA. ATEX is not required. Please quote your best price.', [noCert], settings, null);
ok('D4. ATEX 明确不需要 → 无护栏', !rNeg.certGuard, JSON.stringify(rNeg.certGuard));

console.log('== cert-guard-independence: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
