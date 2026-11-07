/* P1-23-R7-R8-R4-R1-R3：附加身份绑定写入边界专项。
   A 组（故障注入）：非数组字段不得误报 BOUND；
   B 组（正常业务）：合法数组追加语义不变；
   C 组（故障注入）：继承 setter 不得截获下标追加（带调用计数）；
   D 组（故障注入）：冻结/不可扩展/length 不可写/目标位占用 → 明确失败且状态逐项不变；
   E 组（正常业务）：既有绑定语义回归。
   全部虚构数据；Node/vm 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var vm = require('vm');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function idn(raw, sys) { return { source_system: sys || 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
var CONF = { qty: 7, basedOnHash: 'h-conf' };
function ent(internalId, identity, adds, omitAdds) {
  var e = { internalId: internalId, identity: identity,
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: CONF, confirmationHistory: [{ note: 'keep' }], archived: false };
  if (!omitAdds) e.additionalIdentities = adds;
  return e;
}
function setup(e, identity) {
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal[e.internalId] = e;
  return reg;
}
function regSnap(reg) { return Object.keys(reg.byKey).sort().join(',') + '#' + Object.keys(reg.byInternal).sort().join(','); }
var NEWIDN = idn('NEW-1', 'crm');

/* ================= A 组：非数组输入 ================= */
(function () {
  var identity = idn('A0');
  /* A01 字段缺失（无 own 属性）→ 既有规则初始化并 BOUND */
  var e1 = ent('int_a01', identity, null, true);
  var reg1 = setup(e1, identity);
  var r1 = ID.bindAdditionalIdentity(reg1, 'int_a01', NEWIDN, 'op');
  ok(r1.status === 'BOUND' && Array.isArray(e1.additionalIdentities) && e1.additionalIdentities.length === 1 && reg1.byKey[ID.identityKeyOf(NEWIDN)] === e1, 'A01 字段缺失 → 初始化空数组并 BOUND');
  /* A02 字段值为 undefined（own 数据属性）→ 同缺失处理 */
  var e2 = ent('int_a02', identity, undefined);
  var reg2 = setup(e2, identity);
  var r2 = ID.bindAdditionalIdentity(reg2, 'int_a02', NEWIDN, 'op');
  ok(r2.status === 'BOUND' && Array.isArray(e2.additionalIdentities) && e2.additionalIdentities.length === 1, 'A02 字段值 undefined → 按缺失处理 BOUND');
  /* A03–A07 已存在但非数组 → 明确失败、状态不变、不得 BOUND */
  var cases = [['A03', null], ['A04', false], ['A05', ''], ['A06', { not: 'array' }], ['A07', 'a-string']];
  cases.forEach(function (cs) {
    var e = ent('int_' + cs[0].toLowerCase(), identity, cs[1]);
    var reg = setup(e, identity);
    var before = regSnap(reg);
    var r = null, err = null;
    try { r = ID.bindAdditionalIdentity(reg, e.internalId, NEWIDN, 'op'); } catch (ex) { err = ex; }
    ok(!err && r && r.status === 'INVALID' && e.additionalIdentities === cs[1] && regSnap(reg) === before && !reg.byKey[ID.identityKeyOf(NEWIDN)] && e.confirmedValue === CONF, cs[0] + ' 非数组字段（' + (cs[1] === '' ? '空字符串' : typeof cs[1]) + '）→ INVALID、字段与索引不变、无新映射');
  });
  /* A08 字段本身是 getter → INVALID 且 getter 零调用 */
  var e8 = ent('int_a08', identity, null, true);
  var box8 = { count: 0 };
  Object.defineProperty(e8, 'additionalIdentities', { enumerable: true, configurable: true, get: function () { box8.count++; return []; } });
  var reg8 = setup(e8, identity);
  var r8 = null, err8 = null;
  try { r8 = ID.bindAdditionalIdentity(reg8, 'int_a08', NEWIDN, 'op'); } catch (ex) { err8 = ex; }
  ok(!err8 && r8 && r8.status === 'INVALID' && box8.count === 0 && !reg8.byKey[ID.identityKeyOf(NEWIDN)], 'A08 字段为 getter → INVALID、getter 零调用');
})();

