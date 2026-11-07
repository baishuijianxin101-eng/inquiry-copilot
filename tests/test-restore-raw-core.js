/* C9-P1 第一阶段（方案 A）真实 Core 集成测试。
   与既有身份专项不同：本文件不使用克隆桩 Core，而是以 window/localStorage
   垫片在 Node 中加载生产 assets/core.js 本体，让 migrate()/normalizeSettings
   等生产规范化逻辑真实进入回滚路径——C9 缺陷正是简化桩缺了 migrate 才
   对整个套件隐形的。全部虚构数据。
   场景：整包恢复在一致性检查失败后走 abortRestore 回滚，断言回滚把恢复前
   快照逐字写回（内存 + localStorage）、注册表/legacy 复原、日志 ABORTED、
   锁清除；并覆盖原始恢复入口失败时的 fail-closed 与重启可读性。 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var CORE_PATH = path.join(__dirname, '..', 'assets', 'core.js');
var coreSrc = fs.readFileSync(CORE_PATH, 'utf8');
var coreSha = crypto.createHash('sha256').update(coreSrc).digest('hex');
console.log('LOADED_PRODUCTION_CORE ' + CORE_PATH + ' sha256=' + coreSha);

var ID = require('../assets/identity.js');
var REG_KEY = 'ic_identity_registry_v1';

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* localStorage 垫片：可按 STORE_KEY 写入序号注入失败（测原始恢复失败路径） */
function makeLS() {
  var map = new Map();
  var ls = {
    _map: map,
    storeKeyWrites: 0,
    failStoreKeyOnWrite: -1, /* 1 起的写入序号，-1 表示不注入 */
    getItem: function (k) { return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) {
      if (k === 'ali_commission_copilot_v1') {
        ls.storeKeyWrites++;
        if (ls.storeKeyWrites === ls.failStoreKeyOnWrite) throw new Error('injected_store_write_failure');
      }
      map.set(k, String(v));
    },
    removeItem: function (k) { map.delete(k); }
  };
  return ls;
}

/* 全新生产 Core 实例（重跑 core.js 源码，内部 state 归零） */
function freshCore(ls) {
  global.localStorage = ls;
  global.window = { localStorage: ls };
  vm.runInThisContext(coreSrc, { filename: 'assets/core.js' });
  return global.window.Core;
}
function freshTxn() {
  delete require.cache[require.resolve('../assets/identity-txn.js')];
  var t = require('../assets/identity-txn.js');
  global.window.IdentityTxn = t;
  return t;
}

