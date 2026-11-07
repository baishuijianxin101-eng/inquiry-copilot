/* P1-4-LANG P2 专项：西班牙语黄金样本 10 条 + 与英语基准的匹配/评分平价
   + 翻译语种识别。纯 Node，全部虚构数据。
   运行：node tests/test-p1-4-lang-es.js */
'use strict';
global.window = global;
require('../assets/lang-pack.js');
require('../assets/p0-parse.js');
require('../assets/matching.js');
require('../assets/smart-match.js');
require('../assets/opp-score.js');
var P = global.P0Parse, M = global.Matching, SM = global.SmartMatch, OS = global.OppScore, LP = global.LangPack;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function ctxOf(r, name) {
  var ms = (r.fields.certMentions || []).filter(function (c) { return c.name === name; });
  return ms.length ? ms[0].context : '(missing)';
}
function effOf(text) {
  var f = P.extract(text).fields;
  return { productName: f.productName || '', qty: f.qty || 0, targetPriceUsd: f.targetPriceUsd || 0,
    destination: f.destination || '', country: '', leadTimeDays: f.deadlineDays || 0, deadlineText: f.deadlineText || '',
    certs: f.certs || [], certMentions: f.certMentions || [], models: f.models || [], types: M.typesOf(text),
    specs: f.specs || [], specsText: '', productText: f.productText || '', incoterm: f.incoterm || '',
    purpose: f.purpose || '', priceMentions: f.priceMentions || [], edited: {} };
}
var XR4 = { id: 'fx_xr4', sku: 'XR4', title: 'XR4 FPV Receiver 2.4GHz ELRS', titleEn: 'XR4 FPV Receiver 2.4GHz ELRS', category: '', keywords: ['xr4', 'receiver', 'elrs', 'fpv'], specs: 'XR4 2.4GHz ELRS', specsEn: '', certs: ['CE'], moq: 10, leadTimeDays: 15, priceUsd: 20 };
var CAM = { id: 'fx_cam', sku: 'RATEL2', title: 'Ratel 2 FPV Camera', titleEn: 'Ratel 2 FPV Camera', category: '', keywords: ['ratel', 'camera', 'fpv'], specs: 'Ratel 2', specsEn: '', certs: ['CE'], moq: 10, leadTimeDays: 10, priceUsd: 25 };
var MOTOR = { id: 'fx_mot', sku: 'M2207', title: '2207 Brushless Motor', titleEn: '2207 Brushless Motor', category: '', keywords: ['2207', 'motor', 'brushless'], specs: '2207 1960KV', specsEn: '', certs: [], moq: 20, leadTimeDays: 12, priceUsd: 12 };
var POOL = [{ product: XR4 }, { product: CAM }, { product: MOTOR }];

var EN_TWIN = 'Hello, we need 500 pcs of XR4 FPV receiver 2.4GHz ELRS. Delivery to Hamburg port, we need them within 20 days. Please quote your best price. Our target price is $3.50 per pc. CE certificate is required.';

/* ES-1 全要素样本 */
var es1 = 'Hola, necesitamos 500 unidades del receptor FPV XR4 ELRS de 2,4 GHz. Entrega en el puerto de Hamburgo, lo necesitamos en un plazo de 20 días. Por favor, envíennos su mejor precio. Nuestro precio objetivo es de 3,50 dólares por unidad. Se requiere el certificado CE.';
var r1 = P.extract(es1);
ok('ES1 数量 500 unidades', r1.fields.qty === 500, 'qty=' + r1.fields.qty);
ok('ES1 商品名 receptor FPV XR4 ELRS', r1.fields.productName === 'receptor FPV XR4 ELRS', r1.fields.productName);
ok('ES1 目的地归一 Hamburg', r1.fields.destination === 'Hamburg', r1.fields.destination);
ok('ES1 交期 20 días', r1.fields.deadlineDays === 20, 'days=' + r1.fields.deadlineDays);
ok('ES1 目标价 3.5 USD（小数逗号）', r1.fields.targetPriceUsd === 3.5, JSON.stringify(r1.fields.priceMentions));
ok('ES1 CE 语境 mandatory', ctxOf(r1, 'CE') === 'mandatory', ctxOf(r1, 'CE'));

/* ES-2 数量 + 商品名（quiero pedir） */
var r2 = P.extract('Quiero pedir 250 unidades del motor 2207 para mi dron.');
ok('ES2 数量 250', r2.fields.qty === 250, 'qty=' + r2.fields.qty);
ok('ES2 商品名 motor 2207', r2.fields.productName === 'motor 2207', r2.fields.productName);

/* ES-3 交期 + 目的地（无数量样本） */
var r3 = P.extract('Buscamos baterías LiPo 4S, entrega al puerto de Valencia en 15 días.');
ok('ES3 交期 15', r3.fields.deadlineDays === 15, 'days=' + r3.fields.deadlineDays);
ok('ES3 目的地 Valencia', r3.fields.destination === 'Valencia', r3.fields.destination);
ok('ES3 商品名 baterías LiPo 4S', r3.fields.productName === 'baterías LiPo 4S', r3.fields.productName);

/* ES-4 目的地归一（Róterdam → Rotterdam） */
var r4 = P.extract('Necesitamos 800 unidades de antenas ELRS, envío al puerto de Róterdam.');
ok('ES4 数量 800', r4.fields.qty === 800, 'qty=' + r4.fields.qty);
ok('ES4 目的地归一 Rotterdam', r4.fields.destination === 'Rotterdam', r4.fields.destination);
ok('ES4 商品名 antenas ELRS', r4.fields.productName === 'antenas ELRS', r4.fields.productName);

