/* P1-23-R7-R8-R3：版本字段校验、stableStringify 运行时安全、
   registerExisting 完整一致性专项。
   V 组：canonVersion/keyVersion 缺失与非法区分（第一项）；
   P 组：纯 JSON 验证与比较点安全（第二项）；
   G 组：registerExisting 多附加/全键统一/冲突不变性（第三项）。
   引用断言一律严格 ===；失败用例同时检查状态未被修改。
   全部虚构数据；本文件为 Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
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
function regJsonObj(byKey, extra) {
  var o = { byKey: byKey, conflicts: [], reviewEvents: [] };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return JSON.stringify(o);
}
function oneEntByKey(identity) { var byKey = {}; byKey[ID.identityKeyOf(identity)] = ent('int_v', identity); return byKey; }

/* ================= V 组：版本字段 ================= */
/* V01 canonVersion 缺失 → 兼容默认（canon-v3），正常导入 */
(function () {
  var reg = ID.importState(regJsonObj(oneEntByKey(idn('V1')), { keyVersion: 'esc-v2' }));
  ok(reg.canonVersion === 'canon-v3', 'V01 canonVersion 缺失 → 默认当前版本，导入成功');
})();
/* V02 canonVersion 合法三值全部保留 */
(function () {
  ['canon-v1', 'canon-v2', 'canon-v3'].forEach(function (cv) {
    var reg = ID.importState(regJsonObj(oneEntByKey(idn('V2')), { canonVersion: cv, keyVersion: 'esc-v2' }));
    ok(reg.canonVersion === cv, 'V02 ' + cv + ' 合法保留');
  });
})();
/* V03 canonVersion 存在但非法类型/空串 → canon_version_invalid（逐个） */
(function () {
  ['', null, 3, true, {}, []].forEach(function (bad, i) {
    var err = thrown(function () { ID.importState(regJsonObj(oneEntByKey(idn('V3')), { canonVersion: bad, keyVersion: 'esc-v2' })); });
    ok(!!err && err.code === 'registry_canon_version_invalid', 'V03-' + i + ' canonVersion=' + JSON.stringify(bad) + ' → registry_canon_version_invalid', err && err.code);
  });
})();
/* V04 canonVersion 未知字符串 → unknown_canon_version（与类型非法区分） */
(function () {
  var err = thrown(function () { ID.importState(regJsonObj(oneEntByKey(idn('V4')), { canonVersion: 'canon-v9', keyVersion: 'esc-v2' })); });
  ok(!!err && err.code === 'registry_unknown_canon_version', 'V04 canon-v9 → registry_unknown_canon_version');
})();
/* V05 keyVersion 缺失 → legacy-v1 迁移（裸键被接受并迁移） */
(function () {
  var identity = { source_system: 'legacy', source_account: 'local-instance', entity_type: 'opportunity', external_id_raw: 'V5' };
  var byKey = {}; byKey['legacy|local-instance|opportunity|V5'] = ent('int_v5', identity);
  var reg = ID.importState(JSON.stringify({ byKey: byKey, conflicts: [], reviewEvents: [], canonVersion: 'canon-v3' }));
  ok(reg.keyVersion === 'esc-v2' && reg.byKey[ID.identityKeyOf(identity)] === reg.byInternal['int_v5'], 'V05 keyVersion 缺失 → legacy 迁移、esc-v2 键、引用统一');
})();
/* V06 keyVersion 显式 legacy-v1 与 esc-v2 均合法 */
(function () {
  var identity = { source_system: 'legacy', source_account: 'local-instance', entity_type: 'opportunity', external_id_raw: 'V6' };
  var byKeyL = {}; byKeyL['legacy|local-instance|opportunity|V6'] = ent('int_v6', identity);
  var regL = ID.importState(JSON.stringify({ byKey: byKeyL, conflicts: [], reviewEvents: [], canonVersion: 'canon-v3', keyVersion: 'legacy-v1' }));
  ok(regL.keyVersion === 'esc-v2', 'V06a 显式 legacy-v1 → 迁移为 esc-v2');
  var regE = ID.importState(regJsonObj(oneEntByKey(idn('V6')), { canonVersion: 'canon-v3', keyVersion: 'esc-v2' }));
  ok(regE.keyVersion === 'esc-v2', 'V06b esc-v2 原样读取');
})();
/* V07 keyVersion 存在但非法类型/空串 → key_version_invalid（逐个） */
(function () {
  ['', null, 2, false, {}, []].forEach(function (bad, i) {
    var err = thrown(function () { ID.importState(regJsonObj(oneEntByKey(idn('V7')), { canonVersion: 'canon-v3', keyVersion: bad })); });
    ok(!!err && err.code === 'registry_key_version_invalid', 'V07-' + i + ' keyVersion=' + JSON.stringify(bad) + ' → registry_key_version_invalid', err && err.code);
  });
})();
/* V08 keyVersion 未知字符串 → unknown_key_version */
(function () {
  var err = thrown(function () { ID.importState(regJsonObj(oneEntByKey(idn('V8')), { canonVersion: 'canon-v3', keyVersion: 'esc-v1' })); });
  ok(!!err && err.code === 'registry_unknown_key_version', 'V08 esc-v1 → registry_unknown_key_version');
})();
/* V09 旧格式固定夹具：legacy 注册表（无版本字段、账号含 |）迁移前后键值 */
(function () {
  var identity = { source_system: 'legacy', source_account: 'ac|ct', entity_type: 'opportunity', external_id_raw: 'L9' };
  var add = { source_system: 'legacy', source_account: 'ac|ct', entity_type: 'opportunity', external_id_raw: 'L9-ALT' };
  var e = ent('int_fix', identity, [add]);
  var byKey = {};
  byKey['legacy|ac|ct|opportunity|L9'] = e;
  byKey['legacy|ac|ct|opportunity|L9-ALT'] = JSON.parse(JSON.stringify(e));
  var reg = ID.importState(JSON.stringify({ byKey: byKey, conflicts: [], reviewEvents: [] })); /* 两版本字段皆缺失 */
  var keys = Object.keys(reg.byKey).sort();
  var expect = ['legacy|ac\\|ct|opportunity|L9', 'legacy|ac\\|ct|opportunity|L9-ALT'].sort();
  ok(JSON.stringify(keys) === JSON.stringify(expect), 'V09a 迁移后键集合与固定夹具逐字一致（esc-v2 转义）', JSON.stringify(keys));
  ok(reg.canonVersion === 'canon-v3' && reg.keyVersion === 'esc-v2' && reg.byKey[expect[0]] === reg.byInternal['int_fix'] && reg.byKey[expect[1]] === reg.byInternal['int_fix'], 'V09b 版本归一 + 双键与 byInternal 引用统一');
})();
/* V10 canon-v1 固定夹具哈希语义不变 */
(function () {
  var c = { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' };
  ok(ID.contentHash(c, 'opportunity', 'canon-v1') === 'fnv1a32x2:79acda8c1af648e3', 'V10 canon-v1 夹具哈希与 R8 前记录逐字一致（历史语义未变）');
})();

/* ================= P 组：纯 JSON 验证 ================= */
/* P01 isPlainJsonValue 分类（直接验证辅助函数，行为后果由 P03–P06 经真实入口验证） */
(function () {
  var P = ID._isPlainJsonValue;
  var cyc = { a: 1 }; cyc.self = cyc;
  function Foo() { this.x = 1; }
  var extra = [1, 2]; extra.foo = 'x';
  var cases = [
    ['普通嵌套', { a: [1, 'x', null, true, { b: 2 }] }, true],
    ['无原型对象', Object.create(null), true],
    ['同对象非祖先重复引用（菱形）', (function () { var s = { v: 1 }; return { a: s, b: s }; })(), true],
    ['undefined', undefined, false],
    ['顶层 NaN', NaN, false],
    ['嵌套 Infinity', { a: { b: [Infinity] } }, false],
    ['数组中 undefined', [undefined], false],
    ['稀疏数组', [,,], false],
    ['带附加属性的数组', extra, false],
    ['Date', { d: new Date(0) }, false],
    ['类实例', new Foo(), false],
    ['函数值', { f: function () {} }, false],
    ['循环引用', cyc, false]
  ];
  cases.forEach(function (cs, i) { ok(P(cs[1]) === cs[2], 'P01-' + i + ' ' + cs[0] + ' → ' + cs[2]); });
})();
/* P02 stableStringify 键序无关（合法实体比较语义不变） */
(function () {
  var a = { x: 1, y: { c: 2, d: [3, { e: 4, f: 5 }] } };
  var b = { y: { d: [3, { f: 5, e: 4 }], c: 2 }, x: 1 };
  ok(ID._stableStringify(a) === ID._stableStringify(b), 'P02 键序不同、内容相同 → 稳定序列化相等');
})();
/* P03 registerExisting：NaN 副本 vs null 副本（文本相撞）→ unverifiable 冲突、零改动 */
(function () {
  var identity = idn('P3'), key = ID.identityKeyOf(identity);
  var objA = ent('int_p3', identity, [], { qty: NaN, basedOnHash: 'h' });
  var objB = ent('int_p3', identity, [], { qty: null, basedOnHash: 'h' });
  ok(ID._stableStringify(objA) === ID._stableStringify(objB), 'P03-0 前置事实：NaN/null 两份实体的稳定文本确实相撞（旧判定会误判一致）');
  var reg = ID.createRegistry(); reg.byKey[key] = objA; reg.byInternal['int_p3'] = objB;
  var res = ID.registerExisting(reg, identity, 'int_p3', {});
  ok(res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_split_unverifiable', 'P03 相撞文本不放行 → index_split_unverifiable 冲突');
  ok(reg.byKey[key] === objA && reg.byInternal['int_p3'] === objB, 'P03b 拒绝后索引与对象零改动（未统一、未覆盖）');
})();
/* P04 registerExisting：循环引用实体 → 冲突而非栈溢出，状态不变 */
(function () {
  var identity = idn('P4'), key = ID.identityKeyOf(identity);
  var objA = ent('int_p4', identity); objA.loop = objA;
  var objB = ent('int_p4', identity);
  var reg = ID.createRegistry(); reg.byKey[key] = objA; reg.byInternal['int_p4'] = objB;
  var res = null, err = null;
  try { res = ID.registerExisting(reg, identity, 'int_p4', {}); } catch (e) { err = e; }
  ok(!err && res && res.status === 'CONFLICT' && reg.byKey[key] === objA && reg.byInternal['int_p4'] === objB, 'P04 循环引用 → CONFLICT（无异常逃逸）、状态不变');
})();
/* P05 registerExisting：Date 字段副本（文本同为 {}）→ unverifiable 冲突 */
(function () {
  var identity = idn('P5'), key = ID.identityKeyOf(identity);
  var objA = ent('int_p5', identity); objA.content.when = new Date(1000);
  var objB = ent('int_p5', identity); objB.content.when = new Date(9999);
  var reg = ID.createRegistry(); reg.byKey[key] = objA; reg.byInternal['int_p5'] = objB;
  var res = ID.registerExisting(reg, identity, 'int_p5', {});
  ok(res.status === 'CONFLICT' && reg.conflicts[0].kind === 'index_split_unverifiable' && reg.byKey[key] === objA, 'P05 不同 Date 不因空键文本相撞而被判一致');
})();
/* P06 importState：副本一份 qty=1e999（解析为 Infinity）、一份 qty=null → 拒绝
   【R8 收尾修订，2026-11-06】原期望 registry_internal_id_conflict 是
   R8-R3 的契约（纯 JSON 门禁仅作用于副本判等）。R8-R4 任务书将门禁
   扩大为逐实体校验并明确指示本条期望改为
   registry_entity_content_invalid（逐实体校验先于副本判等触发，
   见 R8-R4 报告与 test-identity-r8-r4.js D01）；该修订曾被 R8-R4-R1
   暂缓恢复原样等待裁定，本轮依据两轮任务书证据正式对齐。断言仍为
   特定错误码的严格相等（未放宽）：受保护性质不变——该注册表必须
   被拒绝、两份副本不得被判一致或静默统一。副本判等防线本身仍在
   代码中，纯 JSON 双副本内容不一致仍走 internal_id_conflict（由
   test-identity-r8-rollback-verify.js R10 锁定）。原始断言文本保
   存在 R8 收尾交付目录的 test-identity-r8-r3.js.ORIGINAL-R8R3。 */
(function () {
  var identity = idn('P6'), add = idn('P6-ALT');
  var e = ent('int_p6', identity, [add]);
  var t1 = JSON.stringify(e);
  var t2 = JSON.stringify(e).replace('"qty":5', '"qty":null');
  var t1i = t1.replace('"qty":5', '"qty":1e999');
  var byKeyText = '{"' + ID.identityKeyOf(identity) + '":' + t1i + ',"' + ID.identityKeyOf(add) + '":' + t2 + '}';
  var json = '{"byKey":' + byKeyText + ',"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v3","keyVersion":"esc-v2"}';
  var err = thrown(function () { ID.importState(json); });
  ok(!!err && err.code === 'registry_entity_content_invalid', 'P06 Infinity 副本 vs null 副本 → 拒绝（R8-R4 起逐实体门禁先行：entity_content_invalid；不得凭 null 文本相撞判一致）', err && err.code);
})();
/* P07 importState：单键实体含 1e999（无副本比较）
   【R8 收尾修订，2026-11-06】原断言期望「正常导入」（R8-R3 范围：
   门禁仅限副本判等，注释原文为「本轮验证范围仅限副本判等」），且
   未捕获异常——R8-R4 逐实体门禁上线后该导入改为抛错，未捕获异常
   中断了本文件执行、其后 G 组 9 条断言从未运行。R8-R4 任务书已明
   确指示本条期望改为 registry_entity_content_invalid 拒绝（同
   D01）。本轮据此对齐并改用 thrown() 捕获，使文件可完整执行；
   原始断言文本保存在 R8 收尾交付目录的 .ORIGINAL-R8R3 副本。 */
(function () {
  var identity = idn('P7');
  var e = ent('int_p7', identity);
  var t = JSON.stringify(e).replace('"qty":5', '"qty":1e999');
  var json = '{"byKey":{"' + ID.identityKeyOf(identity) + '":' + t + '},"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v3","keyVersion":"esc-v2"}';
  var err = thrown(function () { ID.importState(json); });
  ok(!!err && err.code === 'registry_entity_content_invalid', 'P07 单键无副本含 1e999 → registry_entity_content_invalid（R8-R4 逐实体门禁）', err && err.code);
})();

/* ================= G 组：registerExisting 完整一致性 ================= */
/* G01 分裂统一覆盖全部键：附加键一指向旧对象、附加键二缺失 → 全部收敛 */
(function () {
  var identity = idn('G1'), a1 = idn('G1-A'), a2 = idn('G1-B');
  var conf = { qty: 7, basedOnHash: 'h7' };
  var objB = ent('int_g1', identity, [a1, a2], conf);
  var objA = JSON.parse(JSON.stringify(objB));
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = objA;
  reg.byKey[ID.identityKeyOf(a1)] = objA;
  /* a2 键缺失 */
  reg.byInternal['int_g1'] = objB;
  var res = ID.registerExisting(reg, identity, 'int_g1', {});
  var allSame = [identity, a1, a2].every(function (x) { return reg.byKey[ID.identityKeyOf(x)] === objB; });
  ok(res.status === 'UNCHANGED' && res.repaired === 'index_unified' && allSame && reg.byInternal['int_g1'] === objB, 'G01 统一后主+全部附加键+byInternal 严格同一对象');
  ok(objB.confirmedValue === conf && objB.additionalIdentities.length === 2, 'G01b 确认值对象引用与附加身份完整保留');
  var res2 = ID.registerExisting(reg, a2, 'int_g1', {});
  ok(res2.status === 'UNCHANGED' && !res2.repaired && reg.conflicts.length === 0, 'G01c 经任一附加键再次登记收敛为普通 UNCHANGED');
})();
/* G02 分裂统一：附加键指向 byInternal 一侧（混合指向）→ 同样全量收敛 */
(function () {
  var identity = idn('G2'), a1 = idn('G2-A');
  var objB = ent('int_g2', identity, [a1]);
  var objA = JSON.parse(JSON.stringify(objB));
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = objA;
  reg.byKey[ID.identityKeyOf(a1)] = objB;
  reg.byInternal['int_g2'] = objB;
  var res = ID.registerExisting(reg, identity, 'int_g2', {});
  ok(res.repaired === 'index_unified' && reg.byKey[ID.identityKeyOf(identity)] === objB && reg.byKey[ID.identityKeyOf(a1)] === objB, 'G02 混合指向分裂 → 全键统一到规范对象');
})();
/* G03 附加键指向第三个对象 → 整笔拒绝、全部状态不变 */
(function () {
  var identity = idn('G3'), a1 = idn('G3-A');
  var objB = ent('int_g3', identity, [a1]);
  var objA = JSON.parse(JSON.stringify(objB));
  var objC = JSON.parse(JSON.stringify(objB));
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = objA;
  reg.byKey[ID.identityKeyOf(a1)] = objC;
  reg.byInternal['int_g3'] = objB;
  var res = ID.registerExisting(reg, identity, 'int_g3', {});
  ok(res.status === 'CONFLICT' && reg.byKey[ID.identityKeyOf(identity)] === objA && reg.byKey[ID.identityKeyOf(a1)] === objC && reg.byInternal['int_g3'] === objB, 'G03 第三对象介入 → 拒绝部分统一、三方引用全不变');
})();
/* G04 内容冲突时深层不变性：对象内容、索引、reviewEvents 均不动 */
(function () {
  var identity = idn('G4'), key = ID.identityKeyOf(identity);
  var objA = ent('int_g4', identity, [], { qty: 1, basedOnHash: 'a' });
  var objB = ent('int_g4', identity, [], { qty: 2, basedOnHash: 'b' });
  var reg = ID.createRegistry(); reg.byKey[key] = objA; reg.byInternal['int_g4'] = objB;
  reg.reviewEvents.push({ internalId: 'int_g4', kind: 'confirmation_basis_changed', at: 't' });
  var snapA = ID._stableStringify(objA), snapB = ID._stableStringify(objB);
  var res = ID.registerExisting(reg, identity, 'int_g4', {});
  ok(res.status === 'CONFLICT' && ID._stableStringify(objA) === snapA && ID._stableStringify(objB) === snapB && reg.reviewEvents.length === 1 && reg.byKey[key] === objA && reg.byInternal['int_g4'] === objB, 'G04 冲突后两份实体内容逐项不变、历史与索引零改动');
})();
/* G05 只有 byInternal，经附加身份请求 → 按附加归属补 byKey */
(function () {
  var identity = idn('G5'), a1 = idn('G5-A');
  var e = ent('int_g5', identity, [a1]);
  var reg = ID.createRegistry(); reg.byInternal['int_g5'] = e;
  var res = ID.registerExisting(reg, a1, 'int_g5', {});
  ok(res.status === 'UNCHANGED' && res.repaired === 'byKey' && reg.byKey[ID.identityKeyOf(a1)] === e, 'G05 byInternal 单边 + 附加身份请求：补该附加键、指向同一对象');
})();
/* G06 只有 byInternal，请求键与实体身份完全无关 → 拒绝且不建键 */
(function () {
  var e = ent('int_g6', idn('G6'));
  var reg = ID.createRegistry(); reg.byInternal['int_g6'] = e;
  var res = ID.registerExisting(reg, idn('G6-STRANGER'), 'int_g6', {});
  ok(res.status === 'CONFLICT' && Object.keys(reg.byKey).length === 0, 'G06 无关身份键 → 冲突、未自动建立错误关联');
})();
/* G07 特殊 ID 分裂统一：internalId=__proto__、外部 ID=constructor */
(function () {
  var identity = idn('constructor'), a1 = idn('toString');
  var objB = ent('__proto__', identity, [a1]);
  var objA = JSON.parse(JSON.stringify(objB));
  var reg = ID.createRegistry();
  reg.byKey[ID.identityKeyOf(identity)] = objA; reg.byInternal['__proto__'] = objB;
  var res = ID.registerExisting(reg, identity, '__proto__', {});
  ok(res.repaired === 'index_unified' && reg.byKey[ID.identityKeyOf(identity)] === objB && reg.byKey[ID.identityKeyOf(a1)] === objB && reg.byInternal['__proto__'] === objB && ({}).polluted === undefined, 'G07 特殊 ID 分裂统一成功、原型未污染');
})();

console.log('== identity-r8-r3: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
