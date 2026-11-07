/* P1-4-LANG 扩容第二批专项：葡萄牙语 / 俄语 / 土耳其语 / 印尼语。
   纯 Node，全部虚构数据。运行：node tests/test-p1-4-lang-more2.js */
'use strict';
global.window = global;
require('../assets/lang-pack.js');
require('../assets/p0-parse.js');
require('../assets/matching.js');
require('../assets/smart-match.js');
require('../assets/opp-score.js');
require('../assets/translate.js');
var P = global.P0Parse, M = global.Matching, SM = global.SmartMatch, OS = global.OppScore, TR = global.Translate;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function F(t) { return P.extract(t).fields; }
function effOf(text) {
  var f = F(text);
  return { productName: f.productName || '', qty: f.qty || 0, targetPriceUsd: f.targetPriceUsd || 0,
    destination: f.destination || '', country: '', leadTimeDays: f.deadlineDays || 0, deadlineText: '',
    certs: f.certs || [], certMentions: f.certMentions || [], models: f.models || [], types: M.typesOf(text),
    specs: f.specs || [], specsText: '', productText: f.productText || '', incoterm: '', purpose: '', priceMentions: f.priceMentions || [], edited: {} };
}
var XR4 = { id: 'fx_xr4', sku: 'XR4', title: 'XR4 FPV Receiver 2.4GHz ELRS', titleEn: 'XR4 FPV Receiver 2.4GHz ELRS', category: '', keywords: ['xr4', 'receiver', 'elrs', 'fpv'], specs: 'XR4 2.4GHz ELRS', specsEn: '', certs: ['CE'], moq: 10, leadTimeDays: 15, priceUsd: 20 };
var CAM = { id: 'fx_cam', sku: 'RATEL2', title: 'Ratel 2 FPV Camera', titleEn: 'Ratel 2 FPV Camera', category: '', keywords: ['ratel', 'camera', 'fpv'], specs: 'Ratel 2', specsEn: '', certs: ['CE'], moq: 10, leadTimeDays: 10, priceUsd: 25 };
var POOL = [{ product: XR4 }, { product: CAM }];
function intentLabels(text) {
  var r = OS.score({ opp: { rawText: text, status: 'new' }, eff: { qty: 500 }, match: null });
  var d = r.dims.find(function (x) { return x.key === 'intent'; });
  return d ? d.reasons.join(' | ') : '';
}

/* ================= 葡萄牙语 ================= */
var PT1 = 'Olá, precisamos de 500 unidades do receptor FPV XR4 ELRS de 2,4 GHz. Entrega no porto de Hamburgo, precisamos em 20 dias. Nosso preço alvo é de 3,50 USD por unidade. O certificado CE é obrigatório. Por favor, envie sua cotação.';
var p = F(PT1);
ok('PT 数量/单位', p.qty === 500, 'qty=' + p.qty);
ok('PT 商品名含 receptor', /receptor/i.test(p.productName || ''), p.productName);
ok('PT 目的地 Hamburgo→Hamburg', p.destination === 'Hamburg', p.destination);
ok('PT 交期 20', p.deadlineDays === 20, 'days=' + p.deadlineDays);
ok('PT 目标价 3.5 USD', p.targetPriceUsd === 3.5, 't=' + p.targetPriceUsd);
ok('PT CE 必须语境', (p.certMentions || []).some(function (c) { return c.name === 'CE' && c.context === 'mandatory'; }), JSON.stringify(p.certMentions));
ok('PT 品类 rx', M.typesOf(PT1).indexOf('rx') >= 0, JSON.stringify(M.typesOf(PT1)));
ok('PT 第一名 XR4', SM.rank(effOf(PT1), PT1, POOL)[0].product.id === 'fx_xr4');
ok('PT 报价信号（葡语）', intentLabels(PT1).indexOf('（葡语）') >= 0, intentLabels(PT1));
ok('PT detect=pt', TR.detect(PT1) === 'pt', TR.detect(PT1));
var pb = F('Nosso orçamento é de 3,00 € por unidade. Precisamos de 200 unidades de câmeras FPV.');
ok('PT 预算 EUR 不进目标价', !pb.targetPriceUsd && (pb.priceMentions || []).some(function (x) { return x.currency === 'EUR' && x.role === 'CUSTOMER_BUDGET'; }), JSON.stringify(pb.priceMentions));
var pi = F('Vocês têm certificado CE? Precisamos de 100 unidades.');
ok('PT CE 询问语境', (pi.certMentions || []).some(function (c) { return c.context === 'inquiry'; }), JSON.stringify(pi.certMentions));
var pn = F('O certificado CE não é necessário. Precisamos de 100 unidades.');
ok('PT CE 不需要语境', (pn.certMentions || []).some(function (c) { return c.context === 'not-required'; }), JSON.stringify(pn.certMentions));
var pbr = F('Nosso preço alvo é de 3,50 reais por unidade. Precisamos de 100 unidades.');
ok('PT 巴西雷亚尔 BRL 提及且不进 USD 目标价', !pbr.targetPriceUsd && (pbr.priceMentions || []).some(function (x) { return x.currency === 'BRL'; }), JSON.stringify(pbr.priceMentions));

