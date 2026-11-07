/* P1-23-R7-R2-R5：恢复事务与导入原子性定点修复专项。
   S 组：restoreBundle 回滚矩阵（任务书故障 A–G）与 recoverRestore
   磁盘裁决；T 组：importBatchFile 事务委托；P 组：身份模型边界
   （特殊键/字段类型/绑定幂等/resolution 白名单/重复组配对）。
   全部虚构数据；故障注入验证磁盘、内存、journal、锁四种状态。
   测试桩与正式 Core 的锁语义一致（见 R5-TEST-HARNESS-REVIEW）。 */
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

/* 故障注入存储：arm(key, {skip, times, corrupt})——skip 次放行后，
   times 次写失败（抛配额错）或静默写坏（corrupt，存入标记串不抛错）。 */
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
/* 与正式 Core 锁语义一致的桩（同 test-identity-r4.js 的 R5 版桩） */
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
/* 注册表与业务状态不一致的备份：删掉一个商机但保留其注册表映射，
   校验和按删除后的状态重算（validateBundle 可通过，恢复后一致性
   检查必然失败——用于在「注册表已写目标值」之后触发 abort）。 */
function inconsistentBundle(TXN) {
  var b = sourceBundle(TXN, [oppRec('IB-1', 1, 1), oppRec('IB-2', 2, 1)]);
  b.state.opportunities = b.state.opportunities.slice(0, 1);
  b.checksums.state = TXN._stateHash(b.state);
  return b;
}

/* ================= S 组：恢复回滚矩阵 ================= */
/* S01 故障 D：注册表已写目标值、一致性检查失败 → 双边回滚（R4 缺陷） */
(function () {
  var TXN = freshTxn();
  var bundle = inconsistentBundle(TXN);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var prevBiz = s.getItem(BIZ_KEY);
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.rolledBack === true && String(rb.reason).indexOf('consistency_check_failed') === 0, 'S01a 一致性失败触发回滚且如实报告', JSON.stringify(rb));
  ok(s.getItem(BIZ_KEY) === prevBiz && c.get().opportunities.length === 0 && s.getItem(IM.REGISTRY_KEY) === null, 'S01b 业务与注册表双边回到恢复前（注册表不再停在目标值）');
  ok(TXN.restoreJournalStatus(s).state === 'aborted' && TXN.isLocked() === false, 'S01c 日志 ABORTED 且锁已解除');
})();

/* S02 故障 E：业务回滚成功、注册表回滚写失败 → 保持 PREPARED+锁，
   存储修复后 recover 按「业务前态+注册表目标」裁决回滚注册表 */
(function () {
  var TXN = freshTxn();
  var bundle = inconsistentBundle(TXN);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('RB-0', 3, 1)]), opts: OPTS });
  var prevBiz = s.getItem(BIZ_KEY), prevReg = s.getItem(IM.REGISTRY_KEY);
  s.arm(IM.REGISTRY_KEY, { skip: 1, times: 1 }); /* 目标写放行、回滚写抛错 */
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && String(rb.reason).indexOf('rollback_failed_restore_pending') > 0 && TXN.restoreJournalStatus(s).state === 'prepared' && TXN.isLocked() === true, 'S02a 注册表回滚失败 → 不标 ABORTED、保持 PREPARED+锁', JSON.stringify(rb));
  ok(s.getItem(BIZ_KEY) === prevBiz && s.getItem(IM.REGISTRY_KEY) === JSON.stringify(bundle.identityRegistry), 'S02b 失败时点状态：业务已回滚、注册表停在目标（如实保留待裁决）');
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && rc.mode === 'aborted_registry_rolled_back' && s.getItem(IM.REGISTRY_KEY) === prevReg && TXN.restoreJournalStatus(s).state === 'aborted' && TXN.isLocked() === false, 'S02c 修复后裁决回滚注册表并完成中止', JSON.stringify(rc));
})();

