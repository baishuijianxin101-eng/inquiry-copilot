/* P1-23-R7-R2-R2：恢复互斥 / 锁失败 / 日志损坏 / 结果一致性 故障注入测试。
   全部虚构数据；存储层真实注错；每个场景使用全新加载的事务模块（隔离内存锁）。 */
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
    armAfter: function (k, skip, times) { rules.push({ key: k, skip: skip, times: times }); },
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
function bundleFor(TXN, core, storage) { return TXN.buildBackup(core, storage); }

/* 准备一个 PREPARED 场景并返回上下文 */
function preparedCtx() {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.arm(IM.REGISTRY_KEY, 1);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('P-1', 1, 1)]), opts: OPTS });
  return { TXN: TXN, s: s, c: c };
}

/* G01/G03 PREPARED 存在时恢复完整备份被拒，且业务/注册表/日志三键逐字不变 */
(function () {
  var ctx = preparedCtx();
  var before = [ctx.s.getItem('biz_state'), ctx.s.getItem(IM.REGISTRY_KEY), ctx.s.getItem(ctx.TXN.JOURNAL_KEY)];
  var bundle = bundleFor(ctx.TXN, ctx.c, ctx.s);
  var rb = ctx.TXN.restoreBundle({ storage: ctx.s, core: ctx.c, bundle: bundle });
  var after = [ctx.s.getItem('biz_state'), ctx.s.getItem(IM.REGISTRY_KEY), ctx.s.getItem(ctx.TXN.JOURNAL_KEY)];
  ok(rb.restored === false && rb.reason === 'pending_transaction_must_recover_first', 'G01 未决事务期间拒绝完整备份恢复');
  ok(JSON.stringify(before) === JSON.stringify(after), 'G03 拒绝恢复不改动业务/注册表/日志任一键');
})();

/* G02/G08 日志损坏时：恢复被拒、导入被拒、加载检查置锁、原文保留 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.JOURNAL_KEY, '{corrupted journal');
  var chk = TXN.checkOnLoad(s, c);
  var bundle = bundleFor(TXN, c, s);
  var rb = TXN.restoreBundle({ storage: s, core: c, bundle: bundle });
  var ci = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('C-1', 1, 1)]), opts: OPTS });
  ok(chk.locked === true && rb.restored === false && ci.applied === false && s.getItem(TXN.JOURNAL_KEY) === '{corrupted journal', 'G02/G08 日志损坏：加载阻断、恢复与导入均拒绝、原文保留未被清空');
})();

/* G09 日志缺字段（PREPARED 无 inverse）→ 判损坏、恢复走人工、保持锁定 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.setItem(TXN.JOURNAL_KEY, JSON.stringify({ phase: 'PREPARED', batchId: 'b-x' }));
  var js = TXN.journalStatus(s);
  var rc = TXN.recover({ storage: s, core: c });
  var chk = TXN.checkOnLoad(s, c);
  ok(js.state === 'corrupt' && rc.recovered === false && rc.reason === 'journal_corrupt_manual_required' && chk.locked === true, 'G09 日志缺字段判损坏、自动恢复拒绝、持续阻断');
})();

/* G04/G05 锁持久化写失败时，同会话内存阻断立即生效；重载后由日志恢复阻断 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.arm(IM.REGISTRY_KEY, 1);          /* 让 commit 在 registry 阶段失败 */
  s.arm(TXN.LOCK_KEY, 10);            /* 且锁键持续写失败 */
  var res = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('L-1', 1, 1)]), opts: OPTS });
  var lockedNow = TXN.isLocked();
  var writeBlocked = c.persist() === false;
  var chk = TXN.checkOnLoad(s, c);    /* 模拟重载：内存锁仍在、且 journal PREPARED 可再置锁 */
  ok(res.applied === false && lockedNow === true && writeBlocked === true, 'G04 锁持久化失败时同会话内存阻断立即生效');
  ok(chk.locked === true && chk.pending !== null, 'G05 重载后由事务日志恢复阻断');
})();

