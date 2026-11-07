/* P1-23-R7-R2 身份事务层（依赖 identity.js / identity-migration.js）
 *
 * 解决 R7-R1 证实的落盘不一致：业务状态（Core STORE_KEY）与身份注册表
 * （ic_identity_registry_v1）是两次独立写入。本层用事务日志实现
 * 「可检测、可阻断、可回滚」的一致性（不是原子事务，不冒充）：
 *
 * - journal 键 ic_identity_journal_v1：{batchId, phase: PREPARED|COMMITTED|RECOVERED,
 *   prevRegistry（落盘前注册表全文）, inverse（业务差异逆操作）, preStateHash, at}
 * - lock 键 ic_identity_lock_v1：未完成批次存在时置位；Core.persist 内的写入
 *   屏障据此拒绝一切业务落盘（恢复通道以 _bypass 内部标记放行本层写入）；
 * - 每步落盘以「写后读回逐字相等」判定成功，setItem 不抛错不算成功；
 * - recover()：回滚注册表与业务差异 → 哈希复验 → RECOVERED 并解锁；
 *   复验不过则继续锁定。锁定期间禁止盲目重跑导入。
 *
 * 备份：buildBackup/restoreBundle 提供含注册表与校验和的 ic-backup v2 整包；
 * 旧格式备份恢复后置 legacyPending 标记，不伪造注册表。 */
