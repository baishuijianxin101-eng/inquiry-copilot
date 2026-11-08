/* P1-5-REPLY IMPLEMENT-01A 三语（es/pt/ru）原语言回复生成测试（纯 Node，虚构数据）
   运行：node tests/test-p1-5-reply-i18n.js */
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
 'assets/lang-pack.js', 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
 'assets/p0-parse.js', 'assets/translate.js', 'assets/decision-desk.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var RA = sandbox.ReplyAssistant, D = sandbox.DecisionDesk, LP = sandbox.LangPack, Core = sandbox.Core;
ok('0. 模块加载', !!RA && !!D && !!LP && !!Core);

var P = { id: 'p1', title: 'XR4 FPV Receiver', titleEn: 'XR4 FPV Receiver', sku: 'XR4', specsEn: '2.4GHz ELRS', certs: ['CE'], moq: 100, leadTimeDays: 15 };
var PnoLead = { id: 'p2', title: 'NoLead Cam', titleEn: 'NoLead Cam', sku: 'CAM1', specsEn: '', certs: [], moq: 0, leadTimeDays: 0 };
var PB = { id: 'p3', title: 'BAYCK Nano Receiver', titleEn: 'BAYCK Nano Receiver', sku: 'NB1', specsEn: '915MHz ELRS', certs: [], moq: 50, leadTimeDays: 10 };
var PRICE = { unit: 4.2, floor: 3.8, breakEven: 3.5 };
var MARK = { es: 'Gracias', pt: 'Obrigado', ru: 'Спасибо' };
var LANGS = ['es', 'pt', 'ru'];

function gen(lang, over) {
  var inp = {
    opp: { rawText: 'inquiry', buyer: { name: 'Juan Perez' } },
    eff: { qty: 500, productName: 'XR4 receiver', models: ['XR4'], destination: 'Hamburg', leadTimeDays: 20, purpose: 'resale' },
    product: P, match: { score: 90, keyConflict: false, conflicts: [] }, price: PRICE, sellerName: 'Alice'
  };
  Object.keys(over || {}).forEach(function (k) {
    if (k === 'eff') Object.assign(inp.eff, over.eff);
    else if (k === 'opp') Object.assign(inp.opp, over.opp);
    else inp[k] = over[k];
  });
  if (lang) inp.lang = lang;
  return RA.generate(inp);
}

/* 1. 三语七场景 + 谈判五分支：发送稿为对应语言、无英文模板残留、zh 对照同源 */
LANGS.forEach(function (lg) {
  var cases = [
    ['first', {}],
    ['prequote', { eff: { qty: 0, destination: '', productName: 'XR4 receiver' }, price: null }],
    ['spec', { scenario: 'spec' }],
    ['moq', { eff: { qty: 50 } }],
    ['neg-noprice', { eff: { targetPriceUsd: 3.5 }, price: null }],
    ['neg-closeok', { eff: { targetPriceUsd: 4.5 } }],
    ['neg-floor', { eff: { targetPriceUsd: 3.9 } }],
    ['neg-belowcost', { eff: { targetPriceUsd: 3.0 } }],
    ['neg-belowfloor', { eff: { targetPriceUsd: 3.6 } }],
    ['sample', { opp: { rawText: 'can I get a sample please' }, eff: { qty: 0 } }],
    ['followup', { opp: { rawText: 'price?', followCount: 2, status: 'quoted' }, scenario: 'sample' }],
    ['clarify', { match: { score: 40, keyConflict: true, conflicts: ['频段不一致'] } }]
  ];
  var FU_MARK = { es: 'seguimiento', pt: 'acompanhando', ru: 'уточнить' };
  cases.forEach(function (c) {
    var r = gen(lg, c[1]);
    var mark = c[0] === 'followup' ? FU_MARK[lg] : MARK[lg];
    ok('1-' + lg + '-' + c[0] + ' 发送稿语种', r.sendLang === lg && !r.degraded, r.sendLang);
    ok('1-' + lg + '-' + c[0] + ' 含本语标记', r.send.indexOf(mark) >= 0);
    ok('1-' + lg + '-' + c[0] + ' 无英文模板残留', !/Thanks for your inquiry|Thanks for sharing|Looking forward to your reply/.test(r.send));
    ok('1-' + lg + '-' + c[0] + ' 中文对照同源', (c[0] === 'followup' ? r.zh.indexOf('跟进') >= 0 : r.zh.indexOf('感谢') >= 0) && r.zh.length > 20);
  });
});

