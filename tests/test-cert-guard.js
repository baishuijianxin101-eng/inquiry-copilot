/* P1-17 修复 B：认证识别与报价就绪护栏测试（纯 Node，全部虚构数据）
   运行：node tests/test-cert-guard.js
   说明：当前商品数据结构无法表达「明确不具备某认证」，本文件不冒充覆盖该状态；
   对未登记商品一律按「未核实」验证护栏行为（这正是生产口径）。 */
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
var P = sandbox.P0Parse, D = sandbox.DecisionDesk;
function SP(o) {
  return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '' }, o);
}
var sensorNoCert = SP({ sku: 'S1', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: [] });
var sensorAtex = SP({ sku: 'S2', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['ATEX', 'CE'] });
var sensorCe = SP({ sku: 'S3', title: 'HydroSense PS-300 Pressure Sensor ABS IP65', titleEn: 'PS-300 Pressure Sensor', keywords: ['pressure sensor', 'ps-300', 'sensor'], specs: 'ABS IP65', priceUsd: 18, priceFloorUsd: 15, costRmb: 90, certs: ['CE'] });
var settings = { fxRate: 7.1, sellerName: 'Test Seller' };
var caseD = 'We need pressure sensors that must have ATEX certification for use in chemical plants. Housing must be 316L stainless steel, IP67, range 0-10 bar, output 4-20mA. Quantity 200 pcs. Please quote your best price.';

/* 1. ATEX 被正确识别且语境为强制 */
var pD = P.extract(caseD);
ok('1. ATEX 进入已识别认证', (pD.fields.certs || []).indexOf('ATEX') >= 0, JSON.stringify(pD.fields.certs));
ok('2. ATEX 语境判定为强制', (pD.fields.certMentions || []).some(function (c) { return c.name === 'ATEX' && c.context === 'mandatory'; }), JSON.stringify(pD.fields.certMentions));

/* 2. 强制要求 + 商品未登记 → 就绪降级，不得 can-quote */
var rNo = D.analyze(caseD, [sensorNoCert], settings, null);
ok('3. 商品未登记 ATEX → 需要人工核实', rNo.readiness.key === 'need-verify', rNo.readiness.key + '/' + rNo.readiness.why);
ok('4. 护栏点名 ATEX', !!rNo.certGuard && rNo.certGuard.names.indexOf('ATEX') >= 0, JSON.stringify(rNo.certGuard));
ok('5. 已形成有效匹配时护栏仍生效', rNo.top && rNo.top.score >= 40 && !rNo.noMatch && rNo.readiness.key !== 'can-quote', 'score=' + (rNo.top && rNo.top.score));

/* 3. 商品已登记 ATEX → 护栏不触发，可正常报价 */
var rYes = D.analyze(caseD, [sensorAtex], settings, null);
ok('6. 商品具备 ATEX → 无护栏且可报价', !rYes.certGuard && rYes.readiness.key === 'can-quote', rYes.readiness.key + '/' + JSON.stringify(rYes.certGuard));

/* 4. 商品只有 CE、客户强制 ATEX → 有效匹配下护栏独立拦截（P1-17 第三阶段 D3 修订：
   原断言允许用 candidates[].issues 文本代替护栏，经第三阶段任务书明确要求改为直接断言护栏对象；
   商品关键词补齐后匹配分 44≥40 且 unity.quotable=true，证明拦截来自护栏而非匹配扣分） */