(function () {
  'use strict';
  var Identity = (typeof window !== 'undefined' && window.Identity) || (typeof module !== 'undefined' ? require('./identity.js') : null);
  var IM = (typeof window !== 'undefined' && window.IdentityMigration) || (typeof module !== 'undefined' ? require('./identity-migration.js') : null);
  var JOURNAL_KEY = 'ic_identity_journal_v1';
  var LOCK_KEY = 'ic_identity_lock_v1';
  var LEGACY_PENDING_KEY = 'ic_identity_legacy_pending_v1';
  /* R4 第一项：整包恢复独立事务日志（与导入 journal 分开，避免改变导入
     日志的既有语义）。记录恢复前/目标的业务哈希、注册表全文与逆操作，
     使页面关闭、崩溃或写失败后，启动检查能识别恢复中间状态，并由
     recoverRestore 按磁盘实际状态完成（complete）或回滚（abort）。 */
  var RESTORE_JOURNAL_KEY = 'ic_identity_restore_journal_v1';
  var _storage = null;
  var api = { _bypass: false };

  function fnv(str, seed) { var h = seed >>> 0; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
  function hashOf(str) { return fnv(str, 2166136261) + fnv(str, 42424242); }
  function stateHash(state) { return hashOf(JSON.stringify(state)); }
  /* R6 第二项：三集合内容哈希（不含 settings）。Core 落盘变换只动
     settings（密钥清空、翻译端点保留本机值），集合内容在窗口期
     中断后仍可据此核对磁盘状态是否正是本次恢复目标。 */
  function collectionsHash(state) { return stateHash({ opportunities: (state && state.opportunities) || [], products: (state && state.products) || [], orders: (state && state.orders) || [] }); }

  function writeStrict(storage, key, value) {
    storage.setItem(key, value);
    var back = null;
    try { back = storage.getItem(key); } catch (e) { back = null; }
    if (back !== value) throw new Error('write_verify_failed:' + key);
  }
  function readJson(storage, key) {
    try { var raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  /* R5 3.3：业务状态的持久化原文读取。Core 的落盘格式为 STORE_KEY 下的
     状态 JSON 原文（core.js persist/load）。事务裁决只认这份原文，
     不以 core.get() 的内存态代替——内存可能与磁盘不一致（写入失败被
     Core 内部回滚、页面加载后未落盘的修改、外部改动）。读不到、
     解析失败、调用方未提供 STORE_KEY，一律 fail-closed 返回 ok:false。 */
  function persistedState(storage, core) {
    if (!core || !core.STORE_KEY) return { ok: false, reason: 'persisted_state_key_unavailable' };
    var raw;
    try { raw = storage.getItem(core.STORE_KEY); } catch (e) { return { ok: false, reason: 'persisted_state_unreadable' }; }
    if (raw === null || raw === undefined) return { ok: false, reason: 'persisted_state_absent' };
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'persisted_state_unparseable' }; }
    return { ok: true, state: parsed, hash: stateHash(parsed) };
  }
  function persistedStateHash(storage, core) { var d = persistedState(storage, core); return d.ok ? { ok: true, hash: d.hash } : d; }

  /* R2-R2 修复 B：内存阻断。发现异常先置内存锁（立即生效），持久化锁随后跟上；
     持久化锁写失败也绝不清除内存锁；锁读取异常按阻断处理。
     内存锁按存储实例隔离（WeakMap 键为 storage 对象）：生产环境只有一个
     localStorage，等价于页面级锁；多存储测试环境互不串扰。 */
  var _memLocks = new WeakMap();
  function memLocked(storage) { return !!(storage && _memLocks.get(storage)); }
  function setMemLockFor(storage, v) { if (storage) _memLocks.set(storage, !!v); }
  function init(storage) { _storage = storage; }
  /* R3-01：锁状态读取严格 fail-closed。区分五种情形：absent（键不存在）/
     valid（内容可解析且结构合法）/ error（getItem 抛异常）/ corrupt（JSON 无法解析）/
     invalid（解析成功但结构不合法，如缺 reason）。只有 absent 且无内存锁时
     才判定未锁定；其余一律锁定。损坏锁绝不自动删除或重置为无锁。
     注：isLocked 仅在 init(storage) 之后有意义（页面 boot 首行即 init）。 */
  function rawLockState(storage) {
    var raw;
    try { raw = storage.getItem(LOCK_KEY); } catch (e) { return { state: 'error' }; }
    if (raw === null) return { state: 'absent' };
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return { state: 'corrupt' }; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.reason !== 'string' || !obj.reason) return { state: 'invalid' };
    return { state: 'valid', lock: obj };
  }
  function isLocked() {
    if (api._bypass) return false;
    if (memLocked(_storage)) return true;
    if (!_storage) return false;
    return rawLockState(_storage).state !== 'absent';
  }
  function setMemLock(v) { setMemLockFor(_storage, v); }
  /* 其他标签页改动了事务相关键：无法协调，立即内存阻断（仅检测，非跨页事务） */
  function noteExternalChange() { setMemLockFor(_storage, true); }
  function lockReason() {
    if (!_storage) return null;
    var rs = rawLockState(_storage);
    if (rs.state === 'valid') return rs.lock;
    if (memLocked(_storage)) return { reason: 'memory_lock_or_unreadable_persistent_lock', lockState: rs.state };
    return null;
  }
  function setLock(storage, info) { setMemLockFor(storage, true); try { writeStrict(storage, LOCK_KEY, JSON.stringify(info)); } catch (e) { /* 持久化锁写失败：内存锁已置位保证本会话阻断，重载后由 journal 恢复阻断 */ } }
  /* R3-03：清锁必须验证。removeItem 后读回确认锁键确为 null 才算成功并清内存锁；
     删除抛异常、静默未删、读回异常，一律返回 false 且保留内存锁，
     调用方（recover/restoreBundle）据此不得报告成功。 */
  function clearLock(storage) {
    try { storage.removeItem(LOCK_KEY); } catch (e) { return false; }
    var back;
    try { back = storage.getItem(LOCK_KEY); } catch (e) { return false; }
    if (back !== null) return false;
    setMemLockFor(storage, false);
    return true;
  }
  /* R2-R2 修复 D：日志状态必须显式判定。原始字符串存在但无法解析、缺关键字段、
     phase 非法，一律判 corrupt —— 绝不解释成"没有未决事务"，且不自动清除原文。 */
  function journalStatus(storage) {
    var raw = null;
    try { raw = storage.getItem(JOURNAL_KEY); } catch (e) { return { state: 'corrupt', reason: 'journal_unreadable' }; }
    /* R3-04：只有 raw === null 才代表键不存在；空字符串等假值落入解析必然失败 → corrupt */
    if (raw === null) return { state: 'none' };
    var j = null;
    try { j = JSON.parse(raw); } catch (e) { return { state: 'corrupt', reason: 'journal_unparseable', raw: raw }; }
    if (!j || typeof j !== 'object' || ['PREPARED', 'COMMITTED', 'RECOVERED', 'SUPERSEDED'].indexOf(j.phase) < 0) return { state: 'corrupt', reason: 'journal_phase_invalid', raw: raw };
    if (j.phase === 'PREPARED' && (!j.batchId || !j.prevRegistry || !j.inverse || !j.preStateHash)) return { state: 'corrupt', reason: 'journal_fields_missing', raw: raw };
    return { state: j.phase.toLowerCase(), journal: j };
  }
  function pendingBatch(storage) {
    var s = journalStatus(storage);
    return s.state === 'prepared' ? s.journal : null;
  }
  function restoreJournalStatus(storage) {
    var raw = null;
    try { raw = storage.getItem(RESTORE_JOURNAL_KEY); } catch (e) { return { state: 'corrupt', reason: 'restore_journal_unreadable' }; }
    if (raw === null) return { state: 'none' };
    var j = null;
    try { j = JSON.parse(raw); } catch (e) { return { state: 'corrupt', reason: 'restore_journal_unparseable', raw: raw }; }
    if (!j || typeof j !== 'object' || ['PREPARED', 'COMPLETED', 'ABORTED'].indexOf(j.phase) < 0) return { state: 'corrupt', reason: 'restore_journal_phase_invalid', raw: raw };
    /* R5 3.3：PREPARED 恢复日志还必须携带裁决所需的注册表前后原文
       （键必须存在且为 string|null）；缺失即结构不完整 → corrupt，
       fail-closed 阻断，绝不当作「没有待恢复事务」。 */
    if (j.phase === 'PREPARED' && (!j.batchId || !j.preStateHash || !j.targetStateHash || !j.inverse || !('prevRegistry' in j) || !('targetRegistry' in j) || (j.prevRegistry !== null && typeof j.prevRegistry !== 'string') || (j.targetRegistry !== null && typeof j.targetRegistry !== 'string'))) return { state: 'corrupt', reason: 'restore_journal_fields_missing', raw: raw };
    return { state: j.phase.toLowerCase(), journal: j };
  }
  function pendingRestore(storage) {
    var s = restoreJournalStatus(storage);
    return s.state === 'prepared' ? s.journal : null;
  }
  /* 一致性校验：业务状态中的 int_ 实体必须在注册表有映射，
     注册表中的实体映射必须能在业务状态中找到对应实体。 */
  function verifyConsistency(storage, core, stateOverride) {
    var problems = [];
    var registry = IM.loadRegistry(storage);
    /* R4 第三项：注册表损坏本身就是不一致，绝不当作空表得出「一致」。 */
    if (registry.registryLoadState === 'corrupt') return { consistent: false, problems: ['registry_corrupt'] };
    /* R5 3.3：recoverRestore 传落盘状态求值，裁决全程只认持久化原文；
       其余调用方不传第三参，仍按内存状态（加载/写入后即落盘态）校验。 */
    var state = stateOverride || core.get();
    var inState = Object.create(null); /* R6 第五项：索引键带类型前缀，数字 ID 与同数字字符串 ID 不合并 */
    ['opportunities', 'products', 'orders'].forEach(function (coll) {
      (state[coll] || []).forEach(function (e) { inState[idKey(e.id)] = coll; if (String(e.id).indexOf('int_') === 0 && !registry.byInternal[e.id]) problems.push('state_entity_without_mapping:' + e.id); });
    });
    Object.keys(registry.byInternal).forEach(function (iid) {
      var ent = registry.byInternal[iid];
      if (ent.identity && ent.identity.source_system !== 'legacy' && !inState[idKey(iid)]) problems.push('mapping_without_state_entity:' + iid);
    });
    return { consistent: problems.length === 0, problems: problems };
  }

  /* 页面加载检查：journal 有 PREPARED 而锁缺失时补锁（进程在置锁前被杀的情形）；
     传入 core 时附带一致性校验，发现不一致同样置锁。 */
  function checkOnLoad(storage, core) {
    init(storage);
    var js = journalStatus(storage);
    if (js.state === 'corrupt') setLock(storage, { reason: 'journal_corrupt:' + js.reason, at: new Date().toISOString() });
    var p = pendingBatch(storage);
    if (p) { setMemLockFor(storage, true); if (rawLockState(storage).state === 'absent') setLock(storage, { batchId: p.batchId, reason: 'unfinished_batch_detected_on_load', at: new Date().toISOString() }); }
    /* R4 第一项：识别整包恢复中间状态。恢复日志 PREPARED（含页面关闭/
       崩溃留下的）一律先阻断，等待 recoverRestore 按磁盘实际状态裁决；
       恢复日志损坏同样阻断，绝不自动清除。 */
    var rjs = restoreJournalStatus(storage);
    var rp = rjs.state === 'prepared' ? rjs.journal : null;
    if (rjs.state === 'corrupt') setLock(storage, { reason: 'restore_journal_corrupt:' + rjs.reason, at: new Date().toISOString() });
    if (rp) { setMemLockFor(storage, true); if (rawLockState(storage).state === 'absent') setLock(storage, { batchId: rp.batchId, reason: 'unfinished_restore_detected_on_load', at: new Date().toISOString() }); }
    var consistency = null;
    if (core && rawLockState(storage).state === 'absent' && !memLocked(storage)) {
      consistency = verifyConsistency(storage, core);
      if (!consistency.consistent) setLock(storage, { reason: 'consistency_check_failed', problems: consistency.problems.slice(0, 10), at: new Date().toISOString() });
    }
    return { locked: isLocked(), pending: p, restorePending: rp, legacyPending: !!readLegacyPending(storage), consistency: consistency, journalState: js.state, restoreJournalState: rjs.state };
  }
  function readLegacyPending(storage) { try { return storage.getItem(LEGACY_PENDING_KEY) === '1'; } catch (e) { return false; } }
  function setLegacyPending(storage) { try { storage.setItem(LEGACY_PENDING_KEY, '1'); } catch (e) {} }
  function clearLegacyPending(storage) { try { storage.removeItem(LEGACY_PENDING_KEY); } catch (e) {} }
  /* R6 第三项：legacyPending 纳入事务闭环。标记读取四态严格区分：
     键不存在 = absent；值 '1' = set；其他任何字符串 = corrupt；
     读取抛错 = error——不得把不存在/读失败/损坏混为一谈。
     writeLegacyPending 为验证写：写后读回确认目标状态才算成功，
     失败返回 false 供事务层进入可恢复状态，绝不吞异常假装成功。
     旧 set/clearLegacyPending 保留给非事务的兼容调用方。 */
  function legacyPendingStatus(storage) {
    var raw;
    try { raw = storage.getItem(LEGACY_PENDING_KEY); } catch (e) { return 'error'; }
    if (raw === null || raw === undefined) return 'absent';
    if (raw === '1') return 'set';
    return 'corrupt';
  }
  function writeLegacyPending(storage, status) {
    /* 已是目标状态时不做物理写：避免无谓的写操作在故障注入/配额
       异常下误伤本无变化的事务步骤（如目标为 absent 且标记本就
       不存在时，无需调用 removeItem）。 */
    if (legacyPendingStatus(storage) === status) return true;
    try {
      if (status === 'set') { storage.setItem(LEGACY_PENDING_KEY, '1'); return storage.getItem(LEGACY_PENDING_KEY) === '1'; }
      storage.removeItem(LEGACY_PENDING_KEY);
      return storage.getItem(LEGACY_PENDING_KEY) === null;
    } catch (e) { return false; }
  }

  /* R6 第五项：ID 索引键必须类型感知。普通对象键会把数字 123 与
     字符串 '123' 静默合并、'__proto__' 赋值被吞。内部索引用带类型
     前缀的键（s:/n:/x:）+ 无原型对象；created 列表保留原始 ID 值
     （JSON 数组可区分数字与字符串）。journal 中 updatedPrev 的键
     自本轮起为类型键并带 format:'typed-v2'；applyInverse 对无
     format 的历史 journal 兼容回退到原始键查找。 */
  function idKey(id) { return (typeof id === 'string' ? 's:' : typeof id === 'number' ? 'n:' : 'x:') + String(id); }
  function diffInverse(prevState, nextState) {
    var inv = { format: 'typed-v2', created: { opportunities: [], products: [], orders: [] }, updatedPrev: { opportunities: Object.create(null), products: Object.create(null), orders: Object.create(null) } };
    ['opportunities', 'products', 'orders'].forEach(function (coll) {
      var prevById = Object.create(null);
      (prevState[coll] || []).forEach(function (e) { prevById[idKey(e.id)] = e; });
      (nextState[coll] || []).forEach(function (e) {
        var prev = prevById[idKey(e.id)];
        if (!prev) inv.created[coll].push(e.id);
        else if (JSON.stringify(prev) !== JSON.stringify(e)) inv.updatedPrev[coll][idKey(e.id)] = prev;
      });
    });
    return inv;
  }
  function applyInverse(state, inv) {
    var s = JSON.parse(JSON.stringify(state));
    var hasOwn = Object.prototype.hasOwnProperty;
    ['opportunities', 'products', 'orders'].forEach(function (coll) {
      var created = Object.create(null);
      (inv.created[coll] || []).forEach(function (id) { created[idKey(id)] = true; });
      var prevMap = (inv.updatedPrev && inv.updatedPrev[coll]) || {};
      s[coll] = (s[coll] || []).filter(function (e) { return !created[idKey(e.id)]; }).map(function (e) {
        /* R7 第二项：快照读取必须用自身属性判定。旧格式 journal 的
           updatedPrev 是普通对象，直接以 e.id 读 '__proto__' /
           'constructor' / 'toString' / 'valueOf' 会命中原型链继承
           属性（如 Object.prototype、构造函数），被误当成实体
           快照写回业务状态——伪造实体。现新旧两种键都先
           hasOwnProperty 确认是日志自带的数据才采用；命中值还
           必须是对象快照，非对象一律不采用（保持现值，后续由
           调用方的哈希复验把不一致导向人工处理，不猜测）。 */
        var prev;
        if (hasOwn.call(prevMap, idKey(e.id))) prev = prevMap[idKey(e.id)];
        else if (!inv.format && hasOwn.call(prevMap, e.id)) prev = prevMap[e.id];
        if (prev && typeof prev === 'object') return JSON.parse(JSON.stringify(prev));
        return e;
      });
    });
    return s;
  }

  /* 事务化身份导入。core 需提供 get()/replaceAllChecked()。
     任一步失败 → 保持 PREPARED + 锁定，返回 {applied:false, stage}，绝不标记成功。 */
  function commitImport(args) {
    var storage = args.storage, core = args.core;
    init(storage);
    if (journalStatus(storage).state === 'corrupt') { setLock(storage, { reason: 'journal_corrupt', at: new Date().toISOString() }); return { applied: false, locked: true, reason: 'journal_corrupt' }; }
    /* R4：未完成整包恢复或注册表损坏时禁止导入（不得把损坏注册表当空表）。 */
    if (pendingRestore(storage)) { setLock(storage, { reason: 'unfinished_restore', at: new Date().toISOString() }); return { applied: false, locked: true, reason: 'unfinished_restore_must_recover_first' }; }
    /* R7 第七项：损坏的恢复日志同样必须阻断导入。pendingRestore 只
       对 PREPARED 返回真值，restoreJournalStatus 判定的 corrupt
       （不可解析/phase 非法/PREPARED 字段缺失/读取抛错）此前会直接
       穿过本检查、带着未裁决的恢复中间状态写入业务数据。现显式
       fail-closed：置锁拒绝，损坏原文保留不删除、不猜测恢复方向。 */
    if (restoreJournalStatus(storage).state === 'corrupt') { setLock(storage, { reason: 'restore_journal_corrupt', at: new Date().toISOString() }); return { applied: false, locked: true, reason: 'restore_journal_corrupt' }; }
    if (IM.loadRegistryStatus(storage) === 'corrupt') { setLock(storage, { reason: 'registry_corrupt', at: new Date().toISOString() }); return { applied: false, locked: true, reason: 'registry_corrupt' }; }
    if (rawLockState(storage).state !== 'absent' || memLocked(storage) || pendingBatch(storage)) return { applied: false, locked: true, reason: 'recovery_required_before_import' };
    /* R6 第三项：legacyPending 纳入事务闭环。先读标记四态存档：
       损坏/读失败 → fail-closed 阻断；标记存在且注册表为空 → 回填
       前置拒绝（标记不动，与旧语义一致）；标记存在且注册表非空 →
       不再在事务开始前提前清除——journal 记录 prevLegacyPending，
       清除移到业务与注册表都落盘之后、COMMITTED 标记之前并读回
       验证；recover 回滚时按 journal 恢复标记到事务前状态。 */
    var lpStatus = legacyPendingStatus(storage);
    if (lpStatus === 'corrupt' || lpStatus === 'error') { setLock(storage, { reason: 'legacy_pending_unreadable', at: new Date().toISOString() }); return { applied: false, locked: true, reason: 'legacy_pending_unreadable' }; }
    var clearLegacyAfterCommit = false;
    if (lpStatus === 'set') {
      var existingReg = IM.loadRegistry(storage);
      if (!Object.keys(existingReg.byKey).length) return { applied: false, legacyPending: true, reason: 'legacy_backfill_required' };
      clearLegacyAfterCommit = true;
    }
    var registry = IM.loadRegistry(storage);
    var prevState = core.get();
    var prevRegistryExport = Identity.exportState(registry);
    var res = IM.importBatch(prevState, registry, args.batch, args.opts || {});
    if (!res.applied) return { applied: false, stage: 'compute', error: res.error };
    var batchId = 'batch_' + Date.now().toString(36) + Math.floor(Math.random() * 4294967296).toString(36);
    var journal = { batchId: batchId, phase: 'PREPARED', at: new Date().toISOString(), prevRegistry: prevRegistryExport, inverse: diffInverse(prevState, res.state), preStateHash: stateHash(prevState), prevLegacyPending: lpStatus };
    try { writeStrict(storage, JOURNAL_KEY, JSON.stringify(journal)); }
    catch (e) { return { applied: false, stage: 'journal', error: String(e && e.message || e) }; }
    api._bypass = true;
    try {
      var okState = core.replaceAllChecked(res.state);
      if (!okState) { setLock(storage, { batchId: batchId, reason: 'business_persist_failed', at: new Date().toISOString() }); return { applied: false, stage: 'business_persist', batchId: batchId }; }
      try { IM.saveRegistry(storage, res.registry); var back = storage.getItem(IM.REGISTRY_KEY); if (back !== Identity.exportState(res.registry)) throw new Error('registry_verify_failed'); }
      catch (e2) { setLock(storage, { batchId: batchId, reason: 'registry_persist_failed', at: new Date().toISOString() }); return { applied: false, stage: 'registry_persist', batchId: batchId }; }
      /* R6 第三项：标记清除是事务的最后一步数据写——清除失败
         （含静默未删）即整批不提交，保持 PREPARED + 锁待 recover
         按 journal.prevLegacyPending 恢复标记与双边状态。 */
      if (clearLegacyAfterCommit && !writeLegacyPending(storage, 'absent')) { setLock(storage, { batchId: batchId, reason: 'legacy_pending_clear_failed', at: new Date().toISOString() }); return { applied: false, stage: 'legacy_pending', batchId: batchId }; }
      journal.phase = 'COMMITTED';
      try { writeStrict(storage, JOURNAL_KEY, JSON.stringify(journal)); }
      catch (e3) { setLock(storage, { batchId: batchId, reason: 'commit_mark_failed', at: new Date().toISOString() }); return { applied: false, stage: 'commit_mark', batchId: batchId }; }
    } finally { api._bypass = false; }
    var counts = {};
    res.results.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    return { applied: true, batchId: batchId, counts: counts, results: res.results };
  }

  /* 恢复：回滚注册表与业务差异，哈希复验通过才解锁。core 需提供 get()/replaceAllChecked()。 */
  function recover(args) {
    var storage = args.storage, core = args.core;
    init(storage);
    var js = journalStatus(storage);
    if (js.state === 'corrupt') return { recovered: false, reason: 'journal_corrupt_manual_required' };
    var journal = pendingBatch(storage);
    if (!journal) {
      /* R5 3.2/3.3：恢复日志损坏必须 fail-closed 报出，不得落到
         no_pending_batch 被误读为「没有待恢复事务」。 */
      var rjs0 = restoreJournalStatus(storage);
      if (rjs0.state === 'corrupt') return { recovered: false, reason: 'restore_journal_corrupt_manual_required' };
      /* R4：无未决导入时，若有未完成整包恢复则转交恢复裁决（同一入口）。 */
      if (pendingRestore(storage)) return recoverRestore(args);
      /* R6 第一项：终态恢复日志 + 残留锁的收敛，必须先证明锁归属。
         R5 版条件过宽：仅 reason 相同、或仅 batchId 相同、或仅内存锁
         残留都可能误清其他恢复事务/其他保护机制的锁。现收紧为：
         持久化锁存在且结构合法（rawLockState=valid）、reason 必须为
         restore_in_progress、batchId 必须与终态恢复日志逐字一致——
         三者同时成立才认定为该恢复的遗留锁并验证清锁。终态日志缺
         batchId、锁缺 batchId、锁损坏/不可读、或只有无法归因的内存
         锁时，一律不清锁，保持锁定并返回 stale_lock_ownership_
         unproven 待人工处理；无任何锁时维持 no_pending_batch。 */
      if (rjs0.state === 'aborted' || rjs0.state === 'completed') {
        var lk = rawLockState(storage);
        if (lk.state !== 'absent' || memLocked(storage)) {
          var owned = !!(rjs0.journal && rjs0.journal.batchId && lk.state === 'valid' && lk.lock.reason === 'restore_in_progress' && lk.lock.batchId === rjs0.journal.batchId);
          if (!owned) return { recovered: false, reason: 'stale_lock_ownership_unproven' };
          if (!clearLock(storage)) return { recovered: false, reason: 'stale_lock_clear_failed' };
          return { recovered: true, mode: 'stale_lock_cleared', restoreJournalState: rjs0.state };
        }
      }
      return { recovered: false, reason: 'no_pending_batch' };
    }
    api._bypass = true;
    try {
      var prevReg = Identity.importState(journal.prevRegistry);
      IM.saveRegistry(storage, prevReg);
      if (storage.getItem(IM.REGISTRY_KEY) !== journal.prevRegistry) return { recovered: false, reason: 'registry_rollback_verify_failed' };
      var rolled = applyInverse(core.get(), journal.inverse);
      var okState = core.replaceAllChecked(rolled);
      if (!okState) return { recovered: false, reason: 'business_rollback_persist_failed' };
      /* R3-05：验证只认真实状态，禁止用待写对象（rolled）的哈希冒充落盘证据：
         ① Core 回滚后的实际内存状态哈希必须等于事务前哈希；
         ② 调用方提供业务存储键（args.bizKey）时，直接读磁盘原文再验哈希；
         任一不一致或读回异常都保持锁定，不报告恢复成功。 */
      if (stateHash(core.get()) !== journal.preStateHash) return { recovered: false, reason: 'state_hash_mismatch_after_rollback' };
      if (args.bizKey) {
        var diskOk = false;
        try { var diskRaw = storage.getItem(args.bizKey); if (diskRaw) diskOk = stateHash(JSON.parse(diskRaw)) === journal.preStateHash; } catch (e) { diskOk = false; }
        if (!diskOk) return { recovered: false, reason: 'disk_state_verify_failed' };
      }
      /* R3-03 顺序：先验证清锁成功、再写 RECOVERED。若先写 RECOVERED 再清锁失败，
         journal 已终结、锁却还在，将形成无事务可恢复的死锁；现顺序下清锁失败时
         journal 保持 PREPARED，修复存储后可直接重跑恢复。 */
      if (!clearLock(storage)) return { recovered: false, reason: 'lock_clear_failed' };
      /* R6 第三项：标记按导入 journal 记录恢复到事务前状态并读回
         验证（旧 journal 无 prevLegacyPending 字段时跳过，兼容）。
         位置在清锁之后、RECOVERED 落盘之前：清锁自身的失败原因
         （lock_clear_failed）不被标记步骤抢占；标记恢复失败则立即
         重新加锁，保持 PREPARED 待重跑（本步幂等）。 */
      if ((journal.prevLegacyPending === 'set' || journal.prevLegacyPending === 'absent') && !writeLegacyPending(storage, journal.prevLegacyPending)) {
        setLock(storage, { batchId: journal.batchId, reason: 'legacy_pending_restore_failed', at: new Date().toISOString() });
        return { recovered: false, reason: 'legacy_pending_restore_failed' };
      }
      journal.phase = 'RECOVERED';
      try { writeStrict(storage, JOURNAL_KEY, JSON.stringify(journal)); }
      catch (e) { setLock(storage, { batchId: journal.batchId, reason: 'journal_mark_failed_after_unlock', at: new Date().toISOString() }); return { recovered: false, reason: 'journal_mark_failed_after_unlock' }; }
      return { recovered: true, batchId: journal.batchId };
    } catch (e) {
      return { recovered: false, reason: String(e && e.message || e) };
    } finally { api._bypass = false; }
  }

  /* ---------- ic-backup v2 整包（含注册表与校验和） ---------- */
  function buildBackup(core, storage) {
    var state = JSON.parse(JSON.stringify(core.get()));
    if (state.settings) { state.settings.dashscopeKey = ''; state.settings.translateEndpoint = ''; }
    /* R6 第七项：注册表读取四态必须区分。键不存在 → registry=null
       （合法的无注册表备份）；读到内容且可解析 → 正常；读取抛错 →
       抛 registry_read_failed；内容不可解析 → 抛 registry_corrupt。
       旧实现把抛错与损坏都吞成 registry=null，生成的备份看似完整
       却丢了整个身份注册表——现改为明确拒绝生成备份。
       R7 第四项：仅凭 JSON 可解析不足以认定注册表合法。空字符串
       （'' 是 falsy，旧 `if (raw)` 会当作键不存在）、JSON null、
       数组、空对象、缺必要字段、索引结构非法，都必须判
       registry_corrupt。结构校验直接复用 identity.js 的
       importState（与 loadRegistry 同一标准，不另立第二套），
       其抛出的 registry_* 错误在此统一转 registry_corrupt；
       不自动修复、不覆盖损坏注册表。 */
    var registry = null;
    var raw = null;
    try { raw = storage.getItem(IM.REGISTRY_KEY); } catch (e) { throw new Error('registry_read_failed'); }
    if (raw !== null && raw !== undefined) {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { throw new Error('registry_corrupt'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('registry_corrupt');
      /* 必要字段存在性：exportState 产出的注册表恒含 byKey /
         canonVersion / keyVersion，缺任一即非本系统注册表格式。
         importState 对缺失字段有默认值（面向旧快照兼容），备份
         导出场景必须更严——缺字段即 corrupt，不拿默认值掩盖。 */
      if (!parsed.byKey || typeof parsed.byKey !== 'object' || Array.isArray(parsed.byKey) || typeof parsed.canonVersion !== 'string' || typeof parsed.keyVersion !== 'string') throw new Error('registry_corrupt');
      try { Identity.importState(raw); } catch (e2) { throw new Error('registry_corrupt'); }
      registry = parsed;
    }
    var stateStr = JSON.stringify(state), regStr = registry ? JSON.stringify(registry) : '';
    return { format: 'ic-backup', version: 2, exportedAt: new Date().toISOString(), state: state, identityRegistry: registry, checksums: { state: hashOf(stateStr), registry: registry ? hashOf(regStr) : null } };
  }
  function validateBundle(bundle) {
    if (!bundle || bundle.format !== 'ic-backup' || bundle.version !== 2 || !bundle.state) return { ok: false, reason: 'not_ic_backup_v2' };
    if (hashOf(JSON.stringify(bundle.state)) !== bundle.checksums.state) return { ok: false, reason: 'state_checksum_mismatch' };
    /* R8 第四项补充修复：注册表校验和只对「在场且非 null」的值免检。
       字段缺失与 null 是无注册表备份的合法形态（buildBackup 产出
       identityRegistry:null + checksums.registry:null）；旧真假守卫
       使 false/0/'' 连校验和都不被核验即被当作无注册表，现收紧为
       !== undefined && !== null，其余值一律核验。 */
    if (bundle.identityRegistry !== undefined && bundle.identityRegistry !== null && hashOf(JSON.stringify(bundle.identityRegistry)) !== bundle.checksums.registry) return { ok: false, reason: 'registry_checksum_mismatch' };
    return { ok: true };
  }
  /* R4 第一项：整包恢复事务裁决。依据恢复日志与磁盘实际状态判定：
       目标态完整 → 完成（COMPLETED）；恢复前态完整 → 中止（ABORTED）；
       业务已达目标但注册表仍为旧值 → 向前补齐注册表后完成；
       注册表已达目标但业务仍为旧值 → 写回旧注册表后中止；
       其余组合一律保持锁定待人工处理。所有结论只认磁盘/内存真实读回。 */
  function recoverRestore(args) {
    var storage = args.storage, core = args.core;
    init(storage);
    var rjs = restoreJournalStatus(storage);
    if (rjs.state === 'corrupt') return { recovered: false, reason: 'restore_journal_corrupt_manual_required' };
    var rj = rjs.state === 'prepared' ? rjs.journal : null;
    if (!rj) return { recovered: false, reason: 'no_pending_restore' };
    api._bypass = true;
    try {
      /* R5 3.3：裁决依据一律为持久化原文——业务状态读 STORE_KEY 落盘
         JSON、注册表读注册表键原文；任一读不到/解析失败即 fail-closed
         保持锁定，绝不以 core.get() 内存态代替磁盘事实。一致性检查
         同样针对落盘状态（verifyConsistency 第三参）求值。 */
      var disk = persistedState(storage, core);
      if (!disk.ok) return { recovered: false, reason: disk.reason };
      var curHash = disk.hash;
      var curReg = null;
      try { curReg = storage.getItem(IM.REGISTRY_KEY); } catch (e) { return { recovered: false, reason: 'registry_unreadable' }; }
      var stateTarget = curHash === rj.targetStateHash, statePrev = curHash === rj.preStateHash;
      var regTarget = curReg === rj.targetRegistry, regPrev = curReg === rj.prevRegistry;
      function finalize(phase, mode) {
        if (!clearLock(storage)) return { recovered: false, reason: 'lock_clear_failed' };
        rj.phase = phase;
        try { writeStrict(storage, RESTORE_JOURNAL_KEY, JSON.stringify(rj)); }
        catch (e) { setLock(storage, { batchId: rj.batchId, reason: 'restore_mark_failed_after_unlock', at: new Date().toISOString() }); return { recovered: false, reason: 'restore_mark_failed_after_unlock' }; }
        return { recovered: true, mode: mode, batchId: rj.batchId };
      }
      function finalConsistency() { return verifyConsistency(storage, core, disk.state); }
      /* R6 第三项：裁决同时核对 legacyPending 标记。恢复日志记录了
         前后标记状态时，标记损坏/读失败 → fail-closed；完成路径要求
         标记=目标状态、中止路径要求标记=恢复前状态，不一致先验证
         修复，修复失败保持锁定。旧日志无标记字段时跳过（兼容）。 */
      var legacyKnown = (rj.prevLegacyPending === 'set' || rj.prevLegacyPending === 'absent') && (rj.targetLegacyPending === 'set' || rj.targetLegacyPending === 'absent');
      var curLegacy = legacyKnown ? legacyPendingStatus(storage) : null;
      if (legacyKnown && (curLegacy === 'corrupt' || curLegacy === 'error')) return { recovered: false, reason: 'legacy_pending_unreadable' };
      function ensureLegacy(want) {
        if (!legacyKnown || curLegacy === want) return true;
        if (!writeLegacyPending(storage, want)) return false;
        curLegacy = want;
        return true;
      }
      if (stateTarget && regTarget) {
        /* 向前完成必须先过最终一致性检查，不一致即保持锁定待人工，
           不得把目标态标为已完成。 */
        var vcT = finalConsistency();
        if (!vcT.consistent) return { recovered: false, reason: 'restore_final_consistency_failed:' + vcT.problems[0] };
        if (!ensureLegacy(rj.targetLegacyPending)) return { recovered: false, reason: 'legacy_pending_fix_failed' };
        return finalize('COMPLETED', 'completed');
      }
      if (statePrev && regPrev) {
        /* 中止裁决回答的是「恢复是否生效」：双边均为前态即未生效。
           前态自身的一致性问题是恢复前既存事项（由 checkOnLoad 的
           一致性检查另行阻断），随结果如实带回，不据此否决裁决。 */
        var vcP = finalConsistency();
        if (!ensureLegacy(rj.prevLegacyPending)) return { recovered: false, reason: 'legacy_pending_fix_failed' };
        var resP = finalize('ABORTED', 'aborted');
        if (resP.recovered && !vcP.consistent) resP.consistencyProblems = vcP.problems;
        return resP;
      }
      if (stateTarget && regPrev && rj.targetRegistry != null) {
        storage.setItem(IM.REGISTRY_KEY, rj.targetRegistry);
        if (storage.getItem(IM.REGISTRY_KEY) !== rj.targetRegistry) return { recovered: false, reason: 'registry_complete_verify_failed' };
        var vcF = finalConsistency();
        if (!vcF.consistent) return { recovered: false, reason: 'restore_final_consistency_failed:' + vcF.problems[0] };
        if (!ensureLegacy(rj.targetLegacyPending)) return { recovered: false, reason: 'legacy_pending_fix_failed' };
        return finalize('COMPLETED', 'completed_forward');
      }
      if (statePrev && regTarget) {
        if (rj.prevRegistry == null) { storage.removeItem(IM.REGISTRY_KEY); if (storage.getItem(IM.REGISTRY_KEY) !== null) return { recovered: false, reason: 'registry_rollback_verify_failed' }; }
        else { storage.setItem(IM.REGISTRY_KEY, rj.prevRegistry); if (storage.getItem(IM.REGISTRY_KEY) !== rj.prevRegistry) return { recovered: false, reason: 'registry_rollback_verify_failed' }; }
        var vcB = finalConsistency();
        if (!ensureLegacy(rj.prevLegacyPending)) return { recovered: false, reason: 'legacy_pending_fix_failed' };
        var resB = finalize('ABORTED', 'aborted_registry_rolled_back');
        if (resB.recovered && !vcB.consistent) resB.consistencyProblems = vcB.problems;
        return resB;
      }
      /* R6 第二项：目标写入窗口的显式处理。业务目标已落盘、日志
         目标哈希尚未刷新时中断，磁盘全量哈希与两个日志哈希都对
         不上（落盘变换只动 settings）。仅当日志带 targetWriteStarted
         与 targetCollectionsHash、注册表已达目标、磁盘三集合内容
         哈希与日志记录的目标集合哈希逐字一致、且一致性检查通过
         时，才采纳磁盘哈希为目标并完成；任何一项不满足仍保持
         锁定待人工，绝不把未知状态猜成目标。 */
      if (rj.targetWriteStarted && regTarget && rj.targetCollectionsHash) {
        if (collectionsHash(disk.state) === rj.targetCollectionsHash) {
          var vcW = finalConsistency();
          if (!vcW.consistent) return { recovered: false, reason: 'restore_final_consistency_failed:' + vcW.problems[0] };
          if (!ensureLegacy(rj.targetLegacyPending)) return { recovered: false, reason: 'legacy_pending_fix_failed' };
          rj.targetStateHash = curHash;
          rj.targetWriteStarted = false;
          rj.targetHashAdopted = true;
          try { writeStrict(storage, RESTORE_JOURNAL_KEY, JSON.stringify(rj)); } catch (e) { return { recovered: false, reason: 'restore_journal_update_failed' }; }
          return finalize('COMPLETED', 'completed_target_adopted');
        }
      }
      return { recovered: false, reason: 'restore_state_inconsistent_manual_required' };
    } catch (e) {
      return { recovered: false, reason: String(e && e.message || e) };
    } finally { api._bypass = false; }
  }

  function restoreBundle(args) {
    var storage = args.storage, core = args.core, bundle = args.bundle;
    init(storage);
    /* R2-R2 修复 A：与未决事务互斥。PREPARED 或日志损坏时一律拒绝恢复，
       且拒绝发生在任何写入之前——业务、注册表、日志三者都不动。
       采用"先处理未决事务、再恢复备份"的可证明顺序，不做事务失效式恢复。 */
    var js = journalStatus(storage);
    if (js.state === 'prepared' || js.state === 'corrupt') return { restored: false, reason: js.state === 'prepared' ? 'pending_transaction_must_recover_first' : 'journal_corrupt' };
    /* R4 第一项：未完成整包恢复未裁决前不得再启一次恢复；注册表损坏且
       备份不含注册表时拒绝（无从确立恢复后的一致注册表）。 */
    var rjs = restoreJournalStatus(storage);
    if (rjs.state === 'prepared') return { restored: false, reason: 'unfinished_restore_must_recover_first' };
    if (rjs.state === 'corrupt') return { restored: false, reason: 'restore_journal_corrupt' };
    var v = validateBundle(bundle);
    if (!v.ok) return { restored: false, reason: v.reason };
    /* R8 第四项修复：备份注册表对象级预检（只读，validateBundle 之后、
       任何落盘之前）。缺陷：原流程对 bundle.identityRegistry 只做
       JSON.stringify 校验和与落盘——stringify 会把 Infinity 等非纯
       JSON 值静默降格为 null，canon-v3 注册表中本应被 importState
       逐实体门禁（identity.js）拒绝的内容因此绕过校验，恢复还会
       报告成功。此处在原始解析对象上先做版本感知的整对象纯 JSON
       检查（canon-v3，含版本缺失按既有契约默认 v3；作用域为整个
       注册表对象——byKey 实体、conflicts、reviewEvents 与顶层全部
       字段及任意嵌套），再以 importState 对序列化文本做校验-only
       结构复核（重建结果丢弃，落盘仍用备份原文对应的
       targetRegistry，绝不写回重建结果）。canon-v1/v2 跳过纯 JSON
       门禁、保持历史语义；版本字段合法性由结构复核按 importState
       既有错误码裁定。拒绝发生在恢复日志、锁、磁盘基线与任何
       持久化写入之前，不进入 abortRestore。 */
    /* R8 第四项补充修复：预检入口同样只对 undefined/null 免检——
       false/0/'' 等非法标量进入下方结构复核，由 importState 以
       registry_not_object 在写前拒绝，不再被真假判断当作无注册表
       备份绕过预检与结构复核。 */
    if (bundle.identityRegistry !== undefined && bundle.identityRegistry !== null) {
      var regObj = bundle.identityRegistry;
      var regIsObj = !!regObj && typeof regObj === 'object' && !Array.isArray(regObj);
      var declaredCanon = regIsObj ? regObj.canonVersion : undefined;
      if (regIsObj && (declaredCanon === undefined || declaredCanon === Identity.CANON_VERSION) && !Identity.isPlainJsonValue(regObj)) {
        return { restored: false, reason: 'registry_entity_content_invalid' };
      }
      try { Identity.importState(JSON.stringify(regObj)); }
      catch (e) { return { restored: false, reason: (e && e.code) ? e.code : 'registry_unparseable' }; }
    }
    if (!bundle.identityRegistry && IM.loadRegistryStatus(storage) === 'corrupt') return { restored: false, reason: 'registry_corrupt' };
    /* R6 第二项：恢复前状态一律以真实持久化原文为据。业务状态读
       STORE_KEY 落盘 JSON：读不到/不存在/不可解析一律 fail-closed
       ——唯一例外是「键不存在且 Core 能落盘」时先显式落盘一次建立
       磁盘基线（首次使用尚未落盘的场景），落盘失败仍拒绝。恢复前
       快照、preStateHash 与一致性基线全部来自这同一份经验证的
       磁盘快照，不再用 core.get() 内存态冒充磁盘事实（内存可能含
       未落盘修改、或在写入失败后与磁盘分道）。 */
    var diskPrev = persistedState(storage, core);
    if (!diskPrev.ok && diskPrev.reason === 'persisted_state_absent' && core && typeof core.persist === 'function') {
      var flushed = false;
      try { flushed = core.persist() === true; } catch (e) { flushed = false; }
      if (flushed) diskPrev = persistedState(storage, core);
    }
    if (!diskPrev.ok) return { restored: false, reason: diskPrev.reason };
    var prevState = diskPrev.state;
    /* R5 第一项（基线口径随 R6 改为磁盘快照）：恢复前的一致性问题
       集作为回滚验收基线——回滚只需把系统带回恢复前的问题集，
       不得因恢复前既存问题把一次忠实回滚判为失败。 */
    var preProblems = [];
    try { preProblems = verifyConsistency(storage, core, prevState).problems || []; } catch (e) { preProblems = ['pre_consistency_unavailable']; }
    /* R6 第三项：legacyPending 纳入恢复事务——恢复前标记状态先
       存档进恢复日志；标记损坏/读失败时拒绝开始，不把异常当作
       不存在。目标状态由备份是否含注册表决定（与旧语义一致）。 */
    var prevLegacy = legacyPendingStatus(storage);
    if (prevLegacy === 'corrupt' || prevLegacy === 'error') return { restored: false, reason: 'legacy_pending_unreadable' };
    var targetLegacy = bundle.identityRegistry ? 'absent' : 'set';
    /* 恢复前注册表原文：读回失败即拒绝开始，不猜测。 */
    var prevRegistry = null;
    try { prevRegistry = storage.getItem(IM.REGISTRY_KEY); } catch (e) { return { restored: false, reason: 'registry_unreadable' }; }
    var targetRegistry = bundle.identityRegistry ? JSON.stringify(bundle.identityRegistry) : prevRegistry;
    var batchId = 'restore_' + Date.now().toString(36) + Math.floor(Math.random() * 4294967296).toString(36);
    var rj = { batchId: batchId, phase: 'PREPARED', kind: 'restore', at: new Date().toISOString(),
      prevRegistry: prevRegistry, targetRegistry: targetRegistry, registryFromBundle: !!bundle.identityRegistry,
      prevState: JSON.parse(JSON.stringify(prevState)),
      inverse: diffInverse(prevState, bundle.state), preStateHash: diskPrev.hash, targetStateHash: stateHash(bundle.state),
      targetCollectionsHash: collectionsHash(bundle.state),
      prevLegacyPending: prevLegacy, targetLegacyPending: targetLegacy, targetWriteStarted: true };
    /* 第一步：恢复日志先落盘（写后读回验证）。此后任何时刻中断，
       启动检查都能凭日志 + 磁盘实际状态识别并裁决这次恢复。 */
    try { writeStrict(storage, RESTORE_JOURNAL_KEY, JSON.stringify(rj)); }
    catch (e) { return { restored: false, stage: 'restore_journal', reason: 'restore_journal_write_failed' }; }
    setLock(storage, { reason: 'restore_in_progress', batchId: batchId, at: new Date().toISOString() });
    /* 中止路径（R5 第一项重写）：业务状态与注册表必须一起回滚。
       R4 版只回滚业务状态——注册表若已写入目标值、随后一致性检查
       失败，注册表会停在目标态与已回滚的业务状态不一致，且无人察觉。
       现顺序：① 业务状态写回恢复前快照（日志中保存了 prevState 全文，
       因为逆操作只覆盖三集合、无法还原 settings 等其余字段），内存
       哈希 + 磁盘原文哈希双重验真；② 注册表写回恢复前原文（或删除），
       写后读回逐字验证；③ 一致性检查，问题集不得超出恢复前基线。
       三步全过才按「先清锁、后落 ABORTED」收尾；任一步失败都保持
       PREPARED + 锁定，交 recoverRestore 按磁盘实际状态裁决，
       绝不标 ABORTED、绝不解锁、绝不报告已回滚。 */
    function abortRestore(reason) {
      function pending() { return { restored: false, reason: reason + ':rollback_failed_restore_pending' }; }
      try {
        /* C9-P1 方案 A（第二阶段收紧）：回滚必须写回快照原文。若经
           replaceAll 的 migrate 规范化（settings 白名单重建会丢弃
           fxUpdatedAt 等键、实体逐字段重建），回滚后整包哈希必然与
           恢复前不一致，下方核验永远失败、回滚永远无法完成。回滚
           只允许走 Core 的原始恢复入口 replaceAllRaw（仅传入事务
           日志内的恢复前快照）；该入口缺失时按 fail-closed 返回待
           处理状态——不写注册表/legacy、不清锁、不落 ABORTED，
           绝不退回规范化写入口凑数（第一阶段的静默 fallback 已废除，
           理由见 C9-P1 第一阶段独立审查 C.3）。 */
        if (typeof core.replaceAllRaw !== 'function') {
          return { restored: false, reason: reason + ':rollback_failed_raw_restore_unavailable' };
        }
        var snapshot = JSON.parse(JSON.stringify(rj.prevState));
        var okBack = core.replaceAllRaw(snapshot);
        if (!okBack) return pending();
        if (stateHash(core.get()) !== rj.preStateHash) return pending();
        /* R6 第二项：回滚验收只认磁盘原文，且一致性检查必须针对
           这份磁盘状态求值——不得在验完磁盘哈希后再调用默认读内存
           的 verifyConsistency 冒充磁盘验证（内存可能与磁盘分道）。 */
        var diskBack = persistedState(storage, core);
        if (!diskBack.ok || diskBack.hash !== rj.preStateHash) return pending();
        if (rj.prevRegistry == null) {
          storage.removeItem(IM.REGISTRY_KEY);
          if (storage.getItem(IM.REGISTRY_KEY) !== null) return pending();
        } else {
          writeStrict(storage, IM.REGISTRY_KEY, rj.prevRegistry);
        }
        /* R6 第三项：标记同步回滚到恢复前状态并读回验证——不得出现
           业务与注册表已回滚、标记却停在目标状态的组合。 */
        if ((rj.prevLegacyPending === 'set' || rj.prevLegacyPending === 'absent') && !writeLegacyPending(storage, rj.prevLegacyPending)) return pending();
        var vc = verifyConsistency(storage, core, diskBack.state);
        var newProblems = (vc.problems || []).filter(function (p) { return preProblems.indexOf(p) < 0; });
        if (newProblems.length) return pending();
      } catch (e) { return pending(); }
      /* 先验证清锁成功、再落 ABORTED 标记（与完成路径同一顺序）：
         清锁失败 → 日志仍 PREPARED，启动裁决按双边前态完成中止；
         落标记失败 → 重新置锁，日志仍 PREPARED 待裁决。两种残留
         组合都可收敛，不存在「已终态 + 残留锁」的死锁组合。 */
      if (!clearLock(storage)) return { restored: false, reason: reason + ':rollback_done_lock_clear_failed' };
      rj.phase = 'ABORTED';
      try { writeStrict(storage, RESTORE_JOURNAL_KEY, JSON.stringify(rj)); }
      catch (e) { setLock(storage, { batchId: rj.batchId, reason: 'restore_abort_mark_failed', at: new Date().toISOString() }); return { restored: false, reason: reason + ':abort_mark_failed' }; }
      return { restored: false, reason: reason, rolledBack: true };
    }
    /* R6 第二项：目标写入窗口由日志字段 targetWriteStarted 标记，
       该字段在 PREPARED 首次落盘时即为 true（见上方 rj 定义）：
       业务目标先落盘、日志目标哈希后刷新，两步之间中断时磁盘哈希
       与日志的两个哈希都对不上，recoverRestore 据此识别窗口并以
       三集合内容哈希验证磁盘状态是否正是本次目标（采纳路径）；
       目标哈希刷新落盘后该字段随之清为 false。 */
    api._bypass = true;
    try {
      var okState = core.replaceAllChecked(bundle.state);
      if (!okState) return abortRestore('state_persist_failed');
      /* R5 3.3 + R6 第二项：目标哈希以真实落盘状态为准——直接读
         STORE_KEY 磁盘原文（Core.replaceAll 的 migrate 与本机设置
         处理会使落盘态与 bundle.state 原文有细微差异），刷新进
         日志、清窗口标记并写后读回；任一步失败 → 中止回滚。 */
      var diskTarget = persistedState(storage, core);
      if (!diskTarget.ok) return abortRestore('persisted_state_unreadable_after_write');
      rj.targetStateHash = diskTarget.hash;
      rj.targetWriteStarted = false;
      try { writeStrict(storage, RESTORE_JOURNAL_KEY, JSON.stringify(rj)); }
      catch (e) { return abortRestore('restore_journal_update_failed'); }
      if (bundle.identityRegistry) {
        try {
          storage.setItem(IM.REGISTRY_KEY, targetRegistry);
          if (storage.getItem(IM.REGISTRY_KEY) !== targetRegistry) throw new Error('registry_verify_failed');
        } catch (e) { return abortRestore('registry_verify_failed'); }
      }
      /* R6 第三项：标记写入是恢复事务的一步，必须读回验证；失败
         即中止并由 abortRestore 把标记与双边状态一起回滚。 */
      if (!writeLegacyPending(storage, targetLegacy)) return abortRestore('legacy_pending_write_failed');
      /* 恢复后一致性验证：备份自带注册表时，业务 int_ 实体与注册表必须
         互相对应，不一致即回滚。备份不含注册表（旧格式）时恢复结果按
         定义处于 legacyPending 待回填态，一致性由回填后的 checkOnLoad
         校验兜底，此处不把已知的待迁移态误判为恢复失败。 */
      if (bundle.identityRegistry) {
        var consistency = verifyConsistency(storage, core);
        if (!consistency.consistent) return abortRestore('consistency_check_failed:' + consistency.problems[0]);
      }
      /* R3-03 顺序：先验证清锁成功、再落 COMPLETED 标记。清锁失败时
         恢复日志保持 PREPARED，启动裁决会按目标态完整将其完成，
         不报告成功、不形成死锁。 */
      if (!clearLock(storage)) return { restored: false, reason: 'lock_clear_failed' };
      rj.phase = 'COMPLETED';
      try { writeStrict(storage, RESTORE_JOURNAL_KEY, JSON.stringify(rj)); }
      catch (e) { setLock(storage, { batchId: batchId, reason: 'restore_mark_failed_after_unlock', at: new Date().toISOString() }); return { restored: false, reason: 'restore_mark_failed_after_unlock' }; }
      /* 恢复成功后使既存导入日志失效：旧批次的逆操作绝不允许作用于新恢复的数据 */
      try { writeStrict(storage, JOURNAL_KEY, JSON.stringify({ phase: 'SUPERSEDED', byRestoreAt: new Date().toISOString(), note: 'superseded_by_backup_restore' })); } catch (e) { /* 日志失效写失败不推翻已校验通过的恢复，下次加载的一致性校验会兜底 */ }
      return { restored: true, legacyPending: !bundle.identityRegistry, restoreBatchId: batchId };
    } catch (e) { return { restored: false, reason: String(e && e.message || e) }; }
    finally { api._bypass = false; }
  }

  Object.assign(api, { init: init, isLocked: isLocked, setMemLock: setMemLock, noteExternalChange: noteExternalChange, journalStatus: journalStatus, lockReason: lockReason, checkOnLoad: checkOnLoad, pendingBatch: pendingBatch,
    commitImport: commitImport, recover: recover, recoverRestore: recoverRestore, restoreJournalStatus: restoreJournalStatus, pendingRestore: pendingRestore, verifyConsistency: verifyConsistency, buildBackup: buildBackup, validateBundle: validateBundle, restoreBundle: restoreBundle,
    setLegacyPending: setLegacyPending, readLegacyPending: readLegacyPending, clearLegacyPending: clearLegacyPending,
    JOURNAL_KEY: JOURNAL_KEY, LOCK_KEY: LOCK_KEY, RESTORE_JOURNAL_KEY: RESTORE_JOURNAL_KEY, _writeStrict: writeStrict, _stateHash: stateHash, _collectionsHash: collectionsHash, _rawLockState: rawLockState, _clearLock: clearLock, _persistedState: persistedState, _legacyPendingStatus: legacyPendingStatus, _writeLegacyPending: writeLegacyPending, _idKey: idKey });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.IdentityTxn = api;
})();
