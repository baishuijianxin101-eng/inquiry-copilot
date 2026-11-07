/* P1-17 第五阶段收尾：R1 证据分层语义 + R4 报价角色区分
   纯 Node，全部虚构数据。运行：node tests/test-phase5-closing.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
function cm(text, name) {
  return P.extract(text).fields.certMentions.filter(function (m) { return m.name === name; })[0] || null;
}

/* ---------- R1：三层语义 ---------- */
var a3 = cm('ATEX is mandatory, and ATEX is mandatory for this order.', 'ATEX');
ok('R1-1. A3 contexts 归纳去重为一个 mandatory', a3 && a3.contexts.length === 1 && a3.contexts[0] === 'mandatory', JSON.stringify(a3 && a3.contexts));
ok('R1-2. A3 evidence 逐次保留两条', a3 && a3.evidence.length === 2, JSON.stringify(a3 && a3.evidence));
ok('R1-3. A3 两条证据位置可区分（pos 不同）', a3 && a3.evidence.length === 2 && typeof a3.evidence[0].pos === 'number' && a3.evidence[0].pos !== a3.evidence[1].pos, JSON.stringify(a3 && a3.evidence));
ok('R1-4. A3 conflict 为 false', a3 && a3.conflict === false, '');
var a1 = cm('ATEX is optional, but ATEX is required.', 'ATEX');
ok('R1-5. A1 两次出现各有证据且位置不同', a1 && a1.evidence.length === 2 && a1.evidence[0].pos !== a1.evidence[1].pos, JSON.stringify(a1 && a1.evidence));
ok('R1-6. A1 两条证据语境分别为 not-required 与 mandatory', a1 && a1.evidence.some(function (e) { return e.context === 'not-required'; }) && a1.evidence.some(function (e) { return e.context === 'mandatory'; }), '');
var b3 = cm('ATEX is mandatory. ATEX is mandatory for this order.', 'ATEX');
ok('R1-7. B3 跨句同语境：证据两条、原文不同、contexts 一个', b3 && b3.evidence.length === 2 && b3.evidence[0].snippet !== b3.evidence[1].snippet && b3.contexts.length === 1, JSON.stringify(b3));
ok('R1-8. 兼容字段保持：context/snippet 仍在且 context 为最高优先级', a1 && a1.context === 'mandatory' && typeof a1.snippet === 'string' && a1.snippet.length > 0, '');

/* ---------- R4：报价角色区分（vm 加载决策台） ---------- */
var sandbox = { console: console };
sandbox.window = sandbox;
var store = {};
sandbox.localStorage = { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } };
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
var sensor = SP({ sku: 'S2', title: 'HydroSense PS-900 Pressure Sensor 316L IP67', titleEn: 'PS-900 Pressure Sensor', keywords: ['pressure sensor', 'ps-900', 'sensor'], specs: '316L IP67 0-10bar 4-20mA', priceUsd: 46, priceFloorUsd: 40, costRmb: 260, certs: ['ATEX', 'CE'] });
/* RA 我方报价的实际句式（源码实测：money() 仅 $X.XX，卖方报价只出现在三种句式中） */
var SELLER_PRICE_RE = /(Our current best price is|The best I can offer|our price is)\s*\$[\d,]+\.\d{2}/i;
function sellerPriceIn(draft) { return SELLER_PRICE_RE.test(draft || ''); }

/* 正对照：可报价时草稿确实含我方报价句式（证明检测器有效，不是永远 false） */
var rOk = D.analyze('We need pressure sensor PS-900, 316L IP67 0-10bar 4-20mA, 200 pcs. Our target price is USD 44 per pc.', [sensor], settings);
ok('R4-1. 正对照：可报价草稿含我方报价句式且检测器命中', rOk.readiness.key === 'can-quote' && sellerPriceIn(rOk.reply && rOk.reply.en), ((rOk.reply && rOk.reply.en) || '').slice(0, 160));
/* 客户目标价回声不得误判为我方报价：目标价 30（低于底价）→ 谈判草稿会回述客户目标价 $30.00，
   且在本场景给出我方最优价 $46.00——检测器应只认卖方句式，客户回声本身不触发 */
var rNeg = D.analyze('We need pressure sensor PS-900, 316L IP67 0-10bar 4-20mA, 200 pcs. Our target price is USD 30 per pc.', [sensor], settings);
var custEcho = /target price of \$30\.00|\$30\.00 is below/.test((rNeg.reply && rNeg.reply.en) || '');
ok('R4-2. 谈判草稿含客户目标价回声（$30.00 以客户语气出现）', custEcho, ((rNeg.reply && rNeg.reply.en) || '').slice(0, 220));
ok('R4-3. 客户回声不等于我方报价：$30.00 不出现在任何卖方报价句式中', !/(Our current best price is|The best I can offer|our price is)\s*\$30\.00/i.test((rNeg.reply && rNeg.reply.en) || ''), '');
/* 同一询盘加未知认证 → 护栏拦截：草稿不得出现我方报价（$46.00 彻底消失），客户回声可保留 */
var rBlk = D.analyze('We need pressure sensor PS-900, 316L IP67 0-10bar 4-20mA, 200 pcs. Our target price is USD 30 per pc. ZZAB certification is required.', [sensor], settings);
ok('R4-4. 护栏拦截后无我方报价句式', !!rBlk.certGuard && !sellerPriceIn(rBlk.reply && rBlk.reply.en), JSON.stringify(rBlk.certGuard));
ok('R4-5. 护栏拦截后我方价格数值 $46.00 不出现在草稿任何位置', !/\$46\.00/.test(((rBlk.reply && rBlk.reply.en) || '') + ((rBlk.reply && rBlk.reply.zh) || '')), ((rBlk.reply && rBlk.reply.en) || '').slice(0, 200));
console.log('== phase5-closing: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
