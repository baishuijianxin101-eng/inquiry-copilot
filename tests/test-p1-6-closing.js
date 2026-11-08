/* P1-6-CLOSING 专项：购买意向识别与成交推进场景。
   覆盖：意向判定与优先级（clarify > negotiation > closing）、四语 closing 稿、
   无价不写价、不编造付款/银行信息、样品转订单、缺句降级、
   Core 白名单兼容（closing 可存、旧稿无损、未知键仍剥离）、决策台集成。
   运行：node tests/test-p1-6-closing.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function load(files, extra) {
  var sb = { console: { log: function () {}, warn: function () {}, error: function () {} } };
  sb.window = sb; sb.globalThis = sb;
  var m = {};
  sb.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  vm.createContext(sb);
  files.forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f }); });
  if (extra) extra(sb);
  return sb;
}
var sb = load(['assets/lang-pack.js', 'assets/reply-assistant.js']);
var RA = sb.ReplyAssistant, LP = sb.LangPack;
var P = { id: 'p1', title: 'receptor RadioMaster XR4 Gemini', titleEn: 'receptor RadioMaster XR4 Gemini', sku: '10000041123242', model: 'XR4', brand: 'RadioMaster', certs: ['CE'], moq: 10, leadTimeDays: 15, priceUsd: 12.5 };
function eff(o) { return Object.assign({ qty: 0, qtyUnit: 'pcs', models: [], productName: '', country: '', destination: '', leadTimeDays: 0, deadlineText: '', purpose: '', certs: [], targetPriceUsd: null, targetQty: null, targetAmbiguous: false, incoterm: '' }, o || {}); }
function gen(o) {
  return RA.generate({ opp: { rawText: o.raw || '', buyer: { name: o.buyer || '' }, status: 'new', followCount: 0 },
    eff: eff(o.eff), product: o.product === null ? null : P, match: o.match || { score: 90, keyConflict: false, conflicts: [] },
    price: o.price === undefined ? { unit: 4.2, floor: 3.8 } : o.price, sellerName: 'Test Seller', scenario: 'auto', lang: o.lang || 'en' });
}

/* 1. EN：索要 PI + 定金安排 → closing；复述可信事实，不编造付款/银行 */
var g1 = gen({ raw: 'Please send the PI for 500 pcs, we will arrange 30% deposit by T/T', eff: { qty: 500 } });
ok(g1.scenario === 'closing', '1. PI+定金 → closing', g1.scenario);
ok(g1.send.indexOf('$4.20') >= 0 && g1.send.indexOf('500') >= 0, '1b. 复述安全报价与数量');
ok(!/30%/.test(g1.send) && !/bank/i.test(g1.send) && !/paid|received/i.test(g1.send), '1c. 不复述定金比例、不编造银行、不写已付款');
ok(g1.send.indexOf('proforma invoice') >= 0 && g1.send.indexOf('Destination port') >= 0, '1d. 清单含形式发票与目的港确认');
ok(g1.unconfirmed.indexOf('付款方式与账期待买家确认') >= 0, '1e. 付款列入待确认');

/* 2. 只问价格 → 不进 closing */
var g2 = gen({ raw: 'price?' });
ok(g2.scenario !== 'closing' && g2.scenario === 'prequote', '2. price? → prequote 不进 closing', g2.scenario);

/* 3. 条件句议价 → negotiation 优先（意向词存在也不进 closing） */
var raw3 = 'If you can do $2.00 I will place the order';
ok(RA.hasOrderIntent(raw3) === true, '3a. 条件句含意向词（靠优先级拦截）');
var g3 = gen({ raw: raw3, eff: { qty: 500, targetPriceUsd: 2, targetQty: 500 }, price: null });
ok(g3.scenario === 'negotiation', '3b. 条件议价 → negotiation', g3.scenario);

/* 4. 中文买家：准备下单 + 问定金 → 中文 closing 发送稿 */
var g4 = gen({ raw: '你好，XR4 接收机我们准备下单了，请问定金怎么付？', eff: { qty: 500 }, lang: 'zh', buyer: '' });
ok(g4.scenario === 'closing' && g4.sendLang === 'zh', '4. 中文下单+定金 → closing/zh', g4.scenario + '/' + g4.sendLang);
ok(g4.send.indexOf('推进这笔订单') >= 0 && g4.send.indexOf('付款方式与账期') >= 0 && g4.send.indexOf('$4.20') >= 0, '4b. 中文稿含推进与清单与安全报价');

/* 5. 西语：cerrar el pedido + factura proforma → 西语 closing + 中文对照 */
var g5 = gen({ raw: 'Hola, podemos cerrar el pedido de 500 unidades del receptor XR4. Por favor envíen la factura proforma.', eff: { qty: 500 }, lang: 'es' });
ok(g5.scenario === 'closing' && g5.sendLang === 'es' && g5.degraded === false, '5. 西语 → closing/es 无降级', g5.scenario + '/' + g5.sendLang);
ok(g5.send.indexOf('factura proforma') >= 0 && g5.send.indexOf('Puerto de destino') >= 0, '5b. 西语稿含清单');
ok(g5.zh.indexOf('形式发票') >= 0 && g5.zh.indexOf('目的港') >= 0, '5c. 中文对照一致');
ok(g5.send.split('\n').length === g5.en.split('\n').length, '5d. 西语与英文行数平价');

