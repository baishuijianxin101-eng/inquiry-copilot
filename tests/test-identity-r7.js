/* P1-23-R7：R6 剩余缺陷定点修复专项（identity / migration 部分）。
   V 组：canon-v3 类型编码安全（第一项）；B 组：buildBackup 注册表
   结构完整性（第四项）；F 组：backfillLegacy 完整审计（第五项）；
   K 组：checkIntegrity 关联边界（第六项）。
   全部虚构数据；本文件为 Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function oppContent(qty) { return { buyerName: 'B', buyerCompany: 'C', productText: 'Widget', qty: qty, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }; }
function throwsCanon(fn) { try { fn(); return null; } catch (e) { return e; } }

function makeStorage() {
  var map = new Map();
  return {
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { map.set(k, String(v)); },
    removeItem: function (k) { map.delete(k); },
    _map: map
  };
}
var BIZ_KEY = 'ali_commission_copilot_v1';
function makeCore(storage, initial) {
  var state = clone(initial);
  var core = { STORE_KEY: BIZ_KEY, get: function () { return state; } };
  storage.setItem(BIZ_KEY, JSON.stringify(state));
  return core;
}
function emptyState() { return { products: [], opportunities: [], orders: [], settings: {} }; }

/* ================= V 组：canon-v3 类型安全 ================= */
/* V01 布尔值进字符串字段 → 明确拒绝（修复前 String(true) 与
   字符串 'true' 编码碰撞） */
(function () {
  var e1 = throwsCanon(function () { ID.canonicalize({ buyerName: true }, 'opportunity', 'canon-v3'); });
  var e2 = throwsCanon(function () { ID.canonicalize({ buyerName: false }, 'opportunity', 'canon-v3'); });
  ok(!!e1 && e1.code === 'canon_type_invalid' && !!e2 && e2.code === 'canon_type_invalid', 'V01 布尔值进字符串字段被拒绝（true/false）');
  ok(ID.canonicalize({ buyerName: 'true' }, 'opportunity', 'canon-v3') !== ID.canonicalize({ buyerName: 'false' }, 'opportunity', 'canon-v3'), 'V01b 字符串 true/false 正常编码且可区分');
})();
/* V02 对象/数组进字符串字段 → 拒绝（修复前 '[object Object]' 与
   数组 join 字符串碰撞） */