/* ================= B 组：正常数组 ================= */
(function () {
  var identity = idn('B0');
  var e1 = ent('int_b01', identity, [idn('B-OLD')]);
  var old0 = e1.additionalIdentities[0];
  var reg1 = setup(e1, identity);
  var r1 = ID.bindAdditionalIdentity(reg1, 'int_b01', NEWIDN, 'op');
  var d = Object.getOwnPropertyDescriptor(e1.additionalIdentities, '1');
  ok(r1.status === 'BOUND' && e1.additionalIdentities.length === 2 && e1.additionalIdentities[0] === old0 && d && 'value' in d && d.enumerable && d.value.external_id_raw === 'NEW-1' && reg1.byKey[ID.identityKeyOf(NEWIDN)] === e1 && reg1.byInternal['int_b01'] === e1, 'B01 普通数组 → BOUND、原元素不变、新元素为自有可枚举数据属性、索引指向原实体');
  var e2 = ent('int_b02', identity, []);
  var reg2 = setup(e2, identity);
  ok(ID.bindAdditionalIdentity(reg2, 'int_b02', NEWIDN, 'op').status === 'BOUND' && e2.additionalIdentities.length === 1, 'B02 空数组 → BOUND');
  var e3 = ent('int_b03', identity, []);
  var reg3 = setup(e3, identity);
  ID.bindAdditionalIdentity(reg3, 'int_b03', idn('M-1', 'crm'), 'op');
  ID.bindAdditionalIdentity(reg3, 'int_b03', idn('M-2', 'erp'), 'op');
  ok(e3.additionalIdentities.length === 2 && e3.additionalIdentities[0].external_id_raw === 'M-1' && e3.additionalIdentities[1].external_id_raw === 'M-2', 'B03 连续追加 → 顺序与长度正确');
  var addsVm = vm.runInNewContext('[{ source_system: "alibaba_api", source_account: "acct-1", entity_type: "opportunity", external_id_raw: "B-VM" }]');
  var e4 = ent('int_b04', identity, addsVm);
  var reg4 = setup(e4, identity);
  var r4 = null, err4 = null;
  try { r4 = ID.bindAdditionalIdentity(reg4, 'int_b04', NEWIDN, 'op'); } catch (ex) { err4 = ex; }
  ok(!err4 && r4 && r4.status === 'BOUND' && e4.additionalIdentities.length === 2, 'B04 跨 realm 数组 → BOUND（既有兼容保持）');
  /* B05 B04 伪造原型数组（指纹可接受）→ 仍可正常追加（R2 行为保持） */
  var adds5 = [idn('B5-X')];
  var fake = []; Object.setPrototypeOf(fake, Object.prototype); Object.setPrototypeOf(adds5, fake);
  var e5 = ent('int_b05', identity, adds5);
  var reg5 = setup(e5, identity);
  var r5 = null, err5 = null;
  try { r5 = ID.bindAdditionalIdentity(reg5, 'int_b05', NEWIDN, 'op'); } catch (ex) { err5 = ex; }
  ok(!err5 && r5 && r5.status === 'BOUND' && adds5.length === 2 && Object.getOwnPropertyDescriptor(adds5, '1').value.external_id_raw === 'NEW-1', 'B05 伪造原型数组 → BOUND、自有属性正确落位（B04 修复行为保持）');
})();

/* ================= C 组：继承 setter ================= */
(function () {
  var identity = idn('C0');
  /* C01 指纹合法原型链 + 下一索引位置继承 setter */
  var adds = [idn('C-OLD')];
  var fake = []; Object.setPrototypeOf(fake, Object.prototype);
  var box = { count: 0 };
  Object.defineProperty(fake, '1', { configurable: true, set: function (v) { box.count++; } });
  Object.setPrototypeOf(adds, fake);
  var e = ent('int_c01', identity, adds);
  var reg = setup(e, identity);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_c01', NEWIDN, 'op'); } catch (ex) { err = ex; }
  var d = Object.getOwnPropertyDescriptor(adds, '1');
  ok(!err && box.count === 0, 'C01 继承 setter 调用次数为 0');
  ok(r && r.status === 'BOUND' && adds.length === 2 && d && 'value' in d && d.value.external_id_raw === 'NEW-1' && reg.byKey[ID.identityKeyOf(NEWIDN)] === e, 'C01b 追加以自有数据属性落位、length 正确、索引与实体一致（无虚假 BOUND）');
  /* C02 setter 在 Object.prototype 层（真实全局污染形态的隔离模拟：用自定义中间层代替，不污染全局） */
  var adds2 = [idn('C-OLD')];
  var mid = []; Object.setPrototypeOf(mid, Object.prototype);
  var box2 = { count: 0 };
  Object.defineProperty(mid, '1', { configurable: true, set: function (v) { box2.count++; } });
  Object.setPrototypeOf(adds2, mid);
  var e2 = ent('int_c02', identity, adds2);
  var reg2 = setup(e2, identity);
  var r2 = ID.bindAdditionalIdentity(reg2, 'int_c02', NEWIDN, 'op');
  ok(box2.count === 0 && r2.status === 'BOUND' && adds2.length === 2, 'C02 中间层 setter 同样零调用、追加成功');
})();

