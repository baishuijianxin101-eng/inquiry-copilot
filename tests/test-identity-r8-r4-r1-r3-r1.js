/* P1-23-R7-R8-R4-R1-R3-R1：bindAdditionalIdentity 双索引一致性与实体初始化边界专项。
   S 组（故障注入）：byKey 与 byInternal 指向不同对象时不得凭 internalId
   字符串相同返回 UNCHANGED——同一对象才幂等；不同对象先结构校验
   （零 getter）再区分 duplicate_internal / index_split_conflict /
   index_entity_invalid；任何拒绝都不得修改两个实体与索引；
   P 组（故障注入）：实体原型继承 setter 不得截获 additionalIdentities
   初始化（defineProperty 语义，带调用计数）；实体不可扩展时初始化
   失败须明确 INVALID 且不写新映射；
   R 组（回归）：byKey 未命中正常绑定不变。
   全部虚构数据；Node/vm 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function idn(raw, sys) { return { source_system: sys || 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
var NEWIDN = idn('NEW-1', 'crm');
var NEWKEY = ID.identityKeyOf(NEWIDN);
function ent(internalId, identity, conf, adds) {
  return { internalId: internalId, identity: identity, additionalIdentities: adds || [],
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: conf, confirmationHistory: [{ note: 'keep' }], archived: false };
}

/* ================= S 组：双索引对象一致性 ================= */
(function () {
  var identity = idn('S0');
  /* S01 同一对象（主身份键命中）→ UNCHANGED、引用与内容全不变、无冲突 */
  var e1 = ent('int_s01', identity, { v: 'A' });
  var reg1 = ID.createRegistry();
  reg1.byKey[ID.identityKeyOf(identity)] = e1; reg1.byInternal['int_s01'] = e1;
  var r1 = ID.bindAdditionalIdentity(reg1, 'int_s01', identity, 'op');
  ok(r1.status === 'UNCHANGED' && reg1.byKey[ID.identityKeyOf(identity)] === e1 && reg1.byInternal['int_s01'] === e1 && e1.additionalIdentities.length === 0 && reg1.conflicts.length === 0, 'S01 同一对象主身份命中 → UNCHANGED、引用不变、无冲突');
  /* S01b 同一对象（附加身份键命中）→ UNCHANGED */
  var e1b = ent('int_s01b', identity, { v: 'A' }, [NEWIDN]);
  var reg1b = ID.createRegistry();
  reg1b.byKey[NEWKEY] = e1b; reg1b.byInternal['int_s01b'] = e1b;
  var r1b = ID.bindAdditionalIdentity(reg1b, 'int_s01b', NEWIDN, 'op');
  ok(r1b.status === 'UNCHANGED' && e1b.additionalIdentities.length === 1 && reg1b.conflicts.length === 0, 'S01b 同一对象附加身份命中 → UNCHANGED、不重复追加');
  /* S02 分裂：A/B 不同对象、internalId 相同、确认值不同 → index_split_conflict，禁止 UNCHANGED 与一切修改 */
  var A = ent('int_split', identity, { v: 'A' });
  var B = ent('int_split', NEWIDN, { v: 'B' });
  var reg2 = ID.createRegistry();
  reg2.byInternal['int_split'] = A; reg2.byKey[NEWKEY] = B;
  var r2 = null, err2 = null;
  try { r2 = ID.bindAdditionalIdentity(reg2, 'int_split', NEWIDN, 'op'); } catch (ex) { err2 = ex; }
  ok(!err2 && r2 && r2.status === 'CONFLICT' && reg2.conflicts.length === 1 && reg2.conflicts[0].kind === 'index_split_conflict', 'S02 双索引分裂（同 ID 不同对象）→ CONFLICT(index_split_conflict)，不返回 UNCHANGED');
  ok(reg2.byKey[NEWKEY] === B && reg2.byInternal['int_split'] === A && A.additionalIdentities.length === 0 && B.additionalIdentities.length === 0 && A.confirmedValue.v === 'A' && B.confirmedValue.v === 'B' && A.confirmationHistory.length === 1 && B.confirmationHistory.length === 1 && Object.keys(reg2.byKey).length === 1, 'S02b 分裂拒绝后 A/B 内容、确认值、历史与双索引逐项不变，未自动合并');
  /* S03 分裂但内容相同 → 仍登记结构冲突（bind 通道不自动统一） */
  var A3 = ent('int_split3', identity, { v: 'SAME' });
  var B3 = ent('int_split3', NEWIDN, { v: 'SAME' });
  var reg3 = ID.createRegistry();
  reg3.byInternal['int_split3'] = A3; reg3.byKey[NEWKEY] = B3;
  var r3 = ID.bindAdditionalIdentity(reg3, 'int_split3', NEWIDN, 'op');
  ok(r3.status === 'CONFLICT' && reg3.conflicts[0].kind === 'index_split_conflict' && reg3.byKey[NEWKEY] === B3 && reg3.byInternal['int_split3'] === A3, 'S03 内容相同的分裂对象 → 仍 CONFLICT(index_split_conflict)，不静默统一');
  /* S04 byKey 指向另一 internalId 的合法实体 → duplicate_internal 语义保留 */
  var A4 = ent('int_a04', identity, { v: 'A' });
  var B4 = ent('int_other', NEWIDN, { v: 'B' });
  var reg4 = ID.createRegistry();
  reg4.byInternal['int_a04'] = A4; reg4.byKey[NEWKEY] = B4;
  var r4 = ID.bindAdditionalIdentity(reg4, 'int_a04', NEWIDN, 'op');
  ok(r4.status === 'CONFLICT' && reg4.conflicts[0].kind === 'duplicate_internal' && A4.additionalIdentities.length === 0 && reg4.byKey[NEWKEY] === B4, 'S04 不同 internalId → CONFLICT(duplicate_internal) 语义保留、无修改');
  /* S05 byKey 命中实体结构非法（附加身份非数组）→ index_entity_invalid，且不按其 internalId 放行 */
  var A5 = ent('int_a05', identity, { v: 'A' });
  var B5 = ent('int_a05', NEWIDN, { v: 'B' });
  B5.additionalIdentities = { not: 'array' };
  var reg5 = ID.createRegistry();
  reg5.byInternal['int_a05'] = A5; reg5.byKey[NEWKEY] = B5;
  var r5 = null, err5 = null;
  try { r5 = ID.bindAdditionalIdentity(reg5, 'int_a05', NEWIDN, 'op'); } catch (ex) { err5 = ex; }
  ok(!err5 && r5 && r5.status === 'CONFLICT' && reg5.conflicts.length === 1 && reg5.conflicts[0].kind === 'index_entity_invalid' && reg5.byKey[NEWKEY] === B5 && reg5.byInternal['int_a05'] === A5 && A5.additionalIdentities.length === 0, 'S05 命中实体结构非法 → CONFLICT(index_entity_invalid)、不静默放行、双方不变');
  /* S06 byKey 命中实体的 internalId 是 getter → 零调用、按结构非法拒绝 */
  var A6 = ent('int_a06', identity, { v: 'A' });
  var B6 = ent('int_a06', NEWIDN, { v: 'B' });
  var box6 = { count: 0 };
  Object.defineProperty(B6, 'internalId', { enumerable: true, configurable: true, get: function () { box6.count++; return 'int_a06'; } });
  var reg6 = ID.createRegistry();
  reg6.byInternal['int_a06'] = A6; reg6.byKey[NEWKEY] = B6;
  var r6 = null, err6 = null;
  try { r6 = ID.bindAdditionalIdentity(reg6, 'int_a06', NEWIDN, 'op'); } catch (ex) { err6 = ex; }
  ok(!err6 && box6.count === 0 && r6 && r6.status === 'CONFLICT' && reg6.conflicts[0].kind === 'index_entity_invalid', 'S06 命中实体 internalId 为 getter → 零调用、CONFLICT(index_entity_invalid)');
})();

