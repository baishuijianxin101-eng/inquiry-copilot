/* P1-4-LANG P4 专项：匹配置信度护栏——未支持文字（俄/阿）不得凭少数
   拉丁 token 虚高；人工补全信息后护栏解除；英/中/西/法不触发。
   纯 Node，全部虚构数据。运行：node tests/test-p1-4-guardrail.js */
'use strict';
global.window = global;
require('../assets/lang-pack.js');
require('../assets/p0-parse.js');
require('../assets/matching.js');
require('../assets/smart-match.js');
var P = global.P0Parse, M = global.Matching, SM = global.SmartMatch;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function effOf(text, extra) {
  var f = P.extract(text).fields;
  var eff = { productName: f.productName || '', qty: f.qty || 0, targetPriceUsd: f.targetPriceUsd || 0,
    destination: f.destination || '', country: '', leadTimeDays: f.deadlineDays || 0, deadlineText: '',
    certs: f.certs || [], certMentions: f.certMentions || [], models: f.models || [], types: M.typesOf(text),
    specs: f.specs || [], specsText: '', productText: f.productText || '', incoterm: '',
    purpose: '', priceMentions: f.priceMentions || [], edited: {} };
  if (extra) Object.keys(extra).forEach(function (k) { eff[k] = extra[k]; });
  return eff;
}
var XR4 = { id: 'fx_xr4', sku: 'XR4', title: 'XR4 FPV Receiver 2.4GHz ELRS', titleEn: 'XR4 FPV Receiver 2.4GHz ELRS', category: '', keywords: ['xr4', 'receiver', 'elrs', 'fpv'], specs: 'XR4 2.4GHz ELRS', specsEn: '', certs: ['CE'], moq: 10, leadTimeDays: 15, priceUsd: 20 };
var POOL = [{ product: XR4 }];

/* 俄语已获词汇包（见 test-p1-4-lang-more2 的「护栏放行」断言），
   封顶用例改用仍无词汇包的希伯来语全要素样本，封顶断言一条不少；
   阿语同理已在更早一轮改用希伯来语（见下 HE）。 */
var HE = 'שלום, אנו צריכים 500 יחידות של מקלט FPV XR4 ELRS בתדר 2.4GHz. משלוח לנמל המבורג, נדרש תוך 20 יום. נא לשלוח את המחיר הטוב ביותר. מחיר היעד שלנו הוא 3.50 דולר ליחידה. נדרש אישור CE.';
var EN = 'Hello, we need 500 pcs of XR4 FPV receiver 2.4GHz ELRS. Delivery to Hamburg port, we need them within 20 days. Please quote your best price. Our target price is $3.50 per pc. CE certificate is required.';
var ZH = '你好，我们需要500个XR4 FPV接收机（2.4GHz ELRS）。交货到汉堡港，20天内需要。请报你们的最优价格。我们的目标价是3.5美元一个。需要CE证书。';
var ES = 'Hola, necesitamos 500 unidades del receptor FPV XR4 ELRS de 2,4 GHz. Entrega en el puerto de Hamburgo, lo necesitamos en un plazo de 20 días. Por favor, envíennos su mejor precio. Nuestro precio objetivo es de 3,50 dólares por unidad. Se requiere el certificado CE.';

var rRu = SM.rank(effOf(HE), HE, POOL)[0].result;
ok('G1 未支持语言（希伯来语）匹配封顶 ≤49', rRu.score <= 49, 'score=' + rRu.score);
ok('G1 希伯来语 lowConfidence=true', rRu.lowConfidence === true);
ok('G1 希伯来语不新增 keyConflict', rRu.keyConflict === false);
ok('G1 希伯来语未确认清单含置信度提示', (rRu.unconfirmed || []).some(function (u) { return /置信度低/.test(u); }), JSON.stringify(rRu.unconfirmed));

var rHe = SM.rank(effOf(HE), HE, POOL)[0].result;
ok('G2 希伯来语匹配封顶 ≤49', rHe.score <= 49, 'score=' + rHe.score);
ok('G2 希伯来语 lowConfidence=true', rHe.lowConfidence === true);
ok('G2 希伯来语不新增 keyConflict', rHe.keyConflict === false);

/* 人工补全数量+商品名（覆盖度≥2）后护栏解除，分数恢复真实水平 */
var rRuFixed = SM.rank(effOf(HE, { qty: 500, productName: 'XR4 FPV receiver' }), HE, POOL)[0].result;
ok('G3 未支持语言人工补全后护栏解除', rRuFixed.lowConfidence === false && rRuFixed.score > 49,
  'score=' + rRuFixed.score + ' lowConf=' + rRuFixed.lowConfidence);

var rEn = SM.rank(effOf(EN), EN, POOL)[0].result;
ok('G4 英语不触发护栏且高分', rEn.lowConfidence === false && rEn.score >= 75, 'score=' + rEn.score);

var rZh = SM.rank(effOf(ZH), ZH, POOL)[0].result;
ok('G5 中文不触发护栏', rZh.lowConfidence === false, 'score=' + rZh.score);

var rEs = SM.rank(effOf(ES), ES, POOL)[0].result;
ok('G6 西语不触发护栏', rEs.lowConfidence === false && rEs.score > 49, 'score=' + rEs.score);

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
