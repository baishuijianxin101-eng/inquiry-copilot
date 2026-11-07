/* P1-23-R7-R8-R4-R1-R2：伪造数组下游异常逃逸专项（方案甲）。
   A 组：B04 原始复现端到端（registerExisting 真实路径）；
   B 组：其他直接消费 additionalIdentities 的入口；
   C 组：拒绝场景状态完整性；D 组：回归。
   全部虚构数据；Node/vm 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var vm = require('vm');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function idn(raw, acct) { return { source_system: 'alibaba_api', source_account: acct || 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
var CONF = { qty: 3, basedOnHash: 'h-conf' };
function ent(internalId, identity, adds) {
  return { internalId: internalId, identity: identity, additionalIdentities: adds,
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: CONF, archived: false };
}
function fakeProtoArray(items) {
  var arr = items.slice();
  var fake = [];
  Object.setPrototypeOf(fake, Object.prototype);
  Object.setPrototypeOf(arr, fake);
  return arr;
}
function snap(e) { return JSON.stringify(e.content) + '|' + JSON.stringify(e.confirmedValue) + '|' + e.contentHash; }

/* ================= A 组：B04 原始复现（端到端） ================= */
(function () {
  var identity = idn('RA'), key = ID.identityKeyOf(identity);
  var e = ent('int_ra', identity, fakeProtoArray([idn('RA-X')]));
  var reg = ID.createRegistry(); reg.byInternal['int_ra'] = e;
  var before = snap(e);
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, 'int_ra', {}); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'UNCHANGED' && res.repaired === 'byKey', 'A01 B04 伪造原型附加数组进入 registerExisting → 不再抛 TypeError，正常补 byKey');
  ok(reg.byKey[key] === e && reg.byInternal['int_ra'] === e && snap(e) === before && e.confirmedValue === CONF && e.additionalIdentities.length === 1, 'A01b 实体/确认值/附加数组不变，索引指向同一实体');
  /* A02 经附加身份键登记（entityKeys 全键路径） */
  var res2 = null, err2 = null;
  try { res2 = ID.registerExisting(reg, idn('RA-X'), 'int_ra', {}); } catch (ex) { err2 = ex; }
  ok(!err2 && res2 && res2.status === 'UNCHANGED' && reg.conflicts.length === 0, 'A02 经伪造原型数组中的附加身份登记 → UNCHANGED 不误报、不抛错');
  /* A03 分裂统一路径（entityKeys 枚举全键 + 逐键改指） */
  var objB = ent('int_ra3', identity, fakeProtoArray([idn('RA-X')]), undefined);
  objB.confirmedValue = { qty: 1, basedOnHash: 'h' };
  var objA = JSON.parse(JSON.stringify(objB));
  objA.additionalIdentities = fakeProtoArray(objA.additionalIdentities);
  var reg3 = ID.createRegistry(); reg3.byKey[key] = objA; reg3.byInternal['int_ra3'] = objB;
  var res3 = null, err3 = null;
  try { res3 = ID.registerExisting(reg3, identity, 'int_ra3', {}); } catch (ex) { err3 = ex; }
  ok(!err3 && res3 && res3.repaired === 'index_unified' && reg3.byKey[key] === objB && reg3.byKey[ID.identityKeyOf(idn('RA-X'))] === objB, 'A03 分裂统一（含伪造原型附加数组）→ 全键改指同一对象、不抛错');
})();

/* ================= B 组：下游入口 ================= */
(function () {
  /* B01 bindAdditionalIdentity：对带伪造原型附加数组的实体追加绑定（push 改下标赋值） */
  var identity = idn('RB1');
  var e = ent('int_rb1', identity, fakeProtoArray([idn('RB1-X')]));
  var reg = ID.createRegistry(); reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal['int_rb1'] = e;
  var crmIdn = { source_system: 'crm', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: 'RB1-Y' };
  var res = null, err = null;
  try { res = ID.bindAdditionalIdentity(reg, 'int_rb1', crmIdn, 'tester'); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'BOUND' && e.additionalIdentities.length === 2 && reg.byKey[ID.identityKeyOf(crmIdn)] === e, 'B01 bindAdditionalIdentity 追加伪造原型数组 → BOUND、长度+1、不抛错');
  /* B02 importState：输入恒为 JSON 字符串，JSON.parse 产物必为标准原型
     数组——B04 形态在 JSON 边界上不可表达（构造方式本身即证明）。此处
     验证多附加身份注册表正常导入且导入后 entityKeys 消费正常。 */
  var src = ID.createRegistry();
  var e2 = ent('int_rb2', identity, [idn('RB2-X'), idn('RB2-Y')]);
  src.byKey[ID.identityKeyOf(identity)] = e2; src.byKey[ID.identityKeyOf(idn('RB2-X'))] = e2; src.byKey[ID.identityKeyOf(idn('RB2-Y'))] = e2;
  var imported = null, err2 = null;
  try { imported = ID.importState(ID.exportState(src)); } catch (ex) { err2 = ex; }
  ok(!err2 && imported && imported.byInternal['int_rb2'] === imported.byKey[ID.identityKeyOf(idn('RB2-Y'))], 'B02 importState 多附加身份注册表 → 导入成功、三处引用同一对象');
  var rB2 = imported ? ID.registerExisting(imported, idn('RB2-Y'), 'int_rb2', {}) : null;
  ok(rB2 && rB2.status === 'UNCHANGED', 'B02b 导入后经附加身份登记 → UNCHANGED');
  /* B03 importState 对非法附加身份仍明确抛 registry_*（失败语义不被下标化掩盖） */
  var bad = JSON.parse(ID.exportState(src));
  bad.byKey[ID.identityKeyOf(identity)].additionalIdentities = 'broken';
  var err3 = null;
  try { ID.importState(JSON.stringify(bad)); } catch (ex) { err3 = ex; }
  ok(!!err3 && err3.code === 'registry_additional_identities_invalid', 'B03 importState 非法附加字段 → registry_additional_identities_invalid（明确失败、非吞错）');
})();

