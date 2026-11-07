/* P1-23-R7-R8-R4-R1：原型边界与无 getter 结构防守专项。
   A 组（故障注入）：isPlainJsonValue 原型指纹判定；
   B/C 组（故障注入）：registerExisting 的 getter 防护与检查顺序；
   D 组（正常业务）：既有分支语义回归。
   全部断言含 getter 计数、索引引用（严格 ===）与实体快照检查。
   全部虚构数据；本文件为 Node/vm 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var vm = require('vm');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function idn(raw, acct) { return { source_system: 'alibaba_api', source_account: acct || 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
function ent(internalId, identity, adds, confirmed) {
  return { internalId: internalId, identity: identity, additionalIdentities: adds || [],
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: confirmed || null, archived: false };
}
function withGetter(obj, field, value) {
  var box = { count: 0 };
  Object.defineProperty(obj, field, { enumerable: true, configurable: true, get: function () { box.count++; return value; } });
  return box;
}

/* ================= A 组：原型边界 ================= */
(function () {
  var P = ID._isPlainJsonValue;
  ok(P(vm.runInNewContext('({ a: [1, { b: 2 }] })')) === true, 'A01 跨 realm 普通对象 → 通过');
  ok(P(vm.runInNewContext('({ d: new Date(0) })')) === false, 'A02 跨 realm Date → 拒绝');
  var oNullProto = Object.create(Object.create(null)); oNullProto.a = 1;
  ok(P(oNullProto) === false, 'A03 以 Object.create(null) 为原型的对象 → 拒绝（旧深度判据会误收）');
  var custom = { marker: 1 };
  var oCustom = Object.create(custom); oCustom.a = 1;
  ok(P(oCustom) === false, 'A04 以普通对象为自定义原型的对象 → 拒绝');
  var oMulti = Object.create(Object.create(Object.create(null))); oMulti.a = 1;
  ok(P(oMulti) === false, 'A05 多层自定义原型链 → 拒绝');
  var oNull = Object.create(null); oNull.a = 1;
  ok(P(oNull) === true, 'A06 Object.create(null) 对象本身 → 通过');
  var arrCustom = [1, 2]; Object.setPrototypeOf(arrCustom, { fake: true });
  ok(P(arrCustom) === false, 'A07 setPrototypeOf 换自定义原型的数组 → 拒绝');
  ok(P([1, 'x', [true]]) === true, 'A08 正常数组 → 通过');
  ok(P(vm.runInNewContext('[1, 2, { z: 3 }]')) === true, 'A09 跨 realm 数组 → 通过（Array.prototype 指纹链验证）');
  function Foo() { this.x = 1; }
  ok(P(new Foo()) === false && P({ d: new Date(0) }) === false, 'A10 类实例/Date → 拒绝');
  /* A11 已知限制（如实锁定）：蓄意伪造的原型（null 原型 + constructor
     循环指认）可通过指纹判定——需要主动构造，JSON 与普通业务代码
     均无法产生；本断言记录当前边界，未来收紧时此处会先变红。 */
  var forged = Object.create(null);
  function FakeCtor() {}
  Object.defineProperty(FakeCtor, 'prototype', { value: forged });
  forged.constructor = FakeCtor;
  var oForged = Object.create(forged); oForged.a = 1;
  ok(P(oForged) === true, 'A11 已知限制：蓄意伪造原型通过指纹判定（记录边界，非期望语义）');
})();

