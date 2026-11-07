/* P1-23-R7：R6 剩余缺陷定点修复专项（事务部分）。
   T 组：数字/字符串/特殊 ID 的逆操作真实往返（第三项，经 recover
   入口执行 applyInverse 并逐字段比对磁盘状态）；J 组：旧格式
   journal 特殊键读取安全（第二项，含原型链诱饵）；C 组：
   commitImport 对 restore journal 各状态的 fail-closed（第七项）。
   全部虚构数据；本文件为 Node 存储桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
var BIZ_KEY = 'ali_commission_copilot_v1';

function makeStorage() {
  var map = new Map(), rules = [];
  return {
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) {
      for (var i = 0; i < rules.length; i++) { var r = rules[i]; if (r.key === k) { if (r.skip > 0) { r.skip--; break; } if (r.times > 0) { r.times--; throw new Error('QuotaExceededError'); } } }
      map.set(k, String(v));
    },
    removeItem: function (k) { map.delete(k); },
    arm: function (k, opts) { rules.push({ key: k, skip: (opts && opts.skip) || 0, times: (opts && opts.times) || 0 }); },
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
      if (storage.getItem(BIZ_KEY) !== raw) { state = JSON.parse(lastGoodRaw); return false; }
      lastGoodRaw = raw;
      return true;
    },
    replaceAllChecked: function (obj) { state = clone(obj); return core.persist(); },
    _txn: null };
  storage.setItem(BIZ_KEY, lastGoodRaw);
  return core;
}
function emptyState() { return { products: [], opportunities: [], orders: [], settings: {} }; }
function oppEnt(id, qty, tag) { return { id: id, tag: tag, buyer: { name: 'B' }, rawText: 'x', followLog: [], log: [], quote: { qty: qty } }; }
function diskState(s) { return JSON.parse(s.getItem(BIZ_KEY)); }
function entByTypeId(list, id) { return list.filter(function (e) { return e.id === id && typeof e.id === typeof id; })[0]; }

/* ================= T 组：typed-v2 逆操作真实往返 ================= */
/* T01 prev 含数字 123、字符串 '123'、'__proto__' 三个实体，事务
   后三者都被改值并新增一个实体；PREPARED journal（typed-v2，
   与 commitImport 实际产出同格式）经 recover() 执行逆操作后，
   磁盘状态必须逐字段回到 prev——三 ID 不合并、不丢失、不污染。 */