(function () {
  var e1 = throwsCanon(function () { ID.canonicalize({ buyerName: { x: 1 } }, 'opportunity', 'canon-v3'); });
  var e2 = throwsCanon(function () { ID.canonicalize({ buyerName: ['a', 'b'] }, 'opportunity', 'canon-v3'); });
  var e3 = throwsCanon(function () { ID.canonicalize({ buyerName: 42 }, 'opportunity', 'canon-v3'); });
  ok(!!e1 && !!e2 && !!e3, 'V02 对象/数组/数字进字符串字段全部被拒绝');
})();
/* V03 数值字段类型：数字正常、字符串/布尔拒绝；0 与 '0' 不再同码 */
(function () {
  var e1 = throwsCanon(function () { ID.canonicalize({ qty: '0' }, 'opportunity', 'canon-v3'); });
  var e2 = throwsCanon(function () { ID.canonicalize({ qty: true }, 'opportunity', 'canon-v3'); });
  var cNum = ID.canonicalize({ qty: 0 }, 'opportunity', 'canon-v3');
  ok(!!e1 && !!e2 && cNum.indexOf('qty=n:1:0') >= 0, 'V03 qty 只接受 number，字符串/布尔被拒绝，0 编码带 n 标签');
})();
/* V04 缺失/null/空串在 v3 下仍严格区分（真实规范串比对） */
(function () {
  var cM = ID.canonicalize({}, 'opportunity', 'canon-v3');
  var cN = ID.canonicalize({ buyerName: null }, 'opportunity', 'canon-v3');
  var cE = ID.canonicalize({ buyerName: '' }, 'opportunity', 'canon-v3');
  ok(cM !== cN && cN !== cE && cM !== cE && cE.indexOf('buyerName=s:0:') >= 0 && cN.indexOf('buyerName=Z') >= 0 && cM.indexOf('buyerName=M') >= 0, 'V04 缺失/null/空串三态规范串互不相同');
})();
/* V05 contentHash 层：非法类型内容哈希直接抛错，不产生指纹 */
(function () {
  var e = throwsCanon(function () { ID.contentHash({ buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: '10', unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, 'opportunity', 'canon-v3'); });
  ok(!!e && e.code === 'canon_type_invalid', 'V05 qty 为字符串时 contentHash 抛 canon_type_invalid');
})();
/* V06 v1/v2 冻结：v1 固定夹具哈希不变；v1 对布尔仍按旧语义
   String() 计算（不抛错）——证明只改 v3、未动历史规则 */
(function () {
  var fixture = { buyerName: 'A', buyerCompany: 'B', productText: 'x|qty=n:1', qty: 2, unit: 'pcs', destination: 'DE', rawTextHash: 'h' };
  ok(ID.contentHash(fixture, 'opportunity', 'canon-v1') === 'fnv1a32x2:1951bd3442435f51', 'V06a v1 固定夹具哈希不变');
  var h1 = null, threw = null;
  try { h1 = ID.contentHash({ buyerName: true, buyerCompany: 'B', productText: 'W', qty: 1, unit: 'pcs', destination: 'DE', rawTextHash: 'h' }, 'opportunity', 'canon-v1'); } catch (e) { threw = e; }
  ok(!threw && typeof h1 === 'string', 'V06b v1 旧语义冻结（布尔按 String 计算、不抛错）');
  var c2 = ID.canonicalize(fixture, 'opportunity', 'canon-v2');
  ok(c2.indexOf('canon-v2|') === 0 && ID.canonicalize(fixture, 'opportunity', 'canon-v1').indexOf('canon-v1|') === 0, 'V06c v1/v2 版本前缀与规则保持');
})();
/* V07 v1 实体经 importRecord 升级路径迁移到 v3（且 v3 类型规则
   在升级后的新内容计算中生效） */
(function () {
  var reg = ID.createRegistry();
  var rec = { identity: { source_system: 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: 'UP-7' }, content: oppContent(10), sourceVersion: 1 };
  var first = ID.importRecord(reg, rec, { now: '2026-11-06T00:00:00.000Z' });
  reg.byInternal[first.internalId].canonVersion = 'canon-v1';
  reg.byInternal[first.internalId].contentHash = ID.contentHash(oppContent(10), 'opportunity', 'canon-v1');
  var second = ID.importRecord(reg, rec, { now: '2026-11-06T00:01:00.000Z' });
  ok(second.status === 'UNCHANGED' && reg.byInternal[first.internalId].contentHash === ID.contentHash(oppContent(10), 'opportunity', 'canon-v3'), 'V07 v1 实体升级到 v3 哈希');
})();

/* ================= B 组：buildBackup 注册表结构完整性 ================= */
function buildWith(rawSetter) {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  TXN.init(s);
  if (rawSetter) rawSetter(s);
  try { return { bundle: TXN.buildBackup(c, s), threw: null }; }
  catch (e) { return { bundle: null, threw: e }; }
}
/* B-R7-01 键不存在 → 合法无注册表备份 */
(function () {
  var r = buildWith(null);
  ok(!r.threw && r.bundle.identityRegistry === null && r.bundle.checksums.registry === null, 'B-R7-01 无注册表键 → 合法导出');
})();
/* B-R7-02 读取抛错 → registry_read_failed */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  TXN.init(s);
  var throwing = { getItem: function (k) { if (k === IM.REGISTRY_KEY) throw new Error('io'); return s.getItem(k); }, setItem: function (k, v) { s.setItem(k, v); }, removeItem: function (k) { s.removeItem(k); } };
  var threw = null;
  try { TXN.buildBackup(c, throwing); } catch (e) { threw = e; }
  ok(!!threw && threw.message.indexOf('registry_read_failed') >= 0, 'B-R7-02 读取抛错 → registry_read_failed');
})();
/* B-R7-03 空字符串 → registry_corrupt（修复前 falsy 被当不存在） */
(function () {
  var r = buildWith(function (s) { s._map.set(IM.REGISTRY_KEY, ''); });
  ok(!!r.threw && r.threw.message.indexOf('registry_corrupt') >= 0 && !r.bundle, 'B-R7-03 空字符串 → registry_corrupt');
})();
/* B-R7-04 JSON 解析失败 → registry_corrupt */
(function () {
  var r = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, '{broken'); });
  ok(!!r.threw && r.threw.message.indexOf('registry_corrupt') >= 0, 'B-R7-04 JSON 损坏 → registry_corrupt');
})();
/* B-R7-05 JSON null → registry_corrupt（修复前被当无注册表） */
(function () {
  var r = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, 'null'); });
  ok(!!r.threw && r.threw.message.indexOf('registry_corrupt') >= 0, 'B-R7-05 JSON null → registry_corrupt');
})();
/* B-R7-06 JSON 数组 → registry_corrupt */
(function () {
  var r = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, '[]'); });
  ok(!!r.threw && r.threw.message.indexOf('registry_corrupt') >= 0, 'B-R7-06 JSON 数组 → registry_corrupt');
})();
/* B-R7-07 空对象（缺必要字段） → registry_corrupt */
(function () {
  var r = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, '{}'); });
  ok(!!r.threw && r.threw.message.indexOf('registry_corrupt') >= 0, 'B-R7-07 空对象 → registry_corrupt');
})();
/* B-R7-08 缺字段/索引结构非法 → registry_corrupt */
(function () {
  var r1 = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, JSON.stringify({ byKey: {} })); });
  var r2 = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, JSON.stringify({ byKey: { k: { nope: 1 } }, conflicts: [], reviewEvents: [], canonVersion: 'canon-v3', keyVersion: 'esc-v2' })); });
  ok(!!r1.threw && r1.threw.message.indexOf('registry_corrupt') >= 0 && !!r2.threw && r2.threw.message.indexOf('registry_corrupt') >= 0, 'B-R7-08 缺字段与非法索引结构 → registry_corrupt');
})();
/* B-R7-09 完整合法注册表 → 正常导出且内容一致（正对照） */
(function () {
  var reg = ID.createRegistry();
  ID.importRecord(reg, { identity: { source_system: 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: 'BK-1' }, content: oppContent(7), sourceVersion: 1 }, { now: '2026-11-06T00:00:00.000Z' });
  var exported = ID.exportState(reg);
  var r = buildWith(function (s) { s.setItem(IM.REGISTRY_KEY, exported); });
  ok(!r.threw && JSON.stringify(r.bundle.identityRegistry) === exported && r.bundle.checksums.registry !== null, 'B-R7-09 合法注册表正常导出、原文一致');
})();

