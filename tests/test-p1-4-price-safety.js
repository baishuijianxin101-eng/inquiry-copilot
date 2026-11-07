/* P1-4-LANG P0专项：价格数字格式安全——小数逗号/千分位/欧元符号/歧义标记，
   以及法语 pièces 不得误触 PI（形式发票）信号。纯 Node，全部虚构数据。
   运行：node tests/test-p1-4-price-safety.js */
'use strict';
global.window = global;
require('../assets/lang-pack.js');
require('../assets/p0-parse.js');
require('../assets/opp-score.js');
var P = global.P0Parse, OS = global.OppScore;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function mentions(text) { return P.extract(text).fields.priceMentions || []; }
function first(text) { return mentions(text)[0] || {}; }
function intentReasons(raw) {
  var r = OS.score({ opp: { rawText: raw, status: 'new' }, eff: {}, match: null });
  var d = (r.dims || []).filter(function (x) { return x.key === 'intent'; })[0];
  return d ? d.reasons.join('；') : '';
}

/* 1. 美式小数点：$3.50 原样 */
var a = first('Price: $3.50 per pc.');
ok('A1 $3.50 → 3.5 USD 且格式确定', a.value === 3.5 && a.currency === 'USD' && a.uncertain === false, JSON.stringify(a));

/* 2. 英文目标价回归锚：不得因格式修复丢失 */
var b = P.extract('Our target price is $3.50 per pc.');
ok('A2 target $3.50 → targetPriceUsd 3.5', b.fields.targetPriceUsd === 3.5, JSON.stringify(b.fields.priceMentions));

/* 3. 小数逗号 + dollars：曾被误读成 350 */
var c = first('El precio es 3,50 dollars.');
ok('A3 3,50 dollars → 3.5（不是 350）', c.value === 3.5 && c.currency === 'USD', JSON.stringify(c));

/* 4. 小数逗号 + USD 缩写 */
var d = first('Precio 3,50 USD por unidad.');
ok('A4 3,50 USD → 3.5', d.value === 3.5 && d.currency === 'USD', JSON.stringify(d));

/* 5. 欧元符号（此前完全不识别） */
var e = first('Precio: 3,50 €');
ok('A5 3,50 € → 3.5 EUR', e.value === 3.5 && e.currency === 'EUR', JSON.stringify(e));
ok('A5b EUR 不写入 USD 目标价', P.extract('Precio: 3,50 €').fields.targetPriceUsd === 0);

/* 6. 欧洲完整格式 1.250,50 EUR（点千分位 + 逗号小数） */
var f = first('Total: 1.250,50 EUR');
ok('A6 1.250,50 EUR → 1250.5 EUR', f.value === 1250.5 && f.currency === 'EUR', JSON.stringify(f));

/* 7. 美式完整格式 1,250.50 USD */
var g = first('Total: 1,250.50 USD');
ok('A7 1,250.50 USD → 1250.5 USD', g.value === 1250.5 && g.currency === 'USD', JSON.stringify(g));

/* 8. 整数金额 350 USD 不受小数逗号规则影响 */
var h = first('Price 350 USD');
ok('A8 350 USD → 350 且确定', h.value === 350 && h.uncertain === false, JSON.stringify(h));

/* 9. 歧义格式 1.250：欧式千分位或 1.25 小数，只留痕不采信 */
var i2 = P.extract('Target price 1.250 USD per pc.');
var im = (i2.fields.priceMentions || [])[0] || {};
ok('A9 1.250 USD → uncertain 标记 + 角色 UNKNOWN', im.uncertain === true && im.role === 'UNKNOWN_PRICE', JSON.stringify(im));
ok('A9b 歧义金额不写入目标价', i2.fields.targetPriceUsd === 0, 'target=' + i2.fields.targetPriceUsd);

/* 10. 歧义格式 3,500：千分位或小数逗号，只留痕不采信 */
var j = P.extract('Target price 3,500 USD per pc.');
var jm = (j.fields.priceMentions || [])[0] || {};
ok('A10 3,500 USD → uncertain + 不写入目标价', jm.uncertain === true && j.fields.targetPriceUsd === 0, JSON.stringify(jm));

/* 11. 价格解析不得阻断其他字段：无价格询盘数量照常 */
var k = P.extract('Please quote 500 pcs of XR4 receiver, delivery to Hamburg port within 20 days.');
ok('A11 无价格文本数量/型号照常', k.fields.qty === 500 && k.fields.model === 'XR4' && (k.fields.priceMentions || []).length === 0, JSON.stringify(k.fields.qty));

/* 12. 法语 pièces 不得误触 PI 信号；英文独立 PI 仍应命中 */
var fr = intentReasons('Nous avons besoin de 500 pièces du récepteur XR4.');
ok('A12 pièces 不触发形式发票信号', fr.indexOf('询问付款/合同细节') < 0, fr);
var en = intentReasons('Please send PI for 500 pcs.');
ok('A12b 独立 PI 仍触发形式发票信号', en.indexOf('询问付款/合同细节') >= 0, en);

console.log('---');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