/* ES-5 目标价 EUR：识别币种与角色，但不写 USD 目标价 */
var r5 = P.extract('Nuestro precio objetivo es de 4,20 € por unidad para 600 piezas del receptor XR5.');
var m5 = (r5.fields.priceMentions || [])[0] || {};
ok('ES5 数量 600 piezas', r5.fields.qty === 600, 'qty=' + r5.fields.qty);
ok('ES5 价格 4.2 EUR 且角色为目标价', m5.value === 4.2 && m5.currency === 'EUR' && m5.role === 'CUSTOMER_TARGET', JSON.stringify(m5));
ok('ES5 EUR 目标价不写入 targetPriceUsd', r5.fields.targetPriceUsd === 0);

/* ES-6 认证询问语境 */
var r6 = P.extract('¿Pueden proporcionar el certificado CE para el receptor XR4? Necesitamos 300 unidades.');
ok('ES6 CE 语境 inquiry', ctxOf(r6, 'CE') === 'inquiry', ctxOf(r6, 'CE'));
ok('ES6 数量 300', r6.fields.qty === 300, 'qty=' + r6.fields.qty);

/* ES-7 认证不需要语境 */
var r7 = P.extract('El certificado CE no es obligatorio para este pedido. Necesitamos 200 unidades del receptor XR4.');
ok('ES7 CE 语境 not-required', ctxOf(r7, 'CE') === 'not-required', ctxOf(r7, 'CE'));
ok('ES7 数量 200', r7.fields.qty === 200, 'qty=' + r7.fields.qty);

/* ES-8 预算价（欧洲数字格式）不得当作目标价 */
var r8 = P.extract('Nuestro presupuesto es de 2.000,50 dólares para 1000 unidades de hélices de 5 pulgadas.');
var m8 = (r8.fields.priceMentions || [])[0] || {};
ok('ES8 预算 2000.50 USD 角色 BUDGET', m8.value === 2000.5 && m8.currency === 'USD' && m8.role === 'CUSTOMER_BUDGET', JSON.stringify(m8));
ok('ES8 预算不写入目标价', r8.fields.targetPriceUsd === 0);
ok('ES8 数量 1000', r8.fields.qty === 1000, 'qty=' + r8.fields.qty);

/* ES-9 竞品价不得当作目标价 */
var r9 = P.extract('Otro proveedor nos ofrece el receptor XR4 a 3,20 dólares, ¿pueden mejorar ese precio? Necesitamos 400 unidades.');
var m9 = (r9.fields.priceMentions || [])[0] || {};
ok('ES9 竞品价角色 COMPETITOR', m9.value === 3.2 && m9.role === 'COMPETITOR_QUOTE', JSON.stringify(m9));
ok('ES9 竞品价不写入目标价', r9.fields.targetPriceUsd === 0);
ok('ES9 数量 400', r9.fields.qty === 400, 'qty=' + r9.fields.qty);

/* ES-10 意向信号完整（报价+下单+紧急）→ 评分平价 */
var es10 = 'Es urgente: queremos hacer un pedido de 750 unidades del receptor FPV XR4 ELRS. Por favor, envíennos su mejor precio hoy.';
var en10 = 'This is urgent: we want to place an order for 750 pcs of the XR4 FPV receiver ELRS. Please send us your best price today.';
ok('ES10 数量 750', P.extract(es10).fields.qty === 750);
var sEs = OS.score({ opp: { rawText: es10, status: 'new' }, eff: effOf(es10), match: null });
var sEn = OS.score({ opp: { rawText: en10, status: 'new' }, eff: effOf(en10), match: null });
var iEs = (sEs.dims.filter(function (x) { return x.key === 'intent'; })[0] || {}).score;
var iEn = (sEn.dims.filter(function (x) { return x.key === 'intent'; })[0] || {}).score;
ok('ES10 意向分与英语一致（25）', iEs === 25 && iEn === 25, 'es=' + iEs + ' en=' + iEn);

/* 匹配 + 评分平价（ES-1 vs 英语同内容） */
var rankEs = SM.rank(effOf(es1), es1, POOL);
var rankEn = SM.rank(effOf(EN_TWIN), EN_TWIN, POOL);
ok('ES-P 匹配第一名与英语一致（XR4）', rankEs[0].product.id === 'fx_xr4' && rankEn[0].product.id === 'fx_xr4',
  'es=' + (rankEs[0] && rankEs[0].product.id) + ' en=' + (rankEn[0] && rankEn[0].product.id));
ok('ES-P 匹配分差 ≤15', Math.abs(rankEs[0].result.score - rankEn[0].result.score) <= 15,
  'es=' + rankEs[0].result.score + ' en=' + rankEn[0].result.score);
ok('ES-P 无 keyConflict', rankEs[0].result.keyConflict === false);
var tEs = OS.score({ opp: { rawText: es1, status: 'new' }, eff: effOf(es1), match: { score: rankEs[0].result.score, keyConflict: false } });
var tEn = OS.score({ opp: { rawText: EN_TWIN, status: 'new' }, eff: effOf(EN_TWIN), match: { score: rankEn[0].result.score, keyConflict: false } });
ok('ES-P 商机分差 ≤10', Math.abs(tEs.total - tEn.total) <= 10, 'es=' + tEs.total + ' en=' + tEn.total);

/* 翻译识别：西语不再误判为 en */
ok('ES-T hintLatin 识别 es', LP.hintLatin(es1) === 'es', LP.hintLatin(es1));

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