/* ---- 夹具构造（与冻结专项同构，全合成） ---- */
function idn(raw) { return { source_system: 'alibaba_api', source_account: 'acct-1', entity_type: 'opportunity', external_id_raw: raw }; }
function ent(internalId, identity, buyerName) {
  return { internalId: internalId, identity: identity, additionalIdentities: [],
    content: { buyerName: buyerName || 'T Buyer', buyerCompany: 'C', productText: 'W', qty: 5, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' },
    contentHash: 'fnv1a32x2:abc', canonVersion: 'canon-v3', sourceVersion: 1, sourceUpdatedAt: null,
    sourceValue: {}, parsedValue: null, confirmedValue: null, archived: false };
}
function registryText(identity, buyerName) {
  return '{"byKey":{"' + ID.identityKeyOf(identity) + '":' + JSON.stringify(ent('int_d', identity, buyerName)) + '},"conflicts":[],"reviewEvents":[],"canonVersion":"canon-v3","keyVersion":"esc-v2"}';
}
function makeBundle(TXN, stateObj, regText) {
  var text = '{"format":"ic-backup","version":2,"exportedAt":"2026-11-06T00:00:00.000Z","state":' + JSON.stringify(stateObj) +
    ',"identityRegistry":' + regText + ',"checksums":{"state":"","registry":""}}';
  var b = JSON.parse(text);
  b.checksums.state = TXN._stateHash(b.state);
  if (b.identityRegistry) b.checksums.registry = TXN._stateHash(b.identityRegistry);
  return b;
}
var EMPTY_STATE = { products: [], opportunities: [], orders: [], settings: {} };
/* 不一致夹具：注册表挂 int_d、业务状态无此实体（C9 原场景） */
function mismatchBundle(TXN, extId) {
  return makeBundle(TXN, clone(EMPTY_STATE), registryText(idn(extId || 'C9T1')));
}
/* 一致夹具：业务状态含 int_d */
function consistentBundle(TXN, extId, buyerName) {
  var st = { products: [], opportunities: [{ id: 'int_d', buyer: { name: buyerName || 'T Buyer' }, followLog: [], log: [] }], orders: [], settings: {} };
  return makeBundle(TXN, st, registryText(idn(extId), buyerName));
}

/* ---- 基线建立：真实 Core 先落一份稳态，再以「直接改内存 + persist」
   模拟 app.js 的生产漂移（fx 刷新写 fxUpdatedAt 就走这条路，不经 migrate） ---- */
function baseState() {
  return {
    version: 1, createdAt: '2026-11-01T00:00:00.000Z', demoMode: false,
    settings: { sellerName: 'T-SELLER' },
    products: [{ id: 'p_t1', title: 'T Widget', priceUsd: 25.5, costRmb: 100 }],
    opportunities: [{ id: 'opp_t1', buyer: { name: 'T Buyer' }, followLog: [], log: [] }],
    orders: [{ id: 'ord_t1', oppId: 'opp_t1', qty: 2, amountUsd: 51 }],
    logs: []
  };
}
function establish(Core, TXN, ls, drift) {
  Core.get();
  Core.replaceAllChecked(baseState());
  var s = Core.get();
  if (drift) drift(s);
  Core.persist();
  var preRaw = ls.getItem(Core.STORE_KEY);
  return { preRaw: preRaw, preHash: TXN._stateHash(JSON.parse(preRaw)), preState: JSON.parse(preRaw) };
}
function restoreJournal(ls, TXN) {
  var raw = ls.getItem(TXN.RESTORE_JOURNAL_KEY);
  return raw ? JSON.parse(raw) : null;
}

/* ============ F 组：加载证明（真实 core.js 在环） ============ */
(function () {
  var ls = makeLS();
  var Core = freshCore(ls);
  ok(typeof Core.replaceAllRaw === 'function' && typeof Core.replaceAllChecked === 'function',
    'F01 生产 Core 已加载且 replaceAllRaw 存在（' + CORE_PATH + '）');
  /* migrate 指纹对照：replaceAllChecked 会丢弃 fxUpdatedAt（规范化在环的
     证据）；replaceAllRaw 必须原样保留——两条入口的差异就是本修复本体。 */
  Core.get();
  var probe = baseState(); probe.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z';
  Core.replaceAllChecked(clone(probe));
  ok(Core.get().settings.fxUpdatedAt === undefined,
    'F02 replaceAllChecked 经 migrate 丢弃 fxUpdatedAt（证明生产规范化在环）');
  var r = Core.replaceAllRaw(clone(probe));
  ok(r === true && Core.get().settings.fxUpdatedAt === '2026-11-06T12:00:00.000Z' &&
     JSON.parse(ls.getItem(Core.STORE_KEY)).settings.fxUpdatedAt === '2026-11-06T12:00:00.000Z',
    'F03 replaceAllRaw 原样保留 fxUpdatedAt（内存与磁盘一致）');
})();

/* ============ R 组：一致性中止后的完整回滚 ============ */
function rollbackScenario(name, drift, extraAssert) {
  var ls = makeLS();
  var Core = freshCore(ls);
  var TXN = freshTxn();
  var base = establish(Core, TXN, ls, drift);
  var preReg = ls.getItem(REG_KEY);
  var preLegacy = TXN._legacyPendingStatus(ls);
  var res = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN) });
  ok(res.restored === false && res.rolledBack === true &&
     res.reason === 'consistency_check_failed:mapping_without_state_entity:int_d',
    name + ' 回滚成功且原因码无 rollback_failed 后缀', JSON.stringify(res));
  var postRaw = ls.getItem(Core.STORE_KEY);
  ok(TXN._stateHash(JSON.parse(postRaw)) === base.preHash && postRaw === base.preRaw,
    name + ' 磁盘状态与恢复前逐字一致（哈希 + 原文）');
  ok(deepEq(Core.get(), base.preState), name + ' 内存状态与恢复前快照一致');
  ok(ls.getItem(REG_KEY) === preReg, name + ' 注册表复原');
  ok(TXN._legacyPendingStatus(ls) === preLegacy, name + ' legacy 复原');
  var rj = restoreJournal(ls, TXN);
  ok(!!rj && rj.phase === 'ABORTED', name + ' 恢复日志 ABORTED');
  ok(ls.getItem(TXN.LOCK_KEY) === null && !TXN.isLocked(), name + ' 恢复锁已清除');
  if (extraAssert) extraAssert(Core, ls, base);
  return { ls: ls, Core: Core, TXN: TXN, base: base };
}

