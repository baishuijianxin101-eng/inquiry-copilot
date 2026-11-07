/* P1-23-R7-R2-R6：身份映射与恢复事务阻断问题定点修复专项。
   L 组：恢复残留锁的归属证明（第一项）；D 组：恢复前状态磁盘来源
   与目标写入窗口（第二项）；G 组：legacyPending 事务闭环（第三项）；
   I 组：身份注册表完整性（第四项）；X 组：ID 类型与索引键安全
   （第五项）；B 组：buildBackup 错误降级（第七项）。
   全部虚构数据；每项同时检查返回值、journal、持久化锁、内存锁、
   业务状态与注册表状态。本文件为 Node 桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function idn(ss, sa, et, raw) { return { source_system: ss, source_account: sa, entity_type: et, external_id_raw: raw }; }
function oppContent(qty) { return { buyerName: 'B', buyerCompany: 'C', productText: 'Widget', qty: qty, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }; }
var BIZ_KEY = 'ali_commission_copilot_v1';
var LEGACY_KEY = 'ic_identity_legacy_pending_v1';

function makeStorage() {
  var map = new Map(), rules = [];
  return {
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.key === k) {
          if (r.skip > 0) { r.skip--; break; }
          if (r.times > 0) { r.times--; if (r.corrupt) { map.set(k, '###corrupted###'); return; } var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        }
      }
      map.set(k, String(v));
    },
    removeItem: function (k) { map.delete(k); },
    arm: function (k, opts) { rules.push({ key: k, skip: (opts && opts.skip) || 0, times: (opts && opts.times) || 0, corrupt: !!(opts && opts.corrupt) }); },
    disarm: function () { rules.length = 0; },
    _map: map
  };
}
function makeCore(storage, initial) {
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
function sourceBundle(TXN, records) {
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch(records), opts: OPTS });
  return TXN.buildBackup(c, s);
}
function inconsistentBundle(TXN) {
  var b = sourceBundle(TXN, [oppRec('IB-1', 1, 1), oppRec('IB-2', 2, 1)]);
  b.state.opportunities = b.state.opportunities.slice(0, 1);
  b.checksums.state = TXN._stateHash(b.state);
  return b;
}
function setLockRaw(s, TXN, lock) { s.setItem(TXN.LOCK_KEY, JSON.stringify(lock)); }
function terminalRj(TXN, batchId) {
  var rj = { batchId: batchId, phase: 'COMPLETED', kind: 'restore', at: '2026-11-06T00:00:00.000Z' };
  return rj;
}

/* ================= L 组：残留锁归属证明 ================= */
/* L01 恢复 A 的终态日志 + 恢复 B 的 restore_in_progress 锁：
   reason 相同但 batchId 不同 → 不得清除（R5 旧条件会误清） */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A')));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_B', at: '2026-11-06T00:01:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_ownership_unproven', 'L01a batchId 不一致的恢复锁不被终态日志清扫', JSON.stringify(rc));
  ok(TXN.isLocked() === true && JSON.parse(s.getItem(TXN.LOCK_KEY)).batchId === 'restore_B' && TXN.restoreJournalStatus(s).state === 'completed', 'L01b 锁与终态日志保持原样');
})();

/* L02 终态日志缺 batchId → 无法证明归属，不清锁 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var rj = terminalRj(TXN, 'restore_A'); delete rj.batchId;
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_A', at: '2026-11-06T00:01:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_ownership_unproven' && TXN.isLocked() === true && !!s.getItem(TXN.LOCK_KEY), 'L02 日志缺 batchId → 保持锁定待人工', JSON.stringify(rc));
})();

/* L03 锁缺 batchId（仅 reason）→ 不清锁 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A')));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', at: '2026-11-06T00:01:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_ownership_unproven' && TXN.isLocked() === true, 'L03 锁缺 batchId → 保持锁定', JSON.stringify(rc));
})();

/* L04 锁结构损坏 → 不清锁、原文保留 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A')));
  s.setItem(TXN.LOCK_KEY, '{broken lock');
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_ownership_unproven' && s.getItem(TXN.LOCK_KEY) === '{broken lock' && TXN.isLocked() === true, 'L04 损坏锁不被清扫、原文保留', JSON.stringify(rc));
})();

/* L05 持久化锁不存在、仅内存锁残留 → 无法归因，不清除 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.arm(TXN.LOCK_KEY, { times: 99 }); /* 持久化锁写全部失败 → 只剩内存锁 */
  s.setItem(TXN.RESTORE_JOURNAL_KEY, '{corrupt rj');
  TXN.checkOnLoad(s, c); /* 损坏恢复日志 → setLock：内存锁生效、磁盘无锁 */
  s.disarm();
  ok(s.getItem(TXN.LOCK_KEY) === null && TXN.isLocked() === true, 'L05a 前置：仅内存锁存在');
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A'))); /* 覆盖为终态日志，模拟遗留组合 */
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_ownership_unproven' && TXN.isLocked() === true, 'L05b 内存锁无法归因 → 不清扫、保持锁定', JSON.stringify(rc));
})();

