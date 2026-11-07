/* P1-23-R8 审计第四项专项：importState 单键非有限数值及真实调用链。
   在 R8-R4 的 D01/D03/D04/D06/D07（直调 + loadRegistry + buildBackup）
   之上补齐：其他非有限形态、副本毒化、版本缺失默认值交互、v1 哈希
   不重算，以及 recover / commitImport / importBatchFile / importBatch /
   restoreSnapshot / restoreBundle 六个真实入口的异常实体封堵证据。
   restoreBundle 用例按 app.js 真实入口复刻：文件文本先 JSON.parse
   （1e999 在内存中成为 Infinity），校验和按 validateBundle 的同一
   算法（hashOf = 双种子 FNV-1a 拼接）对解析后对象重算——即一份
   「自洽但带毒」的备份文件能抵达的最深位置。
   全部虚构数据；本文件为 Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var MIG = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function thrown(fn) { try { fn(); return null; } catch (e) { return e; } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function idn(raw, acct) { return { source_system: 'alibaba_api', source_account: acct || 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
function ent(internalId, identity, adds) {
  return { internalId: internalId, identity: identity, additionalIdentities: adds || [],
    content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: null, archived: false };
}
function registryText(identity, qtyText, canonVersion, omitCanon) {
  var t = JSON.stringify(ent('int_d', identity)).replace('"qty":5', '"qty":' + qtyText);
  var cv = omitCanon ? '' : ',"canonVersion":"' + canonVersion + '"';
  return '{"byKey":{"' + ID.identityKeyOf(identity) + '":' + t + '},"conflicts":[],"reviewEvents":[]' + cv + ',"keyVersion":"esc-v2"}';
}
var REG_KEY = 'ic_identity_registry_v1', BIZ_KEY = 'ali_commission_copilot_v1';
function makeStorage() {
  var map = new Map();
  return { getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { map.set(k, String(v)); },
    removeItem: function (k) { map.delete(k); }, _map: map };
}
function makeCore(storage, initial, TXN) {
  var state = clone(initial);
  var lastGoodRaw = JSON.stringify(state);
  var core = { STORE_KEY: BIZ_KEY,
    get: function () { return state; },
    persist: function () {
      if (TXN && TXN.isLocked() && !TXN._bypass) { state = JSON.parse(lastGoodRaw); return false; }
      var raw = JSON.stringify(state);
      try { storage.setItem(BIZ_KEY, raw); } catch (e) { state = JSON.parse(lastGoodRaw); return false; }
      if (storage.getItem(BIZ_KEY) !== raw) { state = JSON.parse(lastGoodRaw); return false; }
      lastGoodRaw = raw; return true;
    },
    replaceAllChecked: function (obj) { state = clone(obj); return core.persist(); },
    /* C9-P1 第二阶段：本桩无 migrate，克隆落盘即原始恢复语义；与生产 Core 的 replaceAllRaw 对应 */
    replaceAllRaw: function (obj) { state = clone(obj); return core.persist(); } };
  storage.setItem(BIZ_KEY, lastGoodRaw);
  return core;
}
function emptyState() { return { products: [], opportunities: [], orders: [], settings: {} }; }
function hasNonFinite(v, seen) {
  if (typeof v === 'number') return !isFinite(v);
  if (v && typeof v === 'object') {
    seen = seen || [];
    if (seen.indexOf(v) >= 0) return false;
    seen.push(v);
    return Object.keys(v).some(function (k) { return hasNonFinite(v[k], seen); });
  }
  return false;
}