(function () {
  var TXN = freshTxn();
  var prev = { products: [], opportunities: [oppEnt(123, 1, 'num'), oppEnt('123', 2, 'str'), oppEnt('__proto__', 3, 'proto'), oppEnt('keep', 4, 'keep')], orders: [], settings: {} };
  var post = { products: [], opportunities: [oppEnt(123, 10, 'num'), oppEnt('123', 20, 'str'), oppEnt('__proto__', 30, 'proto'), oppEnt('keep', 4, 'keep'), oppEnt('added_r7', 99, 'new')], orders: [], settings: {} };
  var s = makeStorage(), c = makeCore(s, post);
  c._txn = TXN; TXN.init(s);
  var reg = ID.createRegistry();
  var journal = { batchId: 'batch_r7t', phase: 'PREPARED', at: '2026-11-06T00:00:00.000Z',
    prevRegistry: ID.exportState(reg),
    inverse: { format: 'typed-v2',
      created: { opportunities: ['added_r7'], products: [], orders: [] },
      updatedPrev: { opportunities: { 'n:123': clone(prev.opportunities[0]), 's:123': clone(prev.opportunities[1]), 's:__proto__': clone(prev.opportunities[2]) }, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(prev), prevLegacyPending: 'absent' };
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify(journal));
  s.setItem(TXN.LOCK_KEY, JSON.stringify({ batchId: 'batch_r7t', reason: 'business_persist_failed', at: '2026-11-06T00:00:00.000Z' }));
  var rc = TXN.recover({ storage: s, core: c });
  var disk = diskState(s);
  ok(rc.recovered === true, 'T01a recover 成功（逆操作+哈希复验通过）', JSON.stringify(rc));
  ok(TXN._stateHash(disk) === TXN._stateHash(prev) && disk.opportunities.length === 4, 'T01b 磁盘状态哈希与 prev 一致、新增实体已移除');
  var eNum = entByTypeId(disk.opportunities, 123), eStr = entByTypeId(disk.opportunities, '123'), eProto = entByTypeId(disk.opportunities, '__proto__'), eKeep = entByTypeId(disk.opportunities, 'keep');
  ok(!!eNum && typeof eNum.id === 'number' && eNum.quote.qty === 1 && eNum.tag === 'num', 'T01c 数字 ID 123 实体逐字段还原');
  ok(!!eStr && typeof eStr.id === 'string' && eStr.quote.qty === 2 && eStr.tag === 'str', 'T01d 字符串 ID 123 实体逐字段还原（与数字未合并）');
  ok(!!eProto && eProto.quote.qty === 3 && eProto.tag === 'proto' && Object.keys(eProto).sort().join(',') === 'buyer,followLog,id,log,quote,rawText,tag', 'T01e __proto__ 实体逐字段还原且无额外属性');
  ok(!!eKeep && eKeep.quote.qty === 4 && ({}).tag === undefined && !('polluted' in {}), 'T01f 未改动实体保留、Object.prototype 未被污染');
})();

/* T02 真实 commitImport 产生的 journal：导入新建 int_ 实体后在
   注册表落盘一步失败 → PREPARED；recover 后 int_ 实体被逆操作
   移除，存量 123/'123'/'__proto__' 三实体逐字不变 */
(function () {
  var TXN = freshTxn();
  var init = { products: [], opportunities: [oppEnt(123, 1, 'num'), oppEnt('123', 2, 'str'), oppEnt('__proto__', 3, 'proto')], orders: [], settings: {} };
  var s = makeStorage(), c = makeCore(s, init);
  c._txn = TXN; TXN.init(s);
  var prevBiz = s.getItem(BIZ_KEY);
  var OPTS = { buildEntity: function (t, cn, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }, applyContent: function (ent, cn) { if (ent.quote) ent.quote.qty = cn.qty; } };
  var rec = { entity_type: 'opportunity', external_id_raw: 'RT-1', content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, sourceVersion: 1, entity: oppEnt('tmp', 5, 'new') };
  s.arm(IM.REGISTRY_KEY, { times: 1 });
  var ci = TXN.commitImport({ storage: s, core: c, batch: { source_system: 'alibaba_api', source_account: 'acct-1', records: [rec] }, opts: OPTS });
  ok(ci.applied === false && ci.stage === 'registry_persist' && TXN.journalStatus(s).state === 'prepared', 'T02a 真实导入在注册表步失败、journal PREPARED');
  s.disarm();
  var rc = TXN.recover({ storage: s, core: c });
  ok(rc.recovered === true && s.getItem(BIZ_KEY) === prevBiz, 'T02b recover 后磁盘业务原文与事务前逐字一致（存量三实体未被合并/污染）', JSON.stringify(rc));
})();

/* ================= J 组：旧格式 journal 特殊键安全 ================= */
/* J01 旧 journal（无 format）updatedPrev 以原始 ID 为键，含
   '__proto__'/'constructor'/'toString' 三个快照；另有 'valueOf'
   实体未被更新（诱饵：旧实现会读到 Object.prototype.valueOf
   函数并把实体替换成垃圾/抛错）。recover 后：三快照逐字段还原、
   valueOf 实体原样保留、无伪实体、无原型污染。 */
(function () {
  var TXN = freshTxn();
  var prev = { products: [], opportunities: [oppEnt('__proto__', 1, 'p'), oppEnt('constructor', 2, 'c'), oppEnt('toString', 3, 't'), oppEnt('valueOf', 4, 'v'), oppEnt('plain', 5, 'pl')], orders: [], settings: {} };
  var post = { products: [], opportunities: [oppEnt('__proto__', 10, 'p'), oppEnt('constructor', 20, 'c'), oppEnt('toString', 30, 't'), oppEnt('valueOf', 4, 'v'), oppEnt('plain', 5, 'pl'), oppEnt('legacy_added', 9, 'new')], orders: [], settings: {} };
  var s = makeStorage(), c = makeCore(s, post);
  c._txn = TXN; TXN.init(s);
  var reg = ID.createRegistry();
  var updRaw = JSON.parse('{"__proto__":' + JSON.stringify(prev.opportunities[0]) + ',"constructor":' + JSON.stringify(prev.opportunities[1]) + ',"toString":' + JSON.stringify(prev.opportunities[2]) + '}');
  var journal = { batchId: 'batch_legacy', phase: 'PREPARED', at: '2026-11-05T00:00:00.000Z',
    prevRegistry: ID.exportState(reg),
    inverse: { created: { opportunities: ['legacy_added'], products: [], orders: [] },
      updatedPrev: { opportunities: updRaw, products: {}, orders: {} } },
    preStateHash: TXN._stateHash(prev) };
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify(journal));
  s.setItem(TXN.LOCK_KEY, JSON.stringify({ batchId: 'batch_legacy', reason: 'business_persist_failed', at: '2026-11-05T00:00:00.000Z' }));
  var rc = TXN.recover({ storage: s, core: c });
  var disk = diskState(s);
  ok(rc.recovered === true && TXN._stateHash(disk) === TXN._stateHash(prev), 'J01a 旧 journal 逆操作往返成功、哈希复验通过', JSON.stringify(rc));
  var v = entByTypeId(disk.opportunities, 'valueOf');
  ok(disk.opportunities.length === 5 && !!v && v.quote.qty === 4 && v.tag === 'v' && Object.keys(v).sort().join(',') === 'buyer,followLog,id,log,quote,rawText,tag', 'J01b valueOf 诱饵实体未被原型链属性替换、无伪实体');
  var ts = entByTypeId(disk.opportunities, 'toString');
  ok(!!ts && ts.quote.qty === 3 && typeof ts === 'object' && ({}).tag === undefined, 'J01c toString 快照按自身属性还原、原型未污染');
})();