/* ================= D 组：不可写/不可扩展 ================= */
function frozenCase(name, mutate) {
  var identity = idn('D0');
  var adds = [idn('D-OLD')];
  var e = ent('int_' + name.toLowerCase(), identity, adds);
  var reg = setup(e, identity);
  var descBefore = JSON.stringify(Object.getOwnPropertyDescriptor(adds, '0').value.external_id_raw) + '|' + adds.length;
  var regBefore = regSnap(reg);
  mutate(adds, e);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, e.internalId, NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && e.additionalIdentities === adds && adds.length === 1 && JSON.stringify(Object.getOwnPropertyDescriptor(adds, '0').value.external_id_raw) + '|' + adds.length === descBefore && regSnap(reg) === regBefore && !reg.byKey[ID.identityKeyOf(NEWIDN)] && e.confirmedValue === CONF && e.confirmationHistory.length === 1, name + ' → INVALID、数组引用/长度/元素/索引/确认值全不变');
}
frozenCase('D01', function (adds) { Object.freeze(adds); });
frozenCase('D02', function (adds) { Object.preventExtensions(adds); });
frozenCase('D03', function (adds) { Object.defineProperty(adds, 'length', { writable: false }); });
/* D04 追加位置已被不可配置访问器占据（数组变长后目标位即该访问器） */
(function () {
  var identity = idn('D0');
  var adds = [idn('D-OLD')];
  Object.defineProperty(adds, '1', { configurable: false, get: function () { return idn('D-GHOST'); } });
  var e = ent('int_d04', identity, adds);
  var reg = setup(e, identity);
  var regBefore = regSnap(reg);
  var r = null, err = null;
  try { r = ID.bindAdditionalIdentity(reg, 'int_d04', NEWIDN, 'op'); } catch (ex) { err = ex; }
  ok(!err && r && r.status === 'INVALID' && regSnap(reg) === regBefore && !reg.byKey[ID.identityKeyOf(NEWIDN)], 'D04 目标位为不可配置访问器 → INVALID、索引不变');
})();

/* ================= E 组：既有业务回归 ================= */
(function () {
  var identity = idn('E0');
  var e1 = ent('int_e01', identity, [NEWIDN]);
  var reg1 = ID.createRegistry(); reg1.byKey[ID.identityKeyOf(NEWIDN)] = e1; reg1.byInternal['int_e01'] = e1;
  var r1 = ID.bindAdditionalIdentity(reg1, 'int_e01', NEWIDN, 'op');
  ok(r1.status === 'UNCHANGED' && e1.additionalIdentities.length === 1, 'E01 重复绑定同一身份 → UNCHANGED、不重复追加');
  var e2 = ent('int_e02', identity, []);
  var other = ent('int_e03', idn('E-OTHER'), []);
  var reg2 = ID.createRegistry(); reg2.byKey[ID.identityKeyOf(NEWIDN)] = other; reg2.byInternal['int_e02'] = e2; reg2.byInternal['int_e03'] = other;
  var r2 = ID.bindAdditionalIdentity(reg2, 'int_e02', NEWIDN, 'op');
  ok(r2.status === 'CONFLICT' && reg2.conflicts[0].kind === 'duplicate_internal' && e2.additionalIdentities.length === 0, 'E02 身份已属他人 → CONFLICT(duplicate_internal)、未追加');
  var e3 = ent('int_e04', identity, []);
  var reg3 = setup(e3, identity);
  var r3 = ID.bindAdditionalIdentity(reg3, 'int_e04', idn('E-SAMEACCT'), 'op');
  ok(r3.status === 'CONFLICT' && reg3.conflicts[0].kind === 'conflicting_identity_for_entity' && e3.additionalIdentities.length === 0, 'E03 同来源同账号不同原始 ID → 人工冲突规则不变、未追加');
})();

console.log('== identity-r8-r4-r1-r3: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