/* 6. 葡语 / 俄语 closing 模板 */
var g6 = gen({ raw: 'Podemos fechar o pedido de 500 unidades, pode enviar a fatura proforma?', eff: { qty: 500 }, lang: 'pt' });
ok(g6.scenario === 'closing' && g6.sendLang === 'pt' && g6.send.indexOf('fatura proforma') >= 0, '6. 葡语 closing', g6.scenario + '/' + g6.sendLang);
var g7 = gen({ raw: 'Мы готовы заказать 500 шт. Пришлите, пожалуйста, проформу для предоплаты.', eff: { qty: 500 }, lang: 'ru' });
ok(g7.scenario === 'closing' && g7.sendLang === 'ru' && g7.send.indexOf('Порт назначения') >= 0, '6b. 俄语 closing', g7.scenario + '/' + g7.sendLang);

/* 7. closing 无安全报价 → 明说待确认、全稿无价格数字 */
var g8 = gen({ raw: 'Please send the PI for 500 pcs', eff: { qty: 500 }, price: null, lang: 'es' });
ok(g8.scenario === 'closing' && !/\$\s?\d/.test(g8.send) && g8.send.indexOf('aún se está confirmando') >= 0, '7. 无价 closing 不写价且明说待确认');
ok(g8.unconfirmed.some(function (u) { return u.indexOf('回复未写任何价格') >= 0; }), '7b. 无价进入待确认清单');

/* 8. 样品 OK 转订单 → closing，不重复样品话术 */
var g9 = gen({ raw: "Hi, sample is OK, let's move to order for 500 pcs.", eff: { qty: 500 } });
ok(g9.scenario === 'closing' && g9.send.indexOf('arrange a sample') < 0, '8. 样品转订单 → closing', g9.scenario);

/* 9. 防误判：索样/规格/MOQ/冲突均不进 closing */
ok(gen({ raw: 'please send samples for testing', eff: {} }).scenario === 'sample', '9a. 索样仍 sample');
ok(gen({ raw: 'please send the specifications and datasheet', eff: { qty: 500, country: 'Spain', productName: 'XR4' } }).scenario === 'spec', '9b. 规格仍 spec');
ok(gen({ raw: 'what is your MOQ for this receiver?', eff: {} }).scenario !== 'closing', '9c. 问 MOQ 不进 closing');
var g9d = gen({ raw: 'Please send the PI for 500 pcs', eff: { qty: 500 }, match: { score: 40, keyConflict: true, conflicts: ['频段不一致'] } });
ok(g9d.scenario === 'clarify', '9d. 关键冲突 → clarify 优先于 closing', g9d.scenario);
ok(gen({ raw: 'in order to check the quality, please send samples', eff: {} }).scenario === 'sample', '9e. "in order to" 不误触发 closing');

/* 10. 缺句降级：删西语 cAsk → 整稿降级英文 */
var LP2 = load(['assets/lang-pack.js', 'assets/reply-assistant.js'], function (s) { delete s.LangPack.packs.es.reply.cAsk; });
var g10 = LP2.ReplyAssistant.generate({ opp: { rawText: 'Por favor envíen la factura proforma para 500 unidades', buyer: {}, status: 'new', followCount: 0 },
  eff: eff({ qty: 500 }), product: P, match: { score: 90, keyConflict: false, conflicts: [] }, price: { unit: 4.2, floor: 3.8 }, sellerName: 'Test Seller', scenario: 'auto', lang: 'es' });
ok(g10.scenario === 'closing' && g10.degraded === true && g10.sendLang === 'en' && g10.send.indexOf('To prepare the proforma invoice') >= 0, '10. 缺 cAsk → 整稿降级英文', g10.sendLang + '/' + g10.degraded);

/* 11. Core 白名单兼容：closing 可存、旧稿无损、未知键仍剥离 */
var sbC = load(['assets/core.js']);
var C = sbC.Core;
var oppIn = { id: 'o1', createdAt: '2026-11-08T00:00:00.000Z', buyer: { name: 'A' }, status: 'quoted', rawText: 'x',
  replyDrafts: { first: { en: 'OLD EN', zh: '旧稿', edited: true, at: '2026-11-01T00:00:00.000Z' },
    closing: { en: 'NEW CLOSING', zh: '成交稿', edited: false, at: '2026-11-08T00:00:00.000Z' },
    zzz: { en: 'X', zh: 'Y', edited: false, at: '2026-11-08T00:00:00.000Z' } } };