/* S03 故障 F：业务回滚写失败 → 保持 PREPARED+锁；修复后向前完成 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('RB-1', 7, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.arm(TXN.RESTORE_JOURNAL_KEY, { skip: 1, times: 1 }); /* PREPARED 落盘放行、目标哈希刷新写抛错 → 触发 abort */
  s.arm(BIZ_KEY, { skip: 1, times: 1 });                 /* 目标业务写放行、回滚业务写抛错 */
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && String(rb.reason).indexOf('rollback_failed_restore_pending') > 0 && TXN.restoreJournalStatus(s).state === 'prepared' && TXN.isLocked() === true, 'S03a 业务回滚失败 → 保持 PREPARED+锁', JSON.stringify(rb));
  ok(s.getItem(BIZ_KEY) === JSON.stringify(bundle.state) && s.getItem(IM.REGISTRY_KEY) === null, 'S03b 失败时点状态：业务停在目标、注册表仍为前态');
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && rc.mode === 'completed_forward' && s.getItem(IM.REGISTRY_KEY) === JSON.stringify(bundle.identityRegistry) && TXN.restoreJournalStatus(s).state === 'completed' && TXN.isLocked() === false, 'S03c 修复后向前补齐注册表完成恢复', JSON.stringify(rc));
})();

/* S04 故障 C：注册表写入静默写坏（读回不一致）→ 中止并双边回滚 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('RB-1', 7, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var prevBiz = s.getItem(BIZ_KEY);
  s.arm(IM.REGISTRY_KEY, { times: 1, corrupt: true });
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.reason === 'registry_verify_failed' && rb.rolledBack === true && s.getItem(IM.REGISTRY_KEY) === null && s.getItem(BIZ_KEY) === prevBiz && TXN.restoreJournalStatus(s).state === 'aborted' && TXN.isLocked() === false, 'S04 注册表读回不一致 → 回滚双边、ABORTED、解锁', JSON.stringify(rb));
})();

/* S05 故障 G：回滚注册表写被静默写坏（回滚读回不一致）→ 保持待裁决，
   且该组合不可自动裁决（注册表既非前态亦非目标）→ 人工处理 */
(function () {
  var TXN = freshTxn();
  var bundle = inconsistentBundle(TXN);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  /* 目标环境先有既存数据与注册表，使回滚必须以 setItem 写回注册表原文
     （prevRegistry 为 null 时回滚走 removeItem，注入不到写坏路径）。 */
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('RB-0', 3, 1)]), opts: OPTS });
  var prevBiz = s.getItem(BIZ_KEY);
  s.arm(IM.REGISTRY_KEY, { skip: 1, times: 1, corrupt: true }); /* 目标写放行、回滚写写坏 */
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && String(rb.reason).indexOf('rollback_failed_restore_pending') > 0 && TXN.restoreJournalStatus(s).state === 'prepared' && TXN.isLocked() === true && s.getItem(IM.REGISTRY_KEY) === '###corrupted###' && s.getItem(BIZ_KEY) === prevBiz, 'S05a 回滚读回不一致 → 不标 ABORTED、保持 PREPARED+锁、业务已回滚', JSON.stringify(rb));
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && rc.reason === 'restore_state_inconsistent_manual_required' && TXN.isLocked() === true, 'S05b 注册表为未知值 → 不自动裁决、保持锁定待人工', JSON.stringify(rc));
})();

/* S06 recoverRestore 磁盘裁决证明：磁盘=目标、内存=前态、注册表=目标。
   若按内存裁决会得出「回滚注册表」结论；按磁盘裁决应判 COMPLETED。 */
