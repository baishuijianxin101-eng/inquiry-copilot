/* P1-23-R7-R8：注册表一致性与导入安全专项（identity 部分）。
   S 组：importState 规范实体对象统一引用（第一项）；
   R 组：registerExisting 索引分裂不再放行（第二项）；
   N 组：canon-v3 数值有限性（第三项）。
   引用断言一律使用严格 === 检查对象引用，不以 JSON 文本冒充。
   全部虚构数据；本文件为 Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function throwsCode(fn, code) { try { fn(); return null; } catch (e) { return e && e.code === code ? e : { wrong: e }; } }

function idn(raw, acct) { return { source_system: 'alibaba_api', source_account: acct || 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
function ent(internalId, identity, adds, confirmed) {
  return { internalId: internalId, identity: identity, additionalIdentities: adds || [],
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: confirmed || null, archived: false };
}
function regJson(byKey, kv) {
  return JSON.stringify({ byKey: byKey, conflicts: [], reviewEvents: [], canonVersion: 'canon-v3', keyVersion: kv || 'esc-v2' });
}

/* ================= S 组：importState 引用统一 ================= */
/* S01 只有主身份：byKey 与 byInternal 同一对象 */
(function () {
  var identity = idn('S1');
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = ent('int_s1', identity);
  var reg = ID.importState(regJson(byKey));
  ok(reg.byKey[ID.identityKeyOf(identity)] === reg.byInternal['int_s1'], 'S01 单主身份：byKey 与 byInternal 严格同一引用');
})();

/* S02 一个附加身份：主/附加两键与 byInternal 三者同一对象 */
(function () {
  var identity = idn('S2'), add = idn('S2-ALT');
  var e = ent('int_s2', identity, [add]);
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = e; byKey[ID.identityKeyOf(add)] = JSON.parse(JSON.stringify(e));
  var reg = ID.importState(regJson(byKey));
  var a = reg.byKey[ID.identityKeyOf(identity)], b = reg.byKey[ID.identityKeyOf(add)], c = reg.byInternal['int_s2'];
  ok(a === b && b === c, 'S02 主+1 附加：三处严格同一引用');
  a.content.qty = 777;
  ok(reg.byInternal['int_s2'].content.qty === 777 && reg.byKey[ID.identityKeyOf(add)].content.qty === 777, 'S02b 经任一键改实体，其他键与 byInternal 立即可见（无分裂副本）');
})();

/* S03 多个附加身份：全部键同一对象，附加身份不丢失 */
(function () {
  var identity = idn('S3'), a1 = idn('S3-A'), a2 = idn('S3-B');
  var e = ent('int_s3', identity, [a1, a2]);
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = e;
  byKey[ID.identityKeyOf(a1)] = JSON.parse(JSON.stringify(e));
  byKey[ID.identityKeyOf(a2)] = JSON.parse(JSON.stringify(e));
  var reg = ID.importState(regJson(byKey));
  var refs = [reg.byKey[ID.identityKeyOf(identity)], reg.byKey[ID.identityKeyOf(a1)], reg.byKey[ID.identityKeyOf(a2)], reg.byInternal['int_s3']];
  ok(refs.every(function (r) { return r === refs[0]; }) && refs[0].additionalIdentities.length === 2, 'S03 主+2 附加：四处同一引用、附加身份完整保留');
})();

/* S04 副本键序不同、内容一致：不误判冲突，正常统一引用 */
(function () {
  var identity = idn('S4'), add = idn('S4-ALT');
  var e = ent('int_s4', identity, [add]);
  var copy = JSON.parse(JSON.stringify(e));
  var reordered = {}; /* 顶层键反序构造 */
  Object.keys(copy).reverse().forEach(function (k) { reordered[k] = copy[k]; });
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = e; byKey[ID.identityKeyOf(add)] = reordered;
  var reg = ID.importState(regJson(byKey));
  ok(reg.byKey[ID.identityKeyOf(identity)] === reg.byKey[ID.identityKeyOf(add)], 'S04 键序不同的同内容副本：导入成功且引用统一（稳定序列化判定）');
})();