/* ================= F 组：backfillLegacy 完整审计 ================= */
/* F01 异常记录逐项分类：null/missing/undefined/空串/非对象各报
   一次且可区分；数字与字符串不合并；正常 ID 正常回填 */
(function () {
  var reg = ID.createRegistry();
  var state = {
    products: [
      { id: 'p1', title: 'ok' },           /* 0 正常 */
      { id: 123, title: 'num' },           /* 1 数字 → nonStringIds */
      { id: null, title: 'nullid' },       /* 2 null */
      { title: 'missing' },                /* 3 缺失 */
      { id: '', title: 'empty' },          /* 4 空串 */
      { id: undefined, title: 'undef' },   /* 5 undefined */
      'not-an-object',                     /* 6 非对象 */
      null,                                /* 7 非对象（null 记录） */
      { id: 'p1', title: 'dup' }           /* 8 重复 */
    ],
    opportunities: [
      { id: '123', buyer: { name: 'S' }, rawText: 'x', followLog: [], log: [], quote: {} },  /* 字符串 '123' 正常绑定，与数字 123 不合并 */
      { id: 123, buyer: { name: 'N' }, rawText: 'x', followLog: [], log: [], quote: {} }     /* 数字 → nonStringIds */
    ],
    orders: [
      { id: 'o1' },
      { amount: 5 }                        /* 缺失 → invalidRecords */
    ],
    settings: {}
  };
  var rep = IM.backfillLegacy(state, reg);
  var inv = rep.invalidRecords;
  function findInv(t, st) { return inv.filter(function (x) { return x.entity_type === t && x.idState === st; }); }
  ok(findInv('product', 'null').length === 1 && findInv('product', 'null')[0].index === 2, 'F01a null ID 被报告（index 定位）');
  ok(findInv('product', 'missing').length === 1 && findInv('product', 'missing')[0].index === 3, 'F01b 缺失 ID 被报告且与 null 区分');
  ok(findInv('product', 'empty_string').length === 1 && findInv('product', 'empty_string')[0].index === 4, 'F01c 空字符串 ID 被报告');
  ok(findInv('product', 'undefined').length === 1 && findInv('product', 'undefined')[0].index === 5, 'F01d undefined ID 被报告');
  ok(findInv('product', 'non_object').length === 2 && findInv('order', 'missing').length === 1, 'F01e 非对象记录（字符串/null）与订单缺失 ID 被报告');
  ok(inv.length === 7, 'F01f 异常记录总数恰为 7（每条只报一次）', 'got ' + inv.length);
  ok(rep.nonStringIds.length === 2 && rep.duplicateIds.length === 1 && rep.duplicateIds[0].id === 'p1', 'F01g 数字 ID 两条进 nonStringIds、重复 p1 一条');
  ok(rep.bound === 3 && Object.keys(reg.byKey).length === 3, 'F01h 正常字符串 ID 正常回填（p1/opp 123/o1 共 3）', 'bound=' + rep.bound);
})();