(function () {
  var TXN = freshTxn();
  var bundle = sourceBundle(TXN, [oppRec('RB-1', 7, 1)]);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(BIZ_KEY, JSON.stringify(bundle.state)); /* 只改磁盘，内存仍为前态 */
  s.setItem(IM.REGISTRY_KEY, JSON.stringify(bundle.identityRegistry));
  var rj = { batchId: 'restore_disk1', phase: 'PREPARED', kind: 'restore', at: '2026-11-06', prevRegistry: null, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
    prevState: emptyState(), inverse: { created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(emptyState()), targetStateHash: TXN._stateHash(bundle.state) };
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  var chk = TXN.checkOnLoad(s, c);
  var rc = TXN.recover({ storage: s, core: c });
  ok(chk.locked === true && rc.recovered === true && rc.mode === 'completed' && TXN.restoreJournalStatus(s).state === 'completed', 'S06 裁决依据为磁盘原文而非内存态', JSON.stringify(rc));
  /* S06b 磁盘业务原文损坏 → fail-closed */
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  var rj2 = clone(rj); rj2.batchId = 'restore_disk2';
  s2.setItem(TXN2.RESTORE_JOURNAL_KEY, JSON.stringify(rj2));
  s2.setItem(BIZ_KEY, '{broken json');
  TXN2.checkOnLoad(s2, c2);
  var rc2 = TXN2.recover({ storage: s2, core: c2 });
  ok(rc2.recovered === false && rc2.reason === 'persisted_state_unparseable' && TXN2.isLocked() === true, 'S06b 磁盘原文不可解析 → fail-closed 保持锁定', JSON.stringify(rc2));
})();

/* S07 恢复日志结构不完整（缺 targetRegistry）→ corrupt、fail-closed */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var rj = { batchId: 'restore_bad1', phase: 'PREPARED', kind: 'restore', prevRegistry: null, inverse: { created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } }, preStateHash: 'x', targetStateHash: 'y' };
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  var chk = TXN.checkOnLoad(s, c);
  var rc = TXN.recover({ storage: s, core: c });
  ok(chk.restoreJournalState === 'corrupt' && chk.locked === true && rc.recovered === false && rc.reason === 'restore_journal_corrupt_manual_required' && TXN.isLocked() === true, 'S07 结构不完整恢复日志 → corrupt 阻断、不当作无待恢复事务', JSON.stringify(rc));
})();

/* S08 终态日志 + 残留锁收敛；非恢复来源的锁不被误清 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify({ batchId: 'restore_x', phase: 'ABORTED', kind: 'restore', at: '2026-11-06' }));
  s.setItem(TXN.LOCK_KEY, JSON.stringify({ reason: 'restore_in_progress', batchId: 'restore_x', at: '2026-11-06' }));
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && rc.mode === 'stale_lock_cleared' && TXN.isLocked() === false, 'S08a ABORTED + 恢复残留锁 → 清扫解除', JSON.stringify(rc));
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  s2.setItem(TXN2.RESTORE_JOURNAL_KEY, JSON.stringify({ batchId: 'restore_y', phase: 'COMPLETED', kind: 'restore', at: '2026-11-06' }));
  s2.setItem(TXN2.LOCK_KEY, JSON.stringify({ reason: 'consistency_check_failed', at: '2026-11-06' }));
  var rc2 = TXN2.recover({ storage: s2, core: c2 });
  ok(rc2.recovered === false && TXN2.isLocked() === true, 'S08b 一致性锁（非恢复遗留）不被清扫', JSON.stringify(rc2));
})();

/* S09 向前完成路径的一致性门：磁盘为目标/目标但配对本身不一致 →
   不标 COMPLETED、保持锁定待人工 */
(function () {
  var TXN = freshTxn();
  var bundle = inconsistentBundle(TXN);
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(BIZ_KEY, JSON.stringify(bundle.state));
  s.setItem(IM.REGISTRY_KEY, JSON.stringify(bundle.identityRegistry));
  var rj = { batchId: 'restore_bad2', phase: 'PREPARED', kind: 'restore', at: '2026-11-06', prevRegistry: null, targetRegistry: JSON.stringify(bundle.identityRegistry), registryFromBundle: true,
    prevState: emptyState(), inverse: { created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(emptyState()), targetStateHash: TXN._stateHash(bundle.state) };
  s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(rj));
  TXN.checkOnLoad(s, c);
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === false && String(rc.reason).indexOf('restore_final_consistency_failed') === 0 && TXN.restoreJournalStatus(s).state === 'prepared' && TXN.isLocked() === true, 'S09 目标对不一致 → 向前完成被一致性门阻断', JSON.stringify(rc));
})();

