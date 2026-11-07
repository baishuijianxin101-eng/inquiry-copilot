/* P1-20 专项：prequote 草稿问题清单不得重复（I-1）。
   覆盖：A 英文唯一、B 中文唯一、C 双语不串写、D 其他场景不退化与边界、
   E 决策台五案例 + 8b 回归（虚构数据，与 P1-16/P1-19 同一目录）。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var sb = { console: { log: function () {} } };
sb.window = sb;
var m = {};
sb.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
vm.createContext(sb);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
 'assets/matching.js', 'assets/smart-match.js', 'assets/opp-score.js', 'assets/reply-assistant.js',
 'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
});
var RA = sb.ReplyAssistant, DD = sb.DecisionDesk;
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }
function count(hay, needle) { return hay.split(needle).length - 1; }
function baseOpp() { return { rawText: 'x', buyer: { country: '' }, quote: { qty: 0 }, status: 'new', followCount: 0 }; }

/* ---------- A/B/C：直接以 prequote 场景生成 ---------- */
var r = RA.generate({ opp: baseOpp(), eff: { productName: 'Widget X', qty: 0, models: [], certs: [], targetPriceUsd: null }, product: null, match: null, price: null, sellerName: 'Sim Seller', scenario: 'prequote' });
var enLines = r.en.split('\n').filter(function (l) { return l.indexOf('- Could you confirm') === 0; });
var zhLines = r.zh.split('\n').filter(function (l) { return l.indexOf('- 请确认') === 0; });
ok(enLines.length === 3 && new Set(enLines).size === 3, 'A1 英文问题清单 3 条且互不重复');
ok(count(r.en, 'Once I have these') === 1, 'A2 英文过渡句只出现一次');
ok(count(r.en, 'So I can quote accurately') === 1, 'A3 英文引导句只出现一次');
ok(zhLines.length === 3 && new Set(zhLines).size === 3, 'B1 中文问题清单 3 条且互不重复');
ok(r.zh.indexOf('您好') < r.zh.indexOf('- 请确认'), 'B2 中文问候语在问题清单之前');
ok(count(r.zh, '信息齐了之后') === 1, 'B3 中文收尾句只出现一次');
ok(count(r.en, '请确认') === 0, 'C1 英文草稿不含中文问题行');
ok(count(r.zh, 'Could you confirm') === 0, 'C2 中文草稿不含英文问题行');
ok(!/(\- Could you confirm[^\n]*\n)[\s\S]*\1/.test(r.en), 'C3 英文无整段重复');

/* ---------- D：其他场景与边界 ---------- */
var rf = RA.generate({ opp: baseOpp(), eff: { productName: 'Widget X', qty: 100, models: ['WX-1'], certs: [], targetPriceUsd: null, leadTimeDays: 20 }, product: null, match: null, price: null, sellerName: 'Sim Seller', scenario: 'first' });
var fEn = rf.en.split('\n').filter(function (l) { return l.indexOf('- Could you confirm') === 0; });
ok(fEn.length === new Set(fEn).size && fEn.length <= 3, 'D1 first 场景问题不重复（' + fEn.length + ' 条）');
['clarify', 'spec', 'negotiation', 'sample'].forEach(function (sc) {
  var mt = sc === 'clarify' ? { score: 50, keyConflict: true, conflicts: ['Frequency differs: buyer asked 900MHz, catalog lists 2.4GHz'] } : null;
  var rr; try { rr = RA.generate({ opp: baseOpp(), eff: { productName: 'Widget X', qty: 10, models: [], certs: [], targetPriceUsd: null }, product: null, match: mt, price: null, sellerName: 'Sim Seller', scenario: sc }); } catch (e) { rr = null; }
  ok(!!rr && typeof rr.en === 'string' && rr.en.length > 0, 'D2 场景 ' + sc + ' 可正常生成');
});
var re = RA.generate({ opp: baseOpp(), eff: { productName: 'Widget X', qty: 500, models: ['WX-1'], certs: ['CE'], targetPriceUsd: null, leadTimeDays: 15, country: 'Germany', usage: 'resale' }, product: { titleEn: 'Widget X', certs: ['CE'], moq: 10, leadTimeDays: 15, specsEn: 'std' }, match: { score: 90 }, price: null, sellerName: 'Sim Seller', scenario: 'prequote' });
var eEn = re.en.split('\n').filter(function (l) { return l.indexOf('- Could you confirm') === 0; });
ok(eEn.length === new Set(eEn).size, 'D3 信息较全的 prequote 问题仍不重复（' + eEn.length + ' 条）');