/* ================= C 组：拒绝场景状态完整性（沿袭 R1-R1） ================= */
(function () {
  var identity = idn('RC'), key = ID.identityKeyOf(identity);
  var adds = [idn('RC-X')]; Object.setPrototypeOf(adds, { custom: true });
  var e = ent('int_rc', identity, adds);
  var reg = ID.createRegistry(); reg.byInternal['int_rc'] = e;
  var before = snap(e);
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, 'int_rc', {}); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_entity_invalid' && Object.keys(reg.byKey).length === 0 && reg.byInternal['int_rc'] === e && snap(e) === before && e.confirmedValue === CONF, 'C01 普通自定义原型数组 → 仍拒绝、状态逐项不变、无部分写入');
})();

/* ================= D 组：回归 ================= */
(function () {
  var identity = idn('RD'), key = ID.identityKeyOf(identity);
  var e1 = ent('int_rd1', identity, [idn('RD-X')]);
  var reg1 = ID.createRegistry(); reg1.byKey[key] = e1; reg1.byInternal['int_rd1'] = e1;
  ok(ID.registerExisting(reg1, identity, 'int_rd1', {}).status === 'UNCHANGED', 'D01 普通附加数组 → UNCHANGED');
  var e2 = ent('int_rd2', identity, []);
  var reg2 = ID.createRegistry(); reg2.byInternal['int_rd2'] = e2;
  ok(ID.registerExisting(reg2, identity, 'int_rd2', {}).repaired === 'byKey', 'D02 空数组 → 补 byKey');
  var addsVm = vm.runInNewContext('[{ source_system: "alibaba_api", source_account: "acct-1", entity_type: "opportunity", external_id_raw: "RD-VM" }]');
  var e3 = ent('int_rd3', identity, addsVm);
  var reg3 = ID.createRegistry(); reg3.byInternal['int_rd3'] = e3;
  var r3 = null, err3 = null;
  try { r3 = ID.registerExisting(reg3, idn('RD-VM'), 'int_rd3', {}); } catch (ex) { err3 = ex; }
  ok(!err3 && r3 && r3.status === 'UNCHANGED', 'D03 跨 realm 附加数组 → 通过（指纹策略兼容）');
  var e4 = ent('int_rd4', identity, [idn('RD-X')]);
  e4.additionalIdentities = [idn('RD-X')]; Object.setPrototypeOf(e4.additionalIdentities, null);
  var reg4 = ID.createRegistry(); reg4.byInternal['int_rd4'] = e4;
  ok(ID.registerExisting(reg4, identity, 'int_rd4', {}).status === 'CONFLICT', 'D04 null 原型附加数组 → 拒绝');
  var box = { count: 0 };
  var addsG = [idn('RD-X')];
  Object.defineProperty(addsG, '0', { enumerable: true, configurable: true, get: function () { box.count++; return idn('RD-X'); } });
  Object.setPrototypeOf(addsG, { custom: true });
  var e5 = ent('int_rd5', identity, addsG);
  var reg5 = ID.createRegistry(); reg5.byInternal['int_rd5'] = e5;
  var r5 = ID.registerExisting(reg5, identity, 'int_rd5', {});
  ok(r5.status === 'CONFLICT' && box.count === 0, 'D05 自定义原型+元素 getter → 拒绝且 getter 零调用');
  var e6 = ent('int_rd6', identity, [idn('RD-X'), , idn('RD-Y')]);
  var reg6 = ID.createRegistry(); reg6.byInternal['int_rd6'] = e6;
  ok(ID.registerExisting(reg6, identity, 'int_rd6', {}).status === 'CONFLICT', 'D06 稀疏附加数组 → 拒绝');
})();

console.log('== identity-r8-r4-r1-r2: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
