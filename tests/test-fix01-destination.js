/* P1-FIX-01 回归：目的地解析不得把 Lead time 等字段标签误作地名
   运行：node tests/test-fix01-destination.js
   背景：贸易术语单独成句（"…, FOB" 换行 "Lead time: 30 days"）时，
   折行后的 FOB 地名模式会把 "Lead" 误捕为目的地（Android A2 实测）。
   全部使用虚构询盘文本。 */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;

var pass = 0, fail = 0;
function eq(name, got, want) {
  var okc = JSON.stringify(got) === JSON.stringify(want);
  if (okc) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, '| got:', JSON.stringify(got), '| want:', JSON.stringify(want)); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

/* 1. Android A2 实测原文：FOB 后紧跟 Lead time，目的地必须留空待确认 */
var LAURA = 'Dear Sales Manager,\n\nWe are a retail chain based in Spain and we are interested in HappyModel ES900 DUAL RX ELRS Receiver 915/868MHz Built-in TCXO Plastic & Metal RC Airplane FPV Long Range.\n\nQuantity: 100 pcs\nTarget price: USD 16.97 per pc, FOB\nLead time: 30 days\n\nPlease send your best quotation and MOQ.\n\nBest regards,\nLaura';
var r1 = P.extract(LAURA);
eq('Laura：目的地不是 Lead（留空）', r1.fields.destination, '');
eq('Laura：目的地置信度为 0', r1.confidence.destination, 0);
ok('Laura：无目的地证据', !r1.evidence.destination);
eq('Laura：交期仍识别为 30 天', r1.fields.deadlineDays, 30);
eq('Laura：数量仍识别为 100', r1.fields.qty, 100);
eq('Laura：目标价仍识别', r1.fields.targetPriceUsd, 16.97);

/* 2. 大写 Time 写法同样拦截 */
var r2 = P.extract('Quantity: 500 pcs\nPrice: USD 3.20 per pc, FOB\nLead Time: 45 days\nPayment terms: T/T in advance');
eq('Lead Time 大写：目的地留空', r2.fields.destination, '');
eq('Lead Time 大写：交期 45 天', r2.fields.deadlineDays, 45);

/* 3. 真实地名在后文出现时仍能命中（拦截不误伤后续模式） */
var r3 = P.extract('Quantity: 200 pcs, FOB\nLead time: 20 days\nPlease ship to Hamburg port.');
eq('ship to Hamburg：目的地命中', r3.fields.destination, 'Hamburg');
eq('ship to Hamburg：交期 20 天', r3.fields.deadlineDays, 20);

/* 4. CIF + 地名（原有行为回归） */
var r4 = P.extract('Please quote 1,000 pcs, CIF Rotterdam. Delivery time: 25 days.');
eq('CIF Rotterdam：目的地命中', r4.fields.destination, 'Rotterdam');

/* 5. FOB + 地名（原有行为回归） */
var r5 = P.extract('Please quote 800 pcs, FOB Ningbo.');
eq('FOB Ningbo：目的地命中', r5.fields.destination, 'Ningbo');

/* 6. destination: 标签（原有行为回归） */
var r6 = P.extract('Delivery time: 20 days. Destination: Santos.');
eq('Destination Santos：目的地命中', r6.fields.destination, 'Santos');

/* 7. shipping address: 标签（本批次新增关键词） */
var r7 = P.extract('Quantity: 300 pcs. Shipping address: Valencia, Spain. Please confirm price.');
eq('Shipping address Valencia：目的地命中', r7.fields.destination, 'Valencia');

/* 8. delivered to（泛化 to 模式回归） */
var r8 = P.extract('The goods will be delivered to Genoa in June. Quantity: 100 pcs.');
eq('delivered to Genoa：目的地命中', r8.fields.destination, 'Genoa');

/* 9. EXW + 地名、production time 不误捕 */
var r9 = P.extract('Please quote EXW Shenzhen. Production time is 15 days, quantity 2,000 pcs.');
eq('EXW Shenzhen：目的地命中', r9.fields.destination, 'Shenzhen');

/* 10. 只有标签、没有任何地名时必须留空，不得猜测 */
var r10 = P.extract('Quantity: 100 pcs\nDelivery time: 30 days\nShipping: by sea\nPayment: T/T');
eq('纯标签文本：目的地留空', r10.fields.destination, '');

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
