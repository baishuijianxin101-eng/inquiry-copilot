/* P1-8 今日优先专项（Node 部分，全部虚构数据）
   覆盖：ReplyAssistant.detectScenario 导出存在且与 generate 的场景判定
   逐项一致（队列与详情页草稿共用同一判定，不另造规则）；意向只读最新
   买家消息与最新目标价口径。
   队列合成与工作台渲染在 app.js 内，由真实浏览器链路验证（见交付报告）。
   运行：node tests/test-p1-8-priority.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var sb = { console: console }; sb.window = sb; sb.globalThis = sb; vm.createContext(sb);
['assets/lang-pack.js', 'assets/p0-parse.js', 'assets/reply-assistant.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
});
var RA = sb.ReplyAssistant, P0 = sb.P0Parse;
var P = { id: 'p1', title: 'receptor RadioMaster XR4 Gemini', titleEn: 'receptor RadioMaster XR4 Gemini', sku: 'SKU-1', certs: ['CE'], moq: 10, leadTimeDays: 15 };
function eff(o) { return Object.assign({ qty: 500, qtyUnit: 'pcs', models: [], productName: '', country: '', destination: '', leadTimeDays: 0, deadlineText: '', purpose: '', certs: [], targetPriceUsd: null, targetQty: null, targetAmbiguous: false, incoterm: '' }, o || {}); }
function ltOf(text) { var f = (P0.extract(text) || {}).fields || {}; return f.targetPriceUsd > 0 ? f.targetPriceUsd : null; }
function input(raw, latest, e, match) {
  return { opp: { rawText: raw, buyer: {}, status: 'new', followCount: 0 }, eff: eff(e), product: P, match: match || { score: 90, keyConflict: false, conflicts: [] }, price: { unit: 4.2, floor: 3.8 }, sellerName: 'S', scenario: 'auto', lang: 'en', latestText: latest, latestTargetPriceUsd: latest != null ? ltOf(latest) : undefined };
}

ok('Q1 detectScenario 已导出为函数', typeof RA.detectScenario === 'function');

/* 与 generate 的场景判定逐项一致（同输入同结论） */
var CASES = [
  ['PI+定金 → closing', 'Please send the PI for 500 pcs, we will arrange 30% deposit by T/T', null, null, null],
  ['条件议价 → negotiation', 'If you can do $2.00 I will place the order', null, { targetPriceUsd: 2 }, null],
  ['not ready → 非 closing', 'We are not ready to place an order.', null, null, null],
  ['样品 → sample', 'Please send samples for testing first.', null, null, null],
  ['规格 → spec', 'Please share the full specifications and datasheet.', null, null, null],
  ['关键冲突 → clarify', 'Please quote the XR4 receiver.', null, null, { score: 40, keyConflict: true, conflicts: ['型号不符'] }]
];
CASES.forEach(function (c, i) {
  var inp = input(c[1], undefined, c[3], c[4]);
  var viaGen = RA.generate(inp).scenario;
  var viaDet = RA.detectScenario(inp);
  ok('Q2.' + (i + 1) + ' 判定一致：' + c[0], viaGen === viaDet, 'gen=' + viaGen + ' det=' + viaDet);
});

/* 意向只读最新买家消息（队列口径） */
var PI_OLD = 'Please send the PI for 500 pcs, we will arrange the deposit.';
ok('Q3 历史 PI + 最新转冷 → 非 closing', RA.detectScenario(input(PI_OLD, 'Thanks, we are still comparing suppliers.')) !== 'closing', RA.detectScenario(input(PI_OLD, 'Thanks, we are still comparing suppliers.')));
ok('Q4 首条普通 + 最新 PI → closing', RA.detectScenario(input('We need 500 pcs of XR4 receiver with CE, please quote.', 'Please send the PI for 500 pcs.')) === 'closing');
ok('Q5 最新消息重新提价 → negotiation（优先于旧 PI）', RA.detectScenario(input(PI_OLD, 'Can you do $9.80 per pc?')) === 'negotiation', RA.detectScenario(input(PI_OLD, 'Can you do $9.80 per pc?')));
ok('Q6 无 latestText 的旧调用回落 rawText', RA.detectScenario(input(PI_OLD, undefined)) === 'closing');
var noKey = { opp: { rawText: PI_OLD, buyer: {}, status: 'new', followCount: 0 }, eff: eff(), product: P, match: { score: 90, keyConflict: false, conflicts: [] } };
ok('Q7 完全无新参数时回落 eff.targetPriceUsd', RA.detectScenario(Object.assign({}, noKey, { eff: eff({ targetPriceUsd: 3 }) })) === 'negotiation');

console.log('\n=== P1-8 priority (RA): ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