/* ================= N 组：非有限形态补全（importState 直调） ================= */
(function () {
  var e1 = thrown(function () { ID.importState(registryText(idn('N1'), '-1e999', 'canon-v3')); });
  ok(!!e1 && e1.code === 'registry_entity_content_invalid', 'N01 canon-v3 单键 -1e999 → registry_entity_content_invalid', e1 && e1.code);
  var e2 = thrown(function () { ID.importState(registryText(idn('N2'), '{"deep":[1,{"x":1e999}]}', 'canon-v3')); });
  ok(!!e2 && e2.code === 'registry_entity_content_invalid', 'N02 canon-v3 深层嵌套 1e999 → registry_entity_content_invalid', e2 && e2.code);
  var e3 = thrown(function () { ID.importState(registryText(idn('N3'), '[1,2,1e999]', 'canon-v3')); });
  ok(!!e3 && e3.code === 'registry_entity_content_invalid', 'N03 canon-v3 数组元素 1e999 → registry_entity_content_invalid', e3 && e3.code);
  /* N04：主副本干净、附加身份键下的第二份副本带毒——逐键门禁对每份副本都执行 */
  var prim = idn('N4'), add = idn('N4-A');
  var clean = JSON.stringify(ent('int_d', prim, [add]));
  var poisonedCopy = clean.replace('"qty":5', '"qty":1e999');
  var twoKey = '{"byKey":{"' + ID.identityKeyOf(prim) + '":' + clean + ',"' + ID.identityKeyOf(add) + '":' + poisonedCopy + '},"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v3","keyVersion":"esc-v2"}';
  var e4 = thrown(function () { ID.importState(twoKey); });
  ok(!!e4 && e4.code === 'registry_entity_content_invalid', 'N04 第二份副本（附加键）带 1e999 → registry_entity_content_invalid（逐键门禁）', e4 && e4.code);
  /* N05/N06：canonVersion 字段缺失的默认值交互（R8-R3 契约：缺失 = 当前版本） */
  var e5 = thrown(function () { ID.importState(registryText(idn('N5'), '1e999', null, true)); });
  ok(!!e5 && e5.code === 'registry_entity_content_invalid', 'N05 canonVersion 缺失 + 1e999 → 按缺失默认 canon-v3 拒绝', e5 && e5.code);
  var r6 = ID.importState(registryText(idn('N6'), '5', null, true));
  ok(!!r6 && r6.canonVersion === 'canon-v3' && !!r6.byInternal['int_d'], 'N06 canonVersion 缺失 + 正常值 → 以 canon-v3 导入（默认契约）');
})();

/* ================= V 组：版本兼容深化 ================= */
(function () {
  /* V01：canon-v1 导入不重算历史哈希、不改写实体版本字段 */
  var src = ent('int_d', idn('V1'));
  var t = JSON.stringify(src);
  var text = '{"byKey":{"' + ID.identityKeyOf(idn('V1')) + '":' + t + '},"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v1","keyVersion":"esc-v2"}';
  var reg = ID.importState(text);
  ok(reg.byInternal['int_d'].contentHash === src.contentHash && reg.byInternal['int_d'].canonVersion === 'canon-v3' && reg.canonVersion === 'canon-v1',
    'V01 canon-v1 实体 contentHash 与 canonVersion 字段逐字保留（importState 不重算哈希）');
  /* V02：canon-v3 纯 JSON 双副本内容不一致（有限值）→ 副本判等防线仍在 */
  var prim = idn('V2'), add = idn('V2-A');
  var c1 = JSON.stringify(ent('int_d', prim, [add]));
  var c2 = c1.replace('"qty":5', '"qty":6');
  var text2 = '{"byKey":{"' + ID.identityKeyOf(prim) + '":' + c1 + ',"' + ID.identityKeyOf(add) + '":' + c2 + '},"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v3","keyVersion":"esc-v2"}';
  var e2 = thrown(function () { ID.importState(text2); });
  ok(!!e2 && e2.code === 'registry_internal_id_conflict', 'V02 canon-v3 双副本有限值不一致 → registry_internal_id_conflict（判等防线保留）', e2 && e2.code);
})();