/* ================= P 组：实体原型继承 setter 与初始化失败 ================= */
(function () {
  var identity = idn('P0');
  /* P01 实体无自有 additionalIdentities、原型有同名 setter → 初始化不得触发 setter */
  var proto = {};
  var box = { count: 0 };
  Object.defineProperty(proto, 'additionalIdentities', { configurable: true, set: function (v) { box.count++; } });
  var e = ent('int_p01', identity, { v: 'A' });
  delete e.additionalIdentities;
  Object.setPrototypeOf(e, proto);
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal['int_p01'] = e;
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_p01', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var d = Object.getOwnPropertyDescriptor(e, 'additionalIdentities');
  ok(!err && box.count === 0, 'P01 原型 setter 调用次数为 0');
  ok(r && r.status === 'BOUND' && d && 'value' in d && d.enumerable && Array.isArray(d.value) && d.value.length === 1 && d.value[0].external_id_raw === 'NEW-1' && reg.byKey[NEWKEY] === e && reg.byInternal['int_p01'] === e, 'P01b 自有可枚举数据属性生成、数组长度 1、新身份落位、byKey 指向规范实体、byInternal 不变');
  /* P02 实体被冻结（不可扩展）且无自有字段 → 初始化失败 INVALID、不写新映射 */
  var e2 = ent('int_p02', identity, { v: 'A' });
  delete e2.additionalIdentities;
  Object.freeze(e2);
  var reg2 = ID.createRegistry();
  reg2.byKey[ID.identityKeyOf(identity)] = e2; reg2.byInternal['int_p02'] = e2;
  var r2 = null, err2 = null;
  try { r2 = ID.bindAdditionalIdentity(reg2, 'int_p02', NEWIDN, 'op'); } catch (ex) { err2 = ex; }
  ok(!err2 && r2 && r2.status === 'INVALID' && r2.reason === 'additional_identities_not_writable' && !Object.prototype.hasOwnProperty.call(e2, 'additionalIdentities') && !reg2.byKey[NEWKEY] && reg2.byInternal['int_p02'] === e2, 'P02 冻结实体初始化失败 → INVALID(not_writable)、无自有字段、无新映射');
  /* P03 实体 preventExtensions → 同上 */
  var e3 = ent('int_p03', identity, { v: 'A' });
  delete e3.additionalIdentities;
  Object.preventExtensions(e3);
  var reg3 = ID.createRegistry();
  reg3.byKey[ID.identityKeyOf(identity)] = e3; reg3.byInternal['int_p03'] = e3;
  var r3 = null, err3 = null;
  try { r3 = ID.bindAdditionalIdentity(reg3, 'int_p03', NEWIDN, 'op'); } catch (ex) { err3 = ex; }
  ok(!err3 && r3 && r3.status === 'INVALID' && !reg3.byKey[NEWKEY] && reg3.byInternal['int_p03'] === e3, 'P03 不可扩展实体 → INVALID、无新映射、byInternal 不变');
})();

/* ================= R 组：回归 ================= */
(function () {
  var identity = idn('R0');
  var e = ent('int_r01', identity, { v: 'A' });
  delete e.additionalIdentities;
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal['int_r01'] = e;
  var r = ID.bindAdditionalIdentity(reg, 'int_r01', NEWIDN, 'op');
  ok(r.status === 'BOUND' && e.additionalIdentities.length === 1 && reg.byKey[NEWKEY] === e, 'R01 byKey 未命中 → 正常 BOUND（R3 初始化路径保持）');
})();

console.log('== identity-r8-r4-r1-r3-r1: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
