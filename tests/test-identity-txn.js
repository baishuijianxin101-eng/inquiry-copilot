/* P1-23-R7-R2：持久化故障注入专项测试（虚构数据 + 可控失败的独立存储）。
   第 1/2/3 项通过真实模拟存储写入失败验证（在 setItem 层注错），
   并断言最终持久化内容，而非仅函数返回值。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
var TXN = require('../assets/identity-txn.js');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

/* 可控失败存储：arm(key, times) 让接下来 times 次对 key 的 setItem 抛配额错 */
function makeStorage() {
  var map = new Map(), armed = {};
  return {
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { if (armed[k] > 0) { armed[k]--; var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } map.set(k, String(v)); },
    removeItem: function (k) { map.delete(k); },
    arm: function (k, times) { armed[k] = times; },
    _map: map
  };
}
/* 假 Core：与真实 Core 相同的落盘语义（replaceAllChecked 回报成败、persist 受写入屏障约束） */
function makeCore(storage, initial) {
  var state = clone(initial);
  var core = {
    STORE_KEY: 'biz_state', /* R6 夹具对齐：声明本桩的落盘键，供 restoreBundle 磁盘快照读取；断言未动 */
    get: function () { return state; },
    _persist: function () {
      if (TXN.isLocked()) return false;
      try { storage.setItem('biz_state', JSON.stringify(state)); } catch (e) { return false; }
      return storage.getItem('biz_state') === JSON.stringify(state);
    },
    replaceAllChecked: function (obj) { state = clone(obj); return core._persist(); },
    persist: function () { return core._persist(); },
    _setState: function (s) { state = s; }
  };
  storage.setItem('biz_state', JSON.stringify(state));
  return core;
}
function emptyState() { return { products: [], opportunities: [], orders: [], settings: {} }; }
function oppRec(raw, qty, ver) {
  return { entity_type: 'opportunity', external_id_raw: raw, content: { buyerName: 'Ext Buyer', buyerCompany: 'Ext Co', productText: 'Widget', qty: qty, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, sourceVersion: ver,
    entity: { buyer: { name: 'Ext Buyer', company: 'Ext Co', country: 'DE' }, rawText: 'ext', followLog: [{ id: 'fu1', at: '2026-10-01', note: 'hi' }], log: [{ ts: '2026-10-01', text: 'created' }], quote: { qty: qty } } };
}
var OPTS = { buildEntity: function (t, c, iid, rec) { var e = clone(rec.entity); e.id = iid; return e; }, applyContent: function (ent, content) { if (ent.quote) ent.quote.qty = content.qty; } };
function batch(records) { return { source_system: 'alibaba_api', source_account: 'acct-1', records: records }; }

/* F01 注册表落盘失败（真实 setItem 注错）→ 未标记成功、PREPARED+锁定、业务已写但被锁保护 */
var s1 = makeStorage(), c1 = makeCore(s1, emptyState());
TXN.init(s1);
s1.arm(IM.REGISTRY_KEY, 1);
var f1 = TXN.commitImport({ storage: s1, core: c1, batch: batch([oppRec('F-1', 10, 1)]), opts: OPTS });
var j1 = JSON.parse(s1.getItem(TXN.JOURNAL_KEY));
ok(f1.applied === false && f1.stage === 'registry_persist' && j1.phase === 'PREPARED' && TXN.isLocked(), 'F01 注册表落盘失败：批次未成功、事务 PREPARED、写入锁定');
ok(JSON.parse(s1.getItem('biz_state')).opportunities.length === 1 && !s1.getItem(IM.REGISTRY_KEY), 'F01b 持久化事实：业务已落盘、注册表未落盘（不一致被日志锁定而非隐藏）');

/* F02 业务落盘失败 → 注册表不动、锁定 */
var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
TXN.init(s2);
s2.arm('biz_state', 1);
var f2 = TXN.commitImport({ storage: s2, core: c2, batch: batch([oppRec('F-2', 10, 1)]), opts: OPTS });
ok(f2.applied === false && f2.stage === 'business_persist' && TXN.isLocked() && !s2.getItem(IM.REGISTRY_KEY), 'F02 业务落盘失败：注册表未写、进入锁定');

/* F03 事务标记（journal）落盘失败 → 整批未开始落盘、无锁残留误判 */
var s3 = makeStorage(), c3 = makeCore(s3, emptyState());
TXN.init(s3);
s3.arm(TXN.JOURNAL_KEY, 1);
var f3 = TXN.commitImport({ storage: s3, core: c3, batch: batch([oppRec('F-3', 10, 1)]), opts: OPTS });
ok(f3.applied === false && f3.stage === 'journal' && JSON.parse(s3.getItem('biz_state')).opportunities.length === 0, 'F03 journal 落盘失败：业务与注册表均未动');

/* F04/F05 模拟页面中断后重新加载 → checkOnLoad 识别未完成批次并保持锁定 */
var chk = TXN.checkOnLoad(s1, c1);
ok(chk.locked === true && chk.pending && chk.pending.batchId === j1.batchId, 'F04/F05 重新加载识别 PREPARED 批次并阻断');

/* F06/F07/F08 锁定期间新建商机/改商品/建订单（经 persist 漏斗）全部被拒 */
TXN.init(s1);
var st1 = c1.get();
st1.opportunities.push({ id: 'opp_manual_new', buyer: { name: 'X' }, followLog: [], log: [], quote: {} });
ok(c1.persist() === false && JSON.parse(s1.getItem('biz_state')).opportunities.length === 1, 'F06 锁定期间新建商机落盘被屏障拒绝');
st1.products.push({ id: 'p_manual', title: 'X' });
ok(c1.persist() === false, 'F07 锁定期间商品写入被拒绝');
st1.orders.push({ id: 'ord_manual', oppId: 'opp_manual_new' });
ok(c1.persist() === false && JSON.parse(s1.getItem('biz_state')).orders.length === 0, 'F08 锁定期间订单写入被拒绝');

/* F09/F10 锁定期间再次导入（同文件/另一文件）均被拒绝，不盲目重跑 */
var f9 = TXN.commitImport({ storage: s1, core: c1, batch: batch([oppRec('F-1', 10, 1)]), opts: OPTS });
var f10 = TXN.commitImport({ storage: s1, core: c1, batch: batch([oppRec('OTHER-9', 1, 1)]), opts: OPTS });
ok(f9.applied === false && f9.locked === true && f10.applied === false && f10.locked === true, 'F09/F10 锁定期间同批与异批导入均被拒绝');

/* F11 恢复成功 → 解锁、状态与注册表回到批次前、再导入不重复。
   恢复以持久化状态为准：先模拟重新加载（F06-F08 的内存变异未落盘，随重载丢弃，
   与真实浏览器行为一致），再对重载后的 Core 执行恢复。 */
var c1r = makeCore(s1, JSON.parse(s1.getItem('biz_state')));
var rc1 = TXN.recover({ storage: s1, core: c1r });
var afterRec = c1r.get();
ok(rc1.recovered === true && !TXN.isLocked() && afterRec.opportunities.length === 0 && JSON.parse(s1.getItem(IM.REGISTRY_KEY)).byKey && Object.keys(JSON.parse(s1.getItem(IM.REGISTRY_KEY)).byKey).length === 0, 'F11 恢复回滚业务与注册表并解除锁定');
var f11 = TXN.commitImport({ storage: s1, core: c1r, batch: batch([oppRec('F-1', 10, 1)]), opts: OPTS });
ok(f11.applied === true && c1r.get().opportunities.length === 1, 'F11b 恢复后再次导入成功且只有一个实体');

/* F20 恢复后关联完整：跟进与日志随实体保留、完整性校验通过 */
var ent20 = c1r.get().opportunities[0];
ok(ent20.followLog.length === 1 && ent20.log.length === 1 && IM.checkIntegrity(c1r.get()).followRecords === 1, 'F20 恢复/重导后跟进与日志关联完整');

/* F12 恢复失败保持锁定：篡改 journal 的 preStateHash 后恢复应失败且继续锁定 */
var s12 = makeStorage(), c12 = makeCore(s12, emptyState());
TXN.init(s12);
s12.arm(IM.REGISTRY_KEY, 1);
TXN.commitImport({ storage: s12, core: c12, batch: batch([oppRec('F-12', 1, 1)]), opts: OPTS });
var j12 = JSON.parse(s12.getItem(TXN.JOURNAL_KEY)); j12.preStateHash = 'tampered';
s12.setItem(TXN.JOURNAL_KEY, JSON.stringify(j12));
var rc12 = TXN.recover({ storage: s12, core: c12 });
ok(rc12.recovered === false && TXN.isLocked(), 'F12 恢复校验失败后继续保持写入阻断');

/* F13/F14 完整备份导出与恢复（真实整包往返） */
var s13 = makeStorage(), c13 = makeCore(s13, emptyState());
TXN.init(s13);
TXN.commitImport({ storage: s13, core: c13, batch: batch([oppRec('BK-1', 7, 1)]), opts: OPTS });
var bundle = TXN.buildBackup(c13, s13);
ok(bundle.version === 2 && !!bundle.identityRegistry && TXN.validateBundle(bundle).ok, 'F13 完整备份含注册表与校验和且自洽');
var s14 = makeStorage(), c14 = makeCore(s14, emptyState());
var rb = TXN.restoreBundle({ storage: s14, core: c14, bundle: bundle });
var f14 = TXN.commitImport({ storage: s14, core: c14, batch: batch([oppRec('BK-1', 7, 1)]), opts: OPTS });
ok(rb.restored === true && f14.counts && f14.counts.UNCHANGED === 1, 'F14 完整备份恢复后重复导入命中原映射（幂等）');

/* F15 旧格式（无注册表）恢复 → 标记待迁移、不伪造注册表、身份导入被拒 */
var bundleOld = TXN.buildBackup(c14, s14); bundleOld.identityRegistry = null; bundleOld.checksums.registry = null;
var s15 = makeStorage(), c15 = makeCore(s15, emptyState());
var rb15 = TXN.restoreBundle({ storage: s15, core: c15, bundle: bundleOld });
var f15 = TXN.commitImport({ storage: s15, core: c15, batch: batch([oppRec('NEW-1', 1, 1)]), opts: OPTS });
ok(rb15.restored === true && rb15.legacyPending === true && !s15.getItem(IM.REGISTRY_KEY) && f15.applied === false && f15.legacyPending === true, 'F15 旧格式恢复标记待迁移且不静默建注册表');

/* F16 备份损坏（篡改业务内容）→ 校验失败、拒绝恢复、现数据不变 */
var bundleBad = clone(bundle); bundleBad.state.opportunities.push({ id: 'int_opportunity_fake' });
var before16 = s14.getItem('biz_state');
var rb16 = TXN.restoreBundle({ storage: s14, core: c14, bundle: bundleBad });
ok(rb16.restored === false && s14.getItem('biz_state') === before16, 'F16 损坏备份被校验拦截、数据不变');

/* F17 状态与注册表不匹配 → verifyConsistency 检出并在加载检查时置锁 */
var s17 = makeStorage(), c17 = makeCore(s17, emptyState());
TXN.init(s17);
TXN.commitImport({ storage: s17, core: c17, batch: batch([oppRec('M-1', 1, 1)]), opts: OPTS });
s17.setItem(IM.REGISTRY_KEY, ID.exportState(ID.createRegistry())); /* 注册表被替换为空 */
var v17 = TXN.verifyConsistency(s17, c17);
var chk17 = TXN.checkOnLoad(s17, c17);
ok(v17.consistent === false && chk17.locked === true, 'F17 注册表与业务不一致被检出并触发阻断');

/* F18/F19 历史重复 ID：被识别、不自动合并 */
var dupState = { products: [], orders: [], settings: {}, opportunities: [
  { id: 'buyerA', buyer: { name: 'Original Slash' }, rawText: 'from buyer/A', followLog: [{ id: 'a', at: '2026-10-01', note: 'x' }], log: [], quote: {} },
  { id: 'buyerA', buyer: { name: 'Original Plain' }, rawText: 'from buyerA', followLog: [], log: [], quote: {} }] };
var packs = IM.auditDuplicateIds(dupState);
ok(packs.length === 1 && packs[0].count === 2 && packs[0].autoMerged === false && packs[0].action === 'NEEDS_HUMAN_DECISION', 'F18 重复内部 ID 生成裁决证据包');
var regDup = ID.createRegistry(); IM.backfillLegacy(dupState, regDup);
ok(dupState.opportunities.length === 2 && dupState.opportunities[0].followLog.length === 1, 'F19 回填不合并重复 ID 实体、各自关联保留');

/* ---------- 真实 Core 启动检查：persist 回报与屏障 ---------- */
(function () {
  var fs = require('fs'), vm = require('vm'), path = require('path');
  var ROOT = path.join(__dirname, '..');
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var srcs = [...html.matchAll(/<script[^>]* src="([^"]+)"/g)].map(function (m) { return m[1].split('?')[0]; });
  function El() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this._html = ''; this.files = []; this.textContent = ''; this.parentNode = { removeChild: function () {}, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; } }; this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }; }
  El.prototype = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, appendChild: function (c) { this.children.push(c); return c; }, insertBefore: function (c) { this.children.push(c); return c; }, get firstChild() { return this.children[0] || null; }, remove: function () {}, addEventListener: function () {}, removeEventListener: function () {}, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; }, setAttribute: function () {}, getAttribute: function () { return null; }, focus: function () {}, click: function () {} };
  var els = new Map(), store = new Map();
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); }, createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; }, addEventListener: function () {}, body: new El(), documentElement: new El() };
  var sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {}, Date: Date, Math: Math, JSON: JSON, Promise: Promise, localStorage: { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } }, document: documentStub, location: { hash: '#/dashboard', href: 'http://x/' }, navigator: { onLine: true }, fetch: function () { return Promise.reject(new Error('no net')); }, URL: URL, Blob: function () {}, TextEncoder: TextEncoder, TextDecoder: TextDecoder, crypto: require('crypto').webcrypto, addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return true; }, scrollTo: function () {}, scrollY: 0, innerWidth: 1280, history: { pushState: function () {}, replaceState: function () {} }, alert: function () {}, confirm: function () { return true; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  srcs.forEach(function (s) { vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), sandbox, { filename: s }); });
  setTimeout(function () {
    var C = sandbox.Core, T = sandbox.IdentityTxn;
    ok(typeof C.persistOk === 'function' && typeof T.commitImport === 'function', 'F21a 真实 Core 暴露 persistOk、事务层就位');
    var okSave = C.persist();
    ok(okSave === true && C.persistOk() === true, 'F21b 真实 Core 正常保存返回成功');
    /* 在真实 localStorage 桩上置锁 → persist 必须拒绝 */
    T.init(sandbox.localStorage);
    sandbox.localStorage.setItem(T.LOCK_KEY, JSON.stringify({ reason: 'test_lock' }));
    var blockedSave = C.persist();
    ok(blockedSave === false && C.persistOk() === false, 'F21c 真实 Core 在锁定状态下拒绝业务落盘（写入屏障生效）');
    sandbox.localStorage.removeItem(T.LOCK_KEY);
    ok(C.persist() === true, 'F21d 解锁后恢复正常落盘');
    console.log('== identity-txn: ' + pass + ' passed, ' + fail + ' failed ==');
    process.exit(fail ? 1 : 0);
  }, 150);
})();
