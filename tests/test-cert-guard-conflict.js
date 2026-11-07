/* P1-17 第五阶段：认证冲突与报价护栏联动（任务书第七节）
   直接断言 analyze 结果的 certGuard / readiness / 草稿；纯 Node，全部虚构数据。
   运行：node tests/test-cert-guard-conflict.js */
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
var sensorAtex = SP({ sku: 'S2', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['ATEX', 'CE'] });
var sensorPlain = SP({ sku: 'S1', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: [] });
var BASE = 'We need pressure sensor PS-900, 316L IP67 0-10bar 4-20mA, 200 pcs. ';
/* R4 加强版无报价检测：草稿正文在 result.reply.en/zh（第五阶段原版误读 result.draft，
   该字段不存在、断言曾空转，收尾轮已纠正）。覆盖 $X.XX、USD X、X USD、X dollars
   四种写法与 RA 的三种我方报价句式。本文件的询盘文本不含客户价格，
   故全格式封堵不会误伤客户价格角色。 */
function noPrice(r) {
  var d = ((r.reply && r.reply.en) || '') + '\n' + ((r.reply && r.reply.zh) || '');
  return !(/\$\s?\d/.test(d) || /USD\s?\d/.test(d) || /\d+\s?USD/.test(d) || /\d+\s?dollars?/i.test(d) ||
    /(Our current best price is|The best I can offer|our price is)\s*\$/i.test(d));
}

/* 1. 已登记具备 + 明确要求 → 不拦截（对照） */
var r1 = D.analyze(BASE + 'ATEX certification is required.', [sensorAtex], settings);
ok('G1. 具备且明确要求不拦截', !r1.certGuard && r1.readiness.key === 'can-quote', JSON.stringify(r1.certGuard) + ' / ' + r1.readiness.key);
/* 2. 未登记 + 明确要求 → 阻止 */
var r2 = D.analyze(BASE + 'ATEX certification is required.', [sensorPlain], settings);
ok('G2. 未登记且明确要求被护栏阻止且草稿无价', !!r2.certGuard && r2.readiness.key === 'need-verify' && noPrice(r2), JSON.stringify(r2.certGuard));
/* 3. 明确不需要 → 不拦截 */
var r3 = D.analyze(BASE + 'ATEX is not required for this order.', [sensorPlain], settings);
ok('G3. 明确不需要不拦截', !r3.certGuard && r3.readiness.key === 'can-quote', JSON.stringify(r3.certGuard));
/* 4. 冲突（要求+不需要）→ 即使商品具备该认证也必须阻止 */
var r4 = D.analyze(BASE + 'We require ATEX certification. Actually ATEX is not required for this order.', [sensorAtex], settings);
ok('G4. 冲突时护栏为 conflict 类型', !!r4.certGuard && r4.certGuard.type === 'conflict', JSON.stringify(r4.certGuard));
ok('G4. 冲突阻止报价且草稿无价', r4.readiness.key === 'need-verify' && noPrice(r4), r4.readiness.key);
ok('G4. 冲突原因对员工可见（why 含冲突说明）', /冲突/.test(r4.certGuard.why), r4.certGuard.why);
var steps4 = D.nextSteps(r4);
ok('G4. 冲突进入下一步核实事项', steps4.some(function (s) { return /认证/.test(s.action) && /冲突/.test(s.why); }), JSON.stringify(steps4));
/* 5. 未知认证明确要求 → 继续阻止 */
var r5 = D.analyze(BASE + 'ZZAB certification is required.', [sensorAtex], settings);
ok('G5. 未知认证要求仍阻止报价', !!r5.certGuard && r5.certGuard.type === 'unrecognized' && noPrice(r5), JSON.stringify(r5.certGuard));
ok('G5. 最终 readiness 为 need-verify（收尾 R2）', r5.readiness.key === 'need-verify', r5.readiness.key);
ok('G5. 下一步核实事项明确包含 ZZAB（收尾 R2）', D.nextSteps(r5).some(function (s) { return /ZZAB/.test(s.why); }), JSON.stringify(D.nextSteps(r5)));
/* 6. noMatch 时冲突风险保留 */
var r6 = D.analyze('We require ATEX certification. ATEX is not required. Need quantum flux gadget XQ-1, 10 pcs.', [sensorAtex], settings);
ok('G6. noMatch 下冲突护栏仍成立', r6.noMatch === true && !!r6.certGuard && r6.certGuard.type === 'conflict', JSON.stringify(r6.certGuard) + ' noMatch=' + r6.noMatch);
ok('G6. 草稿不含我方报价（收尾 R3）', noPrice(r6), JSON.stringify((r6.reply && r6.reply.en) || ''));
ok('G6. 下一步含认证冲突核实事项（收尾 R3）', D.nextSteps(r6).some(function (s) { return /认证/.test(s.action) && /冲突/.test(s.why); }), JSON.stringify(D.nextSteps(r6)));
/* 注：noMatch 时 readiness 为 not-suitable（无可靠匹配商品是首要阻断），不是 need-verify；
   冲突由 certGuard 与下一步事项独立保留——此口径差异已在 R2-R3 报告中明示待审查裁定。 */
ok('G6. readiness 阻断报价（not-suitable，非 can-quote）（收尾 R3 实测口径）', r6.readiness.key === 'not-suitable' && r6.readiness.key !== 'can-quote', r6.readiness.key);
/* 7. 冲突不因匹配分数高而消失（同 G4 商品为高匹配，再断言 candidates 首位即该商品） */
ok('G7. 高匹配下冲突不消失', r4.candidates.length > 0 && r4.candidates[0].product === sensorAtex && r4.certGuard !== null, '');
console.log('== cert-guard-conflict: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