/* ================= T 组：importBatchFile 事务委托 ================= */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var r1 = IM.importBatchFile(c, batch([oppRec('T-1', 1, 1)]), s, OPTS);
  ok(r1.applied === true && r1.via === 'identity_txn' && r1.counts.CREATED === 1 && c.get().opportunities.length === 1 && TXN.journalStatus(s).state === 'committed', 'T01 importBatchFile 经事务层提交（journal COMMITTED）', JSON.stringify(r1));
  var regRaw = s.getItem(IM.REGISTRY_KEY);
  ok(typeof regRaw === 'string' && regRaw.indexOf(c.get().opportunities[0].id) >= 0, 'T02 注册表与业务状态同批落盘');
  /* 注册表写失败：不得报告成功，journal 保持 PREPARED，recover 可回滚 */
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  s2.arm(IM.REGISTRY_KEY, { times: 10 });
  var r2 = IM.importBatchFile(c2, batch([oppRec('T-2', 1, 1)]), s2, OPTS);
  ok(r2.applied === false && TXN2.journalStatus(s2).state === 'prepared' && TXN2.isLocked() === true, 'T03 注册表写失败 → 不报告成功、PREPARED+锁', JSON.stringify(r2));
  s2.disarm(); /* 模拟存储故障修复后再执行恢复 */
  var rc = TXN2.recover({ storage: s2, core: c2 });
  ok(rc.recovered === true && c2.get().opportunities.length === 0 && TXN2.isLocked() === false, 'T04 失败批次经 recover 回滚干净', JSON.stringify(rc));
})();

/* T05 事务层缺失时明确拒绝（子进程中只部署 identity + migration 两个文件） */
(function () {
  var fs = require('fs'), os = require('os'), path = require('path');
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5t5-'));
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'identity.js'), path.join(dir, 'identity.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'identity-migration.js'), path.join(dir, 'identity-migration.js'));
  var script = "var IM=require(" + JSON.stringify(path.join(dir, 'identity-migration.js')) + ");" +
    "var m=new Map();var st={getItem:function(k){return m.has(k)?m.get(k):null;},setItem:function(k,v){m.set(k,String(v));},removeItem:function(k){m.delete(k);}};" +
    "var core={get:function(){return {products:[],opportunities:[],orders:[]};},replaceAll:function(){throw new Error('must_not_be_called');}};" +
    "var r=IM.importBatchFile(core,{source_system:'s',source_account:'a',records:[]},st,{});console.log(JSON.stringify(r));";
  var out = require('child_process').execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  var parsed = JSON.parse(out.trim().split('\n').pop());
  ok(parsed.applied === false && parsed.error === 'transaction_layer_unavailable', 'T05 无事务层时 importBatchFile 明确拒绝、不执行双写', out);
})();