var norm = C.normalizeOpp(JSON.parse(JSON.stringify(oppIn)));
ok(norm.replyDrafts.first && norm.replyDrafts.first.en === 'OLD EN' && norm.replyDrafts.first.edited === true, '11. 历史草稿无损保留');
ok(norm.replyDrafts.closing && norm.replyDrafts.closing.en === 'NEW CLOSING', '11b. closing 草稿可保存恢复');
ok(!norm.replyDrafts.zzz, '11c. 未知场景键仍被剥离（行为不变）');

/* 12. 决策台集成：西语订单询盘 → closing + 推动下单步骤 */
var sbD = load(['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js', 'assets/lang-pack.js', 'assets/translate.js', 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js', 'assets/p0-parse.js', 'assets/decision-desk.js']);
var D = sbD.DecisionDesk;
function DP(o) { return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o); }
var products = [DP({ sku: 'PA', title: 'RadioMaster XR4 ELRS Receiver 2.4GHz Dual Band', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 12, priceFloorUsd: 10, costRmb: 55, certs: ['CE'] })];
var rD = D.analyze('Hola, podemos cerrar el pedido de 500 unidades del receptor RadioMaster XR4 ELRS. Por favor envíen la factura proforma.', products, { fxRate: 7.1, sellerName: 'Test Seller' }, null);
ok(rD.reply && rD.reply.scenario === 'closing', '12. 决策台西语订单 → closing', rD.reply && rD.reply.scenario);
ok(rD.reply && rD.reply.sendLang === 'es' && rD.reply.send.indexOf('factura proforma') >= 0, '12b. 决策台发送稿为西语 closing');
ok(rD.steps.some(function (s) { return s.action.indexOf('推动下单') === 0; }), '12c. 下一步含推动下单');

/* 13. FIX-01：否定守卫、弱信号、俄语词尾 */
function scenOf(raw, e, lang) { return gen({ raw: raw, eff: e || { qty: 500 }, lang: lang || 'en' }).scenario; }
ok(RA.hasOrderIntent('We are not ready to place an order.') === false && scenOf('We are not ready to place an order.') !== 'closing', '13a. not ready 不得 closing');
ok(scenOf('No deposit before sample approval.') !== 'closing', '13b. No deposit 不得 closing');
ok(scenOf("We don't want to place an order yet.") !== 'closing', '13c. don\'t want 不得 closing');
ok(scenOf('我们还没准备好下单，先看看样品再说。', { qty: 500 }, 'zh') === 'sample', '13d. 中文还没下单 → 落 sample 不进 closing');
ok(scenOf('Todavía no queremos hacer el pedido.', { qty: 500 }, 'es') !== 'closing', '13e. 西语 todavía no 不得 closing');
ok(scenOf('Ainda não estamos prontos para fazer o pedido.', { qty: 500 }, 'pt') !== 'closing', '13f. 葡语 ainda não 不得 closing');
ok(scenOf('Мы пока не готовы заказать.', { qty: 500 }, 'ru') !== 'closing', '13g. 俄语 пока не 不得 closing');
ok(RA.hasOrderIntent('We usually pay a deposit.') === false, '13h. 裸 deposit 惯例陈述不触发');
ok(scenOf('We will arrange the deposit by T/T this week.') === 'closing', '13i. 带承诺线索的定金安排仍触发 closing');
ok(scenOf('请问定金怎么付？', { qty: 100 }, 'zh') === 'closing', '13j. 中文询问定金付法触发 closing');
ok(scenOf("We don't need samples, please send the PI.") === 'closing', '13k. 前小句否定不否决后小句 PI 信号');
ok(scenOf('No problem, please send the PI.') === 'closing', '13l. "No problem" 不误杀 PI 信号');
ok(scenOf('Мы готовы заказать 500 шт приёмников.', { qty: 500 }, 'ru') === 'closing', '13m. 俄语词尾 готовы заказать 正确触发');
ok(scenOf('Please send the PI for 500 pcs.') === 'closing', '13n. 正向 PI 保持 closing');
ok(scenOf('What is your payment method?') !== 'closing', '13o. 只问付款方式不进 closing');
ok(scenOf('If the price is acceptable, we may order.') !== 'closing', '13p. may order 条件式不进 closing');

/* 14. FIX-02：英文疑问式定金表达 */
ok(scenOf('How can we pay the deposit?') === 'closing', '14a. How can we pay the deposit → closing');
ok(scenOf('How do we pay the deposit?') === 'closing', '14b. How do we pay the deposit → closing');
ok(scenOf('What is your payment method?') !== 'closing', '14c. 问付款方式不进 closing');
ok(scenOf('We usually pay a deposit.') !== 'closing', '14d. 惯例陈述不进 closing');
ok(scenOf('Do you accept bank transfer?') !== 'closing', '14e. 问是否接受转账不进 closing');
ok(scenOf('No deposit before sample approval.') !== 'closing', '14f. No deposit 不进 closing');
ok(scenOf('We are not ready to place an order.') !== 'closing', '14g. not ready 不进 closing');
ok(scenOf('We will arrange the deposit by T/T.') === 'closing', '14h. will arrange 定金保持 closing');

console.log('\n总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
