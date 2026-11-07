/* P1-22 第一阶段：客户销售判断模块测试（8 个虚构案例 + 覆盖层/诚实性）。
   eff 由真实 P0Parse 构造（与 app.js effectiveParsed 相同的字段口径子集）。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var sb = { console: { log: function () {} } };
sb.window = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'p0-parse.js'), 'utf8'), sb, { filename: 'p0-parse.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'sales-analysis.js'), 'utf8'), sb, { filename: 'sales-analysis.js' });
var SA = sb.window.SalesAnalysis, P0 = sb.window.P0Parse;
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }

function effOf(text) {
  var p0 = P0.extract(text), f = p0.fields;
  return {
    productName: f.productName || '', purpose: f.purpose || '', qty: f.qty || 0, qtyUnit: f.qtyUnit || 'pcs',
    targetPriceUsd: f.targetPriceUsd || 0, country: '', destination: f.destination || '',
    leadTimeDays: f.deadlineDays || 0, deadlineText: f.deadlineText || '', certs: f.certs || [],
    incoterm: f.incoterm || '', models: f.models || [], specs: f.specs || [], specsText: '',
    productText: f.productText || '', evidence: p0.evidence || {},
    priceAmbiguous: !f.targetPriceUsd && (f.priceTargetCandidates || []).length > 1
  };
}
function inputOf(text, extra) {
  var p0 = P0.extract(text);
  var conflict = (p0.fields.certMentions || []).filter(function (m) { return m.conflict; })[0] || null;
  return Object.assign({
    rawText: text, eff: effOf(text), buyerName: 'Buyer', isRepeat: false, hasPriorOrders: false,
    certConflict: !!conflict, certConflictText: conflict ? conflict.evidence.map(function (e) { return e.snippet; }).join(' / ') : '',
    productName: null, productCerts: null, productMoq: 0
  }, extra || {});
}
function need(r, k) { return r.needs.filter(function (n) { return n.key === k; })[0]; }
function concern(r, t) { return r.concerns.filter(function (c) { return c.topic === t; })[0]; }
function stepHas(r, re) { return r.steps.some(function (s) { return re.test(s.action); }); }

var CASES = {
  c1: 'Hello, we want to order 800 pcs of AeroLink XR4 Pro ELRS receiver for our online store. Need CE and FCC certificates. Delivery within 25 days to Hamburg port, Germany. Please send your quotation with datasheet.',
  c2: 'Hi, price?',
  c3: 'We need FPV receivers, quantity 500 pcs. How much?',
  c4: 'We need 150 pcs PS-900 pressure sensors for our chemical plant. ATEX certification is mandatory. Please quote your best price.',
  c5: 'We want 300 pcs of your XR4 receivers. The receiver must have CE certification. Note: CE is not required for this order.',
  c6: 'Please send me your full price list for all receivers.',
  c7: 'Hi, we would like to reorder the XR4 Pro receivers, 2000 pcs this time, same specs as last order. FCC needed.',
  c8: 'We need 500 pcs XR4 receivers. CE certificate must be provided. Actually CE is not required. Quantity might be 2000 pcs if the price is good. Our target is around $9 to $11 per pc.'
};

/* 案例1 信息完整 */
(function () { var r = SA.analyze(inputOf(CASES.c1));
  ok(need(r, 'qty').status === 'stated' && /800/.test(need(r, 'qty').value), 'C1 数量明确');
  ok(need(r, 'certs').status === 'stated' && /CE/.test(need(r, 'certs').value), 'C1 认证明确');
  ok(need(r, 'delivery').status === 'stated', 'C1 交期明确');
  ok(need(r, 'destination').status === 'stated', 'C1 目的地明确');
  ok(r.stage.label === '明确需求', 'C1 阶段=明确需求（实际 ' + r.stage.label + '）');
  ok(stepHas(r, /报价|样品/), 'C1 建议推进报价/样品');
})();
/* 案例2 一句询价 */
(function () { var r = SA.analyze(inputOf(CASES.c2));
  ok(need(r, 'product').status === 'missing' && need(r, 'qty').status === 'missing', 'C2 产品与数量均为未提供');
  ok(r.stage.label === '暂时无法判断', 'C2 阶段=暂时无法判断（实际 ' + r.stage.label + '）');
  ok(concern(r, '产品质量').level === '未知' && concern(r, '售后').level === '未知', 'C2 未提及的顾虑标未知、不编造');
  ok(!/概率|%/.test(JSON.stringify(r)), 'C2 输出无成交概率类内容');
})();
/* 案例3 规格缺失 */
(function () { var r = SA.analyze(inputOf(CASES.c3));
  ok(need(r, 'product').status !== 'missing', 'C3 产品已识别');
  ok(need(r, 'specs').status === 'missing', 'C3 规格标未提供');
  ok(stepHas(r, /规格/), 'C3 建议先问规格');
})();
/* 案例4 认证要求 */
(function () { var r = SA.analyze(inputOf(CASES.c4));
  ok(/ATEX/.test(need(r, 'certs').value) && need(r, 'certs').status === 'stated', 'C4 ATEX 被识别为认证要求（含未识别标注）');
  ok(concern(r, '认证') && concern(r, '认证').level === '明确关注', 'C4 认证=明确关注且有依据');
})();
/* 案例5 认证冲突 */
(function () { var r = SA.analyze(inputOf(CASES.c5));
  ok(need(r, 'certs').status === 'conflict', 'C5 认证状态=冲突');
  ok(r.steps.length && /核实认证/.test(r.steps[0].action), 'C5 第一步先核实认证冲突');
})();
/* 案例6 只询价无意向 */
(function () { var r = SA.analyze(inputOf(CASES.c6));
  ok(r.stage.label === '初步了解', 'C6 阶段=初步了解而非谈判（实际 ' + r.stage.label + '）');
  ok(concern(r, '价格') && concern(r, '价格').level === '明确关注', 'C6 价格=明确关注');
  ok(!stepHas(r, /议价|让步/), 'C6 不给出议价类建议');
})();
/* 案例7 老客户复购 */
(function () { var r = SA.analyze(inputOf(CASES.c7, { isRepeat: true }));
  ok(r.stage.label === '样品或订单推进', 'C7 复购阶段=样品或订单推进（实际 ' + r.stage.label + '）');
  ok(/系统记录/.test(r.stage.evidence.join(' ')), 'C7 阶段证据注明来自系统记录而非原文');
})();
/* 案例8 多条件冲突 */
(function () { var r = SA.analyze(inputOf(CASES.c8));
  ok(need(r, 'certs').status === 'conflict', 'C8 认证冲突被标出');
  ok(need(r, 'targetPrice').status === 'conflict', 'C8 目标价区间标冲突/待确认');
  ok(/冲突/.test(r.stage.uncertainty), 'C8 不确定性说明包含冲突提示');
  ok(stepHas(r, /核实认证|确认.*目标价/), 'C8 建议先澄清冲突');
})();
/* 覆盖层与诚实性 */
(function () {
  var inp = inputOf(CASES.c1);
  var snapshot = JSON.stringify(inp.eff);
  var r = SA.analyze(inp);
  ok(JSON.stringify(inp.eff) === snapshot, 'H1 analyze 不改动输入解析结果');
  var disp = SA.applyReview(r, { stageFix: '供应商筛选', needFix: { qty: { value: '900 pcs', at: '2026-11-05' } }, concernFix: { '产品质量': 'confirmed' }, flagged: ['stage'] });
  ok(disp.stage.label === '供应商筛选' && disp.stage.confirmed === true, 'H2 员工可修正采购阶段且标记为人工确认');
  ok(need(disp, 'qty').status === 'confirmed' && need(disp, 'qty').value === '900 pcs' && need(disp, 'qty').aiValue !== '900 pcs', 'H3 需求修正以人工确认保存且保留 AI 原值');
  ok(concern(disp, '产品质量').level === '明确关注' && /员工已确认/.test(concern(disp, '产品质量').evidence), 'H4 关注点可人工确认');
  ok(need(r, 'qty').status === 'stated', 'H5 覆盖层不回写 AI 原结果');
  ok(disp.stage.flagged === true, 'H6 可标记阶段判断不准确');
  var allText = JSON.stringify(SA.analyze(inputOf(CASES.c1))) + JSON.stringify(SA.analyze(inputOf(CASES.c7, { isRepeat: true })));
  ok(!/成交概率|win rate|probability/i.test(allText), 'H7 全输出无成交概率话术');
})();

console.log('== sales-analysis: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