/* ================= P 组：身份模型边界 ================= */
/* P01 特殊键：internalId 为 '__proto__' 的注册表导入/重建/往返 */
(function () {
  var ent = { internalId: '__proto__', identity: idn('legacy', 'local-instance', 'product', '__proto__'), content: { title: 'T', model: 'M', category: 'C' }, contentHash: 'h', canonVersion: 'canon-v1', sourceVersion: 1, sourceUpdatedAt: null, sourceValue: {}, parsedValue: null, confirmedValue: null, archived: false };
  var byKey = {}; byKey[ID.identityKeyOf(ent.identity)] = ent;
  var reg = ID.importState(JSON.stringify({ byKey: byKey, conflicts: [], reviewEvents: [], canonVersion: 'canon-v1', keyVersion: 'esc-v2' }));
  ok(Object.prototype.hasOwnProperty.call(reg.byInternal, '__proto__') && reg.byInternal['__proto__'].internalId === '__proto__' && Object.keys(reg.byInternal).length === 1, 'P01a internalId=__proto__ 在重建后仍为自有映射、不丢失');
  ok(({}).polluted === undefined && Object.getPrototypeOf({}) === Object.prototype, 'P01b 无原型污染');
  var reg2 = ID.importState(ID.exportState(reg));
  ok(Object.prototype.hasOwnProperty.call(reg2.byInternal, '__proto__') && reg2.byKey[ID.identityKeyOf(ent.identity)].internalId === '__proto__', 'P01c 导出→再导入往返保持映射');
})();

/* P02 特殊键：registerExisting('constructor') 与 backfill 的 'toString'/'__proto__' 实体 ID */
(function () {
  var r = ID.createRegistry();
  var res = ID.registerExisting(r, idn('legacy', 'local-instance', 'product', 'PX'), 'constructor', { title: 'T', model: 'M', category: 'C' });
  ok(res.status === 'BOUND' && Object.prototype.hasOwnProperty.call(r.byInternal, 'constructor') && r.byInternal['constructor'].internalId === 'constructor', 'P02a internalId=constructor 正常登记、不被原型链遮蔽');
  var reg = ID.createRegistry();
  var st = { products: [{ id: 'toString', title: 'A', model: '', category: '' }, { id: 'toString', title: 'A2', model: '', category: '' }, { id: '__proto__', title: 'B', model: '', category: '' }], opportunities: [], orders: [] };
  var rep = IM.backfillLegacy(st, reg);
  ok(rep.perType.product.bound === 2 && rep.perType.product.duplicates === 1 && Object.prototype.hasOwnProperty.call(reg.byInternal, '__proto__'), 'P02b backfill 对 toString 首个实体正常绑定（不误判重复）、第二个判重复、__proto__ 可绑定', JSON.stringify(rep.perType));
})();

/* P03 身份字段类型矩阵 */
(function () {
  function attempt(idnObj) { return ID.importRecord(ID.createRegistry(), { identity: idnObj, content: oppContent(1), sourceVersion: 1 }); }
  ok(attempt(idn(123, 'a', 'opportunity', 'X')).status === 'INVALID', 'P03a source_system 为数字 → INVALID（不隐式转字符串）');
  ok(attempt(idn('s', 'a', 'opportunity', 123)).status === 'INVALID', 'P03b external_id_raw 为数字 123 → INVALID（与字符串 \'123\' 不碰撞）');
  ok(attempt(idn('s', 'a', 'opportunity', '123')).status === 'CREATED', 'P03c external_id_raw 为字符串 \'123\' → CREATED');
  ok(attempt(idn('s', 'a', 'opportunity', null)).status === 'INVALID' && attempt(idn('s', 'a', 'opportunity', {})).status === 'INVALID' && attempt(idn('s', 'a', 'opportunity', [])).status === 'INVALID' && attempt(idn('s', 'a', 'opportunity', '')).status === 'INVALID', 'P03d raw 为 null/对象/数组/空串 → INVALID');
  ok(attempt(idn('s', 123, 'opportunity', 'X')).status === 'NEEDS_REVIEW', 'P03e source_account 为数字 → NEEDS_REVIEW（不跨账号猜测）');
  var longRaw = 'x'.repeat(10000);
  var lr = attempt(idn('s', 'a', 'opportunity', longRaw));
  ok(lr.status === 'CREATED' && ID.identityKeyOf(idn('s', 'a', 'opportunity', longRaw)).length === 1 + 1 + 1 + 1 + 'opportunity'.length + 1 + 10000, 'P03f 超长字段（10000 字符）原样保留、不截断');
})();