/* S05 副本内容不一致（确认值不同）：拒绝导入 */
(function () {
  var identity = idn('S5'), add = idn('S5-ALT');
  var e = ent('int_s5', identity, [add], null);
  var bad = JSON.parse(JSON.stringify(e)); bad.confirmedValue = { qty: 1, basedOnHash: 'x' };
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = e; byKey[ID.identityKeyOf(add)] = bad;
  var err = throwsCode(function () { ID.importState(regJson(byKey)); }, 'registry_internal_id_conflict');
  ok(!!err && !err.wrong, 'S05 同 internalId 副本确认值不一致 → registry_internal_id_conflict 拒绝');
})();

/* S06 实体 B 的附加身份冒占实体 A 的主身份键（A 先处理）→ 拒绝 */
(function () {
  var idA = idn('S6-A'), idB = idn('S6-B');
  var eA = ent('int_s6a', idA);
  var eB = ent('int_s6b', idB, [idA]); /* B 把 A 的身份列为自己的附加身份 */
  var byKey = {}; byKey[ID.identityKeyOf(idA)] = eA; byKey[ID.identityKeyOf(idB)] = eB;
  var err = null; try { ID.importState(regJson(byKey)); } catch (e) { err = e; }
  ok(!!err && /^registry_/.test(err.code || ''), 'S06 附加身份冒占他人主身份键 → 拒绝（' + (err && err.code) + '）');
})();

/* S07 同上但 B 的条目先处理（顺序互换）→ 同样拒绝 */
(function () {
  var idA = idn('S7-A'), idB = idn('S7-B');
  var eA = ent('int_s7a', idA);
  var eB = ent('int_s7b', idB, [idA]);
  var byKey = {}; byKey[ID.identityKeyOf(idB)] = eB; byKey[ID.identityKeyOf(idA)] = eA;
  var err = null; try { ID.importState(regJson(byKey)); } catch (e) { err = e; }
  ok(!!err && /^registry_/.test(err.code || ''), 'S07 处理顺序互换 → 仍拒绝（' + (err && err.code) + '）');
})();

/* S08 特殊 internalId / 外部 ID：实体不丢失、原型不污染、引用统一 */
(function () {
  var identity = idn('constructor'), add = idn('toString');
  var e = ent('__proto__', identity, [add]);
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = e; byKey[ID.identityKeyOf(add)] = JSON.parse(JSON.stringify(e));
  var reg = ID.importState(regJson(byKey));
  ok(reg.byInternal['__proto__'] && reg.byInternal['__proto__'] === reg.byKey[ID.identityKeyOf(identity)] && reg.byKey[ID.identityKeyOf(add)] === reg.byInternal['__proto__'], 'S08 internalId=__proto__ 的实体在三处可达且引用统一');
  ok(Object.keys(reg.byKey).length === 2 && ({}).polluted === undefined && typeof ({}).toString === 'function', 'S08b 无实体丢失、Object.prototype 未污染');
})();

/* S09 legacy-v1（无 keyVersion、裸拼接键、字段含 |）迁移后引用统一 */
(function () {
  var identity = { source_system: 'legacy', source_account: 'ac|ct', entity_type: 'opportunity', external_id_raw: 'L9' };
  var add = { source_system: 'legacy', source_account: 'ac|ct', entity_type: 'opportunity', external_id_raw: 'L9-ALT' };
  var e = ent('int_s9', identity, [add]);
  var legacyKey = function (x) { return x.source_system + '|' + x.source_account + '|' + x.entity_type + '|' + x.external_id_raw; };
  var byKey = {}; byKey[legacyKey(identity)] = e; byKey[legacyKey(add)] = JSON.parse(JSON.stringify(e));
  var json = JSON.stringify({ byKey: byKey, conflicts: [], reviewEvents: [], canonVersion: 'canon-v3' }); /* 无 keyVersion = legacy-v1 */
  var reg = ID.importState(json);
  var nk1 = ID.identityKeyOf(identity), nk2 = ID.identityKeyOf(add);
  ok(reg.keyVersion === 'esc-v2' && reg.byKey[nk1] && reg.byKey[nk1] === reg.byKey[nk2] && reg.byKey[nk2] === reg.byInternal['int_s9'], 'S09 legacy-v1 迁移到 esc-v2 后：新键三处引用统一');
})();

