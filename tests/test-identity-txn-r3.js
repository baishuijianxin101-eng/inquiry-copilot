/* P1-23-R7-R2-R3：锁 fail-closed / lastGood 基准 / 清锁验证 / journal 空串 / 恢复读回
   故障注入测试。全部虚构数据；存储层真实注错；事务模块逐场景全新加载。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
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
function makeCore(storage, initial) {
  var state = clone(initial);
  var core = { STORE_KEY: 'biz_state', /* R6 夹具对齐：声明本桩的落盘键，供 restoreBundle 磁盘快照读取；断言未动 */
    get: function () { return state; },
    _persist: function (TXN) { if (TXN.isLocked()) return false; try { storage.setItem('biz_state', JSON.stringify(state)); } catch (e) { return false; } return storage.getItem('biz_state') === JSON.stringify(state); },
    replaceAllChecked: function (obj) { state = clone(obj); return core._persist(core._txn); },
    persist: function () { return core._persist(core._txn); }, _txn: null };
  storage.setItem('biz_state', JSON.stringify(state));
  return core;
}
function emptyState() { return { products: [], opportunities: [], orders: [], settings: {} }; }
function oppRec(raw, qty, ver) {
  return { entity_type: 'opportunity', external_id_raw: raw, content: { buyerName: 'Ext Buyer', buyerCompany: 'Ext Co', productText: 'Widget', qty: qty, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, sourceVersion: ver,
    entity: { buyer: { name: 'Ext Buyer', company: 'Ext Co', country: 'DE' }, rawText: 'ext', followLog: [], log: [], quote: { qty: qty } } };
}
var OPTS = { buildEntity: function (t, c, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }, applyContent: function (ent, content) { if (ent.quote) ent.quote.qty = content.qty; } };
function batch(records) { return { source_system: 'alibaba_api', source_account: 'acct-1', records: records }; }
function preparedCtx() {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.arm(IM.REGISTRY_KEY, 1);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('P-1', 1, 1)]), opts: OPTS });
  return { TXN: TXN, s: s, c: c };
}

/* ---------- H1 R3-01：isLocked 五态 fail-closed ---------- */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(); TXN.init(s);
  ok(TXN._rawLockState(s).state === 'absent' && TXN.isLocked() === false, 'H01 无锁键 → absent 且未锁定');
  s.setItem(TXN.LOCK_KEY, JSON.stringify({ reason: 'test_lock', at: '2026-11-05' }));
  ok(TXN._rawLockState(s).state === 'valid' && TXN.isLocked() === true, 'H02 合法锁 → valid 且锁定');
  s.setItem(TXN.LOCK_KEY, '{broken json');
  ok(TXN._rawLockState(s).state === 'corrupt' && TXN.isLocked() === true && s.getItem(TXN.LOCK_KEY) === '{broken json', 'H03 锁 JSON 损坏 → corrupt、锁定、原文不自动删除');
  s.setItem(TXN.LOCK_KEY, JSON.stringify({ at: '2026-11-05' }));
  ok(TXN._rawLockState(s).state === 'invalid' && TXN.isLocked() === true, 'H04 锁缺 reason → invalid 且锁定');
  s.setItem(TXN.LOCK_KEY, JSON.stringify({ reason: 42 }));
  ok(TXN._rawLockState(s).state === 'invalid' && TXN.isLocked() === true, 'H05 锁 reason 类型非法 → invalid 且锁定');
  s.removeItem(TXN.LOCK_KEY);
  TXN.setMemLock(true);
  ok(TXN.isLocked() === true, 'H06 内存锁单独存在 → 锁定');
  TXN.setMemLock(false);
  ok(TXN.isLocked() === false, 'H07 内存锁清除且无持久锁 → 未锁定');
  /* getItem 抛异常 */
  var throwing = { getItem: function (k) { if (k === TXN.LOCK_KEY) throw new Error('read fail'); return null; }, setItem: function () {}, removeItem: function () {} };
  TXN.init(throwing);
  ok(TXN._rawLockState(throwing).state === 'error' && TXN.isLocked() === true, 'H08 锁读取抛异常 → error 且锁定（fail-closed）');
  var healed = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  TXN.init(healed);
  ok(TXN.isLocked() === false, 'H09 读取恢复且确认无锁 → 可正常解锁判定');
})();