/* ================= 俄语 ================= */
var RU1 = 'Здравствуйте, нам нужно 500 шт. приёмника FPV XR4 ELRS 2,4 ГГц. Доставка в порт Гамбург, нужно в течение 20 дней. Пришлите, пожалуйста, вашу лучшую цену. Наша целевая цена — 3,50 доллара за штуку. Сертификат CE обязательно.';
var r = F(RU1);
ok('RU 数量 500', r.qty === 500, 'qty=' + r.qty);
ok('RU 目的地 Гамбург→Hamburg', r.destination === 'Hamburg', r.destination);
ok('RU 交期 20', r.deadlineDays === 20, 'days=' + r.deadlineDays);
ok('RU 目标价 3.5 USD（доллара）', r.targetPriceUsd === 3.5, 't=' + r.targetPriceUsd + ' ' + JSON.stringify(r.priceMentions));
ok('RU CE 必须语境', (r.certMentions || []).some(function (c) { return c.name === 'CE' && c.context === 'mandatory'; }), JSON.stringify(r.certMentions));
ok('RU 品类 rx（приёмник）', M.typesOf(RU1).indexOf('rx') >= 0, JSON.stringify(M.typesOf(RU1)));
var rRank = SM.rank(effOf(RU1), RU1, POOL);
ok('RU 足量样本护栏放行且第一名 XR4', rRank[0].product.id === 'fx_xr4' && rRank[0].result.lowConfidence === false, 'top=' + rRank[0].product.id + ' score=' + rRank[0].result.score + ' lc=' + rRank[0].result.lowConfidence);
ok('RU 报价信号（俄语）', intentLabels(RU1).indexOf('（俄语）') >= 0, intentLabels(RU1));
ok('RU detect=ru', TR.detect(RU1) === 'ru', TR.detect(RU1));
var rThin = 'Здравствуйте, интересует XR4.';
var rThinRank = SM.rank(effOf(rThin), rThin, POOL);
ok('RU 稀薄样本仍被护栏封顶', rThinRank[0].result.score <= 49 && rThinRank[0].result.lowConfidence === true, 'score=' + rThinRank[0].result.score);
var rc = F('Конкурент предлагает тот же приёмник за 3,20 доллара. Нам нужно 200 шт.');
ok('RU 竞品价不进目标价', !rc.targetPriceUsd && (rc.priceMentions || []).some(function (x) { return x.role === 'COMPETITOR_QUOTE' && x.value === 3.2; }), JSON.stringify(rc.priceMentions));

