/* P1-23-R7-R8-R4-R1-R3-R1-R2：bindAdditionalIdentity 精确恢复与复核补全专项。
   强化快照 fullSnap：additionalIdentities 是否存在、原始描述符四字段
   （value/writable/enumerable/configurable）、数组引用、长度、逐元素
   描述符、byKey/byInternal 自有键集、confirmedValue 引用、
   confirmationHistory 内容。失败案例一律比较完整快照，不只看返回值。
   故障注入说明：冻结/不可扩展/键占用为普通对象语义；Proxy 在 X01–X03
   仅作 byKey 写入点抛错载体（验证回滚路径）；X12–X14 的 Proxy 用于
   边界证明——X12 证明结构检查不识别 Proxy 且 trap 会被执行（契约外
   输入的实证），X13/X14 用「谎报描述符」的 Proxy 验证写后完整复核。
   本文件任何断言都不声称 Proxy 在保证范围内（见报告输入契约）。
   全部虚构数据；Node/vm 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function idn(raw, sys) { return { source_system: sys || 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
var NEWIDN = idn('NEW-1', 'crm');
var NEWKEY = ID.identityKeyOf(NEWIDN);
var CONF = { v: 'A' };
function ent(internalId, identity, adds, omitAdds) {
  var e = { internalId: internalId, identity: identity,
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: CONF, confirmationHistory: [{ note: 'keep' }], archived: false };
  if (!omitAdds) e.additionalIdentities = adds;
  return e;
}
function descStr(d) {
  if (!d) return 'ABSENT';
  if (!('value' in d)) return 'ACCESSOR';
  var v = d.value;
  var tag = v === undefined ? 'undefined' : Array.isArray(v) ? 'array#' + v.length : (v && v.external_id_raw ? 'idn:' + v.external_id_raw : typeof v);
  return 'data:' + tag + '|w=' + d.writable + '|e=' + d.enumerable + '|c=' + d.configurable;
}
function fullSnap(reg, e) {
  var d = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
  var elems = '';
  if (d && 'value' in d && Array.isArray(d.value)) {
    var parts = [];
    for (var i = 0; i < d.value.length; i++) parts.push(descStr(Object.getOwnPropertyDescriptor(d.value, String(i))));
    elems = parts.join(';');
  }
  return {
    field: descStr(d),
    addsRef: d && 'value' in d ? d.value : null,
    elems: elems,
    byKeyKeys: Object.keys(reg.byKey).sort().join(','),
    byInternalKeys: Object.keys(reg.byInternal).sort().join(','),
    confRef: e.confirmedValue,
    hist: JSON.stringify(e.confirmationHistory)
  };
}
function sameFull(a, b) {
  return a.field === b.field && a.addsRef === b.addsRef && a.elems === b.elems && a.byKeyKeys === b.byKeyKeys &&
    a.byInternalKeys === b.byInternalKeys && a.confRef === b.confRef && a.hist === b.hist;
}
function baseReg(e, identity) {
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal[e.internalId] = e;
  return reg;
}
function throwingByKey(reg, e, identity) {
  var target = {};
  target[ID.identityKeyOf(identity)] = e;
  reg.byKey = new Proxy(target, {
    set: function () { throw new Error('injected_write_failure'); },
    defineProperty: function () { throw new Error('injected_write_failure'); }
  });
  return target;
}
var identity = idn('X0');

/* X01 字段不存在 + byKey 写入失败 → 恢复后字段仍不存在、完整快照一致 */
(function () {
  var e = ent('int_x01', identity, null, true);
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x01', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && !Object.prototype.hasOwnProperty.call(e, 'additionalIdentities') && sameFull(before, fullSnap(reg, e)), 'X01 字段不存在+写入失败 → INVALID、字段仍不存在、完整快照一致');
})();
/* X02 字段存在值为 undefined（标准描述符）+ byKey 写入失败 → 描述符逐字段恢复一致 */
(function () {
  var e = ent('int_x02', identity, undefined);
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x02', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var after = fullSnap(reg, e);
  ok(!err && r && r.status === 'INVALID' && Object.prototype.hasOwnProperty.call(e, 'additionalIdentities') && sameFull(before, after), 'X02 字段=undefined+写入失败 → INVALID、自有属性保留、描述符与原始逐字段一致');
})();
/* X02b 字段=undefined 且原描述符 writable:false/configurable:true → 恢复后 writable 仍为 false */
(function () {
  var e = ent('int_x02b', identity, null, true);
  Object.defineProperty(e, 'additionalIdentities', { value: undefined, writable: false, enumerable: true, configurable: true });
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x02b', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var d = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
  ok(!err && r && r.status === 'INVALID' && d && d.value === undefined && d.writable === false && d.enumerable === true && d.configurable === true && sameFull(before, fullSnap(reg, e)), 'X02b 非标准原始描述符（writable:false）→ 精确恢复、不得以删除代替');
})();
/* X03 字段为合法数组 + byKey 写入失败 → 引用/内容/长度/逐元素描述符一致 */
(function () {
  var e = ent('int_x03', identity, [idn('X-OLD'), idn('X-OLD2', 'erp')]);
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x03', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && sameFull(before, fullSnap(reg, e)), 'X03 合法数组+写入失败 → INVALID、数组引用/长度/逐元素描述符完全恢复');
})();
/* X04 正常初始化绑定 → BOUND、字段描述符正确（data/数组/w/e/c 全 true） */
(function () {
  var e = ent('int_x04', identity, null, true);
  var reg = baseReg(e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_x04', NEWIDN, 'op');
  var d = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
  ok(r.status === 'BOUND' && d && 'value' in d && Array.isArray(d.value) && d.value.length === 1 && d.writable === true && d.enumerable === true && d.configurable === true && reg.byKey[NEWKEY] === e, 'X04 正常初始化 → BOUND、字段描述符 data/w/e/c 正确、byKey 指向实体');
})();
/* X05 正常追加绑定 → BOUND、数组引用不变、新元素描述符正确 */
(function () {
  var adds = [idn('X-OLD')];
  var e = ent('int_x05', identity, adds);
  var reg = baseReg(e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_x05', NEWIDN, 'op');
  var d = Object.getOwnPropertyDescriptor(adds, '1');
  var dk = Object.getOwnPropertyDescriptor(reg.byKey, NEWKEY);
  ok(r.status === 'BOUND' && e.additionalIdentities === adds && adds.length === 2 && d && 'value' in d && d.value.external_id_raw === 'NEW-1' && d.writable === true && d.enumerable === true && d.configurable === true && dk && dk.value === e && dk.writable === true && dk.configurable === true, 'X05 正常追加 → BOUND、原数组引用不变、新元素与 byKey 键描述符正确');
})();
/* X06 冻结 byKey → 无实体残留（缺失与既存两种情形） */
(function () {
  var e1 = ent('int_x06a', identity, null, true);
  var reg1 = baseReg(e1, identity);
  Object.freeze(reg1.byKey);
  var b1 = fullSnap(reg1, e1);
  var r1 = null, err1 = null;
  try { r1 = ID.bindAdditionalIdentity(reg1, 'int_x06a', NEWIDN, 'op'); } catch (ex) { err1 = ex; }
  var e2 = ent('int_x06b', identity, [idn('X-OLD')]);
  var reg2 = baseReg(e2, identity);
  Object.freeze(reg2.byKey);
  var b2 = fullSnap(reg2, e2);
  var r2 = null, err2 = null;
  try { r2 = ID.bindAdditionalIdentity(reg2, 'int_x06b', NEWIDN, 'op'); } catch (ex) { err2 = ex; }
  ok(!err1 && !err2 && r1.status === 'INVALID' && r2.status === 'INVALID' && sameFull(b1, fullSnap(reg1, e1)) && sameFull(b2, fullSnap(reg2, e2)), 'X06 冻结 byKey → 两种情形均 INVALID、零残留');
})();
/* X07 不可扩展 byKey → 无实体残留 */
(function () {
  var e = ent('int_x07', identity, null, true);
  var reg = baseReg(e, identity);
  Object.preventExtensions(reg.byKey);
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x07', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && sameFull(before, fullSnap(reg, e)), 'X07 不可扩展 byKey → INVALID、零残留');
})();
/* X08 目标键被占用 → 无实体残留 */
(function () {
  var e = ent('int_x08', identity, null, true);
  var reg = baseReg(e, identity);
  Object.defineProperty(reg.byKey, NEWKEY, { value: null, writable: false, enumerable: true, configurable: false });
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x08', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && sameFull(before, fullSnap(reg, e)), 'X08 目标键占用 → INVALID、零残留');
})();
/* X09 byKey 原型 setter → 零执行、BOUND */
(function () {
  var e = ent('int_x09', identity, null, true);
  var reg = baseReg(e, identity);
  var proto = {};
  var box = { count: 0 };
  Object.defineProperty(proto, NEWKEY, { configurable: true, set: function (v) { box.count++; } });
  var plainByKey = {};
  Object.setPrototypeOf(plainByKey, proto);
  plainByKey[ID.identityKeyOf(identity)] = e;
  reg.byKey = plainByKey;
  var r = ID.bindAdditionalIdentity(reg, 'int_x09', NEWIDN, 'op');
  ok(box.count === 0 && r.status === 'BOUND' && reg.byKey[NEWKEY] === e, 'X09 byKey 原型 setter 零执行、BOUND');
})();
/* X10 重复绑定 → UNCHANGED */
(function () {
  var e = ent('int_x10', identity, [NEWIDN]);
  var reg = baseReg(e, identity);
  reg.byKey[NEWKEY] = e;
  var before = fullSnap(reg, e);
  var r = ID.bindAdditionalIdentity(reg, 'int_x10', NEWIDN, 'op');
  ok(r.status === 'UNCHANGED' && sameFull(before, fullSnap(reg, e)), 'X10 重复绑定 → UNCHANGED、快照不变');
})();
/* X11 双索引分裂 → CONFLICT(index_split_conflict) */
(function () {
  var A = ent('int_x11', identity, []);
  var B = ent('int_x11', NEWIDN, []);
  var reg = ID.createRegistry();
  reg.byInternal['int_x11'] = A; reg.byKey[NEWKEY] = B;
  var r = ID.bindAdditionalIdentity(reg, 'int_x11', NEWIDN, 'op');
  ok(r.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_split_conflict', 'X11 分裂 → CONFLICT(index_split_conflict)');
})();
/* X12 Proxy 数组边界证明：结构检查不识别 Proxy、trap 会被执行（契约外输入实证） */
(function () {
  var realAdds = [idn('X-OLD')];
  var trapCount = { n: 0 };
  var proxyAdds = new Proxy(realAdds, {
    getOwnPropertyDescriptor: function (t, p) { trapCount.n++; return Reflect.getOwnPropertyDescriptor(t, p); },
    getPrototypeOf: function (t) { trapCount.n++; return Reflect.getPrototypeOf(t); }
  });
  var isArr = Array.isArray(proxyAdds);
  var e = ent('int_x12', identity, proxyAdds);
  var reg = baseReg(e, identity);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x12', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(isArr === true && trapCount.n > 0, 'X12 Proxy 数组：Array.isArray 为 true（不识别 Proxy）、结构检查期间 trap 被执行 ' + trapCount.n + ' 次——Proxy 属契约外输入，本模块不作零执行/原子性承诺（结果状态不作为保证依据）');
})();
/* X13 谎报描述符的 byKey（defineProperty 落成 writable:false）→ 完整复核拦截、回滚、INVALID */
(function () {
  var e = ent('int_x13', identity, [idn('X-OLD')]);
  var reg = baseReg(e, identity);
  var target = {};
  target[ID.identityKeyOf(identity)] = e;
  reg.byKey = new Proxy(target, {
    defineProperty: function (t, p, desc) {
      var d2 = { value: desc.value, writable: false, enumerable: desc.enumerable, configurable: true };
      return Reflect.defineProperty(t, p, d2);
    }
  });
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x13', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && r.reason === 'registry_write_failed' && sameFull(before, fullSnap(reg, e)) && !Object.prototype.hasOwnProperty.call(target, NEWKEY), 'X13 byKey 写后描述符不符（writable 被谎报）→ 复核拦截、双侧回滚、INVALID');
})();
/* X14 谎报描述符的数组追加（元素落成 writable:false）→ 完整复核拦截、回滚、INVALID */
(function () {
  var realAdds = [idn('X-OLD')];
  var proxyAdds = new Proxy(realAdds, {
    defineProperty: function (t, p, desc) {
      if (p === '1') { var d2 = { value: desc.value, writable: false, enumerable: true, configurable: true }; return Reflect.defineProperty(t, p, d2); }
      return Reflect.defineProperty(t, p, desc);
    }
  });
  var e = ent('int_x14', identity, proxyAdds);
  var reg = baseReg(e, identity);
  var before = fullSnap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_x14', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && realAdds.length === 1 && !Object.prototype.hasOwnProperty.call(reg.byKey, NEWKEY), 'X14 追加元素描述符不符（writable 被谎报）→ 复核拦截、length 回滚、INVALID、无新映射');
})();

console.log('== identity-r8-r4-r1-r3-r1-r2: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