/* ================= E 组：真实入口封堵 ================= */
(function () {
  var poisonV3 = registryText(idn('E0'), '1e999', 'canon-v3');
  /* E01 loadRegistry：corrupt 三态 + 存储原文逐字不变（不修复、不部分采用） */
  var s1 = makeStorage(); s1.setItem(REG_KEY, poisonV3);
  var loaded = MIG.loadRegistry(s1);
  ok(loaded.registryLoadState === 'corrupt' && Object.keys(loaded.byInternal).length === 0 && s1.getItem(REG_KEY) === poisonV3,
    'E01 loadRegistry 带毒注册表 → corrupt + 空表 + 存储原文不变');
  /* E02 commitImport：注册表损坏在计算前阻断——业务盘不动、无 journal、置锁 */
  var TXN2 = freshTxn();
  var s2 = makeStorage(); s2.setItem(REG_KEY, poisonV3);
  var prevBiz = { products: [], opportunities: [{ id: 'keep1', buyer: { name: 'K' }, followLog: [], log: [] }], orders: [], settings: {} };
  var c2 = makeCore(s2, prevBiz, TXN2); TXN2.init(s2);
  var bizBefore = s2.getItem(BIZ_KEY);
  var r2 = TXN2.commitImport({ storage: s2, core: c2, batch: { source_system: 'alibaba_api', source_account: 'acct-1', records: [] }, opts: {} });
  ok(r2.applied === false && r2.reason === 'registry_corrupt' && s2.getItem(BIZ_KEY) === bizBefore && s2.getItem(TXN2.JOURNAL_KEY) === null && TXN2.isLocked(),
    'E02 commitImport 带毒注册表 → registry_corrupt 阻断（业务未动、无 journal、已置锁)', JSON.stringify(r2));
  /* E03 recover：journal 的 prevRegistry 带毒 → importState 先于任何写回抛错，注册表与业务均不变 */
  var TXN3 = freshTxn();
  var s3 = makeStorage();
  var goodRegText = ID.exportState(ID.createRegistry());
  s3.setItem(REG_KEY, goodRegText);
  var c3 = makeCore(s3, emptyState(), TXN3); TXN3.init(s3);
  var biz3Before = s3.getItem(BIZ_KEY);
  var journal = { batchId: 'batch_item4', phase: 'PREPARED', at: '2026-11-06T00:00:00.000Z', prevRegistry: poisonV3,
    inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN3._stateHash(emptyState()) };
  s3.setItem(TXN3.JOURNAL_KEY, JSON.stringify(journal));
  var r3 = TXN3.recover({ storage: s3, core: c3, bizKey: BIZ_KEY });
  ok(r3.recovered === false && String(r3.reason).indexOf('registry_entity_content_invalid') >= 0 && s3.getItem(REG_KEY) === goodRegText && s3.getItem(BIZ_KEY) === biz3Before,
    'E03 recover 的 prevRegistry 带毒 → 拒绝恢复、注册表与业务逐字不变', JSON.stringify(r3));
  /* E04 importBatchFile：损坏注册表前置拒绝 */
  var s4 = makeStorage(); s4.setItem(REG_KEY, poisonV3);
  var c4 = makeCore(s4, emptyState(), null);
  var r4 = MIG.importBatchFile(c4, { source_system: 'alibaba_api', source_account: 'acct-1', records: [] }, s4, {});
  ok(r4.applied === false && r4.error === 'registry_corrupt', 'E04 importBatchFile 带毒注册表 → registry_corrupt 前置拒绝', JSON.stringify(r4));
  /* E05 importBatch：批次记录 content 含 Infinity（内存形态）→ 整批不落、入参状态与注册表不变 */
  var reg5 = ID.createRegistry();
  var st5 = emptyState();
  var st5Snap = JSON.stringify(st5);
  var r5 = MIG.importBatch(st5, reg5, { source_system: 'alibaba_api', source_account: 'acct-1', records: [
    { entity_type: 'opportunity', external_id_raw: 'BAD1', content: { qty: Infinity } },
    { entity_type: 'opportunity', external_id_raw: 'GOOD1', content: { qty: 5 } }] },
    { buildEntity: function (type, content, internalId) { return { id: internalId, buyer: { name: 'G' }, followLog: [], log: [] }; },
      applyContent: function () {} });
  ok(r5.applied === false && JSON.stringify(st5) === st5Snap && Object.keys(reg5.byKey).length === 0,
    'E05 importBatch 含 Infinity 内容记录 → 整批拒绝、入参状态/注册表不变（无部分写入）', JSON.stringify(r5));
  /* E06 restoreSnapshot：快照注册表带毒 → 抛错、无返回值 */
  var e6 = thrown(function () { MIG.restoreSnapshot({ state: emptyState(), registry: poisonV3, at: '2026-11-06T00:00:00.000Z' }); });
  ok(!!e6 && e6.code === 'registry_entity_content_invalid', 'E06 restoreSnapshot 带毒注册表 → registry_entity_content_invalid、无部分恢复', e6 && e6.code);
})();

/* ================= R 组：restoreBundle 备份恢复入口 ================= */
/* hashOf 与 identity-txn.js 同算法（双种子 FNV-1a），用于把自洽校验和
   算到「解析后」的带毒对象上，复刻攻击者/损坏源能做到的最深程度。 */