/* 用例 1：fxUpdatedAt 存在（C9 原始条件） */
rollbackScenario('R1', function (s) { s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z'; }, function (Core) {
  ok(Core.get().settings.fxUpdatedAt === '2026-11-06T12:00:00.000Z', 'R1b fxUpdatedAt 回滚后仍在');
});
/* 用例 2：fxUpdatedAt 缺失 */
rollbackScenario('R2', null, function (Core) {
  ok(Core.get().settings.fxUpdatedAt === undefined, 'R2b 无 fxUpdatedAt 时回滚同样成立');
});
/* 用例 3+4：未知 settings 字段与多类型合法值 */
rollbackScenario('R3', function (s) {
  s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z';
  s.settings.customUnknownKey = 'keep-me';
  s.settings.customNum = 42.5;
  s.settings.customBool = true;
  s.settings.customObj = { nested: [1, 'two', null] };
  s.settings.customNull = null;
}, function (Core) {
  var st = Core.get().settings;
  ok(st.customUnknownKey === 'keep-me' && st.customNum === 42.5 && st.customBool === true &&
     deepEq(st.customObj, { nested: [1, 'two', null] }) && st.customNull === null,
    'R3b 未知 settings 字段（多类型）回滚后全部保留');
});
/* 用例 5：实体带会被 migrate 改写的字段（漂移注入：额外字段、字符串数字、键序） */
rollbackScenario('R4', function (s) {
  s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z';
  s.products[0].legacyNote = 'do-not-normalize';
  s.products[0].priceUsd = '25.50'; /* 字符串数字：migrate 会强制转数值 */
  s.opportunities[0].customField = { z: 1 };
  s.orders[0].customTag = 'T';
}, function (Core, ls, base) {
  var p = Core.get().products[0];
  ok(p.legacyNote === 'do-not-normalize' && p.priceUsd === '25.50' &&
     Core.get().opportunities[0].customField.z === 1 && Core.get().orders[0].customTag === 'T',
    'R4b 实体漂移字段回滚后逐字保留（未被规范化改写）');
});

/* 用例 8：恢复前注册表非空——回滚必须把注册表写回恢复前原文 */
(function () {
  var ls = makeLS();
  var Core = freshCore(ls);
  var TXN = freshTxn();
  Core.get();
  var r0 = TXN.restoreBundle({ storage: ls, core: Core, bundle: consistentBundle(TXN, 'C9T0', 'Prev Buyer') });
  ok(r0.restored === true, 'R5a 前置：一致备份先恢复成功（建立非空注册表基线）', JSON.stringify(r0));
  var preRaw = ls.getItem(Core.STORE_KEY);
  var preReg = ls.getItem(REG_KEY);
  var res = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN, 'C9T2') });
  ok(res.restored === false && res.rolledBack === true, 'R5b 不一致备份回滚成功', JSON.stringify(res));
  ok(ls.getItem(Core.STORE_KEY) === preRaw, 'R5c 业务状态逐字复原');
  ok(ls.getItem(REG_KEY) === preReg && preReg !== null, 'R5d 注册表写回恢复前原文（非空）');
  ok(restoreJournal(ls, TXN).phase === 'ABORTED' && ls.getItem(TXN.LOCK_KEY) === null, 'R5e 日志 ABORTED 且锁清除');
})();

