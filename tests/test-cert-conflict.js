/* P1-17 第五阶段：同句重复提及与跨句冲突（任务书第三节 A1–A4、第四节 B1–B4）
   直接断言 certMentions 的 contexts / evidence / conflict 结构；纯 Node，全部虚构数据。
   运行：node tests/test-cert-conflict.js */
'use strict';
global.window = global;
require('../assets/p0-parse.js');
var P = global.P0Parse;
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function cm(text, name) {
  var ms = P.extract(text).fields.certMentions.filter(function (m) { return m.name === name; });
  return ms[0] || null;
}
function hasCtx(m, ctx) { return !!m && m.contexts.indexOf(ctx) >= 0; }
function evCtxs(m) { return m ? m.evidence.map(function (e) { return e.context; }) : []; }

/* A1 同句 preference + mandatory → 两证据 + 冲突 */
var a1 = cm('ATEX is optional, but ATEX is required.', 'ATEX');
ok('A1. 同句两种语境都保留', hasCtx(a1, 'not-required') && hasCtx(a1, 'mandatory'), JSON.stringify(a1));
ok('A1. conflict=true', a1 && a1.conflict === true, JSON.stringify(a1));
ok('A1. evidence 含两条且语境不同', a1 && a1.evidence.length === 2 && evCtxs(a1).indexOf('mandatory') >= 0 && evCtxs(a1).indexOf('not-required') >= 0, JSON.stringify(a1 && a1.evidence));
ok('A1. 兼容字段 context 为最高优先级 mandatory', a1 && a1.context === 'mandatory', a1 && a1.context);

/* A2 同句 not-required + mandatory → 冲突 */
var a2 = cm('ATEX is not required, but ATEX is mandatory.', 'ATEX');
ok('A2. not-required 与 mandatory 并存且 conflict', a2 && a2.conflict === true && hasCtx(a2, 'not-required') && hasCtx(a2, 'mandatory'), JSON.stringify(a2));

/* A3 同句同语境重复 → 保留但不误报冲突，证据去重 */
var a3 = cm('ATEX is mandatory, and ATEX is mandatory for this order.', 'ATEX');
ok('A3. 同语境重复不算冲突', a3 && a3.conflict === false && a3.contexts.length === 1 && a3.contexts[0] === 'mandatory', JSON.stringify(a3));
ok('A3. evidence 逐次保留两条且句内位置可区分（收尾 R1 新语义）', a3 && a3.evidence.length === 2 && a3.evidence[0].pos !== a3.evidence[1].pos, JSON.stringify(a3 && a3.evidence));

/* A4 不同认证互不污染 */
var a4t = 'ATEX is not required, and CE is mandatory.';
var a4a = cm(a4t, 'ATEX'), a4c = cm(a4t, 'CE');
ok('A4. ATEX=not-required、CE=mandatory，互不污染且无冲突',
  a4a && a4a.context === 'not-required' && a4a.conflict === false &&
  a4c && a4c.context === 'mandatory' && a4c.conflict === false, JSON.stringify([a4a, a4c]));

/* B1 跨句：先要求后否定 → 冲突且两条原文证据都在 */
var b1 = cm('We require ATEX certification. ATEX is not required for this order.', 'ATEX');
ok('B1. 跨句冲突 conflict=true', b1 && b1.conflict === true, JSON.stringify(b1));
ok('B1. 两条证据分别带各自原文', b1 && b1.evidence.length === 2 &&
  b1.evidence.some(function (e) { return e.context === 'mandatory' && /require ATEX certification/.test(e.snippet); }) &&
  b1.evidence.some(function (e) { return e.context === 'not-required' && /not required for this order/.test(e.snippet); }), JSON.stringify(b1 && b1.evidence));
ok('B1. context 兼容字段仍为 mandatory（最高优先级）', b1 && b1.context === 'mandatory', b1 && b1.context);

/* B2 跨句：先否定后要求 → 同样冲突（顺序无关） */
var b2 = cm('ATEX is not required. We require ATEX certification.', 'ATEX');
ok('B2. 反序跨句冲突同样识别', b2 && b2.conflict === true && hasCtx(b2, 'mandatory') && hasCtx(b2, 'not-required'), JSON.stringify(b2));

/* B3 跨句同语境重复 → 不误报冲突 */
var b3 = cm('ATEX is mandatory. ATEX is mandatory for this order.', 'ATEX');
ok('B3. 跨句同语境不误报冲突，证据两条（不同原文）', b3 && b3.conflict === false && b3.contexts.length === 1 && b3.evidence.length === 2, JSON.stringify(b3));

/* B4 询问 + 强制 → 两证据保留，不算 mandatory/not-required 冲突 */
var b4 = cm('Can you provide ATEX? We require ATEX certification.', 'ATEX');
ok('B4. inquiry 与 mandatory 证据都在', b4 && hasCtx(b4, 'inquiry') && hasCtx(b4, 'mandatory') && b4.evidence.length === 2, JSON.stringify(b4));
ok('B4. inquiry+mandatory 不标记 conflict（冲突仅指要求与不需要并存）', b4 && b4.conflict === false, JSON.stringify(b4));

console.log('== cert-conflict: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