/* G06 COMMITTED 写入失败（journal 第二次写注错）→ 不误判成功、保持 PREPARED+锁定 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.armAfter(TXN.JOURNAL_KEY, 1, 1);  /* 跳过 PREPARED 那次写，让 COMMITTED 那次失败 */
  var res = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('CM-1', 1, 1)]), opts: OPTS });
  var j = JSON.parse(s.getItem(TXN.JOURNAL_KEY));
  ok(res.applied === false && res.stage === 'commit_mark' && j.phase === 'PREPARED' && TXN.isLocked(), 'G06 COMMITTED 写失败不误判成功、保持待恢复');
})();

/* G07/G20 回滚过程中业务落盘失败 → 恢复失败且继续锁定 */
(function () {
  var ctx = preparedCtx();
  ctx.s.arm('biz_state', 1);
  var rc = ctx.TXN.recover({ storage: ctx.s, core: ctx.c });
  ok(rc.recovered === false && ctx.TXN.isLocked(), 'G07/G20 回滚落盘失败：恢复未完成且继续阻断');
})();

/* G10 注册表被篡改（哈希/内容漂移）→ 一致性校验检出并置锁 */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('H-1', 1, 1)]), opts: OPTS });
  TXN.init(s);
  s.setItem(IM.REGISTRY_KEY, ID.exportState(ID.createRegistry()));
  var chk = TXN.checkOnLoad(s, c);
  ok(chk.locked === true && chk.consistency && chk.consistency.consistent === false, 'G10 状态与注册表不匹配被检出并阻断');
})();

/* G11/G12 导入在业务/注册表阶段失败时结果为明确失败（无成功语义） */
(function () {
  var TXN = freshTxn();
  var s = makeStorage(), c = makeCore(s, emptyState());
  c._txn = TXN; TXN.init(s);
  s.arm('biz_state', 1);
  var rBiz = TXN.commitImport({ storage: s, core: c, batch: batch([oppRec('R-1', 1, 1)]), opts: OPTS });
  ok(rBiz.applied === false && rBiz.stage === 'business_persist', 'G11 业务落盘失败返回明确失败（stage=business_persist）');
  var TXN2 = freshTxn();
  var s2 = makeStorage(), c2 = makeCore(s2, emptyState());
  c2._txn = TXN2; TXN2.init(s2);
  s2.arm(IM.REGISTRY_KEY, 1);
  var rReg = TXN2.commitImport({ storage: s2, core: c2, batch: batch([oppRec('R-2', 1, 1)]), opts: OPTS });
  ok(rReg.applied === false && rReg.stage === 'registry_persist', 'G12 注册表落盘失败返回明确失败（stage=registry_persist）');
})();

/* G19 恢复成功后业务操作恢复正常 */
(function () {
  var ctx = preparedCtx();
  var rc = ctx.TXN.recover({ storage: ctx.s, core: ctx.c });
  var writeOk = false;
  if (rc.recovered) { ctx.c.get().opportunities.push({ id: 'opp_after', buyer: { name: 'A' }, followLog: [], log: [], quote: {} }); writeOk = ctx.c.persist() === true; }
  ok(rc.recovered === true && writeOk === true && JSON.parse(ctx.s.getItem('biz_state')).opportunities.length === 1, 'G19 恢复成功后写入恢复正常');
})();