/* 用例 9：恢复前 legacy=set——回滚必须把 legacy 写回 set */
(function () {
  var ls = makeLS();
  var Core = freshCore(ls);
  var TXN = freshTxn();
  Core.get();
  var nb = makeBundle(TXN, { products: [], opportunities: [{ id: 'opp_t9', buyer: { name: 'L Buyer' }, followLog: [], log: [] }], orders: [], settings: {} }, 'null');
  var r0 = TXN.restoreBundle({ storage: ls, core: Core, bundle: nb });
  ok(r0.restored === true && TXN._legacyPendingStatus(ls) === 'set', 'R6a 前置：无注册表备份恢复成功且 legacy=set', JSON.stringify(r0));
  var preRaw = ls.getItem(Core.STORE_KEY);
  var res = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN, 'C9T3') });
  ok(res.restored === false && res.rolledBack === true, 'R6b 不一致备份回滚成功', JSON.stringify(res));
  ok(TXN._legacyPendingStatus(ls) === 'set', 'R6c legacy 写回恢复前状态 set');
  ok(ls.getItem(Core.STORE_KEY) === preRaw && ls.getItem(REG_KEY) === null, 'R6d 业务状态复原且注册表仍为 null');
})();

/* 用例 11：原始恢复入口落盘失败 → fail-closed（PREPARED + 锁 + 不宣布回滚） */
(function () {
  var ls = makeLS();
  var Core = freshCore(ls);
  var TXN = freshTxn();
  establish(Core, TXN, ls, function (s) { s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z'; });
  ls.storeKeyWrites = 0;
  ls.failStoreKeyOnWrite = 2; /* 第 1 次是目标态写入（放行），第 2 次是回滚写入（失败） */
  var res = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN, 'C9T4') });
  ok(res.restored === false && res.rolledBack !== true &&
     res.reason === 'consistency_check_failed:mapping_without_state_entity:int_d:rollback_failed_restore_pending',
    'R7a 回滚落盘失败返回 pending 而非成功', JSON.stringify(res));
  var rj = restoreJournal(ls, TXN);
  ok(!!rj && rj.phase === 'PREPARED', 'R7b 日志保持 PREPARED');
  ok(ls.getItem(TXN.LOCK_KEY) !== null && TXN.isLocked(), 'R7c 恢复锁保持（fail-closed）');
  ok(ls.getItem(REG_KEY) !== null, 'R7d 注册表停在目标值（如实呈报未回滚状态）');
})();

/* 用例 12：回滚后重启——磁盘原文不动、新实例可读、启动检查干净 */
(function () {
  var scen = rollbackScenario('R8', function (s) { s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z'; });
  var ls = scen.ls, base = scen.base;
  var Core2 = freshCore(ls); /* 模拟重启：新 Core 实例，同一 localStorage */
  var TXN2 = freshTxn();
  var st = Core2.get();
  ok(ls.getItem(Core2.STORE_KEY) === base.preRaw, 'R8b 重启加载未改动磁盘原文');
  ok(st.products.length === base.preState.products.length &&
     st.opportunities.length === base.preState.opportunities.length &&
     st.orders.length === base.preState.orders.length,
    'R8c 重启后业务集合可正确读取');
  var chk = TXN2.checkOnLoad(ls, Core2);
  ok(chk.locked === false && !chk.restorePending && chk.consistency && chk.consistency.consistent === true,
    'R8d 启动检查无锁、无未决恢复、一致性通过', JSON.stringify(chk && { locked: chk.locked, rp: !!chk.restorePending }));
})();

/* ============ S 组：成功路径未被修复破坏 ============ */
(function () {
  var ls = makeLS();
  var Core = freshCore(ls);
  var TXN = freshTxn();
  Core.get();
  var r1 = TXN.restoreBundle({ storage: ls, core: Core, bundle: consistentBundle(TXN, 'C9T5', 'S Buyer') });
  ok(r1.restored === true && ls.getItem(REG_KEY) !== null, 'S1 带注册表一致备份仍可成功恢复', JSON.stringify(r1));
  var r2 = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN, 'C9T6') });
  ok(r2.restored === false && r2.rolledBack === true, 'S2 成功恢复之后再遇不一致备份仍可干净回滚', JSON.stringify(r2));
})();