/* ================= 土耳其语 ================= */
var TR1 = 'Merhaba, 500 adet XR4 FPV alıcısına ihtiyacımız var. Teslimat Hamburg limanına, 20 gün içinde gerekli. Hedef fiyatımız birim başına 3,50 USD. CE belgesi zorunludur. Lütfen fiyat teklifinizi gönderin.';
var t = F(TR1);
ok('TR 数量 500 adet', t.qty === 500, 'qty=' + t.qty);
ok('TR 商品名含 XR4 且尾巴已切', /XR4/.test(t.productName || '') && !/ihtiyac/.test(t.productName || ''), t.productName);
ok('TR 目的地 Hamburg', t.destination === 'Hamburg', t.destination);
ok('TR 交期 20 gün', t.deadlineDays === 20, 'days=' + t.deadlineDays);
ok('TR 目标价 3.5 USD', t.targetPriceUsd === 3.5, 't=' + t.targetPriceUsd);
ok('TR CE 必须语境（zorunlu）', (t.certMentions || []).some(function (c) { return c.name === 'CE' && c.context === 'mandatory'; }), JSON.stringify(t.certMentions));
ok('TR 品类 rx（alıcı）', M.typesOf(TR1).indexOf('rx') >= 0, JSON.stringify(M.typesOf(TR1)));
ok('TR 第一名 XR4', SM.rank(effOf(TR1), TR1, POOL)[0].product.id === 'fx_xr4');
ok('TR detect=tr', TR.detect(TR1) === 'tr', TR.detect(TR1));
var tb = F('Bütçemiz birim başına 3,00 EUR. 200 adet kamera lazım.');
ok('TR 预算 EUR 不进目标价', !tb.targetPriceUsd && (tb.priceMentions || []).some(function (x) { return x.currency === 'EUR' && x.role === 'CUSTOMER_BUDGET'; }), JSON.stringify(tb.priceMentions));
ok('TR 千位数量 1.250 adet = 1250', F('1.250 adet sipariş vereceğiz.').qty === 1250, 'qty=' + F('1.250 adet sipariş vereceğiz.').qty);

/* ================= 印尼语 ================= */
var ID1 = 'Halo, kami membutuhkan 500 unit penerima FPV XR4 ELRS 2,4GHz. Pengiriman ke pelabuhan Hamburg, kami membutuhkannya dalam 20 hari. Harga target kami 3,50 USD per unit. Sertifikat CE wajib. Mohon kirimkan penawaran harga terbaik Anda.';
var d = F(ID1);
ok('ID 数量 500 unit', d.qty === 500, 'qty=' + d.qty);
ok('ID 商品名含 penerima', /penerima/i.test(d.productName || ''), d.productName);
ok('ID 目的地 Hamburg', d.destination === 'Hamburg', d.destination);
ok('ID 交期 20 hari', d.deadlineDays === 20, 'days=' + d.deadlineDays);
ok('ID 目标价 3.5 USD', d.targetPriceUsd === 3.5, 't=' + d.targetPriceUsd);
ok('ID CE 必须语境（wajib）', (d.certMentions || []).some(function (c) { return c.name === 'CE' && c.context === 'mandatory'; }), JSON.stringify(d.certMentions));
ok('ID 品类 rx（penerima）', M.typesOf(ID1).indexOf('rx') >= 0, JSON.stringify(M.typesOf(ID1)));
ok('ID 第一名 XR4', SM.rank(effOf(ID1), ID1, POOL)[0].product.id === 'fx_xr4');
ok('ID detect=id', TR.detect(ID1) === 'id', TR.detect(ID1));
var dc = F('Pemasok lain menawarkan produk yang sama seharga 2,80 USD. Kami membutuhkan 300 unit.');
ok('ID 竞品价不进目标价', !dc.targetPriceUsd && (dc.priceMentions || []).some(function (x) { return x.role === 'COMPETITOR_QUOTE' && x.value === 2.8; }), JSON.stringify(dc.priceMentions));

/* ================= 串扰与识别回归 ================= */
var ES1 = 'Hola, necesitamos 500 unidades del receptor FPV XR4. Por favor, envíennos su mejor precio.';
ok('X 西语不被葡语信号串扰', intentLabels(ES1).indexOf('（葡语）') < 0 && intentLabels(ES1).indexOf('（西语）') >= 0, intentLabels(ES1));
ok('X 葡语不挂西语标签', intentLabels(PT1).indexOf('（西语）') < 0, intentLabels(PT1));
ok('X 英语 hintLatin 仍为空', global.LangPack.hintLatin('We need 500 pcs of XR4 receiver, delivery to Hamburg port. Please send your best price and catalog.') === '');
ok('X 西语 detect 仍为 es', TR.detect(ES1) === 'es', TR.detect(ES1));

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
