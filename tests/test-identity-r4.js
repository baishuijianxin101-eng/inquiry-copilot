/* P1-23-R7-R2-R4：身份键编码 / 注册表导入完整性 / importBatch 一致性 /
   内部 ID 唯一性 / 版本比较 / restoreBundle 事务化 故障注入测试。
   全部虚构数据；故障注入验证磁盘、内存、journal、锁四种状态，
   不只看函数返回值。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function throwsRegistry(fn) { try { fn(); return false; } catch (e) { return String(e && e.message || e).indexOf('registry_') === 0; } }
function idn(ss, sa, et, raw) { return { source_system: ss, source_account: sa, entity_type: et, external_id_raw: raw }; }
function oppContent(qty) { return { buyerName: 'B', buyerCompany: 'C', productText: 'Widget', qty: qty, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }; }

/* ---------- K 身份键编码 ---------- */
(function () {
  var k1 = ID.identityKeyOf(idn('a|b', 'c', 'opportunity', 'X'));
  var k2 = ID.identityKeyOf(idn('a', 'b|c', 'opportunity', 'X'));
  ok(k1 !== k2, 'K01 旧拼接碰撞对 (a|b,c) 与 (a,b|c) 新键不同');
  var r = ID.createRegistry();
  var e1 = ID.importRecord(r, { identity: idn('a|b', 'c', 'opportunity', 'X'), content: oppContent(1), sourceVersion: 1 });
  var e2 = ID.importRecord(r, { identity: idn('a', 'b|c', 'opportunity', 'X'), content: oppContent(2), sourceVersion: 1 });
  ok(e1.status === 'CREATED' && e2.status === 'CREATED' && e1.internalId !== e2.internalId && Object.keys(r.byKey).length === 2, 'K02 碰撞对身份各自建映射、互不覆盖');
  var e3 = ID.importRecord(r, { identity: idn('a|b', 'c', 'opportunity', 'X'), content: oppContent(1), sourceVersion: 1 });
  ok(e3.status === 'UNCHANGED' && e3.internalId === e1.internalId, 'K03 含 | 身份重复导入幂等');
  var r2 = ID.createRegistry();
  var u1 = ID.importRecord(r2, { identity: idn('alibaba_api', '账号|一', 'opportunity', '询盘 甲|"'), content: oppContent(3), sourceVersion: 1 });
  var u2 = ID.importRecord(r2, { identity: idn('alibaba_api', '账号|一', 'opportunity', '询盘 甲|"'), content: oppContent(3), sourceVersion: 1 });
  ok(u1.status === 'CREATED' && u2.status === 'UNCHANGED', 'K04 中文/空格/引号/竖线外部 ID 原样区分且幂等');
  /* 旧注册表（无 keyVersion、裸拼接键）迁移 */
  var legacyReg = ID.createRegistry();
  ID.importRecord(legacyReg, { identity: idn('legacy', 'local-instance', 'product', 'sbx_p0'), content: { title: 'T', model: 'M', category: 'C' }, sourceVersion: 1 });
  var exported = JSON.parse(ID.exportState(legacyReg));
  var legacyJson = { byKey: {}, conflicts: exported.conflicts, reviewEvents: [], canonVersion: 'canon-v1' };
  Object.keys(exported.byKey).forEach(function (k) { var ent = exported.byKey[k]; legacyJson.byKey[ID._legacyKeyOf(ent.identity)] = ent; });
  var migrated = ID.importState(JSON.stringify(legacyJson));
  ok(!!migrated.byKey[ID.identityKeyOf(idn('legacy', 'local-instance', 'product', 'sbx_p0'))] && migrated.keyVersion === 'esc-v2', 'K05 旧注册表迁移到 esc-v2 且映射可达');
  /* 旧键含 | 的实体：按四元组重算迁移 */
  var legacyJson2 = { byKey: {}, conflicts: [], reviewEvents: [], canonVersion: 'canon-v1' };
  var entPipe = { internalId: 'int_opportunity_pipe1', identity: idn('src', 'ac|ct', 'opportunity', 'E|1'), content: oppContent(1), contentHash: 'x', canonVersion: 'canon-v1', sourceVersion: 1, sourceUpdatedAt: null, sourceValue: {}, parsedValue: null, confirmedValue: null, archived: false };
  legacyJson2.byKey[ID._legacyKeyOf(entPipe.identity)] = entPipe;
  var migrated2 = ID.importState(JSON.stringify(legacyJson2));
  ok(!!migrated2.byKey[ID.identityKeyOf(entPipe.identity)] && migrated2.byInternal['int_opportunity_pipe1'], 'K06 旧键含 | 的实体按四元组重算迁移成功');
})();

