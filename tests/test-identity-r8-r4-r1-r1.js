/* P1-23-R7-R8-R4-R1-R1：附加身份数组原型边界专项。
   A 组（正常业务）：合法附加数组经 registerExisting 正常通过；
   B 组（故障注入）：自定义原型数组必须被拒，且拒绝过程零 getter
   执行、索引与实体逐项不变；B04 为指纹伪造的已知限制（如实标注）。
   全部虚构数据；Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
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
function snap(e) { return JSON.stringify(e.content) + '|' + JSON.stringify(e.confirmedValue) + '|' + e.contentHash; }

/* ================= A 组：正常情况 ================= */
(function () {
  var identity = idn('A1'), key = ID.identityKeyOf(identity);
  /* A01 普通附加数组（1 个附加身份）：双索引同一对象 UNCHANGED */
  var e1 = ent('int_a1', identity, [idn('A1-X')]);
  var reg1 = ID.createRegistry(); reg1.byKey[key] = e1; reg1.byInternal['int_a1'] = e1;
  var r1 = ID.registerExisting(reg1, identity, 'int_a1', {});
  ok(r1.status === 'UNCHANGED' && reg1.byKey[key] === e1 && reg1.byInternal['int_a1'] === e1, 'A01 普通附加身份数组 → 通过（UNCHANGED）');
  /* A02 空附加数组 */
  var e2 = ent('int_a2', identity, []);
  var reg2 = ID.createRegistry(); reg2.byInternal['int_a2'] = e2;
  var r2 = ID.registerExisting(reg2, identity, 'int_a2', {});
  ok(r2.status === 'UNCHANGED' && r2.repaired === 'byKey', 'A02 空附加身份数组 → 通过（补 byKey）');
  /* A03 多个合法附加身份：经第三附加身份登记仍 UNCHANGED */
  var adds3 = [idn('A3-X'), idn('A3-Y'), idn('A3-Z')];
  var e3 = ent('int_a3', identity, adds3);
  var reg3 = ID.createRegistry(); reg3.byKey[key] = e3; reg3.byInternal['int_a3'] = e3;
  var r3 = ID.registerExisting(reg3, idn('A3-Z'), 'int_a3', {});
  ok(r3.status === 'UNCHANGED' && reg3.conflicts.length === 0, 'A03 多个合法附加身份 → 通过');
})();

/* ================= B 组：自定义原型数组 ================= */
function rejectCase(name, mutate, withGetter) {
  var identity = idn(name), key = ID.identityKeyOf(identity);
  var adds = [idn(name + '-X')];
  var box = { count: 0 };
  if (withGetter) Object.defineProperty(adds, '0', { enumerable: true, configurable: true, get: function () { box.count++; return idn(name + '-X'); } });
  mutate(adds);
  var e = ent('int_' + name.toLowerCase(), identity, adds);
  var reg = ID.createRegistry(); reg.byInternal[e.internalId] = e;
  var before = snap(e);
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, e.internalId, {}); } catch (ex) { err = ex; }
  ok(!err && res && res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_entity_invalid', name + ' 自定义原型附加数组 → CONFLICT(index_entity_invalid)、无异常逃逸');
  ok(box.count === 0 && Object.keys(reg.byKey).length === 0 && reg.byInternal[e.internalId] === e && snap(e) === before && e.confirmedValue === CONF, name + 'b 拒绝后：元素 getter 零调用、byKey 未补、byInternal 引用不变、内容/确认值不变');
}
rejectCase('B01', function (adds) { Object.setPrototypeOf(adds, { custom: true }); }, true);
rejectCase('B02', function (adds) { Object.setPrototypeOf(adds, null); }, false);
rejectCase('B03', function (adds) { Object.setPrototypeOf(adds, Object.create(Object.create(null))); }, false);
/* B04 已知限制 + 本轮新发现（如实记录）：伪造一个「假 Array.prototype」
   ——取一个真数组并把它的原型改指到 Object.prototype，它便同时满足
   Array.isArray 与「其原型通过 Object.prototype 指纹」两条，指纹策略
   无法区分它与真正的 Array.prototype。把附加数组的原型换成它后：
   (1) 结构层被接受（_isPlainJsonValue(adds) === true，entityShapeOk
   同策略放行）——这是策略限制本身；
   (2) 但 registerExisting 随后在 entityKeys 里对该数组调用 forEach，
   而它已失去 Array.prototype 方法 → 抛 TypeError。这是本轮实测发现
   的下游后果，比 A11 的普通对象伪造更严重（那边不调方法、无此问题）。
   本断言锁定真实行为（接受 + 下游抛错 + 索引未被部分修改），不标记
   为安全通过；最小修复方案（entityKeys 改下标迭代等）已在报告中
   单独提出，等审查裁决，未在本轮擅自扩大范围实施。 */
(function () {
  var identity = idn('B04'), key = ID.identityKeyOf(identity);
  var adds = [idn('B04-X')];
  var fakeArrProto = [];
  Object.setPrototypeOf(fakeArrProto, Object.prototype);
  Object.setPrototypeOf(adds, fakeArrProto);
  ok(ID._isPlainJsonValue(adds) === true, 'B04 已知限制：伪造 Array.prototype 指纹被结构策略接受（非安全结论）');
  var e = ent('int_b04', identity, adds);
  var reg = ID.createRegistry(); reg.byInternal['int_b04'] = e;
  var err = null;
  try { ID.registerExisting(reg, identity, 'int_b04', {}); } catch (ex) { err = ex; }
  /* 【R8-R4-R1-R2 修订】原断言锁定「registerExisting 在 entityKeys 处
     抛 TypeError」这一缺陷后果；R8-R4-R1-R2 任务书的核心验收标准即
     消除该异常逃逸（方案甲：数组消费改下标迭代），故本条按任务书
     改为断言修复后行为。原断言文本与实测记录保留在 R8-R4-R1-R1 的
     交付副本与报告中，未静默删除。 */
  ok(!err && Object.keys(reg.byKey).length === 1 && reg.byKey[ID.identityKeyOf(identity)] === e && reg.byInternal['int_b04'] === e, 'B04b 【R2 修订】修复后：不再抛 TypeError，正常补 byKey、索引完整');
})();

console.log('== identity-r8-r4-r1-r1: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