/* L06 归属完整匹配（reason + batchId + 日志 batchId）→ 正常清扫 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A')));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_A', at: '2026-11-06T00:01:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && rc.mode === 'stale_lock_cleared' && TXN.isLocked() === false && s.getItem(TXN.LOCK_KEY) === null, 'L06 归属证明完整 → 遗留锁被清扫', JSON.stringify(rc));
})();

/* L07 归属成立但清锁写失败 → 如实失败、锁保留 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A')));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_A', at: '2026-11-06T00:01:00.000Z' });
  s.removeItem = function () { throw new Error('remove fail'); };
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_clear_failed' && s.getItem(TXN.LOCK_KEY) !== null, 'L07 清锁失败 → stale_lock_clear_failed、锁保留', JSON.stringify(rc));
})();

/* L08 非恢复来源保护锁（一致性锁）→ 不归本入口处理、保持不动 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(terminalRj(TXN, 'restore_A')));
  setLockRaw(s, TXN, { reason: 'consistency_check_failed', at: '2026-11-06T00:01:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'stale_lock_ownership_unproven' && JSON.parse(s.getItem(TXN.LOCK_KEY)).reason === 'consistency_check_failed', 'L08 一致性保护锁保持不动', JSON.stringify(rc));
})();

/* ================= D 组：恢复前状态磁盘来源 ================= */
/* D01 内存与磁盘前态不同：内存多出未落盘的幽灵实体，恢复中止后
   必须回到磁盘前态（R5 旧实现以内存为快照会把幽灵写回磁盘） */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('DB-1', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('DB-0', 3, 1)]), opts: OPTS });
  var diskPrevRaw = s.getItem(BIZ_KEY), regPrev = s.getItem(IM.REGISTRY_KEY);
  c.get().opportunities.push({ id: 'ghost_mem_only', buyer: { name: 'G' }, rawText: 'x', followLog: [], log: [], quote: {} }); /* 只改内存、不落盘 */
  s.arm(IM.REGISTRY_KEY, { times: 1 }); /* 目标注册表写失败 → 触发中止回滚 */
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.rolledBack === true, 'D01a 中止回滚发生', JSON.stringify(rb));
  ok(s.getItem(BIZ_KEY) === diskPrevRaw && JSON.stringify(c.get()).indexOf('ghost_mem_only') < 0 && s.getItem(IM.REGISTRY_KEY) === regPrev, 'D01b 回滚目标 = 磁盘前态（幽灵实体未被写入磁盘）');
  var rj = JSON.parse(s.getItem(TXN.RESTORE_JOURNAL_KEY));
  ok(rj.prevState.opportunities.length === 1 && rj.preStateHash === TXN._stateHash(JSON.parse(diskPrevRaw)), 'D01c 日志中的恢复前快照与哈希来自磁盘');
})();

/* D02 磁盘业务状态损坏 → 拒绝开始恢复，不写日志、不动注册表 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('DB-2', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s._map.set(BIZ_KEY, '{broken state');
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.reason === 'persisted_state_unparseable' && s.getItem(TXN.RESTORE_JOURNAL_KEY) === null && TXN.isLocked() === false && s.getItem(IM.REGISTRY_KEY) === null, 'D02 磁盘损坏 → fail-closed 拒绝、无副作用', JSON.stringify(rb));
})();

/* D03 磁盘状态不存在：Core 可落盘时先建立磁盘基线再恢复；
   落盘失败则拒绝开始 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('DB-3', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.removeItem(BIZ_KEY); /* 模拟首次使用尚未落盘 */
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === true && c.get().opportunities.length === 1, 'D03a 落盘建立基线后恢复成功', JSON.stringify(rb));
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  s2.removeItem(BIZ_KEY);
  s2.arm(BIZ_KEY, { times: 99 });
  var rb2 = TXN2.restoreBundle({ storage: s2, core: c2, bundle: bundle });
  ok(rb2.restored === false && rb2.reason === 'persisted_state_absent' && s2.getItem(TXN2.RESTORE_JOURNAL_KEY) === null, 'D03b 基线落盘失败 → 拒绝开始恢复', JSON.stringify(rb2));
})();