/* ---------- V 注册表导入完整性 ---------- */
(function () {
  ok(throwsRegistry(function () { ID.importState('{broken'); }), 'V01 注册表 JSON 损坏 → 明确抛错');
  ok(throwsRegistry(function () { ID.importState(JSON.stringify({ byKey: [], conflicts: [] })); }), 'V02 byKey 非对象 → 抛错');
  ok(throwsRegistry(function () { ID.importState(JSON.stringify({ byKey: {}, canonVersion: 'canon-v99' })); }), 'V03 未知 canon 版本 → 抛错');
  ok(throwsRegistry(function () { ID.importState(JSON.stringify({ byKey: {}, keyVersion: 'weird-v9' })); }), 'V04 未知 keyVersion → 抛错');
  var good = ID.createRegistry();
  ID.importRecord(good, { identity: idn('s', 'a', 'opportunity', 'E1'), content: oppContent(1), sourceVersion: 1 });
  var tampered = JSON.parse(ID.exportState(good));
  var onlyKey = Object.keys(tampered.byKey)[0];
  tampered.byKey['forged|key|x|y'] = tampered.byKey[onlyKey]; delete tampered.byKey[onlyKey];
  ok(throwsRegistry(function () { ID.importState(JSON.stringify(tampered)); }), 'V05 键与四元组不一致 → 抛错（防键/实体错位）');
  var dup = JSON.parse(ID.exportState(good));
  var ent = dup.byKey[onlyKey];
  var ent2 = clone(ent); ent2.content = oppContent(999);
  dup.byKey[ID.identityKeyOf(idn('s', 'a', 'opportunity', 'E2'))] = ent2; /* 同 internalId 不同内容（且键与 identity 不符会先触发 key_mismatch，改走附加身份形态） */
  ent2.identity = idn('s', 'a', 'opportunity', 'E1');
  ent2.additionalIdentities = [idn('s', 'a', 'opportunity', 'E2')];
  ok(throwsRegistry(function () { ID.importState(JSON.stringify(dup)); }), 'V06 同一 internalId 两份不同内容 → 抛错');
  ok(throwsRegistry(function () { ID.importState(JSON.stringify({ byKey: {}, conflicts: [{ kind: 'x' }] })); }), 'V07 conflicts 条目缺 id → 抛错');
  /* loadRegistry 三态 */
  var m = new Map();
  var storage = { getItem: function (k) { return m.has(k) ? m.get(k) : null; }, setItem: function (k, v) { m.set(k, String(v)); }, removeItem: function (k) { m.delete(k); } };
  ok(IM.loadRegistryStatus(storage) === 'absent' && IM.loadRegistry(storage).registryLoadState === 'absent', 'V08 注册表不存在 → absent');
  IM.saveRegistry(storage, good);
  ok(IM.loadRegistryStatus(storage) === 'ok' && IM.loadRegistry(storage).registryLoadState === 'ok', 'V09 注册表正常 → ok');
  m.set(IM.REGISTRY_KEY, '{broken json');
  ok(IM.loadRegistryStatus(storage) === 'corrupt' && IM.loadRegistry(storage).registryLoadState === 'corrupt', 'V10 注册表损坏 → corrupt（与 absent 区分）');
  m.set(IM.REGISTRY_KEY, JSON.stringify({ byKey: { 'x': { internalId: 5 } } }));
  ok(IM.loadRegistryStatus(storage) === 'corrupt', 'V11 注册表结构损坏 → corrupt');
  var f = IM.importBatchFile({ get: function () { return { products: [], opportunities: [], orders: [] }; }, replaceAll: function () {} }, { source_system: 's', source_account: 'a', records: [] }, storage, {});
  ok(f.applied === false && f.error === 'registry_corrupt', 'V12 注册表损坏时 importBatchFile 拒绝导入');
})();