/* ================= B/C 组：getter 防护与顺序 ================= */
function baseReg() { return ID.createRegistry(); }
/* B01 byKeyHit.internalId 是 getter（兼 C 组顺序证明：结构检查前绝不读它） */
(function () {
  var identity = idn('B1'), key = ID.identityKeyOf(identity);
  var e = ent('int_b1', identity);
  var box = withGetter(e, 'internalId', 'int_b1');
  var reg = baseReg(); reg.byKey[key] = e;
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, 'int_b1', {}); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_entity_invalid', 'B01 internalId getter → index_entity_invalid 冲突');
  ok(box.count === 0, 'B01b getter 调用次数为 0（结构检查先于任何字段读取）');
  ok(reg.byKey[key] === e && !reg.byInternal['int_b1'], 'B01c 索引引用不变、未补 byInternal');
})();
/* B02 byIntHit.identity 是 getter */
(function () {
  var identity = idn('B2');
  var e = ent('int_b2', identity);
  var box = withGetter(e, 'identity', identity);
  var reg = baseReg(); reg.byInternal['int_b2'] = e;
  var res = ID.registerExisting(reg, identity, 'int_b2', {});
  ok(res.status === 'CONFLICT' && box.count === 0 && Object.keys(reg.byKey).length === 0 && reg.byInternal['int_b2'] === e, 'B02 identity getter → 冲突、getter 零调用、未补 byKey');
})();
/* B03 byIntHit.additionalIdentities 是 getter */
(function () {
  var identity = idn('B3');
  var e = ent('int_b3', identity);
  var box = withGetter(e, 'additionalIdentities', []);
  var reg = baseReg(); reg.byInternal['int_b3'] = e;
  var res = ID.registerExisting(reg, identity, 'int_b3', {});
  ok(res.status === 'CONFLICT' && box.count === 0 && Object.keys(reg.byKey).length === 0, 'B03 additionalIdentities getter → 冲突、getter 零调用');
})();
/* B04 附加身份数组元素是 getter */
(function () {
  var identity = idn('B4'), add = idn('B4-A');
  var e = ent('int_b4', identity, [add]);
  var box = { count: 0 };
  Object.defineProperty(e.additionalIdentities, '0', { enumerable: true, configurable: true, get: function () { box.count++; return add; } });
  var reg = baseReg(); reg.byInternal['int_b4'] = e;
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, 'int_b4', {}); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'CONFLICT' && box.count === 0 && Object.keys(reg.byKey).length === 0, 'B04 附加身份元素 getter → 冲突、getter 零调用、无异常逃逸');
})();
/* B05 附加身份对象的四元组字段是 getter */
(function () {
  var identity = idn('B5'), add = idn('B5-A');
  var badAdd = { source_system: 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity' };
  var box = withGetter(badAdd, 'external_id_raw', 'B5-A');
  var e = ent('int_b5', identity, [badAdd]);
  var reg = baseReg(); reg.byInternal['int_b5'] = e;
  var res = ID.registerExisting(reg, identity, 'int_b5', {});
  ok(res.status === 'CONFLICT' && box.count === 0, 'B05 附加身份字段 getter → 冲突、getter 零调用');
})();
/* B06 两边都含 getter：byKey 侧 internalId + byInternal 侧 identity，双方都不得被读 */
(function () {
  var identity = idn('B6'), key = ID.identityKeyOf(identity);
  var eA = ent('int_b6', identity);
  var boxA = withGetter(eA, 'internalId', 'int_b6');
  var eB = ent('int_b6', identity);
  var boxB = withGetter(eB, 'identity', identity);
  var reg = baseReg(); reg.byKey[key] = eA; reg.byInternal['int_b6'] = eB;
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, 'int_b6', {}); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'CONFLICT' && boxA.count === 0 && boxB.count === 0, 'B06 双边 getter → 冲突、双方 getter 均零调用（顺序证明）');
  ok(reg.byKey[key] === eA && reg.byInternal['int_b6'] === eB, 'B06b 双边索引引用不变');
})();
/* B07 结构无效拒绝后实体内容与确认值快照不变（非 getter 的损坏形态） */
(function () {
  var identity = idn('B7'), key = ID.identityKeyOf(identity);
  var conf = { qty: 9, basedOnHash: 'h9' };
  var e = ent('int_b7', identity, [], conf); e.additionalIdentities = 'broken';
  var reg = baseReg(); reg.byKey[key] = e;
  var snap = JSON.stringify(e.content) + '|' + JSON.stringify(e.confirmedValue);
  var res = ID.registerExisting(reg, identity, 'int_b7', {});
  ok(res.status === 'CONFLICT' && JSON.stringify(e.content) + '|' + JSON.stringify(e.confirmedValue) === snap && e.confirmedValue === conf && reg.byKey[key] === e && !reg.byInternal['int_b7'], 'B07 拒绝后实体内容/确认值逐项不变、索引不变');
})();