/* D04 目标写入窗口：业务目标已落盘（经 Core 变换、哈希已变）、
   日志目标哈希未刷新、注册表已达目标 → 集合哈希验证后采纳完成 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('DB-4', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('DB-4p', 3, 1)]), opts: OPTS });
  var prevState = clone(c.get()), prevReg = s.getItem(IM.REGISTRY_KEY);
  var targetState = clone(bundle.state);
  targetState.settings = targetState.settings || {};
  targetState.settings.translateEndpoint = 'https://local-endpoint.example'; /* 模拟 Core 落盘变换：集合不变、哈希已变 */
  var diskRaw = JSON.stringify(targetState);
  s._map.set(BIZ_KEY, diskRaw);
  s.setItem(IM.REGISTRY_KEY, JSON.stringify(bundle.identityRegistry));
  var rj = { batchId: 'restore_win', phase: 'PREPARED', kind: 'restore', at: '2026-11-06T00:00:00.000Z',
    prevRegistry: prevReg, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
    prevState: prevState, inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(prevState), targetStateHash: TXN._stateHash(bundle.state),
    targetCollectionsHash: TXN._collectionsHash(bundle.state),
    prevLegacyPending: 'absent', targetLegacyPending: 'absent', targetWriteStarted: true };
  bundle.state.opportunities.forEach(function (e) { rj.inverse.created.opportunities.push(e.id); });
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_win', at: '2026-11-06T00:00:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  var rjAfter = JSON.parse(s.getItem(TXN.RESTORE_JOURNAL_KEY));
  ok(rc.recovered === true && rc.mode === 'completed_target_adopted' && rjAfter.phase === 'COMPLETED' && rjAfter.targetHashAdopted === true && rjAfter.targetStateHash === TXN._stateHash(targetState) && TXN.isLocked() === false, 'D04 窗口状态被识别并采纳磁盘哈希完成', JSON.stringify(rc));
})();

/* D05 窗口变体：磁盘状态是无关垃圾（逆操作还原不回前态）→ 人工 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('DB-5', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var prevState = emptyState();
  var garbage = { products: [], opportunities: [{ id: 'unrelated', buyer: { name: 'X' }, rawText: 'x', followLog: [], log: [], quote: {} }], orders: [], settings: {} };
  s._map.set(BIZ_KEY, JSON.stringify(garbage));
  s.setItem(IM.REGISTRY_KEY, JSON.stringify(bundle.identityRegistry));
  var rj = { batchId: 'restore_win2', phase: 'PREPARED', kind: 'restore', at: '2026-11-06T00:00:00.000Z',
    prevRegistry: null, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
    prevState: prevState, inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(prevState), targetStateHash: TXN._stateHash(bundle.state),
    targetCollectionsHash: TXN._collectionsHash(bundle.state),
    prevLegacyPending: 'absent', targetLegacyPending: 'absent', targetWriteStarted: true };
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_win2', at: '2026-11-06T00:00:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'restore_state_inconsistent_manual_required' && TXN.isLocked() === true && TXN.restoreJournalStatus(s).state === 'prepared', 'D05 无关磁盘状态不被采纳 → 保持锁定待人工', JSON.stringify(rc));
})();

/* D06 窗口变体：磁盘 = 目标但注册表仍为前态 → 不采纳、待人工 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('DB-6', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('DB-6p', 3, 1)]), opts: OPTS });
  var prevState = clone(c.get()), prevReg = s.getItem(IM.REGISTRY_KEY);
  s._map.set(BIZ_KEY, JSON.stringify(bundle.state)); /* 业务已到目标 */
  /* 注册表保持前态（prevReg 不动） */
  var rj = { batchId: 'restore_win3', phase: 'PREPARED', kind: 'restore', at: '2026-11-06T00:00:00.000Z',
    prevRegistry: prevReg, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
    prevState: prevState, inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(prevState), targetStateHash: 'stale_hash_not_matching',
    targetCollectionsHash: TXN._collectionsHash(bundle.state),
    prevLegacyPending: 'absent', targetLegacyPending: 'absent', targetWriteStarted: true };
  bundle.state.opportunities.forEach(function (e) { rj.inverse.created.opportunities.push(e.id); });
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_win3', at: '2026-11-06T00:00:00.000Z' });
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'restore_state_inconsistent_manual_required' && TXN.isLocked() === true, 'D06 注册表未达目标 → 不采纳、待人工（completed_forward 只认日志目标哈希）', JSON.stringify(rc));
})();