/* 2. 英文逐字兼容 + 中文稿兼容（与无 lang 调用完全一致） */
(function () {
  var probes = [
    {}, { eff: { targetPriceUsd: 3.0 } }, { eff: { qty: 50 } },
    { opp: { rawText: 'sample?' }, eff: { qty: 0 } }, { scenario: 'spec' },
    { match: { score: 40, keyConflict: true, conflicts: ['频段不一致'] } },
    { eff: { qty: 0, destination: '' }, price: null }
  ];
  var allSame = true;
  probes.forEach(function (p) {
    var a = gen(null, p), b = gen('en', p);
    if (a.en !== b.en || a.zh !== b.zh || a.send !== a.en || b.sendLang !== 'en' || b.degraded) allSame = false;
  });
  ok('2. lang 缺省/en 时 en、zh 与基线一致且 send=en', allSame);
  var rz = gen('zh', {});
  ok('2b. lang=zh 时 send=zh 稿', rz.sendLang === 'zh' && rz.send === rz.zh && !rz.degraded);
})();

/* 3. 价格安全：谈判稿只写 safePrice.unit；无价时不出现报价句 */
(function () {
  LANGS.forEach(function (lg) {
    var r = gen(lg, { eff: { targetPriceUsd: 3.9 } });
    ok('3-' + lg + ' 带价分支只含 safePrice $4.20', r.send.indexOf('$4.20') >= 0 && r.send.indexOf('$3.80') < 0 && r.send.indexOf('$3.50') < 0);
    var rn = gen(lg, { eff: { targetPriceUsd: 3.5 }, price: null });
    ok('3-' + lg + ' 无 safePrice 时不写报价', rn.usedPrice === false && !/\b(price is|precio es de|preço é de|цена — \$|Nuestro mejor precio|Nosso melhor preço|Наша текущая лучшая цена)/.test(rn.send));
  });
})();

/* 4. 未登记认证不承诺 / 未知库存不承诺 / 未确认交期不承诺 */
(function () {
  LANGS.forEach(function (lg) {
    var rs = gen(lg, { scenario: 'spec', product: PnoLead });
    ok('4-' + lg + ' 未登记认证不写认证句', !/Certificaciones registradas|Certificações registradas|Зарегистрированные сертификаты/.test(rs.send));
    ok('4-' + lg + ' 未登记交期不写交期句', !/Plazo de entrega estándar|Prazo de entrega padrão|Стандартный срок поставки/.test(rs.send));
    var rf = gen(lg, {});
    ok('4-' + lg + ' 任何稿不承诺库存', !/in stock|en stock|em estoque|в наличии|hay existencias/i.test(rf.send + rs.send));
    var rl = gen(lg, { scenario: 'spec' });
    ok('4-' + lg + ' 已登记交期照实写', /15/.test(rl.send));
  });
})();

/* 5. 切换第二候选（generate 层）：发送稿按新商品重算，不带旧商品事实 */
(function () {
  LANGS.forEach(function (lg) {
    var r2 = gen(lg, { product: PB, eff: { productName: 'BAYCK Nano' } });
    ok('5-' + lg + ' 换商品后标题同步', r2.send.indexOf('BAYCK Nano Receiver') >= 0 && r2.send.indexOf('XR4 FPV') < 0);
  });
})();

/* 6. 改目标价重算：谈判分支随目标价切换（西语抽查三档） */
(function () {
  var hi = gen('es', { eff: { targetPriceUsd: 4.5 } });
  var mid = gen('es', { eff: { targetPriceUsd: 3.9 } });
  var low = gen('es', { eff: { targetPriceUsd: 3.0 } });
  ok('6. 改价后分支切换', hi.send.indexOf('cerca de un nivel viable') >= 0 && mid.send.indexOf('Nuestro mejor precio actual') >= 0 && low.send.indexOf('costo de producción') >= 0);
})();

/* 7. 模板缺失降级：删一句 → 整稿回退英文 + degraded；无句库语言（fr）同样降级 */
(function () {
  var keep = LP.packs.es.reply.negLevers;
  delete LP.packs.es.reply.negLevers;
  var r = gen('es', { eff: { targetPriceUsd: 3.9 } });
  ok('7. 缺句整稿降级英文', r.sendLang === 'en' && r.degraded === true && r.send === r.en);
  LP.packs.es.reply.negLevers = keep;
  var rf = gen('fr', {});
  ok('7b. fr 无句库降级', rf.sendLang === 'en' && rf.degraded === true && rf.send === rf.en);
  var rr = gen('es', { eff: { targetPriceUsd: 3.9 } });
  ok('7c. 恢复后回到西语', rr.sendLang === 'es' && !rr.degraded);
})();