/* ================= R 组：registerExisting 索引分裂 ================= */
function regWith(objA, objB, key) {
  var reg = ID.createRegistry();
  if (objA) reg.byKey[key] = objA;
  if (objB) reg.byInternal[objB.internalId] = objB;
  return reg;
}
/* R01 双索引同一对象 → UNCHANGED，无 repaired、无冲突 */
(function () {
  var identity = idn('R1'), key = ID.identityKeyOf(identity);
  var e = ent('int_r1', identity);
  var reg = regWith(e, e, key);
  var res = ID.registerExisting(reg, identity, 'int_r1', {});
  ok(res.status === 'UNCHANGED' && !res.repaired && reg.conflicts.length === 0 && reg.byKey[key] === e && reg.byInternal['int_r1'] === e, 'R01 双索引同一对象：UNCHANGED 且注册表零改动');
})();

/* R02 分裂但内容逐项一致（含确认值）→ 明确修复路径统一引用，信息不丢 */
(function () {
  var identity = idn('R2'), key = ID.identityKeyOf(identity);
  var conf = { qty: 42, basedOnHash: 'h42' };
  var objA = ent('int_r2', identity, [], conf);
  var objB = JSON.parse(JSON.stringify(objA));
  var reg = regWith(objA, objB, key);
  var res = ID.registerExisting(reg, identity, 'int_r2', {});
  ok(res.status === 'UNCHANGED' && res.repaired === 'index_unified', 'R02 内容一致的分裂：走 index_unified 明确修复路径');
  ok(reg.byKey[key] === reg.byInternal['int_r2'] && reg.byInternal['int_r2'].confirmedValue.qty === 42, 'R02b 修复后引用统一、员工确认值完整保留');
  var res2 = ID.registerExisting(reg, identity, 'int_r2', {});
  ok(res2.status === 'UNCHANGED' && !res2.repaired, 'R02c 修复后再次登记为普通 UNCHANGED（状态收敛）');
})();

/* R03 分裂且确认值不同 → CONFLICT，双方对象与注册表零改动 */
(function () {
  var identity = idn('R3'), key = ID.identityKeyOf(identity);
  var objA = ent('int_r3', identity, [], null);
  var objB = ent('int_r3', identity, [], { qty: 99, basedOnHash: 'other' });
  var reg = regWith(objA, objB, key);
  var res = ID.registerExisting(reg, identity, 'int_r3', {});
  ok(res.status === 'CONFLICT' && reg.conflicts.length === 1 && reg.conflicts[0].kind === 'index_split_conflict', 'R03 确认值不同的分裂 → index_split_conflict 冲突');
  ok(reg.byKey[key] === objA && reg.byInternal['int_r3'] === objB && objA.confirmedValue === null && objB.confirmedValue.qty === 99, 'R03b 拒绝后两份实体与索引原样保留（无静默覆盖）');
})();

/* R04 byKey 指向的实体 internalId 与请求不一致 → CONFLICT（既有） */
(function () {
  var identity = idn('R4'), key = ID.identityKeyOf(identity);
  var other = ent('int_someone_else', identity);
  var reg = regWith(other, null, key);
  var res = ID.registerExisting(reg, identity, 'int_r4', {});
  ok(res.status === 'CONFLICT' && reg.conflicts[0].kind === 'duplicate_internal', 'R04 身份键已绑他人实体 → duplicate_internal 冲突');
})();

