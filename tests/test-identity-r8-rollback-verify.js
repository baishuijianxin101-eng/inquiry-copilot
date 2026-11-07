/* P1-23-R8 收尾：bindAdditionalIdentity 回滚可验证性专项。
   审计结论（修复前）：rollbackEntityStep 吞异常且不复核恢复结果——
   回滚失败与成功返回同样的普通 INVALID，调用方无从知道是否存在
   残留副作用。本专项锁定修复后行为：
   - 回滚成功（已验证）→ 普通 INVALID + 原 reason，无 rollbackFailed 标记；
   - 回滚失败（复核不通过）→ INVALID + reason 'rollback_failed' +
     rollbackFailed:true + failedAt（失败步）+ residual（残留描述）。
   R05–R08 用 Proxy 作为「让回滚动作失败」的故障注入载体——只验证
   失败报告通道，不声称对 Proxy 有原子性保证（Proxy 仍属输入契约
   外，见 R1-R2 契约声明）。普通对象上的回滚必成由 R01–R04 锁定
   （含写后复核拦截路径）。全部虚构数据；Node/vm 桩测试。 */
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
var identity = idn('RB0');

/* R01 三态之一「不存在」：byKey 失败 → 已验证回滚、普通 INVALID、无失败标记 */
(function () {
  var e = ent('int_rb01', identity, null, true);
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_rb01', NEWIDN, 'op');
  ok(r.status === 'INVALID' && r.reason === 'registry_write_failed' && r.rollbackFailed === undefined && !Object.prototype.hasOwnProperty.call(e, 'additionalIdentities'), 'R01 不存在态：回滚已验证 → 普通 INVALID(registry_write_failed)、无 rollbackFailed 标记');
})();
/* R02 三态之二「值为 undefined」：byKey 失败 → 描述符精确恢复、无失败标记 */
(function () {
  var e = ent('int_rb02', identity, null, true);
  Object.defineProperty(e, 'additionalIdentities', { value: undefined, writable: false, enumerable: true, configurable: true });
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_rb02', NEWIDN, 'op');
  var d = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
  ok(r.status === 'INVALID' && r.reason === 'registry_write_failed' && r.rollbackFailed === undefined && d && d.value === undefined && d.writable === false && d.configurable === true, 'R02 undefined 态：原描述符（含 writable:false）已验证恢复、无失败标记');
})();
/* R03 三态之三「数组」：byKey 失败 → length 与元素已验证恢复、无失败标记 */
(function () {
  var e = ent('int_rb03', identity, [idn('RB-OLD')]);
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_rb03', NEWIDN, 'op');
  ok(r.status === 'INVALID' && r.reason === 'registry_write_failed' && r.rollbackFailed === undefined && e.additionalIdentities.length === 1 && e.additionalIdentities[0].external_id_raw === 'RB-OLD', 'R03 数组态：回滚已验证 → 普通 INVALID、无失败标记');
})();
/* R04 写后复核拦截路径（byKey 谎报描述符）→ 回滚已验证、普通 INVALID */
(function () {
  var e = ent('int_rb04', identity, [idn('RB-OLD')]);
  var reg = baseReg(e, identity);
  var target = {};
  target[ID.identityKeyOf(identity)] = e;
  reg.byKey = new Proxy(target, {
    defineProperty: function (t, p, desc) { return Reflect.defineProperty(t, p, { value: desc.value, writable: false, enumerable: true, configurable: true }); }
  });
  var r = ID.bindAdditionalIdentity(reg, 'int_rb04', NEWIDN, 'op');
  ok(r.status === 'INVALID' && r.reason === 'registry_write_failed' && r.rollbackFailed === undefined && e.additionalIdentities.length === 1 && !Object.prototype.hasOwnProperty.call(target, NEWKEY), 'R04 复核拦截路径：双侧回滚已验证 → 普通 INVALID、无失败标记');
})();
/* R05 回滚失败报告（初始化删除被拒）→ rollback_failed + 残留描述准确 */
(function () {
  var target = ent('int_rb05', identity, null, true);
  var eProxy = new Proxy(target, {
    deleteProperty: function () { return false; }
  });
  var reg = ID.createRegistry();
  reg.byInternal['int_rb05'] = eProxy;
  var bkTarget = {};
  bkTarget[ID.identityKeyOf(identity)] = eProxy;
  reg.byKey = new Proxy(bkTarget, {
    set: function () { throw new Error('injected_write_failure'); },
    defineProperty: function () { throw new Error('injected_write_failure'); }
  });
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_rb05', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && r.reason === 'rollback_failed' && r.rollbackFailed === true && r.failedAt === 'registry_write_failed' && r.residual && r.residual.field === 'array' && r.residual.byKeyHasTarget === false && Object.prototype.hasOwnProperty.call(target, 'additionalIdentities'), 'R05 删除回滚被拒 → 明确 rollback_failed 报告、residual 与实际残留一致（字段仍在）');
})();
/* R06 回滚失败报告（数组 length 截断被拒）→ rollback_failed + residual.addsLength 准确 */
(function () {
  var realAdds = [idn('RB-OLD')];
  var proxyAdds = new Proxy(realAdds, {
    defineProperty: function (t, p, desc) {
      if (p === 'length') throw new Error('injected_length_rollback_failure');
      return Reflect.defineProperty(t, p, desc);
    }
  });
  var e = ent('int_rb06', identity, proxyAdds);
  var reg = baseReg(e, identity);
  throwingByKey(reg, e, identity);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_rb06', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && r.reason === 'rollback_failed' && r.rollbackFailed === true && r.residual && r.residual.addsLength === 2 && realAdds.length === 2, 'R06 length 截断被拒 → rollback_failed、residual.addsLength=2 与实际一致');
})();
/* R07 回滚失败报告（undefined 描述符恢复被拒）→ rollback_failed、residual.field=array */
(function () {
  var target = ent('int_rb07', identity, undefined);
  var eProxy = new Proxy(target, {
    defineProperty: function (t, p, desc) {
      if (p === 'additionalIdentities' && 'value' in desc && desc.value === undefined) throw new Error('injected_restore_failure');
      return Reflect.defineProperty(t, p, desc);
    }
  });
  var reg = ID.createRegistry();
  reg.byInternal['int_rb07'] = eProxy;
  var bkTarget = {};
  bkTarget[ID.identityKeyOf(identity)] = eProxy;
  reg.byKey = new Proxy(bkTarget, {
    set: function () { throw new Error('injected_write_failure'); },
    defineProperty: function () { throw new Error('injected_write_failure'); }
  });
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_rb07', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var d = Object.getOwnPropertyDescriptor(target, 'additionalIdentities');
  ok(!err && r && r.status === 'INVALID' && r.reason === 'rollback_failed' && r.rollbackFailed === true && r.residual && r.residual.field === 'array' && d && Array.isArray(d.value), 'R07 描述符恢复被拒 → rollback_failed、residual.field=array 与实际残留（数组仍在）一致');
})();
/* R08 回滚失败报告（byKey 残留键删除被拒）→ rollback_failed、residual.byKeyHasTarget=true、实体侧已恢复 */
(function () {
  var e = ent('int_rb08', identity, [idn('RB-OLD')]);
  var reg = baseReg(e, identity);
  var target = {};
  target[ID.identityKeyOf(identity)] = e;
  reg.byKey = new Proxy(target, {
    defineProperty: function (t, p, desc) { return Reflect.defineProperty(t, p, { value: desc.value, writable: false, enumerable: true, configurable: true }); },
    deleteProperty: function () { return false; }
  });
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_rb08', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && r.reason === 'rollback_failed' && r.rollbackFailed === true && r.residual && r.residual.byKeyHasTarget === true && Object.prototype.hasOwnProperty.call(target, NEWKEY) && e.additionalIdentities.length === 1, 'R08 残留键删除被拒 → rollback_failed、byKeyHasTarget=true、实体侧已恢复（length 1）');
})();
/* R09 正常 BOUND 结果形状不变（无多余字段） */
(function () {
  var e = ent('int_rb09', identity, []);
  var reg = baseReg(e, identity);
  var r = ID.bindAdditionalIdentity(reg, 'int_rb09', NEWIDN, 'op');
  ok(r.status === 'BOUND' && Object.keys(r).sort().join(',') === 'internalId,status', 'R09 BOUND 结果形状与既有契约一致（仅 status/internalId）');
})();
/* R10 P06 原意保留：纯 JSON 双副本内容不一致 → registry_internal_id_conflict（副本判等防线仍在） */
(function () {
  var e1 = ent('int_rb10', identity, [NEWIDN]);
  var e2 = JSON.parse(JSON.stringify(e1));
  e2.content.qty = 6;
  var byKey = {};
  byKey[ID.identityKeyOf(identity)] = e1;
  byKey[NEWKEY] = e2;
  var json = JSON.stringify({ byKey: byKey, conflicts: [], reviewEvents: [], canonVersion: 'canon-v3', keyVersion: 'esc-v2' });
  var err = null;
  try { ID.importState(json); } catch (ex) { err = ex; }
  ok(!!err && err.code === 'registry_internal_id_conflict', 'R10 双副本（纯 JSON、内容不同）→ registry_internal_id_conflict');
})();
/* R11 现行契约（R8-R4）：单键非纯 JSON 实体 → registry_entity_content_invalid */
(function () {
  var e = ent('int_rb11', identity);
  var t = JSON.stringify(e).replace('"qty":5', '"qty":1e999');
  var json = '{"byKey":{"' + ID.identityKeyOf(identity) + '":' + t + '},"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v3","keyVersion":"esc-v2"}';
  var err = null;
  try { ID.importState(json); } catch (ex) { err = ex; }
  ok(!!err && err.code === 'registry_entity_content_invalid', 'R11 单键 1e999 → registry_entity_content_invalid（R8-R4 逐实体门禁）');
})();

console.log('== identity-r8-rollback-verify: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
