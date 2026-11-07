/* P1-17 第五阶段最终修订：认证证据位置统一专项测试。
   核心断言：每条 evidence 必须满足 snippet.slice(pos, pos + 名称长度) 精确定位到
   原文中的认证名称（原文写法，含原始大小写）；pos 为 0 基、与 snippet 同一文本基准。
   纯 Node，全部虚构数据。运行：node tests/test-cert-evidence-offset.js */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function mention(text, name) {
  var ms = P.extract(text).fields.certMentions.filter(function (m) { return m.name === name; });
  return ms[0] || null;
}
/* 定位断言：slice 结果必须与原文写法逐字相等（大小写敏感），且其大写形式等于规范名 */
function loc(ev, written, canonical) {
  if (!ev) return false;
  var got = ev.snippet.slice(ev.pos, ev.pos + canonical.length);
  return got === written && got.toUpperCase() === canonical;
}

/* 1 句首 */
var s1 = mention('ATEX is mandatory.', 'ATEX');
ok('S1. 句首 evidence 恰一条', s1 && s1.evidence.length === 1);
ok('S1. 句首 pos=0 且 slice 精确定位', s1 && s1.evidence[0].pos === 0 && loc(s1.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s1 && s1.evidence));
ok('S1. 语境 mandatory、context 兼容字段一致', s1 && s1.evidence[0].context === 'mandatory' && s1.context === 'mandatory');

/* 2 句中 */
var s2 = mention('We require ATEX certification.', 'ATEX');
ok('S2. 句中 slice 精确定位（pos=11）', s2 && s2.evidence[0].pos === 11 && loc(s2.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s2 && s2.evidence));

/* 3 逗号后 */
var s3 = mention('CE is preferred, ATEX is mandatory.', 'ATEX');
ok('S3. 逗号后出现 slice 精确定位', s3 && loc(s3.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s3 && s3.evidence));
ok('S3. 子句选择正确（逗号后子句 mandatory）', s3 && s3.evidence[0].context === 'mandatory', JSON.stringify(s3 && s3.evidence));

/* 4 but 之后 */
var s4 = mention('CE is optional, but ATEX is required.', 'ATEX');
ok('S4. but 后出现 slice 精确定位', s4 && loc(s4.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s4 && s4.evidence));
ok('S4. 子句选择正确（but 后子句 mandatory，未被 optional 污染）', s4 && s4.evidence[0].context === 'mandatory', JSON.stringify(s4 && s4.evidence));

/* 5 前导空格（一个与多个） */
var s5a = mention(' ATEX is mandatory.', 'ATEX');
var s5b = mention('   ATEX is mandatory.', 'ATEX');
ok('S5. 一个前导空格：pos 与 snippet 同基准精确定位', s5a && s5a.evidence[0].pos === 0 && loc(s5a.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s5a && s5a.evidence));
ok('S5. 多个前导空格：同样精确定位', s5b && s5b.evidence[0].pos === 0 && loc(s5b.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s5b && s5b.evidence));

/* 6 同句同认证两次、同语境 */
var s6 = mention('ATEX is mandatory, and ATEX is mandatory for this order.', 'ATEX');
ok('S6. evidence 两条', s6 && s6.evidence.length === 2, JSON.stringify(s6 && s6.evidence));
ok('S6. 两条均精确定位且 pos 不同', s6 && loc(s6.evidence[0], 'ATEX', 'ATEX') && loc(s6.evidence[1], 'ATEX', 'ATEX') && s6.evidence[0].pos !== s6.evidence[1].pos, JSON.stringify(s6 && s6.evidence));
ok('S6. contexts 去重为 [mandatory]、无冲突', s6 && s6.contexts.length === 1 && s6.contexts[0] === 'mandatory' && s6.conflict === false);