/* R05 byInternal 实体的身份（主+附加）不含请求键 → CONFLICT */
(function () {
  var identity = idn('R5'), otherIdn = idn('R5-OTHER');
  var existing = ent('int_r5', otherIdn);
  var reg = regWith(null, existing, null);
  var res = ID.registerExisting(reg, identity, 'int_r5', {});
  ok(res.status === 'CONFLICT' && reg.conflicts[0].kind === 'conflicting_identity_for_entity', 'R05 内部实体身份与请求键无关 → conflicting 冲突');
})();

/* R06 经附加身份合法登记已绑定实体 → UNCHANGED（R8 放宽归属判定） */
(function () {
  var identity = idn('R6'), add = idn('R6-ALT');
  var e = ent('int_r6', identity, [add]);
  var byKey = {}; byKey[ID.identityKeyOf(identity)] = e; byKey[ID.identityKeyOf(add)] = JSON.parse(JSON.stringify(e));
  var reg = ID.importState(regJson(byKey));
  var res = ID.registerExisting(reg, add, 'int_r6', {});
  ok(res.status === 'UNCHANGED' && reg.conflicts.length === 0, 'R06 用附加身份登记同一实体：正常 UNCHANGED，不再误报 conflicting');
})();

/* R07 附加身份属于其他实体：用 B 的附加键给 A 登记 → CONFLICT */
(function () {
  var idA = idn('R7-A'), idB = idn('R7-B'), addB = idn('R7-B-ALT');
  var eA = ent('int_r7a', idA), eB = ent('int_r7b', idB, [addB]);
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(idA)] = eA; reg.byInternal['int_r7a'] = eA;
  reg.byKey[ID.identityKeyOf(idB)] = eB; reg.byKey[ID.identityKeyOf(addB)] = eB; reg.byInternal['int_r7b'] = eB;
  var res = ID.registerExisting(reg, addB, 'int_r7a', {});
  ok(res.status === 'CONFLICT' && reg.byInternal['int_r7a'] === eA && reg.byKey[ID.identityKeyOf(addB)] === eB, 'R07 他人附加键不得绑到本实体 → 冲突且双方零改动');
})();

/* R08 单边索引缺失的安全修复保留（R6 行为）+ 修复后引用统一 */
(function () {
  var identity = idn('R8'), key = ID.identityKeyOf(identity);
  var e1 = ent('int_r8a', identity);
  var reg1 = regWith(e1, null, key);
  var r1 = ID.registerExisting(reg1, identity, 'int_r8a', {});
  ok(r1.status === 'UNCHANGED' && r1.repaired === 'byInternal' && reg1.byInternal['int_r8a'] === e1, 'R08a 只有 byKey：补 byInternal 指向同一对象');
  var e2 = ent('int_r8b', identity);
  var reg2 = regWith(null, e2, null);
  var r2 = ID.registerExisting(reg2, identity, 'int_r8b', {});
  ok(r2.status === 'UNCHANGED' && r2.repaired === 'byKey' && reg2.byKey[key] === e2, 'R08b 只有 byInternal：补 byKey 指向同一对象');
})();

