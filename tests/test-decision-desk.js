/* P1-1 询盘处理决策台测试（纯 Node，全部虚构 DEMO 数据）
   运行：node tests/test-decision-desk.js */
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
ok('0. DecisionDesk 已加载', !!D && typeof D.analyze === 'function');

function P(o) {
  return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o);
}
var products = [
  P({ sku: 'PA', title: 'RadioMaster XR4 ELRS Receiver 2.4GHz Dual Band', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 12, priceFloorUsd: 10, costRmb: 55, certs: ['CE'] }),
  P({ sku: 'PB', title: 'BAYCK ELRS Nano Receiver 2.4GHz 915MHz', titleEn: 'BAYCK ELRS Nano Receiver', keywords: ['elrs receiver', 'nano receiver', '2.4ghz receiver'], specs: '2.4GHz 915MHz ELRS', priceUsd: 4.18, priceFloorUsd: 0, costRmb: 20, certs: [] }),
  P({ sku: 'PE', title: 'Happymodel ELRS Nano Receiver 2.4GHz', titleEn: 'Happymodel ELRS Nano Receiver', keywords: ['elrs receiver', 'nano receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 5, priceFloorUsd: 0, costRmb: 22, certs: [] }),
  P({ sku: 'PC', title: 'DJI Goggles 3 FPV Headset', titleEn: 'DJI Goggles 3', keywords: ['fpv goggles'], specs: 'O4', priceUsd: 499, priceFloorUsd: 450, costRmb: 2800, certs: ['CE', 'FCC'] }),
  P({ sku: 'PD', title: 'Generic ELRS Receiver NoCost Edition', titleEn: 'Generic ELRS Receiver', keywords: ['elrs receiver generic'], specs: '2.4GHz ELRS', priceUsd: 6, priceFloorUsd: 0, costRmb: 0, certs: [] })
];
var settings = { fxRate: 7.1, sellerName: 'Test Seller' };
function stepsHas(r, action) { return r.steps.some(function (s) { return s.action === action; }); }

/* 场景 1：信息完整、匹配明确 */
var r1 = D.analyze('Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days. Our target price is USD 11 per pc.', products, settings, null);
ok('1a. 数量解析为 500', r1.eff.qty === 500, String(r1.eff.qty));
ok('1b. 目标价解析为 11', r1.eff.targetPriceUsd === 11);
ok('1c. 认证解析含 CE', (r1.eff.certs || []).indexOf('CE') >= 0);
ok('1d. 最匹配为 PA 且非无匹配', !r1.noMatch && r1.top && r1.top.product.sku === 'PA', r1.candidates.map(function (c) { return c.product.sku + ':' + Math.round(c.score); }).join(','));
ok('1e. 候选带匹配依据（hits 非空）', r1.top.hits.length > 0, JSON.stringify(r1.top.hits));
ok('1f. 报价状态=可以进入报价', r1.readiness.key === 'can-quote', r1.readiness.key + '/' + r1.readiness.why);
ok('1g. 保本/登记底价/报价底线齐全且底线=取高', r1.unity.breakEvenUsd > 0 && r1.unity.businessFloorUsd === 10 && r1.unity.quoteFloorUsd === Math.max(r1.unity.breakEvenUsd, 10));
ok('1h. 下一步含「准备正式报价」', stepsHas(r1, '准备正式报价'));
ok('1i. 结果带 DEMO 标记', r1.demo === true);

/* 场景 2：规格缺失 */
var r2 = D.analyze('Hi, I want to buy some receivers, about 200 pcs for resale.', products, settings, null);
ok('2a. 规格/型号标记未知', r2.missing.some(function (x) { return x.field === 'spec'; }));
ok('2b. 下一步含「先确认规格/型号」', stepsHas(r2, '先确认规格/型号'));
ok('2c. 草稿未编造我方价格（RA 标记正式报价未形成或澄清场景）',
  !!r2.reply && (r2.reply.unconfirmed.join('；').indexOf('正式报价尚未形成') >= 0 || r2.reply.scenario === 'clarify' || r2.reply.scenario === 'prequote'),
  r2.reply ? r2.reply.scenario + '/' + r2.reply.unconfirmed.join(';') : 'no reply');

/* 场景 3：多商品相似、无法确定唯一 */
var r3 = D.analyze('Please quote 300 pcs ELRS nano receiver 2.4GHz for FPV drones.', products, settings, null);
ok('3a. 识别为多候选歧义', r3.ambiguous === true, r3.candidates.map(function (c) { return c.product.sku + ':' + Math.round(c.score); }).join(','));
ok('3b. 报价状态=需要人工核实', r3.readiness.key === 'need-verify', r3.readiness.key);
ok('3c. 下一步含「在候选商品中人工确认一款」', stepsHas(r3, '在候选商品中人工确认一款'));

/* 场景 4：买家给目标价但报价条件不足（无成本） */
var r4 = D.analyze('I need 100 pcs generic ELRS receiver, my target price is USD 5, please give your best price.', products, settings, null);
ok('4a. 最匹配为无成本商品 PD', r4.top && r4.top.product.sku === 'PD', r4.candidates.map(function (c) { return c.product.sku + ':' + Math.round(c.score); }).join(','));
ok('4b. 报价状态=缺少成本或必要报价参数', r4.readiness.key === 'missing-cost', r4.readiness.key);
ok('4c. 保本价未知（noCost）而非编造', r4.unity.noCost === true && r4.unity.breakEvenUsd === 0);
ok('4d. 下一步含「核实报价条件（先补成本）」', stepsHas(r4, '核实报价条件（先补成本）'));
ok('4e. 草稿标记正式报价未形成（不写我方价格）', !!r4.reply && r4.reply.unconfirmed.join('；').indexOf('正式报价尚未形成') >= 0);

/* 场景 5：商品完全不匹配 */
var r5 = D.analyze('We are looking for 1000 pcs industrial water pump 380V for factory use.', products, settings, null);
ok('5a. 判定无可靠匹配', r5.noMatch === true);
ok('5b. 报价状态=当前条件不适合报价', r5.readiness.key === 'not-suitable', r5.readiness.key);
ok('5c. 不强行给商品出报价（unity 为空）', r5.unity === null);
ok('5d. 下一步含「人工确认商品」', stepsHas(r5, '人工确认商品'));
ok('5e. 草稿不带任何商品价格', !!r5.reply && !/\b(price|USD|\$)\s*\d/i.test(r5.reply.en || '') || (r5.reply && r5.reply.scenario === 'prequote'), r5.reply ? r5.reply.scenario : 'no reply');

/* 人工修正：改数量后重算 */
var r1b = D.analyze('Hello, we need RadioMaster XR4 ELRS receiver.', products, settings, { qty: '50' });
ok('6a. 人工修正数量生效并标记 edited', r1b.eff.qty === 50 && r1b.eff.edited.qty === true, String(r1b.eff.qty));

/* ===== P1-4 回归：歧义时草稿不得带价（P1-3 审查 P1-01） =====
   断言对象是最终草稿文本，不只是 safePrice 布尔值。 */
var PB = products[1], PE = products[2];
var ambProducts = [PB, PE];
function draftHasCandidatePrice(r) {
  var en = (r.reply && r.reply.en) || '';
  return /best price is/i.test(en) || en.indexOf('$4.18') >= 0 || en.indexOf('$5.00') >= 0 || en.indexOf('$5 ') >= 0;
}
/* 场景 A：两款同分（52/52）+ 买家目标价 → 歧义，草稿无价（审查复现例） */
var aA = D.analyze('Please quote 300 pcs ELRS nano receiver 2.4GHz for FPV drones. Our target price is USD 4 per pc.', ambProducts, settings, null);
ok('A1. 同分判定歧义', aA.ambiguous === true, aA.candidates.map(function (c) { return Math.round(c.score); }).join('/'));
ok('A2. 歧义草稿无「best price」报价表达', !/best price is/i.test(aA.reply ? aA.reply.en : ''));
ok('A3. 歧义草稿无任何候选商品价格', !draftHasCandidatePrice(aA), (aA.reply || {}).en);
ok('A4. 歧义时报价状态仍为需要人工核实', aA.readiness.key === 'need-verify');
/* 场景 B：另一组同分文本（56/56）+ 目标价 → 同样无价 */
var aB = D.analyze('Please quote 300 pcs ELRS nano receiver 2.4GHz for resale. Our target price is USD 4 per pc.', ambProducts, settings, null);
ok('B1. 第二组同分判定歧义', aB.ambiguous === true, aB.candidates.map(function (c) { return Math.round(c.score); }).join('/'));
ok('B2. 草稿无候选价格', !draftHasCandidatePrice(aB));
/* 场景 C：分差达到非歧义侧（品牌明确，gap≥10）+ 目标价 → 按原逻辑正常带价 */
var aC = D.analyze('Please quote 300 pcs BAYCK ELRS nano receiver 2.4GHz 915MHz. Our target price is USD 4 per pc.', ambProducts, settings, null);
ok('C1. 品牌明确时不歧义', aC.ambiguous === false);
ok('C2. 明确匹配草稿正常含价（$4.18）', /best price is \$4\.18/i.test(aC.reply ? aC.reply.en : ''), (aC.reply || {}).en);
/* 场景 D：先明确匹配带价，再改为歧义重分析 → 旧价消失 */
var aD1 = D.analyze('Please quote 300 pcs BAYCK ELRS nano receiver 2.4GHz 915MHz. Our target price is USD 4 per pc.', ambProducts, settings, null);
var aD2 = D.analyze('Please quote 300 pcs ELRS nano receiver 2.4GHz for FPV drones. Our target price is USD 4 per pc.', ambProducts, settings, null);
ok('D1. 第一轮明确匹配带价', /best price is/i.test(aD1.reply ? aD1.reply.en : ''));
ok('D2. 改为歧义后旧价消失', aD2.ambiguous === true && !draftHasCandidatePrice(aD2));
/* 场景 E：歧义且买家没给目标价 → 不得自行生成候选价格 */
var aE = D.analyze('Please quote 300 pcs ELRS nano receiver 2.4GHz for FPV drones.', ambProducts, settings, null);
ok('E1. 无目标价仍判定歧义', aE.ambiguous === true);
ok('E2. 草稿无候选价格', !draftHasCandidatePrice(aE), (aE.reply || {}).en);

/* ===== 方案 1 展示修复：工作报价（草稿采用）门控（W 组） =====
   门控真值在 analyze() 的 draftPriced；view() 据此渲染第 3 区。
   W1/W2 按 C2-bis / C2 首轮的信息结构构造，商品与文本全部虚构
   （GATE-03 脱敏：原夹具曾借用真实商品标题与真实成本，已替换）。 */
var S6 = { fxRate: 6.68, sellerName: 'Test Seller' };
var VG9 = P({ sku: 'VG9', title: 'VantaGlow VG-9 Pro 1200 Lumen Black Anodized Aluminum Tactical Flashlight Magnetic Tail Switch 3-Year Warranty for Outdoor Patrol', titleEn: 'VantaGlow VG-9 Tactical Flashlight', keywords: ['vantaglow vg-9', 'vg-9', 'tactical flashlight'], specs: '1200 Lumen', priceUsd: 23.45, priceFloorUsd: 0, costRmb: 96, certs: [] });
function viewOf(r, text) { D._state.text = text; D._state.result = r; D._state.draft = r.reply ? r.reply.en : ''; return D.view(); }
var T_BIS = 'Hello, we are interested in your VantaGlow VG-9 Pro 1200 Lumen Black Anodized Aluminum Tactical Flashlight with Magnetic Tail Switch. Please quote 100 pcs, delivered to Hamburg, Germany. We need delivery within 30 days. The flashlights are for outdoor security patrol use.';
var T_C2 = 'Hello, we are interested in your VantaGlow VG-9 Pro 1200 Lumen Black Anodized Aluminum Tactical Flashlight with Magnetic Tail Switch. Please quote 100 pcs.';
/* W1：完整信息——工作报价正确展示，建议价作为参考展示 */
var w1 = D.analyze(T_BIS, [VG9], S6, null);
ok('W1a. C2-bis 就绪=可以进入报价', w1.readiness.key === 'can-quote', w1.readiness.key);
ok('W1b. C2-bis draftPriced=true', w1.draftPriced === true);
var w1v = viewOf(w1, T_BIS);
ok('W1c. 第 3 区含「工作报价（草稿采用）：$23.45/件」', w1v.indexOf('工作报价（草稿采用）：<b>$23.45/件</b>') >= 0);
ok('W1d. 第 3 区含「系统建议价（参考）：$14.40/件」（本夹具口径）', w1v.indexOf('系统建议价（参考）：<b>$14.40/件</b>') >= 0);
/* W2：信息不完整——澄清草稿不出现「工作报价（草稿采用）」 */
var w2 = D.analyze(T_C2, [VG9], S6, null);
ok('W2a. C2 首轮就绪仍为可以进入报价', w2.readiness.key === 'can-quote', w2.readiness.key);
ok('W2b. C2 首轮 draftPriced=false（草稿为澄清稿）', w2.draftPriced === false, (w2.reply || {}).en);
ok('W2c. 第 3 区不含「工作报价（草稿采用）」', viewOf(w2, T_C2).indexOf('工作报价（草稿采用）') < 0);
/* W3：缺成本——不展示工作报价 */
var w3 = D.analyze('Hello, please quote 300 pcs Generic ELRS Receiver NoCost Edition for FPV drones, delivery within 20 days to Los Angeles, USA.', [products[4]], settings, null);
ok('W3a. 就绪=缺少成本', w3.readiness.key === 'missing-cost', w3.readiness.key);
ok('W3b. draftPriced=false', w3.draftPriced === false);
ok('W3c. 第 3 区不含工作报价、建议价为 —', viewOf(w3, '').indexOf('工作报价（草稿采用）') < 0 && viewOf(w3, '').indexOf('系统建议价（参考）：<b>—</b>') >= 0);
/* W4：歧义拦截——不展示工作报价（复用场景 A 的歧义结果） */
ok('W4a. 歧义 draftPriced=false', aA.draftPriced === false);
ok('W4b. 歧义第 3 区不含「工作报价（草稿采用）」', viewOf(aA, '').indexOf('工作报价（草稿采用）') < 0);
/* W5：认证冲突——不展示工作报价 */
var w5 = D.analyze('Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz, delivery within 20 days to Berlin, Germany. CE certification is mandatory for our market. However, our warehouse team says a CE certificate is not required for this receiver. Please quote.', [products[0]], settings, null);
ok('W5a. 认证冲突已触发', !!w5.certGuard, w5.readiness.key);
ok('W5b. draftPriced=false', w5.draftPriced === false);
ok('W5c. 第 3 区不含「工作报价（草稿采用）」', viewOf(w5, '').indexOf('工作报价（草稿采用）') < 0);
/* W6：草稿其他文字出现相同金额（商品标题含 $23.45），报价行未采用——不得误显示 */
var TRAP = P({ sku: 'TRAP', title: 'Promo Tactical Flashlight $23.45 Special Edition', titleEn: 'Promo Tactical Flashlight Special Edition', keywords: ['promo tactical flashlight', 'special edition flashlight'], specs: '1200 Lumen', priceUsd: 23.45, priceFloorUsd: 0, costRmb: 96, certs: [] });
var w6 = D.analyze('Hello, we are interested in your Promo Tactical Flashlight Special Edition. Please quote 100 pcs.', [TRAP], S6, null);
ok('W6a. 陷阱已布：草稿正文含 $23.45（标题行）且就绪可报价', ((w6.reply || {}).en || '').indexOf('$23.45') >= 0 && w6.readiness.key === 'can-quote', w6.readiness.key);
ok('W6b. draftPriced=false（金额不在报价行）', w6.draftPriced === false, (w6.reply || {}).en);
ok('W6c. 第 3 区不含「工作报价（草稿采用）」', viewOf(w6, '').indexOf('工作报价（草稿采用）') < 0);
/* W7：报价行格式变体——incoterm 后缀、一位小数价格的两位小数形态 */
var w7a = D.analyze(T_BIS + ' FOB Shenzhen.', [VG9], S6, null);
ok('W7a. incoterm 变体：报价行带 (FOB…) 后缀且 draftPriced=true', w7a.draftPriced === true && /per piece \(FOB/.test((w7a.reply || {}).en || ''), (w7a.reply || {}).en);
var DEC = P({ sku: 'DEC', title: 'LumenPro Trail Headlamp 1200 Lumen Rechargeable', titleEn: 'LumenPro Trail Headlamp', keywords: ['lumenpro headlamp', 'trail headlamp'], specs: '1200 Lumen', priceUsd: 17.4, priceFloorUsd: 0, costRmb: 60, certs: [] });
var w7b = D.analyze('Hello, we are interested in your LumenPro Trail Headlamp 1200 Lumen Rechargeable. Please quote 100 pcs, delivered to Hamburg, Germany. We need delivery within 30 days. For trail running use.', [DEC], S6, null);
ok('W7b. 价格 17.4 的报价行以 $17.40 形态出现且 draftPriced=true', w7b.draftPriced === true && ((w7b.reply || {}).en || '').indexOf('our price is $17.40 per piece') >= 0, (w7b.reply || {}).en);
ok('W7c. 第 3 区工作报价显示 $17.40/件（两位小数）', viewOf(w7b, '').indexOf('工作报价（草稿采用）：<b>$17.40/件</b>') >= 0);
/* W8：同一输入下草稿英文与金标逐字一致（金标为脱敏夹具实测捕获） */
var GOLDEN_W = ['Hi,', '', 'Thanks for your inquiry about the VantaGlow VG-9 Pro 1200 Lumen Black Anodized Aluminum Tactical Flashlight Magnetic Tail Switch 3-Year Warranty for Outdoor Patrol (VG9).', 'Specifications as listed: 1200 Lumen.', 'Minimum order quantity: 10 pcs.', 'Standard lead time: about 15 days.', 'For 100 pcs, our price is $23.45 per piece.', 'To finalize the details, could you confirm:', '- Could you confirm what the products will be used for?', 'Looking forward to your reply.', '', 'Best regards,', 'Test Seller'].join('\n');
ok('W8. 草稿英文与金标逐字一致', w1.reply.en === GOLDEN_W, JSON.stringify(w1.reply.en));

console.log('\n== decision-desk: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