/* ================= K 组：checkIntegrity 关联边界 ================= */
/* K01 关联字段六态：缺失/null 忽略；数字进类型异常；空串与不存
   在的字符串进孤儿；数字 0 与字符串 '0' 不合并 */
(function () {
  var state = {
    products: [{ id: '0' }, { id: 'p1' }],
    opportunities: [
      { id: 'a', selectedProductId: 0, followLog: [], log: [], matches: [] },
      { id: 'b', selectedProductId: '0', followLog: [], log: [], matches: [] },
      { id: 'c', selectedProductId: '', followLog: [], log: [], matches: [] },
      { id: 'd', followLog: [], log: [], matches: [] },
      { id: 'e', selectedProductId: null, followLog: [], log: [], matches: [] },
      { id: 'f', selectedProductId: 'ghost', followLog: [], log: [], matches: [] },
      { id: 'g', followLog: [], log: [], matches: [{ productId: 0 }, { productId: 'p1' }, { productId: '' }] }
    ],
    orders: [
      { id: 'od1', oppId: 0 },
      { id: 'od2', oppId: 'a' },
      { id: 'od3', oppId: '' },
      { id: 'od4' }
    ],
    settings: {}
  };
  var r = IM.checkIntegrity(state);
  ok(r.orphanSelectedProduct === 2, 'K01a 空串与不存在字符串计入孤儿（selectedProductId）', 'got ' + r.orphanSelectedProduct);
  ok(r.orphanMatchProduct === 1 && r.orphanOrderOpp === 1, 'K01b matches 空串与订单空串 oppId 计入孤儿');
  ok(r.typeAnomalies.length === 3 && r.typeAnomalies.filter(function (x) { return x.value === 0; }).length === 3, 'K01c 三处数字 0 关联全部进类型异常（未与字符串 0 合并、未跳过）', JSON.stringify(r.typeAnomalies));
  var fields = r.typeAnomalies.map(function (x) { return x.field; }).sort().join(',');
  ok(fields === 'matches.productId,oppId,selectedProductId', 'K01d 类型异常字段标注完整');
  ok(r.duplicateIds.length === 0 && r.nonStringIds.length === 0, 'K01e 无误报重复/实体非字符串（关联异常不污染实体报告）');
})();

console.log('== identity-r7: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