/* ================= G 组：legacyPending 事务闭环 ================= */
/* G01 导入中途失败时标记不得被提前清除（R5 旧实现在事务开始前
   就清标记，失败后标记丢失）；recover 后标记仍为事务前状态 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-0', 3, 1)]), opts: OPTS });
  var prevBiz = s.getItem(BIZ_KEY), prevReg = s.getItem(IM.REGISTRY_KEY);
  s.setItem(LEGACY_KEY, '1');
  s.arm(IM.REGISTRY_KEY, { times: 1 }); /* 本次导入的注册表写失败 */
  var ci = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-1', 4, 1)]), opts: OPTS });
  ok(ci.applied === false && ci.stage === 'registry_persist' && s.getItem(LEGACY_KEY) === '1', 'G01a 导入失败时标记未被提前清除', JSON.stringify(ci));
  var j = JSON.parse(s.getItem(TXN.JOURNAL_KEY));
  ok(j.phase === 'PREPARED' && j.prevLegacyPending === 'set', 'G01b journal 记录了事务前标记状态');
  s.disarm();
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && s.getItem(LEGACY_KEY) === '1' && s.getItem(BIZ_KEY) === prevBiz && s.getItem(IM.REGISTRY_KEY) === prevReg && TXN.isLocked() === false, 'G01c 回滚后标记/业务/注册表均为事务前状态', JSON.stringify(rc));
})();

/* G02 正常导入：标记在提交成功后才清除，journal 留痕 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-2', 3, 1)]), opts: OPTS });
  s.setItem(LEGACY_KEY, '1');
  var ci = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-3', 4, 1)]), opts: OPTS });
  var j = JSON.parse(s.getItem(TXN.JOURNAL_KEY));
  ok(ci.applied === true && s.getItem(LEGACY_KEY) === null && j.phase === 'COMMITTED' && j.prevLegacyPending === 'set', 'G02 提交成功后标记清除且 journal 记录 prevLegacyPending', JSON.stringify(ci));
})();

/* G03 标记清除写失败 → 整批不提交（stage=legacy_pending），
   recover 后标记与双边状态回到事务前 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-4', 3, 1)]), opts: OPTS });
  var prevBiz = s.getItem(BIZ_KEY), prevReg = s.getItem(IM.REGISTRY_KEY);
  s.setItem(LEGACY_KEY, '1');
  var origRemove = s.removeItem;
  s.removeItem = function (k) { if (k === LEGACY_KEY) throw new Error('marker remove fail'); origRemove(k); };
  var ci = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-5', 4, 1)]), opts: OPTS });
  ok(ci.applied === false && ci.stage === 'legacy_pending' && s.getItem(LEGACY_KEY) === '1' && TXN.journalStatus(s).state === 'prepared' && TXN.isLocked() === true, 'G03a 标记清除失败 → 不提交、PREPARED+锁、标记仍在', JSON.stringify(ci));
  s.removeItem = origRemove;
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && s.getItem(LEGACY_KEY) === '1' && s.getItem(BIZ_KEY) === prevBiz && s.getItem(IM.REGISTRY_KEY) === prevReg, 'G03b recover 回滚双边且标记保持事务前状态', JSON.stringify(rc));
})();

/* G04 标记损坏（非 '1' 内容）→ 导入与恢复都 fail-closed 拒绝，
   不把损坏当作不存在 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('LG-6', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(LEGACY_KEY, 'yes');
  var ci = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-7', 4, 1)]), opts: OPTS });
  ok(ci.applied === false && ci.reason === 'legacy_pending_unreadable' && TXN.isLocked() === true && s.getItem(LEGACY_KEY) === 'yes', 'G04a 标记损坏 → 导入拒绝并阻断、标记原文保留', JSON.stringify(ci));
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  s2.setItem(LEGACY_KEY, 'yes');
  var rb = TXN2.restoreBundle({ storage: s2, core: c2, bundle: bundle });
  ok(rb.restored === false && rb.reason === 'legacy_pending_unreadable' && s2.getItem(TXN2.RESTORE_JOURNAL_KEY) === null, 'G04b 标记损坏 → 恢复拒绝开始、无日志写入', JSON.stringify(rb));
})();

/* G05 恢复中止时标记同步回滚：含注册表备份恢复中标记已清、
   一致性失败触发中止 → 标记必须回到恢复前的 'set' */
