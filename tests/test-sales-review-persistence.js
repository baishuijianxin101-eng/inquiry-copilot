/* P1-22-R2：salesReview 持久化生命周期回归。
   层级声明：本测试在 Node 中以内存 localStorage 桩驱动 core.js 的真实
   load→migrate→normalizeOpp 与 mergeAll 链路，属对象级持久化验证，
   不等同于真实浏览器页面刷新测试。全部虚构数据。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'core.js'), 'utf8');
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }
function memStorage() { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; }, _m: m }; }
function loadCore(storage) {
  var sandbox = { console: { log: function () {}, warn: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sandbox.window = sandbox; sandbox.localStorage = storage;
  vm.createContext(sandbox); vm.runInContext(SRC, sandbox, { filename: 'core.js' });
  return sandbox.Core;
}
function review() {
  return { needFix: { qty: { value: '900 pcs', at: '2026-11-05' } }, stageFix: '供应商筛选',
    concernFix: { '产品质量': 'confirmed', '价格': 'dismissed' }, flagged: ['stage', 'need:certs'], at: '2026-11-05' };
}
function oppWith(C, rv) {
  return C.normalizeOpp({ id: 'opp_t1', status: 'new', buyer: { name: 'Daniel', company: 'FlyMart', country: 'Germany', channel: '询盘' },
    rawText: 'fictional inquiry text', quote: { qty: 800 }, followLog: [], log: [], salesReview: rv });
}

/* 1. 完整生命周期：写入 → persist → 新上下文重读（走 load→migrate→normalizeOpp） */
(function () {
  var store = memStorage();
  var C1 = loadCore(store);
  var st = C1.get();
  st.opportunities.push(oppWith(C1, review()));
  C1.persist();
  ok(!!store._m['ali_commission_copilot_v1'], 'L1 persist 已写入存储');
  var C2 = loadCore(store);
  var back = C2.get().opportunities.filter(function (o) { return o.id === 'opp_t1'; })[0];
  ok(!!back, 'L2 重读后商机仍在');
  var rv = back && back.salesReview;
  ok(!!rv && rv.stageFix === '供应商筛选', 'L3 重读后 stageFix 保留');
  ok(rv && rv.needFix && rv.needFix.qty && rv.needFix.qty.value === '900 pcs', 'L4 重读后 needFix 保留');
  ok(rv && rv.concernFix && rv.concernFix['产品质量'] === 'confirmed' && rv.concernFix['价格'] === 'dismissed', 'L5 重读后两个 concernFix 都保留');
  ok(rv && Array.isArray(rv.flagged) && rv.flagged.indexOf('stage') >= 0 && rv.flagged.indexOf('need:certs') >= 0, 'L6 重读后 flagged 保留');
  ok(back && back.rawText === 'fictional inquiry text' && back.quote && back.quote.qty === 800, 'L7 原始询盘与报价字段未被修正层触碰');
})();
/* 2. 多次规范化幂等 */
(function () {
  var C = loadCore(memStorage());
  var once = oppWith(C, review());
  var twice = C.normalizeOpp(once);
  var thrice = C.normalizeOpp(twice);
  ok(JSON.stringify(once.salesReview) === JSON.stringify(twice.salesReview), 'M1 normalize 两次结果一致');
  ok(JSON.stringify(twice.salesReview) === JSON.stringify(thrice.salesReview), 'M2 normalize 三次结果一致');
  ok(Object.keys(thrice.salesReview).sort().join(',') === 'at,concernFix,flagged,needFix,stageFix', 'M3 不产生额外字段');
})();
/* 3. 旧数据兼容 */
(function () {
  var C = loadCore(memStorage());
  var old = C.normalizeOpp({ id: 'opp_old', status: 'quoted', buyer: { name: 'Old Buyer' }, rawText: 'legacy', quote: { qty: 5 } });
  ok(old.salesReview === null, 'O1 无 salesReview 的旧商机规范化后为 null、不报错');
  ok(old.buyer.name === 'Old Buyer' && old.quote.qty === 5 && old.status === 'quoted', 'O2 旧商机其他字段完整保留');
})();
/* 4. 非法数据防护 */
(function () {
  var C = loadCore(memStorage());
  [null, 'string-junk', [1, 2], 42].forEach(function (bad, i) {
    var o = C.normalizeOpp({ id: 'opp_bad' + i, buyer: { name: 'B' }, rawText: 'x', salesReview: bad });
    ok(o.salesReview === null && o.buyer.name === 'B', 'X' + (i + 1) + ' 非对象 salesReview(' + JSON.stringify(bad) + ')被整层丢弃且商机完好');
  });
  var mixed = C.normalizeOpp({ id: 'opp_mix', buyer: { name: 'M' }, rawText: 'x', salesReview: {
    hackerKey: 'drop me', stageFix: '不存在的阶段',
    needFix: { qty: { value: 123 }, evil: { value: 'no' }, certs: { value: 'CE', at: '2026-11-05' } },
    concernFix: { '价格': 'maybe', '售后': 'confirmed' },
    flagged: ['stage', 'need:evil', 42, 'stage', 'need:qty'] } });
  var rv = mixed.salesReview;
  ok(rv && !('hackerKey' in rv), 'X5 未知顶层字段被丢弃');
  ok(rv && !rv.stageFix, 'X6 非法 stageFix 被丢弃');
  ok(rv && rv.needFix && !rv.needFix.qty && !rv.needFix.evil && rv.needFix.certs.value === 'CE', 'X7 needFix 只保留白名单键与字符串值');
  ok(rv && rv.concernFix && !('价格' in rv.concernFix) && rv.concernFix['售后'] === 'confirmed', 'X8 concernFix 只保留 confirmed/dismissed');
  ok(rv && rv.flagged.join(',') === 'stage,need:qty', 'X9 flagged 去重且只留白名单项');
  var long = C.normalizeOpp({ id: 'opp_long', buyer: { name: 'L' }, rawText: 'x', salesReview: { needFix: { product: { value: new Array(302).join('a') } } } });
  ok(long.salesReview.needFix.product.value.length === 200, 'X10 超长字符串被截断到 200');
})();
/* 5. 多项修正互不清空（规范化层） */
(function () {
  var C = loadCore(memStorage());
  var o = oppWith(C, review());
  o.salesReview.concernFix['价格'] = 'confirmed';   /* 只改其中一项 */
  var again = C.normalizeOpp(o);
  ok(again.salesReview.concernFix['产品质量'] === 'confirmed' && again.salesReview.concernFix['价格'] === 'confirmed', 'P1 改一项后另一项仍在');
  ok(again.salesReview.needFix.qty.value === '900 pcs' && again.salesReview.stageFix === '供应商筛选', 'P2 其余修正层字段不受影响');
})();
/* 6. mergeAll 迁移入口 */
(function () {
  var C = loadCore(memStorage());
  var cur = C.get();
  var importObj = { version: cur.version, settings: cur.settings, products: [], opportunities: [oppWith(C, review())], orders: [], logs: [] };
  C.mergeAll(importObj);
  var back = C.get().opportunities.filter(function (o) { return o.id === 'opp_t1'; })[0];
  ok(back && back.salesReview && back.salesReview.stageFix === '供应商筛选', 'G1 mergeAll 路径下 salesReview 保留');
})();

console.log('== sales-review-persistence: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