/* ---------- H2 R3-04：journalStatus 状态矩阵 ---------- */
(function () {
  var TXN = freshTxn();
  var s = makeStorage();
  function st() { return TXN.journalStatus(s).state; }
  ok(st() === 'none', 'H10 journal 键不存在 → none');
  s.setItem(TXN.JOURNAL_KEY, '');
  ok(st() === 'corrupt', 'H11 journal 空字符串 → corrupt（不再误判 none）');
  s.setItem(TXN.JOURNAL_KEY, '{bad');
  ok(st() === 'corrupt', 'H12 journal 非法 JSON → corrupt');
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'WEIRD' }));
  ok(st() === 'corrupt', 'H13 journal phase 非法 → corrupt');
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'PREPARED', batchId: 'b1' }));
  ok(st() === 'corrupt', 'H14 PREPARED 缺关键字段 → corrupt');
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'PREPARED', batchId: 'b1', prevRegistry: '{}', inverse: { created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } }, preStateHash: 'x' }));
  ok(st() === 'prepared', 'H15 正常 PREPARED → prepared');
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'COMMITTED', batchId: 'b1' }));
  ok(st() === 'committed', 'H16 正常 COMMITTED → committed');
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'RECOVERED', batchId: 'b1' }));
  ok(st() === 'recovered', 'H17 正常 RECOVERED → recovered');
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'SUPERSEDED' }));
  ok(st() === 'superseded', 'H18 正常 SUPERSEDED → superseded');
  var throwing = { getItem: function () { throw new Error('read fail'); }, setItem: function () {}, removeItem: function () {} };
  ok(TXN.journalStatus(throwing).state === 'corrupt', 'H19 journal 读取异常 → corrupt');
})();

/* ---------- H3 R3-03：clearLock 验证与恢复报告 ---------- */
(function () {
  /* removeItem 抛异常 */
  var ctx = preparedCtx();
  var origRemove = ctx.s.removeItem;
  ctx.s.removeItem = function () { throw new Error('remove fail'); };
  var rc = ctx.TXN.recover({ storage: ctx.s, core: ctx.c });
  var stillPrepared = ctx.TXN.journalStatus(ctx.s).state === 'prepared';
  ok(rc.recovered === false && rc.reason === 'lock_clear_failed' && stillPrepared && ctx.TXN.isLocked(), 'H20 清锁抛异常：恢复不报成功、journal 保持 PREPARED、继续锁定');
  ctx.s.removeItem = origRemove;
  var rc2 = ctx.TXN.recover({ storage: ctx.s, core: ctx.c });
  ok(rc2.recovered === true && ctx.TXN.isLocked() === false, 'H21 存储修复后重跑恢复成功并解锁');
  /* removeItem 静默 no-op */
  var ctx2 = preparedCtx();
  ctx2.s.removeItem = function () { /* 静默不删 */ };
  var rc3 = ctx2.TXN.recover({ storage: ctx2.s, core: ctx2.c });
  ok(rc3.recovered === false && rc3.reason === 'lock_clear_failed' && ctx2.TXN.isLocked(), 'H22 清锁静默未删：读回仍有锁 → 不报成功、继续锁定');
  /* 删除后读回抛异常 */
  var ctx3 = preparedCtx();
  var origGet = ctx3.s.getItem;
  ctx3.s.removeItem = function (k) { ctx3.s._map.delete(k); };
  ctx3.s.getItem = function (k) { if (k === ctx3.TXN.LOCK_KEY) throw new Error('readback fail'); return origGet(k); };
  var rc4 = ctx3.TXN.recover({ storage: ctx3.s, core: ctx3.c });
  ok(rc4.recovered === false && rc4.reason === 'lock_clear_failed', 'H23 清锁后读回异常 → 不报成功');
  /* restoreBundle 清锁失败 */
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  var bundle = TXN.buildBackup(c, s);
  s.removeItem = function () { throw new Error('remove fail'); };
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  ok(rb.restored === false && rb.reason === 'lock_clear_failed' && TXN.journalStatus(s).state === 'none', 'H24 整包恢复清锁失败：不报成功且 journal 未被改写');
})();