(function () {
  var TXN = freshTxn();
  var bundle = inconsistentBundle(TXN);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('LG-8', 3, 1)]), opts: OPTS });
  var prevBiz = s.getItem(BIZ_KEY), prevReg = s.getItem(IM.REGISTRY_KEY);
  s.setItem(LEGACY_KEY, '1');
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.rolledBack === true && s.getItem(LEGACY_KEY) === '1' && s.getItem(BIZ_KEY) === prevBiz && s.getItem(IM.REGISTRY_KEY) === prevReg && TXN.restoreJournalStatus(s).state === 'aborted', 'G05 中止回滚后标记/业务/注册表三方回到恢复前', JSON.stringify(rb));
})();

/* G06 recoverRestore 裁决时修正标记：双边已达目标但标记停在
   中间状态 → 完成时修正为目标状态；修正写失败 → 保持锁定 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('LG-9', 5, 1)]);
  function winEnv() {
    var s = makeStorage(), c = makeCore(s, bundle.state);
    c._txn = TXN; TXN.init(s);
    s.setItem(IM.REGISTRY_KEY, JSON.stringify(bundle.identityRegistry));
    s.setItem(LEGACY_KEY, '1'); /* 标记停在恢复前状态，未随完成推进 */
    var rj = { batchId: 'restore_lg', phase: 'PREPARED', kind: 'restore', at: '2026-11-06T00:00:00.000Z',
      prevRegistry: null, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
      prevState: emptyState(), inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
      preStateHash: TXN._stateHash(emptyState()), targetStateHash: TXN._stateHash(bundle.state),
      prevLegacyPending: 'set', targetLegacyPending: 'absent', targetWriteStarted: false };
    bundle.state.opportunities.forEach(function (e) { rj.inverse.created.opportunities.push(e.id); });
    s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
    setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_lg', at: '2026-11-06T00:00:00.000Z' });
    return { s: s, c: c };
  }
  var env = winEnv();
  var rc = TXN.recover({ storage: env.s, core: env.c });
  ok(rc.recovered === true && rc.mode === 'completed' && env.s.getItem(LEGACY_KEY) === null && TXN.restoreJournalStatus(env.s).state === 'completed', 'G06a 裁决完成时标记被修正为目标状态', JSON.stringify(rc));
  var env2 = winEnv();
  var origRemove = env2.s.removeItem;
  env2.s.removeItem = function (k) { if (k === LEGACY_KEY) throw new Error('marker fix fail'); origRemove(k); };
  var rc2 = TXN.recover({ storage: env2.s, core: env2.c });
  ok(rc2.recovered === false && rc2.reason === 'legacy_pending_fix_failed' && TXN.isLocked() === true && TXN.restoreJournalStatus(env2.s).state === 'prepared', 'G06b 标记修正失败 → 保持 PREPARED+锁', JSON.stringify(rc2));
})();

/* G07 中止裁决时标记回到恢复前：双边为前态、标记却停在目标
   状态（不存在）→ 裁决中止后标记应被恢复为 'set' */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('LG-10', 5, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var rj = { batchId: 'restore_lg2', phase: 'PREPARED', kind: 'restore', at: '2026-11-06T00:00:00.000Z',
    prevRegistry: null, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
    prevState: emptyState(), inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(emptyState()), targetStateHash: TXN._stateHash(bundle.state),
    prevLegacyPending: 'set', targetLegacyPending: 'absent', targetWriteStarted: false };
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  setLockRaw(s, TXN, { reason: 'restore_in_progress', batchId: 'restore_lg2', at: '2026-11-06T00:00:00.000Z' });
  /* 标记当前不存在（=目标状态），但双边均为前态 → 裁决中止须恢复标记 */
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && rc.mode === 'aborted' && s.getItem(LEGACY_KEY) === '1' && TXN.restoreJournalStatus(s).state === 'aborted', 'G07 中止裁决把标记恢复到恢复前状态', JSON.stringify(rc));
})();