var sensorCe900 = SP({ sku: 'S4', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor', 'pressure sensors', 'chemical plant'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['CE'] });
var rPart = D.analyze(caseD, [sensorCe900], settings, null);
ok('7. 有效匹配+CE缺ATEX → 护栏独立拦截', !!rPart.certGuard && rPart.certGuard.type === 'uncovered' && rPart.certGuard.names.indexOf('ATEX') >= 0 && rPart.readiness.key !== 'can-quote' && !rPart.noMatch && rPart.top.score >= 40 && !!(rPart.unity && rPart.unity.quotable), JSON.stringify(rPart.certGuard) + '/' + rPart.readiness.key + '/score=' + (rPart.top && rPart.top.score));

/* 5. 表外认证留痕 + 降级 */
var unkText = 'We need 100 pcs PS-900 pressure sensors for our plant. The sensor must meet XYZ-9000 certification for our market. Please quote your best price.';
var pU = P.extract(unkText);
ok('8. 表外认证 XYZ-9000 被留痕', (pU.fields.unrecognizedCertMentions || []).some(function (u) { return u.token === 'XYZ-9000' && u.needsVerify; }), JSON.stringify(pU.fields.unrecognizedCertMentions));
var rU = D.analyze(unkText, [sensorNoCert], settings, null);
ok('9. 未识别认证 → 降级且护栏类型为未识别', rU.readiness.key === 'need-verify' && !!rU.certGuard && rU.certGuard.type === 'unrecognized', rU.readiness.key + '/' + JSON.stringify(rU.certGuard));

/* 6. 仅询问不误判为强制 */
var pAsk = P.extract('Do you have ATEX certification for your pressure sensors? We need 200 pcs.');
ok('10. 询问语境判定为 inquiry', (pAsk.fields.certMentions || []).some(function (c) { return c.name === 'ATEX' && c.context === 'inquiry'; }), JSON.stringify(pAsk.fields.certMentions));
var rAsk = D.analyze('Do you have ATEX certification for the PS-900 pressure sensor? We need 200 pcs, please quote your best price.', [sensorNoCert], settings, null);
ok('11. 仅询问不触发护栏', !rAsk.certGuard, JSON.stringify(rAsk.certGuard));

/* 7. 普通偏好不误伤 */
var pPref = P.extract('ATEX preferred, if available. We need 200 pcs pressure sensors.');
ok('12. 偏好语境判定为 preference', (pPref.fields.certMentions || []).some(function (c) { return c.name === 'ATEX' && c.context === 'preference'; }), JSON.stringify(pPref.fields.certMentions));

/* 8. 多句混合：强制句不被询问句掩盖 */
var pMix = P.extract('We require ATEX. Can you provide the certificate? We need 200 pcs sensors.');
ok('13. 强制句优先于同询盘的询问句', (pMix.fields.certMentions || []).some(function (c) { return c.name === 'ATEX' && c.context === 'mandatory'; }), JSON.stringify(pMix.fields.certMentions));

/* 9. G2：已识别与未识别同句并存，分别留痕且整体降级 */
var g2 = 'We need CE and ZZZ-2000 certification for 100 pcs PS-900 pressure sensors. Please quote your best price.';
var pG2 = P.extract(g2);
ok('14. CE 正常识别', (pG2.fields.certs || []).indexOf('CE') >= 0, JSON.stringify(pG2.fields.certs));
ok('15. ZZZ-2000 独立留痕', (pG2.fields.unrecognizedCertMentions || []).some(function (u) { return u.token === 'ZZZ-2000'; }), JSON.stringify(pG2.fields.unrecognizedCertMentions));
var rG2 = D.analyze(g2, [sensorCe900], settings, null);
ok('16. 含未识别认证时整体降级', rG2.readiness.key === 'need-verify' && !!rG2.certGuard, rG2.readiness.key);

/* 10. 护栏触发时草稿不带我方价格、不肯定承诺未知认证 */
var draftNo = (rNo.reply && rNo.reply.en) || '';
ok('17. 降级时草稿不出现商品价格 $46', draftNo.indexOf('$46') < 0, draftNo);
ok('18. 草稿不肯定承诺 ATEX 认证', !/ATEX certified|certified.{0,20}ATEX/i.test(draftNo), draftNo);

/* 11. 常规路径不回归：CE/FCC 齐全且有成本 → 仍可报价 */
var rx = SP({ sku: 'R1', title: 'RadioMaster XR4 ELRS Receiver', titleEn: 'XR4 Receiver', keywords: ['radiomaster xr4', 'elrs receiver'], specs: '2.4GHz ELRS', priceUsd: 12.5, priceFloorUsd: 10.8, costRmb: 58, certs: ['CE', 'FCC'] });
var rOk = D.analyze('Hello, we need 500 pcs of your XR4 Pro receiver. Our target price is USD 11 per pc. Must have CE and FCC certification, delivery within 20 days.', [rx], settings, null);
ok('19. 认证齐全的常规询盘仍可报价', rOk.readiness.key === 'can-quote' && !rOk.certGuard, rOk.readiness.key + '/' + rOk.readiness.why);

console.log('== cert-guard: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