/* ---------- U importBatch 一致性 ---------- */
(function () {
  function buildEntity(t, c, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }
  function applyContent(ent, content) { if (ent.quote) ent.quote.qty = content.qty; }
  function oppRec(raw, qty, ver) { return { entity_type: 'opportunity', external_id_raw: raw, content: oppContent(qty), sourceVersion: ver, entity: { buyer: { name: 'B' }, rawText: 'x', followLog: [], log: [], quote: { qty: qty } } }; }
  function batch(records) { return { source_system: 'alibaba_api', source_account: 'acct-1', records: records }; }
  var state0 = { products: [], opportunities: [], orders: [] };
  var reg0 = ID.createRegistry();
  var r1 = IM.importBatch(state0, reg0, batch([oppRec('U-1', 1, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
  ok(r1.applied === true && r1.state.opportunities.length === 1, 'U01 基线导入成功');
  /* UPDATED 但业务实体被外部删除 */
  var stateMissing = clone(r1.state); stateMissing.opportunities = [];
  var regBefore = ID.exportState(r1.registry);
  var r2 = IM.importBatch(stateMissing, r1.registry, batch([oppRec('U-1', 5, 2)]), { buildEntity: buildEntity, applyContent: applyContent });
  ok(r2.applied === false && /updated_entity_missing/.test(r2.error || '') && ID.exportState(r1.registry) === regBefore && stateMissing.opportunities.length === 0, 'U02 UPDATED 缺失业务实体 → 整批失败、注册表与状态不变');
  /* UPDATED 命中重复实体 */
  var stateDup = clone(r1.state); stateDup.opportunities.push(clone(stateDup.opportunities[0]));
  var r3 = IM.importBatch(stateDup, r1.registry, batch([oppRec('U-1', 5, 2)]), { buildEntity: buildEntity, applyContent: applyContent });
  ok(r3.applied === false && /updated_entity_duplicate/.test(r3.error || ''), 'U03 UPDATED 命中重复实体 → 整批失败');
  /* CREATED 无 buildEntity */
  var r4 = IM.importBatch(state0, ID.createRegistry(), batch([oppRec('U-2', 1, 1)]), { applyContent: applyContent });
  ok(r4.applied === false && /created_entity_builder_missing/.test(r4.error || ''), 'U04 CREATED 缺 buildEntity → 整批失败（不留单边映射）');
  /* 正常 UPDATED / STALE / CONFLICT 不误伤 */
  var r5 = IM.importBatch(r1.state, r1.registry, batch([oppRec('U-1', 9, 2)]), { buildEntity: buildEntity, applyContent: applyContent });
  ok(r5.applied === true && r5.state.opportunities[0].quote.qty === 9, 'U05 正常 UPDATED 业务实体同步更新');
  var r6 = IM.importBatch(r5.state, r5.registry, batch([oppRec('U-1', 1, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
  ok(r6.applied === true && r6.results[0].status === 'STALE', 'U06 STALE 正常通过不失败');
})();

/* ---------- I 内部 ID 唯一性（冻结时间与随机源，强制首候选碰撞） ---------- */
(function () {
  var realNow = Date.now, realRand = Math.random;
  Date.now = function () { return 1730000000000; };
  Math.random = function () { return 0.5; };
  try {
    delete require.cache[require.resolve('../assets/identity.js')];
    var IDF = require('../assets/identity.js');
    var firstCandidate = 'int_opportunity_' + (1730000000000).toString(36) + Math.floor(0.5 * 4294967296).toString(36) + (1).toString(36);
    var reg = IDF.createRegistry();
    /* 预占首候选 ID（属于另一身份的实体） */
    var occ = { internalId: firstCandidate, identity: idn('s', 'a', 'opportunity', 'OTHER'), content: oppContent(1), contentHash: 'h', canonVersion: 'canon-v1', sourceVersion: 1, sourceUpdatedAt: null, sourceValue: {}, parsedValue: null, confirmedValue: null, archived: false };
    reg.byKey[IDF.identityKeyOf(occ.identity)] = occ; reg.byInternal[firstCandidate] = occ;
    var created = IDF.importRecord(reg, { identity: idn('s', 'a', 'opportunity', 'NEW-1'), content: oppContent(2), sourceVersion: 1 });
    ok(created.status === 'CREATED' && created.internalId !== firstCandidate && reg.byInternal[firstCandidate].identity.external_id_raw === 'OTHER' && reg.byInternal[created.internalId].identity.external_id_raw === 'NEW-1', 'I01 生成 ID 冲突时重生成、既有实体不被覆盖');
    delete require.cache[require.resolve('../assets/identity.js')];
  } finally { Date.now = realNow; Math.random = realRand; }
})();

/* ---------- O 版本比较 ---------- */
(function () {
  ok(ID.versionOrder(2, 1) === 'newer' && ID.versionOrder(1, 2) === 'stale' && ID.versionOrder(2, 2) === 'same', 'O01 数字版本数值比较');
  ok(ID.versionOrder('10', '9') === 'newer', 'O02 数字字符串按数值比较（非字典序）');
  ok(ID.versionOrder('1.2.3', '1.2.10') === 'stale' && ID.versionOrder('1.10.0', '1.2.9') === 'newer', 'O03 语义版本逐段比较');
  ok(ID.versionOrder('v2', 'v1') === 'unknown' && ID.versionOrder('v1', 'v1') === 'same', 'O04 普通字符串只认逐字相同、其余 unknown');
  ok(ID.versionOrder(2, 'release-x') === 'unknown' && ID.versionOrder(2, '1.0.0') === 'unknown', 'O05 混合/跨类版本 → unknown');
  ok(ID.versionOrder(2, '10') === 'stale', 'O06 number 与数字字符串同属数值类可互比');
  var r = ID.createRegistry();
  ID.importRecord(r, { identity: idn('s', 'a', 'opportunity', 'V-1'), content: oppContent(1), sourceVersion: 1 });
  var ent = r.byKey[ID.identityKeyOf(idn('s', 'a', 'opportunity', 'V-1'))];
  ID.setConfirmation(r, ent.internalId, { qty: '员工确认值' }, 'tester');
  var fmtChange = ID.importRecord(r, { identity: idn('s', 'a', 'opportunity', 'V-1'), content: oppContent(99), sourceVersion: 'release-x' });
  ok(fmtChange.status === 'NEEDS_REVIEW' && ent.content.qty === 1 && ent.confirmedValue.fields.qty === '员工确认值', 'O07 版本格式变化 → 人工复核、不覆盖内容与员工确认值');
  var newer = ID.importRecord(r, { identity: idn('s', 'a', 'opportunity', 'V-1'), content: oppContent(5), sourceVersion: 2 });
  ok(newer.status === 'UPDATED' && newer.confirmationReview === true && ent.confirmedValue.fields.qty === '员工确认值', 'O08 正常新版本更新来源值、员工确认值保留并标记复核');
})();

/* ---------- R restoreBundle 事务化故障注入 ---------- */
function makeStorage() {
  var map = new Map(), rules = [];
  return {
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) {
      for (var i = 0; i < rules.length; i++) { var r = rules[i]; if (r.key === k) { if (r.skip > 0) { r.skip--; break; } if (r.times > 0) { r.times--; var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } } }
      map.set(k, String(v));
    },
    removeItem: function (k) { map.delete(k); },
    arm: function (k, times) { rules.push({ key: k, skip: 0, times: times }); },
    _map: map
  };
}
var BIZ_KEY = 'ali_commission_copilot_v1';
function makeCore(storage, initial) {
  /* R5 第三项：与正式 Core（assets/core.js）锁语义一致的测试桩，取代
     R4 版桩。R4 桩有三处与正式实现不符（详见 R5-TEST-HARNESS-REVIEW）：
       1) 旧 _persist 只判 TXN.isLocked()、不认 _bypass——正式 persist 的
          屏障是 isLocked() && !_bypass，事务通道置 _bypass 后放行；
          旧桩在恢复期间一律拒绝落盘，使 R02 的「业务写失败」实际由
          锁拒绝触发，而非注入的配额故障；
       2) 旧 replaceAllChecked 先换内存再落盘、失败不回滚内存——正式
          persist 落盘失败会把内存回滚到最近落盘态（rollbackOrNote）；
       3) 旧桩用私有键 'biz_state'——正式落盘是 STORE_KEY 下的状态
          JSON 原文，磁盘断言应针对正式键。
     本桩逐项对齐：屏障条件与 _bypass、写后读回逐字校验、失败回滚
     内存、STORE_KEY 原文格式、replaceAllChecked 返回落盘成败。
     已知差异：正式 replaceAll 还做 migrate 与 settings 本机项处理；
     本桩夹具状态均为已迁移形态，故直接替换，不影响用例路径。 */
  var state = clone(initial);
  var lastGoodRaw = JSON.stringify(state);
  var core = { STORE_KEY: BIZ_KEY,
    get: function () { return state; },
    persist: function () {
      var TXN = core._txn;
      if (TXN && TXN.isLocked() && !TXN._bypass) { state = JSON.parse(lastGoodRaw); return false; }
      var raw = JSON.stringify(state);
      try { storage.setItem(BIZ_KEY, raw); } catch (e) { state = JSON.parse(lastGoodRaw); return false; }
      var back = null;
      try { back = storage.getItem(BIZ_KEY); } catch (e) { back = null; }
      if (back !== raw) { state = JSON.parse(lastGoodRaw); return false; }
      lastGoodRaw = raw;
      return true;
    },
    replaceAllChecked: function (obj) { state = clone(obj); return core.persist(); },
    /* C9-P1 第二阶段：本桩无 migrate，克隆落盘即原始恢复语义；与生产 Core 的 replaceAllRaw 对应 */
    replaceAllRaw: function (obj) { state = clone(obj); return core.persist(); },
    replaceAll: function (obj) { state = clone(obj); core.persist(); },
    _txn: null };
  storage.setItem(BIZ_KEY, lastGoodRaw);
  return core;
}
function emptyState() { return { products: [], opportunities: [], orders: [], settings: {} }; }
function oppRec(raw, qty, ver) {
  return { entity_type: 'opportunity', external_id_raw: raw, content: oppContent(qty), sourceVersion: ver,
    entity: { buyer: { name: 'B', company: 'C', country: 'DE' }, rawText: 'ext', followLog: [], log: [], quote: { qty: qty } } };
}
var OPTS = { buildEntity: function (t, c, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }, applyContent: function (ent, content) { if (ent.quote) ent.quote.qty = content.qty; } };
function batch(records) { return { source_system: 'alibaba_api', source_account: 'acct-1', records: records }; }
/* 构造带一个已导入实体的源环境并导出整包 */
function sourceBundle(TXN) {
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('RB-1', 7, 1)]), opts: OPTS });
  return TXN.buildBackup(c, s);
}
(function () {
  /* R01 注册表写抛错 → 回滚、ABORTED、解锁、磁盘内存均为恢复前态 */
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var prevBiz = s.getItem(BIZ_KEY);
  s.arm(IM.REGISTRY_KEY, 1);
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.rolledBack === true && s.getItem(BIZ_KEY) === prevBiz && c.get().opportunities.length === 0 && TXN.restoreJournalStatus(s).state === 'aborted' && TXN.isLocked() === false && !s.getItem(IM.REGISTRY_KEY), 'R01 注册表写失败 → 整包回滚、四态一致（磁盘/内存/日志/锁）');
  /* R02 业务写失败 → state_persist_failed、ABORTED、注册表未动 */
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  s2.arm(BIZ_KEY, 1);
  var rb2 = TXN2.restoreBundle({ storage: s2, core: c2, bundle: bundle });
  ok(rb2.restored === false && rb2.reason === 'state_persist_failed' && TXN2.restoreJournalStatus(s2).state === 'aborted' && !s2.getItem(IM.REGISTRY_KEY), 'R02 业务写失败 → 中止且注册表未被写入');
  /* R03 正常恢复 → COMPLETED、注册表与业务均达目标、主日志 SUPERSEDED */
  var TXN3 = freshTxn();
  var s3 = makeStorage(), c3 = makeCore(s3, emptyState());
  c3._txn = TXN3; TXN3.init(s3);
  var rb3 = TXN3.restoreBundle({ storage: s3, core: c3, bundle: bundle });
  ok(rb3.restored === true && TXN3.restoreJournalStatus(s3).state === 'completed' && c3.get().opportunities.length === 1 && s3.getItem(IM.REGISTRY_KEY) === JSON.stringify(bundle.identityRegistry) && TXN3.journalStatus(s3).state === 'superseded' && TXN3.isLocked() === false, 'R03 正常整包恢复全目标达成');
  /* R04 崩溃模拟：恢复日志 PREPARED + 业务已达目标 + 注册表仍旧值 → 启动识别并向前完成 */
  var TXN4 = freshTxn();
  var s4 = makeStorage(), c4 = makeCore(s4, clone(bundle.state));
  c4._txn = TXN4; TXN4.init(s4);
  var rj4 = { batchId: 'restore_crash1', phase: 'PREPARED', kind: 'restore', at: '2026-11-06', prevRegistry: null, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true, inverse: { created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } }, preStateHash: TXN4._stateHash(emptyState()), targetStateHash: TXN4._stateHash(bundle.state) };
  s4.setItem(TXN4.RESTORE_JOURNAL_KEY, JSON.stringify(rj4));
  var chk4 = TXN4.checkOnLoad(s4, c4);
  ok(chk4.locked === true && !!chk4.restorePending, 'R04 启动检查识别未完成恢复并阻断');
  var rc4 = TXN4.recover({ storage: s4, core: c4 });
  ok(rc4.recovered === true && rc4.mode === 'completed_forward' && s4.getItem(IM.REGISTRY_KEY) === JSON.stringify(bundle.identityRegistry) && TXN4.restoreJournalStatus(s4).state === 'completed' && TXN4.isLocked() === false, 'R05 恢复裁决向前补齐注册表并完成');
  /* R05 崩溃时业务与注册表均为旧态 → 裁决 ABORTED */
  var TXN5 = freshTxn();
  var s5 = makeStorage(), c5 = makeCore(s5, emptyState());
  c5._txn = TXN5; TXN5.init(s5);
  var rj5 = clone(rj4); rj5.batchId = 'restore_crash2';
  s5.setItem(TXN5.RESTORE_JOURNAL_KEY, JSON.stringify(rj5));
  TXN5.checkOnLoad(s5, c5);
  var rc5 = TXN5.recover({ storage: s5, core: c5 });
  ok(rc5.recovered === true && rc5.mode === 'aborted' && TXN5.restoreJournalStatus(s5).state === 'aborted' && TXN5.isLocked() === false, 'R06 未生效的恢复被裁决中止');
  /* R06 状态不匹配任何一态 → 保持锁定待人工 */
  var TXN6 = freshTxn();
  var s6 = makeStorage(), c6 = makeCore(s6, { products: [], opportunities: [{ id: 'unrelated' }], orders: [], settings: {} });
  c6._txn = TXN6; TXN6.init(s6);
  var rj6 = clone(rj4); rj6.batchId = 'restore_crash3';
  s6.setItem(TXN6.RESTORE_JOURNAL_KEY, JSON.stringify(rj6));
  TXN6.checkOnLoad(s6, c6);
  var rc6 = TXN6.recover({ storage: s6, core: c6 });
  ok(rc6.recovered === false && rc6.reason === 'restore_state_inconsistent_manual_required' && TXN6.isLocked() === true, 'R07 状态不可裁决 → 保持锁定待人工、不自动清除');
  /* R07 PREPARED 期间拒绝第二次恢复与导入 */
  var rb7 = TXN6.restoreBundle({ storage: s6, core: c6, bundle: bundle });
  var ci7 = TXN6.commitImport({ storage: s6, core: c6, batch: batch([oppRec('RB-2', 1, 1)]), opts: OPTS });
  ok(rb7.restored === false && rb7.reason === 'unfinished_restore_must_recover_first' && ci7.applied === false, 'R08 未完成恢复期间拒绝新恢复与新导入');
  /* R08 清锁失败收尾：不报成功；存储修复后经 recover 完成裁决 */
  var TXN8 = freshTxn();
  var s8 = makeStorage(), c8 = makeCore(s8, emptyState());
  c8._txn = TXN8; TXN8.init(s8);
  var origRemove = s8.removeItem;
  s8.removeItem = function () { throw new Error('remove fail'); };
  var rb8 = TXN8.restoreBundle({ storage: s8, core: c8, bundle: bundle });
  var mainJournal8 = TXN8.journalStatus(s8).state;
  s8.removeItem = origRemove;
  var rc8 = TXN8.recover({ storage: s8, core: c8 });
  ok(rb8.restored === false && rb8.reason === 'lock_clear_failed' && mainJournal8 === 'none' && TXN8.restoreJournalStatus(s8).state === 'completed' && rc8.recovered === true && rc8.mode === 'completed', 'R09 清锁失败不报成功、修复后裁决完成（主导入日志不受影响）');
  /* R09 注册表损坏时 commitImport 拒绝 */
  var TXN9 = freshTxn();
  var s9 = makeStorage(), c9 = makeCore(s9, emptyState());
  c9._txn = TXN9; TXN9.init(s9);
  s9.setItem(IM.REGISTRY_KEY, '{broken');
  var ci9 = TXN9.commitImport({ storage: s9, core: c9, batch: batch([oppRec('RB-3', 1, 1)]), opts: OPTS });
  ok(ci9.applied === false && ci9.reason === 'registry_corrupt' && TXN9.isLocked() === true, 'R10 注册表损坏 → 导入拒绝并阻断');
})();

console.log('== identity-r4: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