/* ================= I 组：身份注册表完整性 ================= */
function validExportWithAdditionals() {
  var reg = ID.createRegistry();
  var r1 = ID.importRecord(reg, { identity: idn('alibaba_api', 'acct-1', 'opportunity', 'EXT-1'), content: oppContent(10), sourceVersion: 1 }, { now: '2026-11-06T00:00:00.000Z' });
  ID.bindAdditionalIdentity(reg, r1.internalId, idn('alibaba_tm', 'acct-1', 'opportunity', 'TM-1'));
  return JSON.parse(ID.exportState(reg));
}
function expectThrow(name, data, codePart) {
  var threw = null;
  try { ID.importState(JSON.stringify(data)); } catch (e) { threw = e; }
  ok(!!threw && String(threw.reason || threw.message).indexOf(codePart) >= 0, name, threw ? String(threw.reason || threw.message) : 'no throw');
}
/* I01 additionalIdentities 非数组 → 明确拒绝 */
(function () {
  var data = validExportWithAdditionals();
  var ent = data.byKey[Object.keys(data.byKey)[0]];
  ent.additionalIdentities = 'not-an-array';
  expectThrow('I01 additionalIdentities 非数组被拒绝', data, 'additional_identities_invalid');
})();
/* I02 附加身份字段不完整 → 拒绝 */
(function () {
  var data = validExportWithAdditionals();
  var ent = data.byKey[Object.keys(data.byKey)[0]];
  ent.additionalIdentities = [{ source_system: 'alibaba_tm', entity_type: 'opportunity', external_id_raw: 'TM-9' }];
  expectThrow('I02 附加身份缺字段被拒绝', data, 'additional_identity_invalid');
})();
/* I03 附加身份与主身份重复 → 拒绝 */
(function () {
  var data = validExportWithAdditionals();
  var keys = Object.keys(data.byKey);
  var primary = data.byKey[keys[0]].identity;
  data.byKey[keys[0]].additionalIdentities = [clone(primary)];
  expectThrow('I03 附加身份与主身份重复被拒绝', data, 'additional_duplicates_primary');
})();
/* I04 附加身份声称的键不在 byKey 中 → 覆盖校验拒绝 */
(function () {
  var data = validExportWithAdditionals();
  var keys = Object.keys(data.byKey);
  var tmKey = keys.filter(function (k) { return k.indexOf('alibaba_tm') === 0; })[0];
  delete data.byKey[tmKey];
  expectThrow('I04 附加键缺失被覆盖校验拒绝', data, 'key_coverage_missing');
})();
/* I05 合法附加身份注册表往返成功（正对照） */
(function () {
  var data = validExportWithAdditionals();
  var reg = ID.importState(JSON.stringify(data));
  var keys = Object.keys(reg.byKey);
  ok(keys.length === 2 && reg.byKey[keys[0]].internalId === reg.byKey[keys[1]].internalId && !!reg.byInternal[reg.byKey[keys[0]].internalId], 'I05 合法附加身份注册表导入成功、双键指向同一内部实体');
})();
/* I06 无效内容哈希不参与疑似重复分组、且被显式报告 */
(function () {
  var reg = ID.createRegistry();
  function mk(raw, qty) { return ID.importRecord(reg, { identity: idn('alibaba_api', 'acct-1', 'opportunity', raw), content: oppContent(qty), sourceVersion: 1 }, { now: '2026-11-06T00:00:00.000Z' }); }
  var a = mk('NH-1', 1), b = mk('NH-2', 2), d = mk('NH-3', 3);
  delete reg.byInternal[a.internalId].contentHash;
  reg.byInternal[b.internalId].contentHash = null;
  reg.byInternal[d.internalId].contentHash = '';
  var rep = ID.findPossibleDuplicatesReport(reg);
  ok(rep.pairs.length === 0 && rep.invalidHashEntities.length === 3, 'I06a 无效哈希不伪造配对、三实体被显式报告', JSON.stringify(rep.invalidHashEntities));
  var e1 = mk('NH-4', 9), e2 = mk('NH-5', 9);
  var rep2 = ID.findPossibleDuplicatesReport(reg);
  ok(rep2.pairs.length === 1 && rep2.invalidHashEntities.length === 3, 'I06b 有效同哈希仍正常配对、报告互不干扰');
})();
/* I07 registerExisting 单边索引缺失 → 补齐同一实体、不新建覆盖 */
(function () {
  var reg = ID.createRegistry();
  var r1 = ID.importRecord(reg, { identity: idn('alibaba_api', 'acct-1', 'opportunity', 'RE-1'), content: oppContent(10), sourceVersion: 1 }, { now: '2026-11-06T00:00:00.000Z' });
  var ent = reg.byInternal[r1.internalId];
  ID.setConfirmation(reg, r1.internalId, { status: 'confirmed', confirmedValue: 'keep-me' });
  var key = ID.identityKeyOf(ent.identity);
  delete reg.byKey[key]; /* 模拟单边索引缺失 */
  var res = ID.registerExisting(reg, idn('alibaba_api', 'acct-1', 'opportunity', 'RE-1'), r1.internalId);
  ok(res.status === 'UNCHANGED' && res.repaired === 'byKey' && reg.byKey[key] === ent && reg.byKey[key].confirmedValue && reg.byKey[key].confirmedValue.fields.confirmedValue === 'keep-me', 'I07a byKey 缺失被补齐、原实体与确认值保留', JSON.stringify(res));
  var reg2 = ID.createRegistry();
  var r2 = ID.importRecord(reg2, { identity: idn('alibaba_api', 'acct-1', 'opportunity', 'RE-2'), content: oppContent(10), sourceVersion: 1 }, { now: '2026-11-06T00:00:00.000Z' });
  var ent2 = reg2.byInternal[r2.internalId];
  var key2 = ID.identityKeyOf(ent2.identity);
  delete reg2.byInternal[r2.internalId];
  var res2 = ID.registerExisting(reg2, idn('alibaba_api', 'acct-1', 'opportunity', 'RE-2'), r2.internalId);
  ok(res2.status === 'UNCHANGED' && res2.repaired === 'byInternal' && reg2.byInternal[r2.internalId] === ent2 && reg2.byKey[key2] === ent2, 'I07b byInternal 缺失被补齐、指向同一实体', JSON.stringify(res2));
})();
/* I08 canon-v3：v1 的字段边界碰撞在 v3 下消除；v1 语义冻结不变；
   缺失/null/空串在 v3 下严格区分；注册表版本升级路径可用 */
