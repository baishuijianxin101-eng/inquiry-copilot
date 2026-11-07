/* P1-23-R7-R8-R4：纯 JSON 属性边界、registerExisting 结构防守、
   importState 单键非有限数值专项。
   A 组（故障注入）：isPlainJsonValue 全部自有属性边界；
   B 组（故障注入）：含隐藏属性的分裂实体不得统一；
   C 组（故障注入）：registerExisting 单边/双边结构防守；
   D 组（正常业务+故障注入）：importState 单键异常与各入口处理；
   E 组（正常业务）：双索引完整性复核。
   引用断言一律严格 ===；拒绝路径同时断言状态不变。
   全部虚构数据；本文件为 Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var MIG = require('../assets/identity-migration.js');
var TXN = require('../assets/identity-txn.js');
/* 注：真实 core.js 依赖 window，不在 Node 桩中直接加载；D07/D08 只需
   buildBackup 读取的 STORE_KEY 与 get()，用与既有 txn 测试相同的桩约定。 */
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function thrown(fn) { try { fn(); return null; } catch (e) { return e; } }
function idn(raw, acct) { return { source_system: 'alibaba_api', source_account: acct || 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
function ent(internalId, identity, adds, confirmed) {
  return { internalId: internalId, identity: identity, additionalIdentities: adds || [],
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: confirmed || null, archived: false };
}

/* ================= A 组：isPlainJsonValue 属性边界 ================= */
(function () {
  var P = ID._isPlainJsonValue;
  var sym = {}; sym[Symbol('s')] = 1;
  var nonEnum = {}; Object.defineProperty(nonEnum, 'hidden', { value: 1, enumerable: false });
  var getterInvoked = false;
  var withGetter = {}; Object.defineProperty(withGetter, 'evil', { enumerable: true, get: function () { getterInvoked = true; return 1; } });
  var withSetter = {}; Object.defineProperty(withSetter, 'evil', { enumerable: true, set: function (v) {} });
  var arrSym = [1]; arrSym[Symbol('s')] = 2;
  var arrNonEnum = [1]; Object.defineProperty(arrNonEnum, 'extra', { value: 9, enumerable: false });
  var arrGetterInvoked = false;
  var arrGetter = [1]; Object.defineProperty(arrGetter, '0', { enumerable: true, get: function () { arrGetterInvoked = true; return 1; } });
  var arrExtra = [1]; arrExtra.foo = 'x';
  var shared = { v: 1 };
  ok(P(sym) === false, 'A01 对象含 Symbol 自有属性 → 拒绝');
  ok(P(nonEnum) === false, 'A02 对象含不可枚举自有属性 → 拒绝');
  ok(P(withGetter) === false && getterInvoked === false, 'A03 对象含 getter 属性 → 拒绝且 getter 未被执行');
  ok(P(withSetter) === false, 'A04 对象含 setter-only 属性 → 拒绝');
  ok(P(arrSym) === false, 'A05 数组含 Symbol 属性 → 拒绝');
  ok(P(arrNonEnum) === false, 'A06 数组含不可枚举附加属性 → 拒绝');
  ok(P(arrGetter) === false && arrGetterInvoked === false, 'A07 数组元素为访问器 → 拒绝且 getter 未被执行');
  ok(P(arrExtra) === false, 'A08 数组含非标准附加属性 → 拒绝');
  ok(P([,,]) === false, 'A09 稀疏数组 → 拒绝');
  ok(P({ a: shared, b: shared }) === true, 'A10 菱形重复引用（非循环）→ 通过');
  var cyc = {}; cyc.me = cyc;
  ok(P(cyc) === false, 'A11 循环引用 → 拒绝');
  ok(P({ a: [1, 'x', null, true, { b: 2.5 }] }) === true, 'A12 正常深层 JSON → 通过（无误拒绝）');
  var np = Object.create(null); np.k = 'v';
  ok(P(np) === true, 'A13 无原型普通对象 → 通过');
  ok(P({ d: new Date(0) }) === false && P(NaN) === false && P({ q: Infinity }) === false, 'A14 Date/NaN/Infinity → 拒绝');
  /* A15 跨 realm：其他 realm 的普通对象必须通过、Date 必须拒绝
     （I30c 真实 Core 集成测试曾因 realm 敏感的原型比较误拒整表注册表） */
  var vm = require('vm');
  var foreign = vm.runInNewContext('({ a: [1, 2], b: { c: "x" } })');
  var foreignDate = vm.runInNewContext('({ d: new Date(0) })');
  ok(P(foreign) === true, 'A15a 跨 realm 普通对象 → 通过');
  ok(P(foreignDate) === false, 'A15b 跨 realm Date → 拒绝');
})();

/* ================= B 组：隐藏属性不同的分裂实体 ================= */
(function () {
  var identity = idn('B1'), key = ID.identityKeyOf(identity);
  var objA = ent('int_b1', identity);
  var objB = ent('int_b1', identity);
  Object.defineProperty(objB, 'secretNote', { value: 'only-in-b', enumerable: false }); /* 可见内容相同、隐藏属性不同 */
  ok(ID._stableStringify(objA) === ID._stableStringify(objB), 'B01-0 前置事实：隐藏属性对 stableStringify 不可见（文本相同）');
  var reg = ID.createRegistry(); reg.byKey[key] = objA; reg.byInternal['int_b1'] = objB;
  var res = ID.registerExisting(reg, identity, 'int_b1', {});
  ok(res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_split_unverifiable', 'B01 隐藏属性不同 → 拒绝统一（不凭可见文本相同判一致）');
  ok(reg.byKey[key] === objA && reg.byInternal['int_b1'] === objB, 'B01b 拒绝后双方引用不变');
  var objC = ent('int_b1', identity); objC[Symbol('tag')] = 'x';
  var reg2 = ID.createRegistry(); reg2.byKey[key] = objC; reg2.byInternal['int_b1'] = objA;
  var res2 = ID.registerExisting(reg2, identity, 'int_b1', {});
  ok(res2.status === 'CONFLICT' && reg2.byKey[key] === objC && reg2.byInternal['int_b1'] === objA, 'B02 一份含 Symbol 属性 → 拒绝统一、状态不变');
  var invoked = false;
  var objD = ent('int_b1', identity);
  Object.defineProperty(objD, 'evil', { enumerable: true, get: function () { invoked = true; return 0; } });
  var reg3 = ID.createRegistry(); reg3.byKey[key] = objD; reg3.byInternal['int_b1'] = objA;
  var res3 = null, err3 = null;
  try { res3 = ID.registerExisting(reg3, identity, 'int_b1', {}); } catch (e) { err3 = e; }
  ok(!err3 && res3 && res3.status === 'CONFLICT' && invoked === false, 'B03 含 getter 的分裂实体 → 冲突、无异常逃逸、getter 未执行');
  var objE = ent('int_b1', identity); objE.loop = objE;
  var reg4 = ID.createRegistry(); reg4.byKey[key] = objE; reg4.byInternal['int_b1'] = objA;
  var res4 = null, err4 = null;
  try { res4 = ID.registerExisting(reg4, identity, 'int_b1', {}); } catch (e) { err4 = e; }
  ok(!err4 && res4 && res4.status === 'CONFLICT' && reg4.byKey[key] === objE, 'B04 循环引用分裂实体 → 冲突、无栈溢出、状态不变');
})();

/* ================= C 组：registerExisting 结构防守 ================= */
(function () {
  /* C01 byInternal 命中但 additionalIdentities 损坏（字符串）→ 拒绝、不抛错、不建键 */
  var e1 = ent('int_c1', idn('C1')); e1.additionalIdentities = 'garbage';
  var reg1 = ID.createRegistry(); reg1.byInternal['int_c1'] = e1;
  var r1 = null, err1 = null;
  try { r1 = ID.registerExisting(reg1, idn('C1'), 'int_c1', {}); } catch (e) { err1 = e; }
  ok(!err1 && r1 && r1.status === 'CONFLICT' && reg1.conflicts[0].kind === 'index_entity_invalid' && Object.keys(reg1.byKey).length === 0, 'C01 byInternal 附加身份损坏（字符串）→ index_entity_invalid、无 TypeError 逃逸、未建键');
  /* C02 byKey 命中但 additionalIdentities 损坏（数字）→ 拒绝、byInternal 不被补 */
  var e2 = ent('int_c2', idn('C2')); e2.additionalIdentities = 42;
  var key2 = ID.identityKeyOf(idn('C2'));
  var reg2 = ID.createRegistry(); reg2.byKey[key2] = e2;
  var r2 = ID.registerExisting(reg2, idn('C2'), 'int_c2', {});
  ok(r2.status === 'CONFLICT' && reg2.conflicts[0].kind === 'index_entity_invalid' && !reg2.byInternal['int_c2'] && reg2.byKey[key2] === e2, 'C02 byKey 附加身份损坏（数字）→ 拒绝、未补 byInternal、原索引不变');
  /* C03 byInternal 实体主身份缺字段 → 拒绝 */
  var e3 = ent('int_c3', { source_system: 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity' });
  var reg3 = ID.createRegistry(); reg3.byInternal['int_c3'] = e3;
  var r3 = ID.registerExisting(reg3, idn('C3'), 'int_c3', {});
  ok(r3.status === 'CONFLICT' && Object.keys(reg3.byKey).length === 0, 'C03 主身份缺 external_id_raw → 冲突、未补 byKey');
  /* C04 byInternal 实体的 internalId 与请求不一致 → 拒绝 */
  var e4 = ent('int_someone_else', idn('C4'));
  var reg4 = ID.createRegistry(); reg4.byInternal['int_c4'] = e4;
  var r4 = ID.registerExisting(reg4, idn('C4'), 'int_c4', {});
  ok(r4.status === 'CONFLICT' && Object.keys(reg4.byKey).length === 0, 'C04 实体 internalId 与索引键不一致 → 冲突、未绑定');
  /* C05 结构完好的 byInternal 单边 + 附加身份请求 → 正常修复（防守不误伤） */
  var e5 = ent('int_c5', idn('C5'), [idn('C5-A')]);
  var reg5 = ID.createRegistry(); reg5.byInternal['int_c5'] = e5;
  var r5 = ID.registerExisting(reg5, idn('C5-A'), 'int_c5', {});
  ok(r5.status === 'UNCHANGED' && r5.repaired === 'byKey' && reg5.byKey[ID.identityKeyOf(idn('C5-A'))] === e5, 'C05 结构完好时单边修复照常工作');
  /* C06 附加身份列表内含损坏项（缺账号）→ 拒绝 */
  var e6 = ent('int_c6', idn('C6'), [{ source_system: 'alibaba_api', entity_type: 'opportunity', external_id_raw: 'X' }]);
  var reg6 = ID.createRegistry(); reg6.byInternal['int_c6'] = e6;
  var r6 = ID.registerExisting(reg6, idn('C6'), 'int_c6', {});
  ok(r6.status === 'CONFLICT' && reg6.conflicts[0].kind === 'index_entity_invalid', 'C06 附加身份项缺账号 → index_entity_invalid 拒绝');
})();

/* ================= D 组：importState 单键异常与入口 ================= */
function registryText(identity, qtyText, canonVersion) {
  var e = ent('int_d', identity);
  var t = JSON.stringify(e).replace('"qty":5', '"qty":' + qtyText);
  return '{"byKey":{"' + ID.identityKeyOf(identity) + '":' + t + '},"conflicts":[],"reviewEvents":[],"canonVersion":"' + canonVersion + '","keyVersion":"esc-v2"}';
}
(function () {
  var errV3 = thrown(function () { ID.importState(registryText(idn('D1'), '1e999', 'canon-v3')); });
  ok(!!errV3 && errV3.code === 'registry_entity_content_invalid', 'D01 canon-v3 单键 1e999 → registry_entity_content_invalid（导入期拒绝）');
  var regOk = ID.importState(registryText(idn('D2'), '5', 'canon-v3'));
  ok(!!regOk.byInternal['int_d'], 'D02 canon-v3 正常单键 → 导入成功（不误伤）');
  var regV1 = ID.importState(registryText(idn('D3'), '1e999', 'canon-v1'));
  ok(regV1.canonVersion === 'canon-v1' && regV1.byInternal['int_d'].content.qty === Infinity, 'D03 canon-v1 单键 1e999 → 历史语义兼容、照常导入（不按 v3 拒绝）');
  var regV2 = ID.importState(registryText(idn('D4'), '1e999', 'canon-v2'));
  ok(regV2.canonVersion === 'canon-v2' && !!regV2.byInternal['int_d'], 'D04 canon-v2 单键 1e999 → 兼容导入');
  var regStr = ID.importState(registryText(idn('D5'), '"5"', 'canon-v3'));
  ok(!!regStr.byInternal['int_d'], 'D05 canon-v3 字段类型异常但纯 JSON（qty 字符串）→ importState 不越界拒绝（类型语义归 importRecord 的 canonicalize）');
  /* D06 入口一：loadRegistry（主入口）的既有契约是不抛错、三态返回——
     异常注册表必须得到 registryLoadState='corrupt' 且空注册表（异常实体
     绝不进入返回的注册表），由调用方按状态阻断（commitImport 等已如此）。 */
  var store = { _m: {}, getItem: function (k) { return this._m[k] || null; }, setItem: function (k, v) { this._m[k] = String(v); }, removeItem: function (k) { delete this._m[k]; } };
  store.setItem('ic_identity_registry_v1', registryText(idn('D6'), '1e999', 'canon-v3'));
  var loaded = MIG.loadRegistry(store);
  ok(loaded.registryLoadState === 'corrupt' && Object.keys(loaded.byKey).length === 0 && Object.keys(loaded.byInternal).length === 0, 'D06 loadRegistry 遇异常注册表 → corrupt 三态 + 空注册表（异常实体未进入）');
  ok(MIG.loadRegistryStatus(store) === 'corrupt', 'D06b loadRegistryStatus → corrupt（与 absent/ok 区分）');
  /* D07 入口二：buildBackup 对异常注册表明确 registry_corrupt，不把异常实体导出进备份（签名 buildBackup(core, storage)） */
  var coreState = { products: [], opportunities: [], customers: [], followUps: [], quotes: [], costItems: [], settings: {}, version: 1 };
  var coreStub = { STORE_KEY: 'ali_commission_copilot_v1', get: function () { return coreState; } };
  var bkErr = null, bk = null;
  try { bk = TXN.buildBackup(coreStub, store); } catch (e) { bkErr = e; }
  ok(!!bkErr && bkErr.message === 'registry_corrupt' && bk === null, 'D07 buildBackup 遇异常注册表 → registry_corrupt 中止，不导出异常实体');
  /* D08 入口三：干净注册表时 buildBackup 正常（对照，证明 D07 不是恒失败） */
  var store2 = { _m: {}, getItem: function (k) { return this._m[k] || null; }, setItem: function (k, v) { this._m[k] = String(v); }, removeItem: function (k) { delete this._m[k]; } };
  var bk2 = null, bk2Err = null;
  try { bk2 = TXN.buildBackup(coreStub, store2); } catch (e) { bk2Err = e; }
  ok(!bk2Err && !!bk2 && bk2.format === 'ic-backup', 'D08 无注册表（首次）时 buildBackup 正常产出');
})();

/* ================= E 组：双索引完整性复核 ================= */
(function () {
  var identity = idn('E1'), a1 = idn('E1-A'), a2 = idn('E1-B');
  var e = ent('int_e1', identity, [a1, a2]);
  var reg = ID.createRegistry(); reg.byKey[ID.identityKeyOf(identity)] = e; reg.byInternal['int_e1'] = e;
  var r = ID.registerExisting(reg, identity, 'int_e1', {});
  ok(r.status === 'UNCHANGED' && !r.repaired && reg.conflicts.length === 0, 'E01 双索引同一对象+身份正确 → 普通 UNCHANGED');
  var objB = ent('int_e2', identity, [a1, a2], { qty: 3, basedOnHash: 'h' });
  var objA = JSON.parse(JSON.stringify(objB));
  var reg2 = ID.createRegistry();
  reg2.byKey[ID.identityKeyOf(identity)] = objA; reg2.byInternal['int_e2'] = objB;
  var r2 = ID.registerExisting(reg2, identity, 'int_e2', {});
  var allEq = [identity, a1, a2].every(function (x) { return reg2.byKey[ID.identityKeyOf(x)] === objB; }) && reg2.byInternal['int_e2'] === objB;
  ok(r2.repaired === 'index_unified' && allEq, 'E02 分裂内容相同 → 主+全部附加键+byInternal 严格同一引用（=== 逐键检查）');
  var objC = ent('int_e3', identity, [a1], { qty: 1, basedOnHash: 'x' });
  var objD = ent('int_e3', identity, [a1], { qty: 2, basedOnHash: 'y' });
  var reg3 = ID.createRegistry();
  reg3.byKey[ID.identityKeyOf(identity)] = objC; reg3.byKey[ID.identityKeyOf(a1)] = objC; reg3.byInternal['int_e3'] = objD;
  var snapC = JSON.stringify(objC), snapD = JSON.stringify(objD);
  var r3 = ID.registerExisting(reg3, identity, 'int_e3', {});
  ok(r3.status === 'CONFLICT' && reg3.byKey[ID.identityKeyOf(identity)] === objC && reg3.byKey[ID.identityKeyOf(a1)] === objC && reg3.byInternal['int_e3'] === objD && JSON.stringify(objC) === snapC && JSON.stringify(objD) === snapD, 'E03 确认值不同 → 冲突、全部索引与两份实体逐项不变');
})();

console.log('== identity-r8-r4: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
