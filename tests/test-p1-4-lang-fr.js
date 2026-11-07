/* P1-4-LANG P3 专项：法语黄金样本 10 条 + 与英语基准的匹配/评分平价
   + 翻译语种识别 + pièces 不误触 PI。纯 Node，全部虚构数据。
   运行：node tests/test-p1-4-lang-fr.js */
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

/* FR-1 全要素样本 */
var fr1 = 'Bonjour, nous avons besoin de 500 pièces du récepteur FPV XR4 ELRS 2,4 GHz. Livraison au port de Hambourg, délai souhaité de 20 jours. Veuillez nous envoyer votre meilleur prix. Notre prix cible est de 3,50 dollars par pièce. Le certificat CE est exigé.';
var r1 = P.extract(fr1);
ok('FR1 数量 500 pièces', r1.fields.qty === 500, 'qty=' + r1.fields.qty);
ok('FR1 商品名含 récepteur FPV XR4 ELRS', /récepteur FPV XR4 ELRS/.test(r1.fields.productName), r1.fields.productName);
ok('FR1 目的地归一 Hamburg', r1.fields.destination === 'Hamburg', r1.fields.destination);
ok('FR1 交期 20 jours', r1.fields.deadlineDays === 20, 'days=' + r1.fields.deadlineDays);
ok('FR1 目标价 3.5 USD（小数逗号）', r1.fields.targetPriceUsd === 3.5, JSON.stringify(r1.fields.priceMentions));
ok('FR1 CE 语境 mandatory', ctxOf(r1, 'CE') === 'mandatory', ctxOf(r1, 'CE'));

/* FR-2 数量 + 商品名 + 目的地（Marseille） */
var r2 = P.extract('Je cherche 300 unités de caméras FPV pour drones, livraison au port de Marseille.');
ok('FR2 数量 300 unités', r2.fields.qty === 300, 'qty=' + r2.fields.qty);
ok('FR2 商品名 caméras FPV pour drones', r2.fields.productName === 'caméras FPV pour drones', r2.fields.productName);
ok('FR2 目的地 Marseille', r2.fields.destination === 'Marseille', r2.fields.destination);

/* FR-3 目的地归一（Dunkerque → Dunkirk） */
var r3 = P.extract("Nous avons besoin de 1000 pièces d'antennes ELRS, port de Dunkerque.");
ok('FR3 数量 1000', r3.fields.qty === 1000, 'qty=' + r3.fields.qty);
ok('FR3 目的地归一 Dunkirk', r3.fields.destination === 'Dunkirk', r3.fields.destination);
ok('FR3 商品名 antennes ELRS', r3.fields.productName === 'antennes ELRS', r3.fields.productName);

/* FR-4 交期 + 目的地（Nantes） */
var r4 = P.extract('Je recherche 450 pièces de batteries LiPo, délai de 10 jours, destination le port de Nantes.');
ok('FR4 数量 450', r4.fields.qty === 450, 'qty=' + r4.fields.qty);
ok('FR4 交期 10 jours', r4.fields.deadlineDays === 10, 'days=' + r4.fields.deadlineDays);
ok('FR4 目的地 Nantes', r4.fields.destination === 'Nantes', r4.fields.destination);
ok('FR4 商品名 batteries LiPo', r4.fields.productName === 'batteries LiPo', r4.fields.productName);

/* FR-5 目标价 EUR */
var r5 = P.extract('Notre prix cible est de 4,20 € par pièce pour 600 pièces du récepteur XR5.');
var m5 = (r5.fields.priceMentions || [])[0] || {};
ok('FR5 数量 600', r5.fields.qty === 600, 'qty=' + r5.fields.qty);
ok('FR5 价格 4.2 EUR 且角色为目标价', m5.value === 4.2 && m5.currency === 'EUR' && m5.role === 'CUSTOMER_TARGET', JSON.stringify(m5));
ok('FR5 EUR 目标价不写入 targetPriceUsd', r5.fields.targetPriceUsd === 0);

