/* P1-23-R7-R8-R4-R1-R3-R1-R1：bindAdditionalIdentity 写入原子性专项。
   每个失败案例都做失败前后状态快照对比（byKey 键集、byInternal 键集、
   实体自有字段、数组引用/内容/长度、确认值、历史），不只看返回值。
   故障注入对象语义说明：
   - 冻结/不可扩展/不可配置键：普通对象语义（本模块 createRegistry 与
     importState 产出的注册表即普通无原型对象，属于保证范围）；
   - byKey 原型 setter：普通对象原型链语义；
   - Proxy byKey：仅用作「写入点抛错」的故障注入载体，用来执行并验证
     回滚代码路径——不代表对 Proxy 注册表的原子性保证（Proxy 的 trap
     可以在抛错前任意修改状态，当前架构明确不承诺，见报告边界说明）。
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
function snap(reg, e) {
  var d = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
  return {
    byKeyKeys: Object.keys(reg.byKey).sort().join(','),
    byInternalKeys: Object.keys(reg.byInternal).sort().join(','),
    hasOwnAdds: !!d, addsIsAccessor: d ? !('value' in d) : false,
    addsRef: d && 'value' in d ? d.value : null,
    addsLen: d && 'value' in d && Array.isArray(d.value) ? d.value.length : -1,
    addsRaws: d && 'value' in d && Array.isArray(d.value) ? d.value.map(function (x) { return x && x.external_id_raw; }).join(',') : '',
    confRef: e.confirmedValue, histLen: e.confirmationHistory.length
  };
}
function sameSnap(a, b) {
  return a.byKeyKeys === b.byKeyKeys && a.byInternalKeys === b.byInternalKeys && a.hasOwnAdds === b.hasOwnAdds &&
    a.addsRef === b.addsRef && a.addsLen === b.addsLen && a.addsRaws === b.addsRaws && a.confRef === b.confRef && a.histLen === b.histLen;
}
function baseReg(e, identity) {
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal[e.internalId] = e;
  return reg;
}
var identity = idn('W0');

/* W01 byKey 冻结 + 实体无附加字段 → INVALID、实体仍无该自有字段、无新映射 */
(function () {
  var e = ent('int_w01', identity, null, true);
  var reg = baseReg(e, identity);
  Object.freeze(reg.byKey);
  var before = snap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w01', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && !Object.prototype.hasOwnProperty.call(e, 'additionalIdentities') && sameSnap(before, snap(reg, e)), 'W01 byKey 冻结 → INVALID、实体无遗留字段、快照逐项不变');
})();
/* W02 byKey 不可扩展 + 已有数组 → INVALID、无新映射、数组不变 */
(function () {
  var e = ent('int_w02', identity, [idn('W-OLD')]);
  var reg = baseReg(e, identity);
  Object.preventExtensions(reg.byKey);
  var before = snap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w02', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && sameSnap(before, snap(reg, e)) && !Object.prototype.hasOwnProperty.call(reg.byKey, NEWKEY), 'W02 byKey 不可扩展 → INVALID、无新映射、数组引用/内容/长度不变');
})();
/* W03 目标键为不可配置不可写数据属性（值 null，命中分支不触发）→ 不得 BOUND、零修改 */
(function () {
  var e = ent('int_w03', identity, null, true);
  var reg = baseReg(e, identity);
  Object.defineProperty(reg.byKey, NEWKEY, { value: null, writable: false, enumerable: true, configurable: false });
  var before = snap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w03', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var d = Object.getOwnPropertyDescriptor(reg.byKey, NEWKEY);
  ok(!err && r && r.status === 'INVALID' && d.value === null && sameSnap(before, snap(reg, e)), 'W03 目标键不可写不可配置 → INVALID（非 BOUND）、实体与索引零修改');
})();
/* W03b 目标键为不可配置访问器（get 返回 null）→ INVALID、零修改 */
(function () {
  var e = ent('int_w03b', identity, [idn('W-OLD')]);
  var reg = baseReg(e, identity);
  Object.defineProperty(reg.byKey, NEWKEY, { enumerable: true, configurable: false, get: function () { return null; } });
  var before = snap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w03b', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && sameSnap(before, snap(reg, e)), 'W03b 目标键为不可配置访问器 → INVALID、数组与实体零修改');
})();
/* W04 byKey 原型同名 setter → 零调用、BOUND、自有数据属性落位（普通对象原型链语义） */
(function () {
  var e = ent('int_w04', identity, null, true);
  var reg = baseReg(e, identity);
  var proto = {};
  var box = { count: 0 };
  Object.defineProperty(proto, NEWKEY, { configurable: true, set: function (v) { box.count++; } });
  var plainByKey = {};
  Object.setPrototypeOf(plainByKey, proto);
  plainByKey[ID.identityKeyOf(identity)] = e;
  reg.byKey = plainByKey;
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w04', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var d = Object.getOwnPropertyDescriptor(reg.byKey, NEWKEY);
  ok(!err && box.count === 0 && r && r.status === 'BOUND' && d && 'value' in d && d.value === e && reg.byKey[NEWKEY] === e, 'W04 byKey 原型 setter 零调用、BOUND、byKey[key] === e（自有数据属性）');
})();
/* W05 byKey 写入点抛错（Proxy 故障注入）+ 已有数组 → INVALID、追加被回滚、快照逐项不变 */
(function () {
  var e = ent('int_w05', identity, [idn('W-OLD')]);
  var reg = baseReg(e, identity);
  var target = {};
  target[ID.identityKeyOf(identity)] = e;
  reg.byKey = new Proxy(target, {
    set: function () { throw new Error('injected_write_failure'); },
    defineProperty: function () { throw new Error('injected_write_failure'); }
  });
  var before = snap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w05', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && sameSnap(before, snap(reg, e)) && !Object.prototype.hasOwnProperty.call(target, NEWKEY), 'W05 byKey 写入失败 → INVALID、原数组引用/内容/长度完全恢复、无新映射');
})();
/* W06 byKey 写入点抛错（Proxy 故障注入）+ 字段缺失 → INVALID、初始化被回滚（无遗留空数组） */
(function () {
  var e = ent('int_w06', identity, null, true);
  var reg = baseReg(e, identity);
  var target = {};
  target[ID.identityKeyOf(identity)] = e;
  reg.byKey = new Proxy(target, {
    set: function () { throw new Error('injected_write_failure'); },
    defineProperty: function () { throw new Error('injected_write_failure'); }
  });
  var before = snap(reg, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_w06', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && !Object.prototype.hasOwnProperty.call(e, 'additionalIdentities') && sameSnap(before, snap(reg, e)), 'W06 byKey 写入失败（字段缺失情形）→ INVALID、实体无遗留 additionalIdentities 自有属性');
})();
/* W07 正常绑定：BOUND 且 byKey[key] === e、描述符为自有数据属性 */
(function () {
  var e = ent('int_w07', identity, [idn('W-OLD')]);
  var reg = baseReg(e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_w07', NEWIDN, 'op');
  var d = Object.getOwnPropertyDescriptor(reg.byKey, NEWKEY);
  ok(r.status === 'BOUND' && reg.byKey[NEWKEY] === e && d && 'value' in d && d.enumerable && e.additionalIdentities.length === 2, 'W07 正常绑定 BOUND、byKey[key] === e');
})();
/* W08 重复绑定 → UNCHANGED（原子性改造不得破坏幂等） */
(function () {
  var e = ent('int_w08', identity, [NEWIDN]);
  var reg = baseReg(e, identity);
  reg.byKey[NEWKEY] = e;
  var before = snap(reg, e);
  var r = ID.bindAdditionalIdentity(reg, 'int_w08', NEWIDN, 'op');
  ok(r.status === 'UNCHANGED' && sameSnap(before, snap(reg, e)), 'W08 重复绑定 → UNCHANGED、快照不变');
})();
/* W09 双索引分裂 → CONFLICT(index_split_conflict) 保持 */
(function () {
  var A = ent('int_w09', identity, []);
  var B = ent('int_w09', NEWIDN, []);
  var reg = ID.createRegistry();
  reg.byInternal['int_w09'] = A; reg.byKey[NEWKEY] = B;
  var r = ID.bindAdditionalIdentity(reg, 'int_w09', NEWIDN, 'op');
  ok(r.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_split_conflict' && A.additionalIdentities.length === 0 && reg.byKey[NEWKEY] === B, 'W09 分裂 → CONFLICT(index_split_conflict)、双方不变');
})();

console.log('== identity-r8-r4-r1-r3-r1-r1: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