/* ---------- 真实 Core：落盘失败时内存回滚（修复 C 的机制级证据） ---------- */
(function () {
  var fs = require('fs'), vm = require('vm'), path = require('path');
  var ROOT = path.join(__dirname, '..');
  var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  var srcs = [...html.matchAll(/<script[^>]* src="([^"]+)"/g)].map(function (m) { return m[1].split('?')[0]; });
  function El() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this._html = ''; this.files = []; this.textContent = ''; this.parentNode = { removeChild: function () {}, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; } }; this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }; }
  El.prototype = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, appendChild: function (c) { this.children.push(c); return c; }, insertBefore: function (c) { this.children.push(c); return c; }, get firstChild() { return this.children[0] || null; }, remove: function () {}, addEventListener: function () {}, removeEventListener: function () {}, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; }, setAttribute: function () {}, getAttribute: function () { return null; }, focus: function () {}, click: function () {} };
  var els = new Map(), store = new Map(), failBiz = false;
  var BIZKEY = 'ali_commission_copilot_v1';
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); }, createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; }, addEventListener: function () {}, body: new El(), documentElement: new El() };
  var sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} }, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {}, Date: Date, Math: Math, JSON: JSON, Promise: Promise,
    localStorage: { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { if (failBiz && k === BIZKEY) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } },
    document: documentStub, location: { hash: '#/dashboard', href: 'http://x/' }, navigator: { onLine: true }, fetch: function () { return Promise.reject(new Error('no net')); }, URL: URL, Blob: function () {}, TextEncoder: TextEncoder, TextDecoder: TextDecoder, crypto: require('crypto').webcrypto, addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return true; }, scrollTo: function () {}, scrollY: 0, innerWidth: 1280, history: { pushState: function () {}, replaceState: function () {} }, alert: function () {}, confirm: function () { return true; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  srcs.forEach(function (s) { vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), sandbox, { filename: s }); });
  setTimeout(function () {
    var C = sandbox.Core;
    C.persist();
    var baseOpps = C.get().opportunities.length, baseProds = C.get().products.length;
    var failCount0 = C.persistFailureCount();
    failBiz = true;
    /* G13 合并导入落盘失败 → 内存不假装已保存 */
    C.mergeAll({ opportunities: [{ id: 'opp_should_not_stick', buyer: { name: 'Ghost' }, rawText: 'x' }], products: [], orders: [] });
    ok(C.persistOk() === false && C.persistFailureCount() > failCount0 && C.get().opportunities.length === baseOpps, 'G13 合并导入落盘失败后内存回滚、不假装已保存');
    /* G15/G16 商品与询盘修改落盘失败 → 回滚 */
    var st = C.get();
    st.products.push({ id: 'p_ghost', title: 'Ghost Product' });
    st.opportunities.push(C.normalizeOpp({ id: 'opp_ghost2', buyer: { name: 'Ghost2' }, rawText: 'x' }));
    C.persist();
    ok(C.get().products.length === baseProds && C.get().opportunities.length === baseOpps, 'G15/G16 商品/询盘修改落盘失败后内存回滚');
    /* G14 覆盖导入落盘失败 → 回滚到原状态 */
    C.replaceAll({ products: [], opportunities: [], orders: [], settings: {} });
    ok(C.get().opportunities.length === baseOpps && C.persistOk() === false, 'G14 覆盖导入落盘失败后内存回滚到原状态');
    /* G17/G18 订单与跟进：先正常落盘一个商机与订单，再注入失败验证回滚 */
    failBiz = false;
    var seedOpp = C.normalizeOpp({ id: 'opp_seed_r2', buyer: { name: 'Seed' }, rawText: 'x', followLog: [{ id: 'fu_seed', at: '2026-10-01', note: 'seed' }] });
    C.get().opportunities.push(seedOpp);
    C.get().orders = C.get().orders || [];
    var ordBefore = C.get().orders.length;
    C.persist();
    failBiz = true;
    var live = C.get().opportunities.filter(function (o) { return o.id === 'opp_seed_r2'; })[0];
    live.followLog = live.followLog.concat([{ id: 'fu_ghost', at: '2026-11-05', note: 'ghost' }]);
    C.get().orders.push({ id: 'ord_ghost', oppId: 'opp_seed_r2', buyerName: 'Seed', amountCents: 1, currency: 'USD', status: 'paid' });
    C.persist();
    var after = C.get().opportunities.filter(function (o) { return o.id === 'opp_seed_r2'; })[0];
    ok(after && after.followLog.length === 1 && C.get().orders.length === ordBefore, 'G17/G18 订单创建/跟进记录落盘失败后内存回滚');
    failBiz = false;
    ok(C.persist() === true, 'G19b 故障解除后真实 Core 恢复正常落盘');
    console.log('== identity-txn-r2: ' + pass + ' passed, ' + fail + ' failed ==');
    process.exit(fail ? 1 : 0);
  }, 150);
})();
