/* P1-4-LANG 扩容专项：德语 / 阿拉伯语 / 印地语黄金样本 + 护栏联动
   + 德语与英语平价 + 语种识别。纯 Node，全部虚构数据。
   运行：node tests/test-p1-4-lang-more.js */
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
var POOL = [{ product: XR4 }, { product: CAM }];
var EN_TWIN = 'Hello, we need 500 pcs of XR4 FPV receiver 2.4GHz ELRS. Delivery to Hamburg port, we need them within 20 days. Please quote your best price. Our target price is $3.50 per pc. CE certificate is required.';

/* ---------- 德语 ---------- */
var de1 = 'Hallo, wir benötigen 500 Stück des XR4 FPV Empfängers 2,4 GHz ELRS. Lieferung an den Hafen Hamburg, wir brauchen die Ware innerhalb von 20 Tagen. Bitte senden Sie uns Ihr bestes Angebot. Unser Zielpreis liegt bei 3,50 USD pro Stück. Das CE-Zertifikat ist erforderlich.';
var rd = P.extract(de1);
ok('DE1 数量 500 Stück', rd.fields.qty === 500, 'qty=' + rd.fields.qty);
ok('DE1 商品名', rd.fields.productName === 'XR4 FPV Empfängers 2,4 GHz ELRS', rd.fields.productName);
ok('DE1 目的地 Hamburg', rd.fields.destination === 'Hamburg', rd.fields.destination);
ok('DE1 交期 20 Tagen', rd.fields.deadlineDays === 20, 'days=' + rd.fields.deadlineDays);
ok('DE1 目标价 3.5 USD（小数逗号+Zielpreis）', rd.fields.targetPriceUsd === 3.5, JSON.stringify(rd.fields.priceMentions));
ok('DE1 CE 语境 mandatory', ctxOf(rd, 'CE') === 'mandatory', ctxOf(rd, 'CE'));

var rd2 = P.extract('Können Sie uns das CE-Zertifikat zusenden? Wir benötigen 300 Stück des Empfängers.');
ok('DE2 CE 语境 inquiry', ctxOf(rd2, 'CE') === 'inquiry', ctxOf(rd2, 'CE'));
ok('DE2 数量 300', rd2.fields.qty === 300, 'qty=' + rd2.fields.qty);

var rd3 = P.extract('Das CE-Zertifikat ist nicht erforderlich. Wir benötigen 200 Stück.');
ok('DE3 CE 语境 not-required', ctxOf(rd3, 'CE') === 'not-required', ctxOf(rd3, 'CE'));
ok('DE3 数量 200', rd3.fields.qty === 200, 'qty=' + rd3.fields.qty);

var rd4 = P.extract('Unser Budget beträgt 2.000,50 USD für 1000 Stück Antennen.');
var md4 = (rd4.fields.priceMentions || [])[0] || {};
ok('DE4 预算 2000.50 USD 角色 BUDGET', md4.value === 2000.5 && md4.role === 'CUSTOMER_BUDGET', JSON.stringify(md4));
ok('DE4 预算不写入目标价', rd4.fields.targetPriceUsd === 0);
ok('DE4 数量 1000', rd4.fields.qty === 1000, 'qty=' + rd4.fields.qty);

var rankDe = SM.rank(effOf(de1), de1, POOL);
var rankEn = SM.rank(effOf(EN_TWIN), EN_TWIN, POOL);
ok('DE-P 匹配第一名与英语一致', rankDe[0].product.id === 'fx_xr4' && rankEn[0].product.id === 'fx_xr4');
ok('DE-P 匹配分差 ≤15', Math.abs(rankDe[0].result.score - rankEn[0].result.score) <= 15, 'de=' + rankDe[0].result.score + ' en=' + rankEn[0].result.score);
ok('DE-P 无 keyConflict/护栏', rankDe[0].result.keyConflict === false && rankDe[0].result.lowConfidence === false);
var tDe = OS.score({ opp: { rawText: de1, status: 'new' }, eff: effOf(de1), match: { score: rankDe[0].result.score, keyConflict: false } });
var tEn = OS.score({ opp: { rawText: EN_TWIN, status: 'new' }, eff: effOf(EN_TWIN), match: { score: rankEn[0].result.score, keyConflict: false } });
ok('DE-P 商机分差 ≤10', Math.abs(tDe.total - tEn.total) <= 10, 'de=' + tDe.total + ' en=' + tEn.total);
ok('DE-T hintLatin 识别 de', LP.hintLatin(de1) === 'de', LP.hintLatin(de1));