/* 8. 决策台链路：自动识别三语 + 歧义金额不带价 + 保存结构兼容 */
(function () {
  var prods = [
    { id: 'D1', sku: 'D1', title: 'RadioMaster XR4 ELRS Receiver', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', 'receptores', 'приёмники', 'receptores elrs'], specs: '2.4GHz ELRS', specsEn: '2.4GHz ELRS', certs: ['CE'], moq: 100, leadTimeDays: 15, priceUsd: 12, priceFloorUsd: 10, costRmb: 55 },
    { id: 'D2', sku: 'D2', title: 'BAYCK ELRS Nano Receiver', titleEn: 'BAYCK ELRS Nano Receiver', keywords: ['elrs receiver', 'nano receiver', 'receptores', 'приёмники'], specs: '2.4GHz ELRS', specsEn: '2.4GHz ELRS', certs: [], moq: 50, leadTimeDays: 10, priceUsd: 5, priceFloorUsd: 4, costRmb: 20 }
  ];
  var settings = { fxRate: 7.1, sellerName: 'Test Seller' };
  var es = D.analyze('Hola, necesitamos 500 unidades de receptores RadioMaster XR4 ELRS 2.4GHz con certificado CE, entrega en 20 días a España.', prods, settings, null);
  ok('8-es 决策台发送稿为西语', es.reply && es.reply.sendLang === 'es' && es.reply.send.indexOf('Gracias') >= 0, es.reply && es.reply.sendLang);
  var pt = D.analyze('Olá, precisamos de 500 unidades de receptores RadioMaster XR4 ELRS 2.4GHz com certificado CE, entrega em 20 dias para o Brasil.', prods, settings, null);
  ok('8-pt 决策台发送稿为葡语', pt.reply && pt.reply.sendLang === 'pt' && pt.reply.send.indexOf('Obrigado') >= 0, pt.reply && pt.reply.sendLang);
  var ru = D.analyze('Здравствуйте, нам нужно 500 шт приёмников RadioMaster XR4 ELRS 2.4GHz с сертификатом CE, срок поставки 20 дней, доставка в Москву.', prods, settings, null);
  ok('8-ru 决策台发送稿为俄语', ru.reply && ru.reply.sendLang === 'ru' && ru.reply.send.indexOf('Спасибо') >= 0, ru.reply && ru.reply.sendLang);
  var amb = D.analyze('Hola, necesitamos 500 unidades de receptores RadioMaster XR4 ELRS. Mi precio objetivo es 1.250 USD.', prods, settings, null);
  ok('8-amb 歧义金额不进草稿报价', !(amb.reply && amb.reply.usedPrice) || !/\$4\.20|\$11\.|\$10\./.test(amb.reply.send.replace('1.250', '')));
  ok('8-amb 目标价未被采信', amb.eff.targetPriceUsd === 0, String(amb.eff.targetPriceUsd));
  var payload = D.buildSavePayload(es, es.eff, es.reply.send, es.reply.send);
  ok('8-save draftSlot 结构不变', !!payload.draftSlot && payload.draftSlot.en === es.reply.send && typeof payload.draftSlot.zh === 'string');
})();

/* 9. 保存/刷新兼容：replyDrafts 经 Core 白名单往返不丢、旧英文数据照常读 */
(function () {
  var opp = Core.normalizeOpp({
    id: 't1', rawText: 'Hola', status: 'new', createdAt: '2026-11-07T00:00:00.000Z',
    replyDrafts: {
      negotiation: { en: 'Gracias por compartir su precio objetivo de $3.50 para el producto.', zh: '感谢您给出目标价。', edited: false, at: '2026-11-07T01:00:00.000Z' },
      first: { en: 'Hi,\n\nThanks for your inquiry.', zh: '您好，感谢询盘。', edited: true, at: null }
    }
  });
  ok('9. 三语发送稿经 normalize 往返保留', opp.replyDrafts.negotiation.en.indexOf('Gracias') === 0 && opp.replyDrafts.negotiation.zh.indexOf('感谢') === 0);
  ok('9b. 旧英文草稿照常保留', opp.replyDrafts.first.en.indexOf('Thanks') > 0 && opp.replyDrafts.first.edited === true);
})();

console.log('\n总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