/* FR-6 认证询问语境 */
var r6 = P.extract('Pouvez-vous fournir le certificat CE pour ce récepteur ? Nous avons besoin de 300 pièces.');
ok('FR6 CE 语境 inquiry', ctxOf(r6, 'CE') === 'inquiry', ctxOf(r6, 'CE'));
ok('FR6 数量 300', r6.fields.qty === 300, 'qty=' + r6.fields.qty);

/* FR-7 认证不需要语境（pas obligatoire） */
var r7 = P.extract("Le certificat CE n'est pas obligatoire pour cette commande. Il nous faut 200 pièces du récepteur XR4.");
ok('FR7 CE 语境 not-required', ctxOf(r7, 'CE') === 'not-required', ctxOf(r7, 'CE'));
ok('FR7 数量 200', r7.fields.qty === 200, 'qty=' + r7.fields.qty);

/* FR-8 预算价（欧洲数字格式） */
var r8 = P.extract("Notre budget est de 2.000,50 dollars pour 1000 pièces d'hélices.");
var m8 = (r8.fields.priceMentions || [])[0] || {};
ok('FR8 预算 2000.50 USD 角色 BUDGET', m8.value === 2000.5 && m8.currency === 'USD' && m8.role === 'CUSTOMER_BUDGET', JSON.stringify(m8));
ok('FR8 预算不写入目标价', r8.fields.targetPriceUsd === 0);
ok('FR8 数量 1000', r8.fields.qty === 1000, 'qty=' + r8.fields.qty);

/* FR-9 我方价被拒（votre prix + trop cher）不得当作目标价 */
var r9 = P.extract('Votre prix de 3,80 dollars par pièce est trop cher. Nous avons besoin de 400 pièces du récepteur XR4.');
var m9 = (r9.fields.priceMentions || [])[0] || {};
ok('FR9 价格 3.8 角色 OUR_QUOTE', m9.value === 3.8 && m9.role === 'OUR_QUOTE', JSON.stringify(m9));
ok('FR9 不写入目标价', r9.fields.targetPriceUsd === 0);
ok('FR9 数量 400', r9.fields.qty === 400, 'qty=' + r9.fields.qty);

/* FR-10 小数逗号陷阱：3,50 必须是 3.5 */
var r10 = P.extract('Le prix de 3,50 dollars nous convient pour 500 pièces du récepteur XR4 ELRS.');
var m10 = (r10.fields.priceMentions || [])[0] || {};
ok('FR10 3,50 dollars → 3.5（不是 350）', m10.value === 3.5, JSON.stringify(m10));
ok('FR10 数量 500', r10.fields.qty === 500, 'qty=' + r10.fields.qty);

/* 匹配 + 评分平价（FR-1 vs 英语同内容） */
var rankFr = SM.rank(effOf(fr1), fr1, POOL);
var rankEn = SM.rank(effOf(EN_TWIN), EN_TWIN, POOL);
ok('FR-P 匹配第一名与英语一致（XR4）', rankFr[0].product.id === 'fx_xr4' && rankEn[0].product.id === 'fx_xr4',
  'fr=' + (rankFr[0] && rankFr[0].product.id) + ' en=' + (rankEn[0] && rankEn[0].product.id));
ok('FR-P 匹配分差 ≤15', Math.abs(rankFr[0].result.score - rankEn[0].result.score) <= 15,
  'fr=' + rankFr[0].result.score + ' en=' + rankEn[0].result.score);
ok('FR-P 无 keyConflict', rankFr[0].result.keyConflict === false);
ok('FR-P 无低置信护栏误伤', rankFr[0].result.lowConfidence === false);
var tFr = OS.score({ opp: { rawText: fr1, status: 'new' }, eff: effOf(fr1), match: { score: rankFr[0].result.score, keyConflict: false } });
var tEn = OS.score({ opp: { rawText: EN_TWIN, status: 'new' }, eff: effOf(EN_TWIN), match: { score: rankEn[0].result.score, keyConflict: false } });
ok('FR-P 商机分差 ≤10', Math.abs(tFr.total - tEn.total) <= 10, 'fr=' + tFr.total + ' en=' + tEn.total);

/* 翻译识别：法语不再误判为 en */
ok('FR-T hintLatin 识别 fr', LP.hintLatin(fr1) === 'fr', LP.hintLatin(fr1));

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