/* ---------- H4 R3-05：恢复只认真实读回 ---------- */
(function () {
  /* 谎报 core：replaceAllChecked 返回 true 但不落盘不改状态 */
  var ctx = preparedCtx();
  var lying = { get: ctx.c.get, replaceAllChecked: function () { return true; } };
  var rc = ctx.TXN.recover({ storage: ctx.s, core: lying });
  ok(rc.recovered === false && rc.reason === 'state_hash_mismatch_after_rollback' && ctx.TXN.isLocked(), 'H25 待写对象正确但实际状态未变 → 哈希复验拒绝、保持锁定');
  /* bizKey 磁盘读回：落盘内容被篡改 */
  var ctx2 = preparedCtx();
  var tamper = { get: ctx2.c.get, replaceAllChecked: function (obj) { ctx2.s.setItem('biz_state', JSON.stringify({ products: [], opportunities: [{ id: 'tampered' }], orders: [], settings: {} })); return true; } };
  var rc2 = ctx2.TXN.recover({ storage: ctx2.s, core: tamper, bizKey: 'biz_state' });
  ok(rc2.recovered === false && (rc2.reason === 'disk_state_verify_failed' || rc2.reason === 'state_hash_mismatch_after_rollback') && ctx2.TXN.isLocked(), 'H26 磁盘读回与事务前哈希不一致 → 恢复拒绝、保持锁定', rc2.reason);
  /* bizKey 正常路径 */
  var ctx3 = preparedCtx();
  var rc3 = ctx3.TXN.recover({ storage: ctx3.s, core: ctx3.c, bizKey: 'biz_state' });
  ok(rc3.recovered === true && ctx3.TXN.isLocked() === false, 'H27 内存+磁盘双读回一致 → 恢复成功');
  /* 注册表回滚失败 */
  var ctx4 = preparedCtx();
  ctx4.s.arm(IM.REGISTRY_KEY, 1);
  var rc4 = ctx4.TXN.recover({ storage: ctx4.s, core: ctx4.c });
  ok(rc4.recovered === false && ctx4.TXN.isLocked(), 'H28 注册表回滚写失败 → 恢复失败、保持锁定');
  /* RECOVERED 标记写失败（清锁后）→ 重新置锁、不报成功 */
  var ctx5 = preparedCtx();
  ctx5.s.arm(ctx5.TXN.JOURNAL_KEY, 1);
  var rc5 = ctx5.TXN.recover({ storage: ctx5.s, core: ctx5.c });
  ok(rc5.recovered === false && rc5.reason === 'journal_mark_failed_after_unlock' && ctx5.TXN.isLocked(), 'H29 RECOVERED 标记写失败 → 不报成功、立即重新阻断');
})();