function fnv(str, seed) { var h = seed >>> 0; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
function hashOf(str) { return fnv(str, 2166136261) + fnv(str, 42424242); }
function craftedBundle(stateObj, poisonedRegText) {
  var text = '{"format":"ic-backup","version":2,"exportedAt":"2026-11-06T00:00:00.000Z","state":' + JSON.stringify(stateObj) +
    ',"identityRegistry":' + poisonedRegText + ',"checksums":{"state":"","registry":""}}';
  var bundle = JSON.parse(text); /* 与 app.js 文件入口相同：1e999 在此成为 Infinity */
  bundle.checksums.state = hashOf(JSON.stringify(bundle.state));
  bundle.checksums.registry = hashOf(JSON.stringify(bundle.identityRegistry));
  return bundle;
}
(function () {
  var poisonV3 = registryText(idn('R0'), '1e999', 'canon-v3');
  /* R01（R8 第四项修复轮按任务书换夹具，兼 T11）：原带毒夹具在修复后
     会在前置预检即被拒绝（见 R02），无法再抵达一致性回滚路径；故换
     为全部有限合法、但注册表实体在备份业务状态中无对应的夹具——能
     通过预检与结构复核、进入恢复事务后一致性失败 → 中止并双边
     回滚。断言文本与强度不变，另补锁/日志收尾断言。 */
  var finiteV3 = registryText(idn('R0'), '5', 'canon-v3');
  var TXN = freshTxn();
  var s = makeStorage();
  var prevRegText = ID.exportState(ID.createRegistry());
  s.setItem(REG_KEY, prevRegText);
  var prevState = { products: [], opportunities: [{ id: 'keep_r', buyer: { name: 'K' }, followLog: [], log: [] }], orders: [], settings: {} };
  var core = makeCore(s, prevState, TXN); TXN.init(s);
  var bizBefore = s.getItem(BIZ_KEY);
  var bundle = craftedBundle({ products: [], opportunities: [], orders: [], settings: {} }, finiteV3);
  var r = TXN.restoreBundle({ storage: s, core: core, bundle: bundle });
  ok(r.restored === false && r.rolledBack === true && s.getItem(REG_KEY) === prevRegText && s.getItem(BIZ_KEY) === bizBefore,
    'R01/T11 restoreBundle 有限值注册表 + 状态不对应 → 中止、注册表与业务双边回滚逐字一致', JSON.stringify(r));
  ok(s.getItem(TXN.LOCK_KEY) === null && TXN.isLocked() === false && JSON.parse(s.getItem(TXN.RESTORE_JOURNAL_KEY)).phase === 'ABORTED',
    'R01 回滚收尾语义保持：锁已清、恢复日志落 ABORTED');
  /* R02（修复轮按任务书翻转断言）：毒性构造方法原样保留（文件文本
     1e999 + 按解析后对象重算自洽校验和）；修复前该备份被接受并把
     qty 静默降格为 null 后报告成功，修复后必须在前置预检被拒：
     restored:false + registry_entity_content_invalid，且业务/注册
     表原文逐字不变、无恢复日志、无锁、Core 未发生业务写入。 */
  var TXN2 = freshTxn();
  var s2 = makeStorage();
  s2.setItem(REG_KEY, prevRegText);
  var core2 = makeCore(s2, emptyState(), TXN2); TXN2.init(s2);
  var bizBefore2 = s2.getItem(BIZ_KEY);
  var bundleState = { products: [], opportunities: [{ id: 'int_d', buyer: { name: 'B' }, followLog: [], log: [] }], orders: [], settings: {} };
  var bundle2 = craftedBundle(bundleState, poisonV3);
  var r2 = TXN2.restoreBundle({ storage: s2, core: core2, bundle: bundle2 });
  ok(r2.restored === false && r2.reason === 'registry_entity_content_invalid' &&
     s2.getItem(REG_KEY) === prevRegText && s2.getItem(BIZ_KEY) === bizBefore2 &&
     s2.getItem(TXN2.RESTORE_JOURNAL_KEY) === null && s2.getItem(TXN2.LOCK_KEY) === null && TXN2.isLocked() === false,
    'R02 restoreBundle 自洽毒性 v3 备份（状态对应）→ 预检拒绝 registry_entity_content_invalid、双边原文不变、无日志无锁', JSON.stringify(r2));
})();

/* ================= T 组：restoreBundle 整对象预检覆盖（修复轮新增） =================
   判别目标：只查 byKey 实体的方案（旧设计 A/C）会在 T3–T7 漏过——
   conflicts / reviewEvents / 顶层字段的毒性必须同样被拒。全部拒绝
   用例统一断言存储全量快照逐字不变（业务、注册表、日志、锁都在
   快照内）且锁定状态与调用前一致。毒性一律以原始对象/文本中的
   1e999 构造（占位数字 987654321 经字符串替换为字面 1e999 后再
   JSON.parse，与文件入口一致），不用 stringify 后的 null 冒充。 */
var MATCH_STATE = { products: [], opportunities: [{ id: 'int_d', buyer: { name: 'B' }, followLog: [], log: [] }], orders: [], settings: {} };
function snapOf(s) { var o = {}; s._map.forEach(function (v, k) { o[k] = v; }); return o; }
function sameSnap(s, snap) { var now = snapOf(s); var ks = Object.keys(snap); if (ks.length !== Object.keys(now).length) return false; return ks.every(function (k) { return now[k] === snap[k]; }); }
function attempt(bundle) {
  var TXN = freshTxn(); var s = makeStorage();
  s.setItem(REG_KEY, ID.exportState(ID.createRegistry()));
  var core = makeCore(s, emptyState(), TXN); TXN.init(s);
  var snap = snapOf(s);
  var r = TXN.restoreBundle({ storage: s, core: core, bundle: bundle });
  return { TXN: TXN, s: s, r: r, snap: snap };
}
function expectReject(bundle, reason, name) {
  var a = attempt(bundle);
  ok(a.r.restored === false && a.r.reason === reason && sameSnap(a.s, a.snap) && a.TXN.isLocked() === false, name, JSON.stringify(a.r));
}
function regTextMut(mut, canonVersion, omitCanon) {
  var o = JSON.parse(registryText(idn('T'), '5', canonVersion || 'canon-v3', !!omitCanon));
  mut(o);
  return JSON.stringify(o).split('987654321').join('1e999');
}
function conflictWith(patch) {
  var c = { id: 'cf1', kind: 'k', identity: null, internalId: null, summary: 's', at: '2026-11-06T00:00:00.000Z', status: 'PENDING', resolution: null, resolvedBy: null, resolvedAt: null, fingerprint: null };
  Object.keys(patch).forEach(function (k) { c[k] = patch[k]; });
  return c;
}
(function () {
  expectReject(craftedBundle(MATCH_STATE, registryText(idn('T1'), '1e999', 'canon-v3')), 'registry_entity_content_invalid',
    'T1 实体直接 1e999 → 预检拒绝、存储逐字不变');
  expectReject(craftedBundle(MATCH_STATE, registryText(idn('T2'), '{"deep":[1,{"x":1e999}]}', 'canon-v3')), 'registry_entity_content_invalid',
    'T2 实体深层嵌套 1e999 → 预检拒绝、存储逐字不变');
  expectReject(craftedBundle(MATCH_STATE, regTextMut(function (o) { o.conflicts.push(conflictWith({ resolution: 987654321 })); })), 'registry_entity_content_invalid',
    'T3 conflicts 元素字段 1e999 → 预检拒绝（仅查实体会漏过）、存储逐字不变');
  expectReject(craftedBundle(MATCH_STATE, regTextMut(function (o) { o.conflicts.push(conflictWith({ detail: { list: [987654321] } })); })), 'registry_entity_content_invalid',
    'T4 conflicts 嵌套字段 1e999 → 预检拒绝、存储逐字不变');
  expectReject(craftedBundle(MATCH_STATE, regTextMut(function (o) { o.reviewEvents.push({ internalId: 'int_d', kind: 'confirmation_basis_changed', at: '2026-11-06T00:00:00.000Z', v: 987654321 }); })), 'registry_entity_content_invalid',
    'T5 reviewEvents 元素 1e999 → 预检拒绝、存储逐字不变');
  expectReject(craftedBundle(MATCH_STATE, regTextMut(function (o) { o.extraTop = 987654321; })), 'registry_entity_content_invalid',
    'T6 顶层额外字段 1e999 → 预检拒绝、存储逐字不变');
  expectReject(craftedBundle(MATCH_STATE, registryText(idn('T7'), '1e999', null, true)), 'registry_entity_content_invalid',
    'T7a canonVersion 缺失 + 实体 1e999 → 按默认 v3 拒绝');
  expectReject(craftedBundle(MATCH_STATE, regTextMut(function (o) { o.conflicts.push(conflictWith({ resolution: 987654321 })); }, 'canon-v3', true)), 'registry_entity_content_invalid',
    'T7b canonVersion 缺失 + conflicts 1e999 → 按默认 v3 拒绝');
  expectReject(craftedBundle(MATCH_STATE, regTextMut(function (o) { o.reviewEvents.push({ internalId: 'int_d', kind: 'x', at: '2026-11-06T00:00:00.000Z', v: 987654321 }); }, 'canon-v3', true)), 'registry_entity_content_invalid',
    'T7c canonVersion 缺失 + reviewEvents 1e999 → 按默认 v3 拒绝');
  /* T8：v1/v2 跳过 v3 门禁，恢复行为与修复前一致（接受 + 落盘即
     备份对象 stringify 的逐字结果，含其既有降格形态）。 */
  var t8aText = registryText(idn('T8'), '1e999', 'canon-v1').replace('"canonVersion":"canon-v3"', '"canonVersion":"canon-v1"');
  var b8a = craftedBundle(MATCH_STATE, t8aText);
  var a8a = attempt(b8a);
  ok(a8a.r.restored === true && a8a.s.getItem(REG_KEY) === JSON.stringify(b8a.identityRegistry) && a8a.s.getItem(REG_KEY).indexOf('"qty":null') >= 0,
    'T8a canon-v1 实体 1e999 → 不被 v3 门禁拒绝、按修复前行为恢复（落盘为原对象 stringify）', JSON.stringify(a8a.r));
  var b8b = craftedBundle(MATCH_STATE, regTextMut(function (o) { o.conflicts.push(conflictWith({ resolution: 987654321 })); }, 'canon-v2'));
  var a8b = attempt(b8b);
  ok(a8b.r.restored === true && a8b.s.getItem(REG_KEY) === JSON.stringify(b8b.identityRegistry),
    'T8b canon-v2 conflicts 1e999 → 历史行为保持、恢复成功', JSON.stringify(a8b.r));
  var b8c = craftedBundle(MATCH_STATE, regTextMut(function (o) { o.conflicts.push(conflictWith({ resolution: 987654321 })); }, 'canon-v1'));
  var a8c = attempt(b8c);
  ok(a8c.r.restored === true && a8c.s.getItem(REG_KEY) === JSON.stringify(b8c.identityRegistry),
    'T8c canon-v1 conflicts 1e999 → 历史行为保持、恢复成功', JSON.stringify(a8c.r));
  /* T9：版本字段非法/未知 → importState 既有错误码，零写入。 */
  function verBundle(canonVal, keyVal) {
    var o = JSON.parse(registryText(idn('T9'), '5', 'canon-v3'));
    if (canonVal !== undefined) o.canonVersion = canonVal;
    if (keyVal !== undefined) o.keyVersion = keyVal;
    return craftedBundle(MATCH_STATE, JSON.stringify(o));
  }
  expectReject(verBundle(null), 'registry_canon_version_invalid', 'T9a canonVersion=null → registry_canon_version_invalid、零写入');
  expectReject(verBundle(''), 'registry_canon_version_invalid', 'T9b canonVersion 空串 → registry_canon_version_invalid、零写入');
  expectReject(verBundle(123), 'registry_canon_version_invalid', 'T9c canonVersion 数字 → registry_canon_version_invalid、零写入');
  expectReject(verBundle('canon-v9'), 'registry_unknown_canon_version', 'T9d 未知 canonVersion → registry_unknown_canon_version、零写入');
  expectReject(verBundle(undefined, 123), 'registry_key_version_invalid', 'T9e keyVersion 数字 → registry_key_version_invalid、零写入');
  expectReject(verBundle(undefined, 'esc-v9'), 'registry_unknown_key_version', 'T9f 未知 keyVersion → registry_unknown_key_version、零写入');
  /* T10：正常 v3 备份成功恢复，落盘文本与原备份 stringify 逐字一致。 */
  var b10 = craftedBundle(MATCH_STATE, registryText(idn('T10'), '5', 'canon-v3'));
  var a10 = attempt(b10);
  ok(a10.r.restored === true && a10.s.getItem(REG_KEY) === JSON.stringify(b10.identityRegistry) &&
     JSON.parse(a10.s.getItem(a10.TXN.RESTORE_JOURNAL_KEY)).phase === 'COMPLETED' && a10.s.getItem(a10.TXN.LOCK_KEY) === null,
    'T10 正常 canon-v3 备份 → 恢复成功、落盘逐字一致、日志 COMPLETED、锁已清', JSON.stringify(a10.r));
  /* T6b：有限值顶层额外字段本轮不拒绝（任务书明确），随备份原文落盘。 */
  var b6 = craftedBundle(MATCH_STATE, regTextMut(function (o) { o.extraTop = 7; }));
  var a6 = attempt(b6);
  ok(a6.r.restored === true && a6.s.getItem(REG_KEY) === JSON.stringify(b6.identityRegistry) && a6.s.getItem(REG_KEY).indexOf('"extraTop":7') >= 0,
    'T6b 有限值顶层额外字段 → 不拒绝、随原文落盘', JSON.stringify(a6.r));
  /* T12：正常 v1/v2 有限值备份恢复，版本字段与键编码逐字保持。 */
  var t12aText = registryText(idn('T12'), '5', 'canon-v1').replace('"canonVersion":"canon-v3"', '"canonVersion":"canon-v1"');
  var b12a = craftedBundle(MATCH_STATE, t12aText);
  var a12a = attempt(b12a);
  ok(a12a.r.restored === true && a12a.s.getItem(REG_KEY) === JSON.stringify(b12a.identityRegistry) && a12a.s.getItem(REG_KEY).indexOf('"canonVersion":"canon-v1"') >= 0,
    'T12a 正常 canon-v1 备份 → 恢复成功、版本字段与键逐字保持', JSON.stringify(a12a.r));
  var b12b = craftedBundle(MATCH_STATE, registryText(idn('T12'), '5', 'canon-v2'));
  var a12b = attempt(b12b);
  ok(a12b.r.restored === true && a12b.s.getItem(REG_KEY) === JSON.stringify(b12b.identityRegistry) && a12b.s.getItem(REG_KEY).indexOf('"canonVersion":"canon-v2"') >= 0,
    'T12b 正常 canon-v2 备份 → 恢复成功、版本字段与键逐字保持', JSON.stringify(a12b.r));
  /* T13：预存保护状态（COMPLETED 恢复日志 + 外部锁）下预检失败，
     不得清除或改写任何既有保护状态，锁定状态与调用前一致。 */
  var TXN13 = freshTxn(); var s13 = makeStorage();
  s13.setItem(REG_KEY, ID.exportState(ID.createRegistry()));
  var core13 = makeCore(s13, emptyState(), TXN13); TXN13.init(s13);
  s13.setItem(TXN13.RESTORE_JOURNAL_KEY, JSON.stringify({ batchId: 'restore_old', phase: 'COMPLETED', kind: 'restore', at: '2026-11-01T00:00:00.000Z' }));
  s13.setItem(TXN13.LOCK_KEY, JSON.stringify({ reason: 'other_operation', at: '2026-11-06T00:00:00.000Z' }));
  var snap13 = snapOf(s13);
  var r13 = TXN13.restoreBundle({ storage: s13, core: core13, bundle: craftedBundle(MATCH_STATE, registryText(idn('T13'), '1e999', 'canon-v3')) });
  ok(r13.restored === false && r13.reason === 'registry_entity_content_invalid' && sameSnap(s13, snap13) && TXN13.isLocked() === true,
    'T13 预存 COMPLETED 日志 + 外部锁 → 预检拒绝且保护状态逐字不变、锁定状态不变', JSON.stringify(r13));
})();

/* ================= F 组：非法 falsy identityRegistry 拒绝（R8 第四项补充修复） =================
   缺陷：false/0/'' 曾被真假判断当作无注册表备份——validateBundle
   连注册表校验和都不核验，restoreBundle 跳过预检与结构复核后恢复
   成功。修复：两处守卫收紧为 !== undefined && !== null。本组除终局
   快照外另加写入计数屏障（storage setItem/removeItem、Core persist、
   replaceAllChecked 全程计数，断言增量为零）——init 与 journal 读
   检查只读不写，计数为零即证明拒绝发生在任何持久化之前。 */
var LP_KEY = 'ic_identity_legacy_pending_v1';
function falsyBundle(stateObj, regValue, regChecksum, omitField) {
  var bundle = { format: 'ic-backup', version: 2, exportedAt: '2026-11-06T00:00:00.000Z',
    state: clone(stateObj), checksums: { state: '', registry: regChecksum } };
  bundle.checksums.state = hashOf(JSON.stringify(bundle.state));
  if (!omitField) bundle.identityRegistry = regValue;
  return bundle;
}
function countedAttempt(bundle) {
  var TXN = freshTxn();
  var raw = makeStorage();
  var counts = { setItem: 0, removeItem: 0 };
  var s = { getItem: raw.getItem, _map: raw._map,
    setItem: function (k, v) { counts.setItem++; raw.setItem(k, v); },
    removeItem: function (k) { counts.removeItem++; raw.removeItem(k); } };
  raw.setItem(REG_KEY, ID.exportState(ID.createRegistry()));
  var prevRegText = raw.getItem(REG_KEY);
  var core = makeCore(s, emptyState(), TXN);
  var cc = { persist: 0, replaceAllChecked: 0 };
  var bp = core.persist, br = core.replaceAllChecked;
  core.persist = function () { cc.persist++; return bp(); };
  core.replaceAllChecked = function (o) { cc.replaceAllChecked++; return br(o); };
  TXN.init(s);
  var snap = snapOf(raw);
  var c0 = { setItem: counts.setItem, removeItem: counts.removeItem, persist: cc.persist, replaceAllChecked: cc.replaceAllChecked };
  var r = TXN.restoreBundle({ storage: s, core: core, bundle: bundle });
  return { TXN: TXN, raw: raw, r: r, snap: snap, prevRegText: prevRegText,
    writes: (counts.setItem - c0.setItem) + (counts.removeItem - c0.removeItem),
    coreWrites: (cc.persist - c0.persist) + (cc.replaceAllChecked - c0.replaceAllChecked) };
}
(function () {
  [['false', false], ['0', 0], ['empty-string', '']].forEach(function (pair) {
    var label = pair[0], val = pair[1];
    /* A：自洽校验和——validateBundle 应通过，拒绝必须来自结构复核 */
    var bA = falsyBundle(emptyState(), val, hashOf(JSON.stringify(val)));
    ok(freshTxn().validateBundle(bA).ok === true, 'F-A ' + label + ' 自洽校验和 → validateBundle 通过（拒绝来自结构复核而非校验和）');
    var aA = countedAttempt(bA);
    ok(aA.r.restored === false && aA.r.reason === 'registry_not_object' && aA.writes === 0 && aA.coreWrites === 0 &&
       sameSnap(aA.raw, aA.snap) && aA.raw.getItem(aA.TXN.RESTORE_JOURNAL_KEY) === null && aA.raw.getItem(aA.TXN.LOCK_KEY) === null,
      'F-A ' + label + ' → registry_not_object 写前拒绝、storage 写入 0 次、Core 写入 0 次、无日志无锁', JSON.stringify(aA.r) + ' writes=' + aA.writes + '/' + aA.coreWrites);
    /* B：垃圾校验和——守卫对齐后必须先死在校验和 */
    var bB = falsyBundle(emptyState(), val, 'deadbeefgarbage');
    var vb = freshTxn().validateBundle(bB);
    var aB = countedAttempt(bB);
    ok(vb.ok === false && vb.reason === 'registry_checksum_mismatch' && aB.r.restored === false && aB.r.reason === 'registry_checksum_mismatch' &&
       aB.writes === 0 && aB.coreWrites === 0 && sameSnap(aB.raw, aB.snap),
      'F-B ' + label + ' 垃圾校验和 → registry_checksum_mismatch、零写入', JSON.stringify(aB.r));
  });
  /* C：null 与字段缺失的无注册表兼容必须原样保留 */
  var cState = { products: [], opportunities: [{ id: 'new_opp', buyer: { name: 'N' }, followLog: [], log: [] }], orders: [], settings: {} };
  [['null', falsyBundle(cState, null, null, false)], ['missing', falsyBundle(cState, null, null, true)]].forEach(function (pair) {
    var a = countedAttempt(pair[1]);
    ok(a.r.restored === true && a.r.legacyPending === true && a.raw.getItem(REG_KEY) === a.prevRegText &&
       a.raw.getItem(LP_KEY) === '1' && JSON.parse(a.raw.getItem(a.TXN.RESTORE_JOURNAL_KEY)).phase === 'COMPLETED' &&
       a.raw.getItem(a.TXN.LOCK_KEY) === null && a.TXN.isLocked() === false,
      'F-C ' + pair[0] + ' → 无注册表兼容保持：恢复成功、现存注册表逐字保留、legacyPending 标记置位、日志 COMPLETED、锁已清', JSON.stringify(a.r));
  });
  /* D：[] 自洽校验和——保持既有 registry_not_object 写前拒绝 */
  var aD = countedAttempt(falsyBundle(emptyState(), [], hashOf('[]')));
  ok(aD.r.restored === false && aD.r.reason === 'registry_not_object' && aD.writes === 0 && aD.coreWrites === 0 && sameSnap(aD.raw, aD.snap),
    'F-D [] 自洽校验和 → registry_not_object 写前拒绝、零写入（现有行为不变）', JSON.stringify(aD.r));
})();

console.log('== identity-r8-item4: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