/* ================= C 组：commitImport × restore journal 状态 ================= */
function baseEnv(TXN) {
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  return { s: s, c: c };
}
var OPTS2 = { buildEntity: function (t, cn, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }, applyContent: function (ent, cn) { if (ent.quote) ent.quote.qty = cn.qty; } };
function oneBatch() { return { source_system: 'alibaba_api', source_account: 'acct-1', records: [{ entity_type: 'opportunity', external_id_raw: 'CJ-1', content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, sourceVersion: 1, entity: oppEnt('tmp', 5, 'n') }] }; }
function validRj(TXN, phase) {
  return { batchId: 'restore_cj', phase: phase, kind: 'restore', at: '2026-11-06T00:00:00.000Z',
    prevRegistry: null, targetRegistry: null, registryFromBundle: false,
    prevState: emptyState(), inverse: { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: {}, products: {}, orders: {} } },
    preStateHash: 'h1', targetStateHash: 'h2', targetCollectionsHash: 'h3', prevLegacyPending: 'absent', targetLegacyPending: 'absent', targetWriteStarted: false };
}
/* C01 restore journal 不存在 → 导入正常进行 */
(function () {
  var TXN = freshTxn(); var env = baseEnv(TXN);
  var ci = TXN.commitImport({ storage: env.s, core: env.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci.applied === true && env.c.get().opportunities.length === 1, 'C01 无恢复日志 → 导入正常');
})();
/* C02 restore journal PREPARED → unfinished_restore 阻断（既有） */
(function () {
  var TXN = freshTxn(); var env = baseEnv(TXN);
  env.s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(validRj(TXN, 'PREPARED')));
  var before = env.s.getItem(BIZ_KEY);
  var ci = TXN.commitImport({ storage: env.s, core: env.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci.applied === false && ci.reason === 'unfinished_restore_must_recover_first' && env.s.getItem(BIZ_KEY) === before && TXN.isLocked() === true, 'C02 PREPARED 恢复日志 → 阻断、业务不变');
})();
/* C03 restore journal COMPLETED / ABORTED → 不阻断导入 */
(function () {
  var TXN = freshTxn(); var env = baseEnv(TXN);
  env.s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(validRj(TXN, 'COMPLETED')));
  var ci = TXN.commitImport({ storage: env.s, core: env.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci.applied === true, 'C03a COMPLETED 恢复日志 → 导入正常');
  var TXN2 = freshTxn(); var env2 = baseEnv(TXN2);
  env2.s.setItem(TXN2.RESTORE_JOURNAL_KEY, JSON.stringify(validRj(TXN2, 'ABORTED')));
  var ci2 = TXN2.commitImport({ storage: env2.s, core: env2.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci2.applied === true, 'C03b ABORTED 恢复日志 → 导入正常');
})();
/* C04 restore journal JSON 损坏 → fail-closed（R7 修复点：修复前
   pendingRestore 只认 PREPARED，损坏会穿过检查继续写业务） */
(function () {
  var TXN = freshTxn(); var env = baseEnv(TXN);
  env.s.setItem(TXN.RESTORE_JOURNAL_KEY, '{corrupt restore journal');
  var beforeBiz = env.s.getItem(BIZ_KEY), beforeReg = env.s.getItem(IM.REGISTRY_KEY);
  var ci = TXN.commitImport({ storage: env.s, core: env.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci.applied === false && ci.reason === 'restore_journal_corrupt' && ci.locked === true, 'C04a 损坏恢复日志 → restore_journal_corrupt 阻断', JSON.stringify(ci));
  ok(env.s.getItem(BIZ_KEY) === beforeBiz && env.s.getItem(IM.REGISTRY_KEY) === beforeReg && env.s.getItem(TXN.RESTORE_JOURNAL_KEY) === '{corrupt restore journal' && TXN.isLocked() === true && env.c.get().opportunities.length === 0, 'C04b 业务/注册表/损坏原文三者不变、已置锁、无业务写入');
})();
/* C05 restore journal 结构非法（PREPARED 缺裁决字段） → 同样阻断 */
(function () {
  var TXN = freshTxn(); var env = baseEnv(TXN);
  var bad = validRj(TXN, 'PREPARED'); delete bad.targetRegistry;
  env.s.setItem(TXN.RESTORE_JOURNAL_KEY, JSON.stringify(bad));
  var beforeBiz = env.s.getItem(BIZ_KEY);
  var ci = TXN.commitImport({ storage: env.s, core: env.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci.applied === false && ci.reason === 'restore_journal_corrupt' && env.s.getItem(BIZ_KEY) === beforeBiz && TXN.isLocked() === true, 'C05 结构非法恢复日志 → 阻断、业务不变');
})();
/* C06 restore journal 读取抛错 → fail-closed 阻断 */
(function () {
  var TXN = freshTxn(); var env = baseEnv(TXN);
  var throwing = { getItem: function (k) { if (k === TXN.RESTORE_JOURNAL_KEY) throw new Error('io fail'); return env.s.getItem(k); }, setItem: function (k, v) { env.s.setItem(k, v); }, removeItem: function (k) { env.s.removeItem(k); } };
  var beforeBiz = env.s.getItem(BIZ_KEY);
  var ci = TXN.commitImport({ storage: throwing, core: env.c, batch: oneBatch(), opts: OPTS2 });
  ok(ci.applied === false && ci.reason === 'restore_journal_corrupt' && env.s.getItem(BIZ_KEY) === beforeBiz && env.c.get().opportunities.length === 0, 'C06 恢复日志读取抛错 → 阻断、无业务写入', JSON.stringify(ci));
})();

console.log('== identity-txn-r7: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