/* ---------- H5 R3-02：真实 Core 的 lastGood 基准（vm 隔离逐场景） ---------- */
(function () {
  var fs = require('fs'), vm = require('vm'), path = require('path');
  var CORE = fs.readFileSync(path.join(__dirname, '..', 'assets', 'core.js'), 'utf8');
  var BIZ = 'ali_commission_copilot_v1';
  function loadCore(store, failFlag) {
    var sb = { console: { log: function () {}, warn: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout };
    sb.window = sb;
    sb.localStorage = {
      getItem: function (k) { return store.has(k) ? store.get(k) : null; },
      setItem: function (k, v) { if (failFlag.on && k === BIZ) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); },
      removeItem: function (k) { store.delete(k); }
    };
    vm.createContext(sb);
    vm.runInContext(CORE, sb, { filename: 'core.js' });
    return sb.Core;
  }
  function counts(C) { var s = C.get(); return s.opportunities.length + '/' + s.products.length + '/' + s.orders.length; }
  /* a) 首次空存储 */
  (function () {
    var store = new Map(), failFlag = { on: false };
    var C = loadCore(store, failFlag);
    var base = counts(C);
    C.get().opportunities.push(C.normalizeOpp({ id: 'ghost_a', buyer: { name: 'G' }, rawText: 'x' }));
    failFlag.on = true;
    var r = C.persist();
    ok(r === false && counts(C) === base, 'H30 首次空存储：第一次落盘失败回滚到初始基准', base + ' vs ' + counts(C));
  })();
  /* b) 已有正常数据 */
  (function () {
    var store = new Map(), f1 = { on: false };
    var C1 = loadCore(store, f1);
    C1.get().opportunities.push(C1.normalizeOpp({ id: 'keep_b', buyer: { name: 'K' }, rawText: 'x' }));
    C1.persist();
    var failFlag = { on: false };
    var C = loadCore(store, failFlag);
    var base = counts(C);
    C.get().opportunities.push(C.normalizeOpp({ id: 'ghost_b', buyer: { name: 'G' }, rawText: 'x' }));
    failFlag.on = true;
    var r = C.persist();
    ok(r === false && counts(C) === base && C.get().opportunities.some(function (o) { return o.id === 'keep_b'; }), 'H31 已有数据：落盘失败回滚到加载时状态');
  })();
  /* c) 损坏原文 + 自动备份恢复 */
  (function () {
    var store = new Map(), f1 = { on: false };
    var C1 = loadCore(store, f1);
    C1.get().opportunities.push(C1.normalizeOpp({ id: 'bak_c', buyer: { name: 'B' }, rawText: 'x' }));
    C1.persist();
    var goodRaw = store.get(BIZ);
    store.set(BIZ, '{corrupted main');
    store.set(BIZ + '_bak', JSON.stringify({ at: '2026-11-05', data: JSON.parse(goodRaw) }));
    var failFlag = { on: false };
    var C = loadCore(store, failFlag);
    var base = counts(C);
    var hasBak = C.get().opportunities.some(function (o) { return o.id === 'bak_c'; });
    C.get().opportunities.push(C.normalizeOpp({ id: 'ghost_c', buyer: { name: 'G' }, rawText: 'x' }));
    failFlag.on = true;
    var r = C.persist();
    ok(hasBak && r === false && counts(C) === base, 'H32 损坏+备份恢复：落盘失败回滚到恢复后基准（非损坏原文）');
  })();
  /* d) 损坏原文 + 无备份 → freshState 基准 */
  (function () {
    var store = new Map();
    store.set(BIZ, '{corrupted main');
    var failFlag = { on: false };
    var C = loadCore(store, failFlag);
    var base = counts(C);
    C.get().opportunities.push(C.normalizeOpp({ id: 'ghost_d', buyer: { name: 'G' }, rawText: 'x' }));
    failFlag.on = true;
    var r = C.persist();
    ok(r === false && counts(C) === base, 'H33 损坏+无备份：落盘失败回滚到初始状态基准');
  })();
  /* e) 整包恢复后基准 = 恢复状态 */
  (function () {
    var store = new Map(), failFlag = { on: false };
    var ls = { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { if (failFlag.on && k === BIZ) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } };
    var TXN = freshTxn(); TXN.init(ls);
    var C = loadCore(store, failFlag);
    C.get().opportunities.push(C.normalizeOpp({ id: 'pre_e', buyer: { name: 'P' }, rawText: 'x' }));
    C.persist();
    var bundleState = clone(C.get());
    bundleState.opportunities = bundleState.opportunities.filter(function (o) { return o.id !== 'pre_e'; });
    bundleState.opportunities.push({ id: 'restored_e', buyer: { name: 'R', company: '', country: '', channel: '' }, rawText: 'x', followLog: [], log: [], quote: {} });
    var bundle = { format: 'ic-backup', version: 2, exportedAt: '2026-11-05', state: bundleState, identityRegistry: null, checksums: null };
    bundle.checksums = { state: TXN._stateHash(bundleState), registry: null };
    /* validateBundle 内部以 hashOf(JSON.stringify(state)) 重算比对，与 _stateHash(对象) 同口径 */
    var rb = TXN.restoreBundle({ storage: ls, core: { STORE_KEY: C.STORE_KEY, /* R6 夹具对齐：透传真实 Core 的落盘键 */ get: function () { return C.get(); }, replaceAllChecked: function (o) { return C.replaceAllChecked(o); } }, bundle: bundle });
    var base = counts(C);
    var hasRestored = C.get().opportunities.some(function (o) { return o.id === 'restored_e'; });
    C.get().opportunities.push(C.normalizeOpp({ id: 'ghost_e', buyer: { name: 'G' }, rawText: 'x' }));
    failFlag.on = true;
    var r = C.persist();
    ok(rb.restored === true && hasRestored && r === false && counts(C) === base, 'H34 整包恢复后：落盘失败回滚到恢复状态基准', JSON.stringify(rb));
  })();
})();

console.log('== identity-txn-r3: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