/* ============ G 组：第二阶段——无 replaceAllRaw 时 fail-closed（禁 fallback） ============ */
(function () {
  var ls = makeLS();
  var Core = freshCore(ls);
  var TXN = freshTxn();
  establish(Core, TXN, ls, function (s) { s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z'; });
  /* 计数包装在基线建立后安装：统计本次恢复尝试内的调用 */
  var calls = { replaceAllChecked: 0, replaceAll: 0 };
  var origChecked = Core.replaceAllChecked, origAll = Core.replaceAll;
  Core.replaceAllChecked = function (o) { calls.replaceAllChecked++; return origChecked(o); };
  Core.replaceAll = function (o) { calls.replaceAll++; return origAll(o); };
  var savedRaw = Core.replaceAllRaw;
  delete Core.replaceAllRaw; /* 模拟原始恢复入口缺失（如版本错位） */
  var res = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN, 'C9T7') });
  ok(res.restored === false && res.rolledBack !== true &&
     res.reason === 'consistency_check_failed:mapping_without_state_entity:int_d:rollback_failed_raw_restore_unavailable',
    'G1 无 replaceAllRaw → 明确原因 rollback_failed_raw_restore_unavailable', JSON.stringify(res));
  ok(calls.replaceAllChecked === 1 && calls.replaceAll === 0,
    'G2 回滚阶段未调用 replaceAllChecked/replaceAll（全程仅目标态写入调用 replaceAllChecked 1 次）',
    JSON.stringify(calls));
  var rj = restoreJournal(ls, TXN);
  ok(!!rj && rj.phase === 'PREPARED' && ls.getItem(TXN.LOCK_KEY) !== null && TXN.isLocked(),
    'G3 fail-closed：日志 PREPARED、锁保留、未落 ABORTED');
  ok(ls.getItem(REG_KEY) === rj.targetRegistry &&
     TXN._stateHash(JSON.parse(ls.getItem(Core.STORE_KEY))) === rj.targetStateHash &&
     TXN._legacyPendingStatus(ls) === 'absent',
    'G4 中止未写回任何一侧：注册表/业务/legacy 均停在目标态（回滚一步未走）');
  Core.replaceAllRaw = savedRaw;
})();

/* replaceAllRaw 返回 false / 抛异常：沿用原有 pending 失败处理 */
(function () {
  [['返回 false', function () { return false; }], ['抛出异常', function () { throw new Error('raw boom'); }]].forEach(function (pair, idx) {
    var ls = makeLS();
    var Core = freshCore(ls);
    var TXN = freshTxn();
    establish(Core, TXN, ls, function (s) { s.settings.fxUpdatedAt = '2026-11-06T12:00:00.000Z'; });
    Core.replaceAllRaw = pair[1];
    var res = TXN.restoreBundle({ storage: ls, core: Core, bundle: mismatchBundle(TXN, 'C9T8' + idx) });
    var rj = restoreJournal(ls, TXN);
    ok(res.restored === false && res.rolledBack !== true &&
       res.reason === 'consistency_check_failed:mapping_without_state_entity:int_d:rollback_failed_restore_pending' &&
       !!rj && rj.phase === 'PREPARED' && ls.getItem(TXN.LOCK_KEY) !== null,
      'G5 replaceAllRaw ' + pair[0] + ' → pending、PREPARED、锁保留', JSON.stringify(res));
  });
})();

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