/* P04 bindAdditionalIdentity 幂等 */
(function () {
  var r = ID.createRegistry();
  var a = ID.importRecord(r, { identity: idn('s', 'a', 'opportunity', 'P1'), content: oppContent(1), sourceVersion: 1 });
  var b1 = ID.bindAdditionalIdentity(r, a.internalId, idn('s2', 'a', 'opportunity', 'P1-ext'), 'op');
  var ent = r.byInternal[a.internalId];
  var b2 = ID.bindAdditionalIdentity(r, a.internalId, idn('s2', 'a', 'opportunity', 'P1-ext'), 'op');
  ok(b1.status === 'BOUND' && b2.status === 'UNCHANGED' && ent.additionalIdentities.length === 1 && Object.keys(r.byKey).length === 2, 'P04a 重复绑定同一附加身份 → UNCHANGED、不重复追加');
  var b3 = ID.bindAdditionalIdentity(r, a.internalId, idn('s', 'a', 'opportunity', 'P1'), 'op');
  ok(b3.status === 'UNCHANGED' && ent.additionalIdentities.length === 1, 'P04b 重复绑定主身份 → UNCHANGED');
  var other = ID.importRecord(r, { identity: idn('s', 'a', 'opportunity', 'P2'), content: oppContent(2), sourceVersion: 1 });
  var b4 = ID.bindAdditionalIdentity(r, other.internalId, idn('s2', 'a', 'opportunity', 'P1-ext'), 'op');
  ok(b4.status === 'CONFLICT' && !!b4.conflictId && r.byKey[ID.identityKeyOf(idn('s2', 'a', 'opportunity', 'P1-ext'))].internalId === a.internalId, 'P04c 绑定他人已占身份 → CONFLICT 且原映射不变');
})();

/* P05 resolveConflict 白名单 */
(function () {
  var r = ID.createRegistry();
  var nr = ID.importRecord(r, { identity: idn('s', '', 'opportunity', 'X1'), content: oppContent(1) });
  var cid = nr.conflictId;
  function status() { return r.conflicts.filter(function (x) { return x.id === cid; })[0].status; }
  ok(ID.resolveConflict(r, cid, 'bogus', 'op').ok === false && status() === 'PENDING', 'P05a 未知 resolution → 拒绝、冲突保持 PENDING');
  ok(ID.resolveConflict(r, cid, '', 'op').ok === false && ID.resolveConflict(r, cid, '__proto__', 'op').ok === false && status() === 'PENDING', 'P05b 空串/__proto__ resolution → 拒绝');
  ok(ID.resolveConflict(r, cid, 'need_more_info', 'op').ok === true && status() === 'NEEDS_MORE_INFO', 'P05c need_more_info 合法');
  ok(ID.resolveConflict(r, cid, 'keep_existing', 'op').ok === true && status() === 'RESOLVED', 'P05d keep_existing → RESOLVED');
  ok(ID.resolveConflict(r, 'nonexistent-id', 'keep_existing', 'op').ok === false, 'P05e 不存在的冲突 → 拒绝');
})();

/* P06 findPossibleDuplicates 完整配对 */
(function () {
  function mkReg(n) {
    var r = ID.createRegistry();
    for (var i = 0; i < n; i++) ID.importRecord(r, { identity: idn('src' + i, 'a', 'opportunity', 'D' + i), content: oppContent(7), sourceVersion: 1 });
    return r;
  }
  var p3 = ID.findPossibleDuplicates(mkReg(3));
  var p4 = ID.findPossibleDuplicates(mkReg(4));
  ok(p3.length === 3 && p4.length === 6, 'P06a 三实体重复组 → 3 对、四实体 → 6 对（完整无序配对）', p3.length + '/' + p4.length);
  ok(p4.every(function (pr) { return pr[0] !== pr[1]; }), 'P06b 无自配对');
})();

console.log('== identity-r5: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