/* 7 同句同认证两次、语境不同 */
var s7 = mention('ATEX is optional, but ATEX is required.', 'ATEX');
ok('S7. 两条均精确定位', s7 && s7.evidence.length === 2 && loc(s7.evidence[0], 'ATEX', 'ATEX') && loc(s7.evidence[1], 'ATEX', 'ATEX'), JSON.stringify(s7 && s7.evidence));
ok('S7. 语境分别为 not-required 与 mandatory、conflict=true', s7 && s7.evidence[0].context === 'not-required' && s7.evidence[1].context === 'mandatory' && s7.conflict === true, JSON.stringify(s7));
ok('S7. contexts 含两种语境、context 兼容字段为 mandatory', s7 && s7.contexts.indexOf('mandatory') >= 0 && s7.contexts.indexOf('not-required') >= 0 && s7.context === 'mandatory');

/* 8 不同认证同句不同子句 */
var s8t = 'CE is mandatory, and ATEX is not required.';
var s8a = mention(s8t, 'CE'), s8b = mention(s8t, 'ATEX');
ok('S8. CE 精确定位且子句语境 mandatory', s8a && loc(s8a.evidence[0], 'CE', 'CE') && s8a.evidence[0].context === 'mandatory', JSON.stringify(s8a && s8a.evidence));
ok('S8. ATEX 精确定位且子句语境 not-required（未被前子句污染）', s8b && loc(s8b.evidence[0], 'ATEX', 'ATEX') && s8b.evidence[0].context === 'not-required', JSON.stringify(s8b && s8b.evidence));

/* 9 长句后部（>90 字符） */
var longText = 'Please confirm the delivery schedule, packaging details, pallet size and shipping marks for this order first, and note that ATEX is mandatory for the final shipment to our warehouse.';
var s9 = mention(longText, 'ATEX');
ok('S9. 长句长度确实超过 90 字符', longText.length > 90, String(longText.length));
ok('S9. 长句后部 evidence 仍精确定位', s9 && s9.evidence.length === 1 && loc(s9.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s9 && s9.evidence));
ok('S9. snippet 长度不超过 90 且名称完整落在 snippet 内', s9 && s9.evidence[0].snippet.length <= 90 && s9.evidence[0].pos + 4 <= s9.evidence[0].snippet.length, JSON.stringify(s9 && s9.evidence));
ok('S9. 长句语境仍为 mandatory', s9 && s9.evidence[0].context === 'mandatory', JSON.stringify(s9 && s9.evidence));

/* 10 跨句出现 */
var s10 = mention('ATEX is optional. We require ATEX certification for this order.', 'ATEX');
ok('S10. 跨句 evidence 两条且各自精确定位', s10 && s10.evidence.length === 2 && loc(s10.evidence[0], 'ATEX', 'ATEX') && loc(s10.evidence[1], 'ATEX', 'ATEX'), JSON.stringify(s10 && s10.evidence));
ok('S10. 跨句冲突 conflict=true', s10 && s10.conflict === true, JSON.stringify(s10));

/* 11 大小写不同的写法：定位对象为原文写法，规范名仅用于归类 */
var s11 = mention('atex is mandatory for this order.', 'ATEX');
ok('S11. 小写写法被识别并归类为规范名 ATEX', !!s11);
ok('S11. slice 得到原文小写写法 atex（定位原文而非规范名）', s11 && loc(s11.evidence[0], 'atex', 'ATEX') && s11.evidence[0].pos === 0, JSON.stringify(s11 && s11.evidence));
var s11b = mention('Atex is mandatory.', 'ATEX');
ok('S11. 首字母大写写法 slice 得到原文 Atex', s11b && loc(s11b.evidence[0], 'Atex', 'ATEX'), JSON.stringify(s11b && s11b.evidence));

/* 12 认证后紧跟标点 */
var s12 = mention('ATEX: mandatory certification for this order.', 'ATEX');
ok('S12. 紧跟冒号：pos=0 精确定位', s12 && s12.evidence[0].pos === 0 && loc(s12.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s12 && s12.evidence));
var s12b = mention('Please provide ATEX.', 'ATEX');
ok('S12. 紧跟句号：精确定位', s12b && loc(s12b.evidence[0], 'ATEX', 'ATEX'), JSON.stringify(s12b && s12b.evidence));

console.log('== cert-evidence-offset: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
