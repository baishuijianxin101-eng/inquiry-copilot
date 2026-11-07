/* P1-23-R7-R8：init 调用链审计的行为证据（第四项）。
   W 组用写盘间谍存储证明：
   - init(storage) 本身零读写（纯内存赋值，无钩子/恢复/清理）；
   - commitImport 在损坏日志检查之前没有任何写盘；被拒时唯一的
     写入是保护性锁（LOCK_KEY），业务/注册表/日志原文全不动；
   - 正常导入的第一笔写盘是 PREPARED journal，业务写在其后；
   - checkOnLoad 对损坏日志只写锁、不清不改日志；
   - restoreBundle 在日志损坏时零写入拒绝。
   全部虚构数据；本文件为 Node 存储桩测试，不冒充真实浏览器。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function freshTxn() { delete require.cache[require.resolve('../assets/identity-txn.js')]; return require('../assets/identity-txn.js'); }
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
var BIZ_KEY = 'ali_commission_copilot_v1';

function makeSpyStorage() {
  var map = new Map(), calls = [];
  return {
    getItem: function (k) { calls.push({ op: 'get', key: k }); return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { calls.push({ op: 'set', key: k }); map.set(k, String(v)); },
    removeItem: function (k) { calls.push({ op: 'remove', key: k }); map.delete(k); },
    _map: map, _calls: calls,
    writes: function () { return calls.filter(function (c) { return c.op !== 'get'; }); },
    resetCalls: function () { calls.length = 0; }
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
var OPTS = { buildEntity: function (t, cn, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }, applyContent: function (ent, cn) { if (ent.quote) ent.quote.qty = cn.qty; } };
function oneBatch() { return { source_system: 'alibaba_api', source_account: 'acct-1', records: [{ entity_type: 'opportunity', external_id_raw: 'W-1', content: { buyerName: 'B', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, sourceVersion: 1, entity: oppEnt('tmp', 5, 'n') }] }; }

/* W01 init 纯度：调用 init 不产生任何存储读写 */
(function () {
  var TXN = freshTxn();
  var s = makeSpyStorage();
  TXN.init(s);
  ok(s._calls.length === 0, 'W01 init(storage) 零存储调用（纯内存赋值，无恢复/清理/写盘钩子）');
})();

/* W02 commitImport × 损坏 restore journal：写盘只有保护性锁 */
(function () {
  var TXN = freshTxn();
  var s = makeSpyStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.RESTORE_JOURNAL_KEY, '{corrupt restore journal');
  var beforeBiz = s.getItem(BIZ_KEY);
  s.resetCalls();
  var ci = TXN.commitImport({ storage: s, core: c, batch: oneBatch(), opts: OPTS });
  var w = s.writes();
  ok(ci.applied === false && ci.reason === 'restore_journal_corrupt', 'W02a 损坏恢复日志 → 导入被拒');
  ok(w.length > 0 && w.every(function (x) { return x.key === TXN.LOCK_KEY; }), 'W02b 被拒路径的全部写盘仅为 LOCK_KEY（保护性置锁）', JSON.stringify(w));
  ok(s.getItem(BIZ_KEY) === beforeBiz && s.getItem(TXN.RESTORE_JOURNAL_KEY) === '{corrupt restore journal' && s.getItem(TXN.JOURNAL_KEY) === null && s.getItem(IM.REGISTRY_KEY) === null, 'W02c 业务/损坏原文不变、无 journal 写、无注册表写');
})();

/* W03 正常导入写顺序：第一笔写 = PREPARED journal，业务写在其后，无锁写 */
(function () {
  var TXN = freshTxn();
  var s = makeSpyStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.resetCalls();
  var ci = TXN.commitImport({ storage: s, core: c, batch: oneBatch(), opts: OPTS });
  var w = s.writes();
  var firstJournal = w.findIndex(function (x) { return x.key === TXN.JOURNAL_KEY; });
  var firstBiz = w.findIndex(function (x) { return x.key === BIZ_KEY; });
  ok(ci.applied === true && firstJournal === 0 && firstBiz > firstJournal, 'W03a 首笔写盘为 PREPARED journal、业务写随后（索引 journal=' + firstJournal + ' biz=' + firstBiz + '）');
  ok(!w.some(function (x) { return x.key === TXN.LOCK_KEY; }), 'W03b 正常路径无锁写、无恢复/清理动作');
})();

/* W04 checkOnLoad × 损坏 import journal：只写锁，日志原文保留 */
(function () {
  var TXN = freshTxn();
  var s = makeSpyStorage(), c = makeCore(s, emptyState());
  c._txn = TXN;
  s.setItem(TXN.JOURNAL_KEY, '{broken journal');
  s.resetCalls();
  var chk = TXN.checkOnLoad(s, c);
  var w = s.writes();
  ok(chk.locked === true && chk.journalState === 'corrupt', 'W04a checkOnLoad 报告 corrupt 且已锁定');
  ok(w.every(function (x) { return x.key === TXN.LOCK_KEY; }) && s.getItem(TXN.JOURNAL_KEY) === '{broken journal', 'W04b 写盘仅锁键、损坏日志原文未清未改（不自动恢复/清理）');
})();

/* W05 restoreBundle × 损坏 import journal：零写入拒绝 */
(function () {
  var TXN = freshTxn();
  var s = makeSpyStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.JOURNAL_KEY, '{broken journal');
  s.resetCalls();
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: { format: 'ic-backup', version: 2, state: emptyState(), identityRegistry: null } });
  ok(rb.restored === false && rb.reason === 'journal_corrupt' && s.writes().length === 0, 'W05 日志损坏 → restoreBundle 零写入拒绝');
})();

console.log('== identity-txn-r8: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
