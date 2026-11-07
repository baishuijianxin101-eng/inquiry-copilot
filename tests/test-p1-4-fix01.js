/* P1-4-LANG FIX-01 专项：商品名误捕获数量短语 + 阿语目的地功能词。
   纯 Node，全部虚构数据。运行：node tests/test-p1-4-fix01.js */
'use strict';
global.window = global;
require('../assets/lang-pack.js');
require('../assets/p0-parse.js');
require('../assets/matching.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function F(t) { return P.extract(t).fields; }

/* ---- 问题一：纯数量短语不得当商品名 ---- */
var a = F('Wir benötigen 400 Stück.');
ok('F1 德语纯数量 → 商品名留空', a.productName === '', JSON.stringify(a.productName));
ok('F1 数量本身照常 400', a.qty === 400, 'qty=' + a.qty);

var b = F('نحتاج إلى ١٠٠ قطعة.');
ok('F2 阿语纯数量 → 商品名留空', b.productName === '', JSON.stringify(b.productName));
ok('F2 数量本身照常 100', b.qty === 100, 'qty=' + b.qty);

var b2 = F('Necesitamos 500.');
ok('F2b 西语纯数字 → 商品名留空', b2.productName === '', JSON.stringify(b2.productName));

/* 句尾标点剥离：有商品名但以句号结尾 */
var c = F('Wir benötigen 500 Stück des XR4 Empfängers.');
ok('F3 商品名保留且无尾句号', c.productName === 'XR4 Empfängers', JSON.stringify(c.productName));

var c2 = F('Ein anderer Anbieter bietet den XR4 an. Wir benötigen 400 Stück des XR4.');
ok('F3b 型号名保留且无尾句号', c2.productName === 'XR4', JSON.stringify(c2.productName));

/* ---- 问题二：阿语目的地不带功能词 ---- */
var d = F('التسليم إلى ميناء دبي خلال 10 أيام. نحتاج 250 قطعة.');
ok('F4 阿语目的地归一 Dubai', d.destination === 'Dubai', JSON.stringify(d.destination));
ok('F4 交期不受影响 10 天', d.deadlineDays === 10, 'days=' + d.deadlineDays);
ok('F4 数量不受影响 250', d.qty === 250, 'qty=' + d.qty);

/* 阿语其他已支持港口回归 */
ok('F5 هامبورغ → Hamburg', F('التسليم إلى ميناء هامبورغ. نحتاج 100 قطعة.').destination === 'Hamburg');
ok('F5 جدة → Jeddah', F('الشحن إلى ميناء جدة. نحتاج 100 قطعة.').destination === 'Jeddah');
ok('F5 روتردام → Rotterdam', F('التسليم إلى ميناء روتردام. نحتاج 100 قطعة.').destination === 'Rotterdam');

/* 未命中归一表的目的地保留原始提取，不强行猜 */
var e = F('التسليم إلى ميناء العقبة. نحتاج 100 قطعة.');
ok('F6 未收录港口保留原文 العقبة', e.destination === 'العقبة', JSON.stringify(e.destination));

/* 两词真实地名不得被首词逻辑误截（如 San Pedro 不在表中，保持全称） */
var g = F('Necesitamos 100 unidades de antenas, envío al puerto de San Pedro.');
ok('F7 两词地名 San Pedro 保持完整', g.destination === 'San Pedro', JSON.stringify(g.destination));

/* ---- 五语言商品名回归（与各黄金样本一致） ---- */
ok('R-ES 商品名', F('Hola, necesitamos 500 unidades del receptor FPV XR4 ELRS de 2,4 GHz. Entrega en el puerto de Hamburgo.').productName === 'receptor FPV XR4 ELRS');
ok('R-FR 商品名', /récepteur FPV XR4 ELRS/.test(F('Bonjour, nous avons besoin de 500 pièces du récepteur FPV XR4 ELRS 2,4 GHz. Livraison au port de Hambourg.').productName));
ok('R-DE 商品名', F('Hallo, wir benötigen 500 Stück des XR4 FPV Empfängers 2,4 GHz ELRS. Lieferung an den Hafen Hamburg.').productName === 'XR4 FPV Empfängers 2,4 GHz ELRS');
ok('R-AR 商品名', (F('مرحبًا، نحتاج إلى ٥٠٠ قطعة من جهاز استقبال FPV XR4 ELRS بتردد 2.4GHz. التسليم إلى ميناء هامبورغ.').productName || '').indexOf('جهاز استقبال') >= 0);
ok('R-HI 商品名', F('नमस्ते, हमें ५०० पीस XR4 FPV रिसीवर 2.4GHz ELRS चाहिए। डिलीवरी हैम्बर्ग बंदरगाह पर।').productName === 'XR4 FPV रिसीवर 2.4GHz ELRS');

/* ---- 英/中原有解析回归锚 ---- */
var en = F('Hello, we need 500 pcs of XR4 FPV receiver 2.4GHz ELRS. Delivery to Hamburg port, we need them within 20 days. Our target price is $3.50 per pc.');
ok('R-EN 商品名/数量/目的地/目标价不变', en.productName === 'XR4 FPV receiver 2.4GHz ELRS' && en.qty === 500 && en.destination === 'Hamburg' && en.targetPriceUsd === 3.5,
  JSON.stringify({ n: en.productName, q: en.qty, d: en.destination, t: en.targetPriceUsd }));
var zh = F('你好，我们需要500个XR4 FPV接收机（2.4GHz ELRS）。交货到汉堡港，20天内需要。我们的目标价是3.5美元一个。');
ok('R-ZH 数量/交期/目标价不变', zh.qty === 500 && zh.deadlineDays === 20 && zh.targetPriceUsd === 3.5,
  JSON.stringify({ q: zh.qty, d: zh.deadlineDays, t: zh.targetPriceUsd }));

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