/* ================= D 组：正常回归 ================= */
(function () {
  var identity = idn('D1'), a1 = idn('D1-A');
  var e = ent('int_d1', identity, [a1]);
  var reg = baseReg(); reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal['int_d1'] = e;
  var r = ID.registerExisting(reg, identity, 'int_d1', {});
  ok(r.status === 'UNCHANGED' && !r.repaired, 'D01 双索引同一对象 → UNCHANGED');
  var objB = ent('int_d2', identity, [a1], { qty: 1, basedOnHash: 'h' });
  var objA = JSON.parse(JSON.stringify(objB));
  var reg2 = baseReg(); reg2.byKey[ID.identityKeyOf(identity)] = objA; reg2.byInternal['int_d2'] = objB;
  var r2 = ID.registerExisting(reg2, identity, 'int_d2', {});
  ok(r2.repaired === 'index_unified' && reg2.byKey[ID.identityKeyOf(identity)] === objB && reg2.byKey[ID.identityKeyOf(a1)] === objB && reg2.byInternal['int_d2'] === objB, 'D02 分裂内容相同 → 全键统一、严格引用相等');
  var objC = ent('int_d3', identity, [], { qty: 1, basedOnHash: 'x' });
  var objD = ent('int_d3', identity, [], { qty: 2, basedOnHash: 'y' });
  var reg3 = baseReg(); reg3.byKey[ID.identityKeyOf(identity)] = objC; reg3.byInternal['int_d3'] = objD;
  var r3 = ID.registerExisting(reg3, identity, 'int_d3', {});
  ok(r3.status === 'CONFLICT' && reg3.conflicts[0].kind === 'index_split_conflict' && reg3.byKey[ID.identityKeyOf(identity)] === objC && reg3.byInternal['int_d3'] === objD, 'D03 分裂内容冲突 → index_split_conflict、双方不变');
  var e4 = ent('int_d4', identity);
  var reg4 = baseReg(); reg4.byKey[ID.identityKeyOf(identity)] = e4;
  var r4 = ID.registerExisting(reg4, identity, 'int_d4', {});
  ok(r4.repaired === 'byInternal' && reg4.byInternal['int_d4'] === e4, 'D04 byKey 单边 → 补 byInternal');
  var e5 = ent('int_d5', identity);
  var reg5 = baseReg(); reg5.byInternal['int_d5'] = e5;
  var r5 = ID.registerExisting(reg5, identity, 'int_d5', {});
  ok(r5.repaired === 'byKey' && reg5.byKey[ID.identityKeyOf(identity)] === e5, 'D05 byInternal 单边 → 补 byKey');
  var r6 = ID.registerExisting(reg, a1, 'int_d1', {});
  ok(r6.status === 'UNCHANGED' && reg.conflicts.length === 0, 'D06 经附加身份登记 → UNCHANGED 不误报');
  var other = ent('int_other', identity);
  var reg7 = baseReg(); reg7.byKey[ID.identityKeyOf(identity)] = other;
  var r7 = ID.registerExisting(reg7, identity, 'int_d7', {});
  ok(r7.status === 'CONFLICT' && reg7.conflicts[0].kind === 'duplicate_internal', 'D07 身份键绑他人实体 → duplicate_internal（顺序调整后冲突类型保持）');
  var r8 = ID.registerExisting(baseReg(), idn('D8'), 'int_d8', { buyerName: 'X' });
  ok(r8.status === 'BOUND', 'D08 双边皆无 → BOUND 新建语义不变');
})();

console.log('== identity-r8-r4-r1: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