/* ---------- 阿拉伯语（本地数字） ---------- */
var ar1 = 'مرحبًا، نحتاج إلى ٥٠٠ قطعة من جهاز استقبال FPV XR4 ELRS بتردد 2.4GHz. التسليم إلى ميناء هامبورغ، ونحتاجه خلال ٢٠ يومًا. يرجى إرسال أفضل سعر لديكم. السعر المستهدف لدينا هو ٣.٥ دولار للقطعة. شهادة CE مطلوبة.';
var ra = P.extract(ar1);
ok('AR1 数量 500（阿拉伯-印度数字归一）', ra.fields.qty === 500, 'qty=' + ra.fields.qty);
ok('AR1 商品名含 جهاز استقبال', (ra.fields.productName || '').indexOf('جهاز استقبال') >= 0, ra.fields.productName);
ok('AR1 目的地归一 Hamburg', ra.fields.destination === 'Hamburg', ra.fields.destination);
ok('AR1 交期 20', ra.fields.deadlineDays === 20, 'days=' + ra.fields.deadlineDays);
ok('AR1 目标价 3.5 USD', ra.fields.targetPriceUsd === 3.5, JSON.stringify(ra.fields.priceMentions));
ok('AR1 CE 语境 mandatory', ctxOf(ra, 'CE') === 'mandatory', ctxOf(ra, 'CE'));
var rankAr = SM.rank(effOf(ar1), ar1, POOL);
ok('AR1 护栏已解除（信息可解析）', rankAr[0].result.lowConfidence === false, 'lowConf=' + rankAr[0].result.lowConfidence);
ok('AR1 第一名为 XR4 且无 keyConflict', rankAr[0].product.id === 'fx_xr4' && rankAr[0].result.keyConflict === false, 'score=' + rankAr[0].result.score);

var ra2 = P.extract('هل يمكنكم توفير شهادة CE لهذا المنتج؟ نحتاج 300 قطعة.');
ok('AR2 CE 语境 inquiry', ctxOf(ra2, 'CE') === 'inquiry', ctxOf(ra2, 'CE'));
ok('AR2 数量 300', ra2.fields.qty === 300, 'qty=' + ra2.fields.qty);

var ra3 = P.extract('شهادة CE غير مطلوبة لهذا الطلب. نحتاج 200 قطعة.');
ok('AR3 CE 语境 not-required', ctxOf(ra3, 'CE') === 'not-required', ctxOf(ra3, 'CE'));
ok('AR3 数量 200', ra3.fields.qty === 200, 'qty=' + ra3.fields.qty);

/* ---------- 印地语（天城文数字） ---------- */
var hi1 = 'नमस्ते, हमें ५०० पीस XR4 FPV रिसीवर 2.4GHz ELRS चाहिए। डिलीवरी हैम्बर्ग बंदरगाह पर, हमें यह २० दिनों के अंदर चाहिए। कृपया अपना सर्वोत्तम मूल्य भेजें। हमारा लक्षित मूल्य ३.५ डॉलर प्रति पीस है। CE प्रमाणपत्र आवश्यक है।';
var rh = P.extract(hi1);
ok('HI1 数量 500（天城文数字归一）', rh.fields.qty === 500, 'qty=' + rh.fields.qty);
ok('HI1 商品名', rh.fields.productName === 'XR4 FPV रिसीवर 2.4GHz ELRS', rh.fields.productName);
ok('HI1 目的地归一 Hamburg', rh.fields.destination === 'Hamburg', rh.fields.destination);
ok('HI1 交期 20', rh.fields.deadlineDays === 20, 'days=' + rh.fields.deadlineDays);
ok('HI1 目标价 3.5 USD', rh.fields.targetPriceUsd === 3.5, JSON.stringify(rh.fields.priceMentions));
ok('HI1 CE 语境 mandatory', ctxOf(rh, 'CE') === 'mandatory', ctxOf(rh, 'CE'));
var rankHi = SM.rank(effOf(hi1), hi1, POOL);
ok('HI1 护栏已解除', rankHi[0].result.lowConfidence === false, 'lowConf=' + rankHi[0].result.lowConfidence);
ok('HI1 第一名为 XR4 且无 keyConflict', rankHi[0].product.id === 'fx_xr4' && rankHi[0].result.keyConflict === false, 'score=' + rankHi[0].result.score);

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