(function () {
  var bleedA = { buyerName: 'X|buyerCompany=s:Y', buyerCompany: 'Z', productText: 'W', qty: 1, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' };
  var bleedB = { buyerName: 'X', buyerCompany: 'Y|buyerCompany=s:Z', productText: 'W', qty: 1, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' };
  ok(ID.contentHash(bleedA, 'opportunity', 'canon-v1') === ID.contentHash(bleedB, 'opportunity', 'canon-v1'), 'I08a v1 碰撞对可复现（记录 v1 固有缺陷）');
  ok(ID.contentHash(bleedA, 'opportunity', 'canon-v3') !== ID.contentHash(bleedB, 'opportunity', 'canon-v3'), 'I08b v3 长度前缀编码消除字段边界碰撞');
  var fixture = { buyerName: 'A', buyerCompany: 'B', productText: 'x|qty=n:1', qty: 2, unit: 'pcs', destination: 'DE', rawTextHash: 'h' };
  ok(ID.contentHash(fixture, 'opportunity', 'canon-v1') === 'fnv1a32x2:1951bd3442435f51', 'I08c v1 哈希语义冻结（固定夹具值不变）');
  var cMiss = { buyerName: 'A' }, cNull = { buyerName: 'A', buyerCompany: null }, cEmpty = { buyerName: 'A', buyerCompany: '' };
  var hM = ID.canonicalize(cMiss, 'opportunity', 'canon-v3'), hN = ID.canonicalize(cNull, 'opportunity', 'canon-v3'), hE = ID.canonicalize(cEmpty, 'opportunity', 'canon-v3');
  ok(hM !== hN && hN !== hE && hM !== hE && ID.CANON_VERSION === 'canon-v3', 'I08d v3 区分缺失/null/空串、当前版本为 canon-v3');
  var reg = ID.createRegistry();
  var rec = { identity: idn('alibaba_api', 'acct-1', 'opportunity', 'UP-1'), content: oppContent(10), sourceVersion: 1 };
  var first = ID.importRecord(reg, rec, { now: '2026-11-06T00:00:00.000Z' });
  /* 模拟旧版实体：其实体级 canonVersion 与哈希回退到 v1 */
  reg.byInternal[first.internalId].canonVersion = 'canon-v1';
  reg.byInternal[first.internalId].contentHash = ID.contentHash(oppContent(10), 'opportunity', 'canon-v1');
  var second = ID.importRecord(reg, rec, { now: '2026-11-06T00:01:00.000Z' });
  ok(second.status === 'UNCHANGED' && reg.byInternal[first.internalId].contentHash === ID.contentHash(oppContent(10), 'opportunity', 'canon-v3'), 'I08e v1 注册表实体经升级路径迁移到 v3 哈希', JSON.stringify(second));
})();

/* ================= X 组：ID 类型与索引键安全 ================= */
/* X01 diffInverse/applyInverse 类型键：数字 123 与字符串 '123'
   不合并；逆操作按类型精确还原 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('XT-1', 3, 1)]), opts: OPTS });
  var j = JSON.parse(s.getItem(TXN.JOURNAL_KEY));
  ok(j.inverse.format === 'typed-v2', 'X01a 新 journal 逆操作带 typed-v2 格式标记');
  var prev = { opportunities: [{ id: 'a', v: 1 }], products: [], orders: [], settings: {} };
  var next = { opportunities: [{ id: 'a', v: 2 }, { id: '123', v: 9 }], products: [], orders: [], settings: {} };
  /* 经真实逆操作往返验证：用一份含数字 ID 的 prev/next 直接验证
     applyInverse 对类型键的处理（通过 recover 路径太绕，这里用
     journal 手工构造 + recover 的回滚语义等价物：applyInverse 未
     导出，改由 commitImport 的 journal 内容间接断言） */
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, { opportunities: [{ id: 123, buyer: { name: 'N' }, rawText: 'x', followLog: [], log: [], quote: { qty: 1 } }], products: [], orders: [], settings: {} });
  c2._txn = TXN2; TXN2.init(s2);
  var ci = TXN2.commitImport({ storage: s2, core: c2, batch: batch([oppRec('XT-2', 3, 1)]), opts: OPTS });
  var j2 = JSON.parse(s2.getItem(TXN2.JOURNAL_KEY));
  ok(ci.applied === true && j2.inverse.created.opportunities.length === 1 && Object.keys(j2.inverse.updatedPrev.opportunities).length === 0, 'X01b 数字 ID 实体未被误判为已更新（类型键区分）', JSON.stringify(j2.inverse.created));
})();
/* X02 backfillLegacy：非字符串 ID 列入人工复核、不绑定不转换 */
(function () {
  var reg = ID.createRegistry();
  var state = { products: [{ id: 123, title: 'Num' }, { id: '123', title: 'Str' }], opportunities: [], orders: [], settings: {} };
  var rep = IM.backfillLegacy(state, reg);
  ok(rep.nonStringIds.length === 1 && rep.nonStringIds[0].id === 123 && rep.bound === 1 && Object.keys(reg.byKey).length === 1, 'X02 数字 ID 不绑定、字符串 ID 正常绑定、复核清单完整', JSON.stringify(rep.nonStringIds));
})();
/* X03 checkIntegrity：数字 123 与字符串 '123' 不算重复、
   引用按类型匹配、非字符串 ID 被报告 */