/* ---------- E：决策台五案例 + 8b ---------- */
function P(o) { return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o); }
var catalog = [
  P({ sku: 'A1', title: 'AeroLink XR4 Pro ELRS Receiver 2.4GHz Dual Antenna', titleEn: 'AeroLink XR4 Pro ELRS Receiver', keywords: ['aerolink xr4 pro', 'xr4 pro', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS dual antenna CRSF', priceUsd: 12.5, priceFloorUsd: 10.8, costRmb: 58, certs: ['CE', 'FCC'], moq: 100 }),
  P({ sku: 'A2', title: 'AeroLink XR4 Lite ELRS Receiver 2.4GHz Single Antenna', titleEn: 'AeroLink XR4 Lite ELRS Receiver', keywords: ['aerolink xr4 lite', 'xr4 lite', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS single antenna', priceUsd: 9.8, priceFloorUsd: 8.6, costRmb: 44, certs: ['CE'], moq: 100 }),
  P({ sku: 'C1', title: 'VoltPeak Vortex 3 FPV Drone RTF 3-inch', titleEn: 'VoltPeak Vortex 3 FPV Drone', keywords: ['vortex 3', 'fpv drone', 'voltpeak'], specs: '3 inch FPV RTF', priceUsd: 129, priceFloorUsd: 118, costRmb: 780, certs: ['CE'], moq: 20 }),
  P({ sku: 'D1', title: 'HydroSense PS-900 Industrial Pressure Sensor 316L IP67', titleEn: 'HydroSense PS-900 Pressure Sensor', keywords: ['ps-900', 'pressure sensor', 'hydrosense'], specs: '316L stainless steel, IP67, 4-20mA output', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['CE'], moq: 50 })
];
var settings = { fxRate: 7.1, sellerName: 'Sim Seller' };
var CASES = {
  A: 'Hello, this is Daniel from FlyMart GmbH. We want to order 800 pcs of AeroLink XR4 Pro ELRS receiver 2.4GHz, dual antenna version, with CE and FCC certificates. Delivery within 25 days. Please send your best quotation.',
  B: 'Hi, I saw your small receiver for FPV drones. Might order about 100 pcs. How much?',
  C: "Hi, we're interested in your Vortex 3 FPV drone. Your listed price is USD 129, but another supplier offered us USD 100 for a similar drone. Our target price is USD 102 per unit. Quantity: 300 pcs. Can you do that price?",
  D: 'We need industrial pressure sensors for a chemical plant project. Model PS-900 in your catalog looks close. Quantity is 150 pcs to start. We require ATEX certification for this order. Please quote your best price.',
  E: 'Hi, this is Daniel from FlyMart again. The XR4 Pro receivers from last order worked well. We want to reorder 2000 pcs of XR4 Pro, same spec as last time, and we still need FCC. Our target price this time is USD 10.5 per unit — can you match it?',
  B8: 'We require ATEX certification for this order. However, ATEX certification is not required for the same order.'
};
function dupFree(draft) {
  var lines = draft.split('\n').filter(function (l) { return l.indexOf('- Could you confirm') === 0 || l.indexOf('- 请确认') === 0; });
  return lines.length === new Set(lines).size && count(draft, 'Once I have these') <= 1;
}
['A', 'B', 'D', 'B8'].forEach(function (k) {
  var res = DD.analyze(CASES[k], catalog, settings, null);
  ok(res.reply && dupFree(res.reply.en) && dupFree(res.reply.zh), 'E 案例 ' + k + ' 双语草稿问题清单不重复');
});
var rc = DD.analyze(CASES.C, catalog, settings, null);
ok(/target price of \$102\.00/i.test(rc.reply.en) && rc.eff.targetPriceUsd === 102, 'E 案例 C 目标价角色不变（$102 客户目标价）');
var reE = DD.analyze(CASES.E, catalog, settings, null);
ok(!/(below|under|lower than)[^.]{0,40}(production )?cost/i.test(reE.reply.en), 'E 案例 E 无错误生产成本措辞');
var r8 = DD.analyze(CASES.B8, catalog, settings, null);
ok(r8.certGuard && r8.certGuard.type === 'conflict' && !/\$\s?\d/.test(r8.reply.en), 'E 案例 8b 冲突仍阻止报价且草稿无价');

console.log('== reply-prequote-duplicate: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