/* R09 单边 byKey 命中但键与实体身份不符（错位索引）→ 拒绝绑定 */
(function () {
  var identity = idn('R9'), key = ID.identityKeyOf(identity);
  var wrong = ent('int_r9', idn('R9-REAL')); /* 实体真实身份是别的键 */
  var reg = regWith(wrong, null, key);
  var res = ID.registerExisting(reg, identity, 'int_r9', {});
  ok(res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_key_mismatch' && !reg.byInternal['int_r9'], 'R09 错位索引：index_key_mismatch 冲突，未把 internalId 绑到错误实体');
})();

/* ================= N 组：canon-v3 数值有限性 ================= */
var baseContent = { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' };
function withQty(q) { var c = JSON.parse(JSON.stringify(baseContent)); c.qty = q; return c; }
/* 注：JSON 往返会把 NaN/undefined 变 null，故含特殊值的用例直接构造对象 */
function withQtyRaw(q) { var c = {}; Object.keys(baseContent).forEach(function (k) { c[k] = baseContent[k]; }); c.qty = q; return c; }

(function () {
  ok(ID.canonicalize(withQty(5), 'opportunity').indexOf('qty=n:1:5') >= 0, 'N01a 正常正数 5 编码 n:1:5');
  ok(ID.canonicalize(withQty(-3), 'opportunity').indexOf('qty=n:2:-3') >= 0, 'N01b 正常负数 -3 编码 n:2:-3');
  ok(ID.canonicalize(withQty(0), 'opportunity').indexOf('qty=n:1:0') >= 0, 'N01c 0 编码 n:1:0');
  ok(ID.canonicalize(withQtyRaw(-0), 'opportunity') === ID.canonicalize(withQty(0), 'opportunity'), 'N02 -0 与 0 规范化相同（既定语义：JSON 往返同样归一，业务量无独立含义）');
  [NaN, Infinity, -Infinity].forEach(function (v, i) {
    var err = throwsCode(function () { ID.canonicalize(withQtyRaw(v), 'opportunity'); }, 'canon_type_invalid');
    ok(!!err && !err.wrong && /qty/.test(err.message), 'N03' + 'abc'[i] + ' ' + String(v) + ' → canon_type_invalid（消息含字段名）');
  });
  var eStr = throwsCode(function () { ID.canonicalize(withQtyRaw('5'), 'opportunity'); }, 'canon_type_invalid');
  var eBool = throwsCode(function () { ID.canonicalize(withQtyRaw(true), 'opportunity'); }, 'canon_type_invalid');
  var eObj = throwsCode(function () { ID.canonicalize(withQtyRaw({}), 'opportunity'); }, 'canon_type_invalid');
  var eArr = throwsCode(function () { ID.canonicalize(withQtyRaw([5]), 'opportunity'); }, 'canon_type_invalid');
  ok(!!eStr && !!eBool && !!eObj && !!eArr, 'N04 数字字符串/布尔/对象/数组 → 全部 canon_type_invalid');
  ok(ID.canonicalize(withQtyRaw(undefined), 'opportunity').indexOf('qty=M') >= 0, 'N05a 缺失（undefined）→ M，不抛错');
  ok(ID.canonicalize(withQtyRaw(null), 'opportunity').indexOf('qty=Z') >= 0, 'N05b null → Z，不抛错');
  var eHash = throwsCode(function () { ID.contentHash(withQtyRaw(NaN), 'opportunity'); }, 'canon_type_invalid');
  ok(!!eHash && !eHash.wrong, 'N06 contentHash 对 NaN 同样拒绝');
  /* N07 实际导入流程：importRecord 遇 Infinity 抛错且注册表零改动 */
  var reg = ID.createRegistry();
  var threw = null;
  try { ID.importRecord(reg, { identity: idn('N7'), content: withQtyRaw(Infinity), sourceVersion: 1 }); } catch (e) { threw = e; }
  ok(!!threw && threw.code === 'canon_type_invalid' && Object.keys(reg.byKey).length === 0 && Object.keys(reg.byInternal).length === 0, 'N07 importRecord 非有限数值：抛错且未进注册表');
  /* N08 v1 历史语义不变：canon-v1 对 NaN 仍按旧规则 String 化（不属 R8 变更范围） */
  var v1 = ID.canonicalize(withQtyRaw(NaN), 'opportunity', 'canon-v1');
  ok(typeof v1 === 'string' && v1.indexOf('qty=n:NaN') >= 0, 'N08 canon-v1 历史语义保持（n:NaN），未被 R8 误改');
})();

console.log('== identity-r8: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