(function () {
  var state = { products: [{ id: 123 }, { id: '123' }], opportunities: [
    { id: 'o1', selectedProductId: '123', followLog: [], log: [], matches: [] },
    { id: 'o2', selectedProductId: 123, followLog: [], log: [], matches: [] }], orders: [], settings: {} };
  var r = IM.checkIntegrity(state);
  ok(r.duplicateIds.length === 0 && r.orphanSelectedProduct === 0 && r.nonStringIds.length === 1, 'X03 类型区分：无误报重复/孤儿、数字 ID 被报告', JSON.stringify(r));
})();
/* X04 '__proto__' ID 的逆操作：updatedPrev 以类型键存储不丢数据 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, { opportunities: [{ id: '__proto__', buyer: { name: 'P' }, rawText: 'x', followLog: [], log: [], quote: { qty: 1 } }], products: [], orders: [], settings: {} });
  c._txn = TXN; TXN.init(s);
  var ci = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('XT-3', 3, 1)]), opts: OPTS });
  var j = JSON.parse(s.getItem(TXN.JOURNAL_KEY));
  ok(ci.applied === true && j.inverse.created.opportunities.length === 1, 'X04 __proto__ 存量 ID 不污染逆操作结构', JSON.stringify(Object.keys(j.inverse)));
})();

/* ================= B 组：buildBackup 错误降级 ================= */
/* B01 注册表读取抛错 → buildBackup 明确抛错，不生成残缺备份 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var throwing = { getItem: function (k) { if (k === IM.REGISTRY_KEY) throw new Error('io fail'); return s.getItem(k); }, setItem: function (k, v) { s.setItem(k, v); }, removeItem: function (k) { s.removeItem(k); } };
  var threw = null;
  try { TXN.buildBackup(c, throwing); } catch (e) { threw = e; }
  ok(!!threw && String(threw.message).indexOf('registry_read_failed') >= 0, 'B01 注册表读取失败 → 抛 registry_read_failed', threw && threw.message);
})();
/* B02 注册表内容损坏 → 抛 registry_corrupt */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(IM.REGISTRY_KEY, '{broken registry');
  var threw = null;
  try { TXN.buildBackup(c, s); } catch (e) { threw = e; }
  ok(!!threw && String(threw.message).indexOf('registry_corrupt') >= 0, 'B02 注册表损坏 → 抛 registry_corrupt', threw && threw.message);
})();
/* B03 注册表不存在 → 合法生成无注册表备份（正对照） */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var b = TXN.buildBackup(c, s);
  ok(b.identityRegistry === null && b.checksums.registry === null && TXN.validateBundle(b).ok === true, 'B03 无注册表时备份合法生成且自洽');
})();

console.log('== identity-r6: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
