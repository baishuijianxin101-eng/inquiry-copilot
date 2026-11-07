/* P1-23-R7 迁移兼容层（独立模块，依赖 assets/identity.js）
 *
 * 职责：存量实体 legacy 身份回填、关联完整性检查、迁移快照/回滚、
 * 以及「导入数据」单入口的身份层接管（importBatch / importBatchFile）。
 *
 * 关键约定：
 * - legacy 映射的 external_id_raw = 存量实体当前的内部 ID 原文，
 *   它不是、也不冒充恢复出的阿里原始 ID（历史 safeId 已丢失的信息无法恢复）；
 * - 回填只写映射注册表，绝不改业务实体、绝不改内部 ID、绝不自动合并实体；
 * - 存量同 ID 重复（历史清洗碰撞的幸存形态）只登记审计、标记待人工判断；
 * - importBatch 在隔离副本上完成全部写入，成功后整体替换（copy-swap）；
 *   失败即丢弃副本，业务数据与注册表保持原状，不存在半写入；
 * - 注册表独立持久化于 localStorage 键 ic_identity_registry_v1，
 *   不进 Core 状态（避免被 migrate 的字段白名单裁掉）。 */
(function () {
  'use strict';
  var Identity = (typeof window !== 'undefined' && window.Identity) || (typeof module !== 'undefined' ? require('./identity.js') : null);
  var REGISTRY_KEY = 'ic_identity_registry_v1';
  var LEGACY_SOURCE = 'legacy';
  var LEGACY_ACCOUNT = 'local-instance';

  function legacyIdentity(entityType, entity) {
    return { source_system: LEGACY_SOURCE, source_account: LEGACY_ACCOUNT, entity_type: entityType, external_id_raw: String(entity && entity.id) };
  }
  function legacyContent(entityType, e) {
    if (entityType === 'opportunity') return { buyerName: (e.buyer && e.buyer.name) || '', buyerCompany: (e.buyer && e.buyer.company) || '', productText: e.productName || '', qty: (e.quote && e.quote.qty) || undefined, unit: (e.quote && e.quote.unit) || '', destination: (e.buyer && e.buyer.country) || '', rawTextHash: e.rawText ? 'len:' + String(e.rawText).length : '' };
    if (entityType === 'product') return { title: e.title || '', model: e.model || '', category: e.category || '' };
    if (entityType === 'order') return { buyerName: e.buyerName || '', amountCents: e.amountCents != null ? e.amountCents : undefined, currency: e.currency || '', statusText: e.status || '' };
    return {};
  }

  var COLLECTIONS = [['products', 'product'], ['opportunities', 'opportunity'], ['orders', 'order']];

  /* 存量回填：只写注册表。重复 ID 登记审计（duplicateIds），不合并、不拆分、不改实体。 */
  function backfillLegacy(state, registry) {
    var report = { bound: 0, unchanged: 0, conflicts: [], duplicateIds: [], nonStringIds: [], invalidRecords: [], perType: {} };
    COLLECTIONS.forEach(function (pair) {
      var list = Array.isArray(state[pair[0]]) ? state[pair[0]] : [];
      var type = pair[1], seen = Object.create(null); /* R5 6.1：实体 ID 可能是 'toString'/'__proto__' 等原型键，普通对象会误判已见或吞赋值 */
      report.perType[type] = { total: list.length, bound: 0, unchanged: 0, duplicates: 0 };
      list.forEach(function (e, idx) {
        /* R7 第五项：无法安全绑定的记录不得静默跳过。旧实现
           `!e || e.id == null` 把非对象记录、缺失/null/undefined
           ID 全部无声丢弃，空字符串 ID 还会进入绑定流程。现逐条
           分类进 invalidRecords（带集合内下标作稳定定位），每条
           异常只报告一次；不生成内部 ID、不改原始数据。数字等
           非字符串 ID 仍走 nonStringIds（R6 口径不变）。 */
        if (!e || typeof e !== 'object' || Array.isArray(e)) { report.invalidRecords.push({ entity_type: type, index: idx, idState: 'non_object', note: '记录不是对象：未绑定，待人工复核' }); report.perType[type].invalid = (report.perType[type].invalid || 0) + 1; return; }
        if (!('id' in e)) { report.invalidRecords.push({ entity_type: type, index: idx, idState: 'missing', note: 'ID 字段缺失：未绑定，待人工复核' }); report.perType[type].invalid = (report.perType[type].invalid || 0) + 1; return; }
        if (e.id === undefined) { report.invalidRecords.push({ entity_type: type, index: idx, idState: 'undefined', note: 'ID 为 undefined：未绑定，待人工复核' }); report.perType[type].invalid = (report.perType[type].invalid || 0) + 1; return; }
        if (e.id === null) { report.invalidRecords.push({ entity_type: type, index: idx, idState: 'null', note: 'ID 为 null：未绑定，待人工复核' }); report.perType[type].invalid = (report.perType[type].invalid || 0) + 1; return; }
        if (typeof e.id === 'string' && e.id === '') { report.invalidRecords.push({ entity_type: type, index: idx, idState: 'empty_string', id: '', note: 'ID 为空字符串：未绑定，待人工复核' }); report.perType[type].invalid = (report.perType[type].invalid || 0) + 1; return; }
        /* R6 第五项：非字符串 ID 不做静默 String() 合并——数字 123
           与字符串 '123' 是两个不同存量 ID，绑定规则未定前不绑定、
           不改 ID，逐个列入 nonStringIds 交人工复核。 */
        if (typeof e.id !== 'string') {
          report.nonStringIds.push({ entity_type: type, id: e.id, idType: typeof e.id, note: '存量非字符串 ID：未绑定、未转换，待人工复核' });
          report.perType[type].nonString = (report.perType[type].nonString || 0) + 1;
          return;
        }
        if (seen[e.id]) {
          report.duplicateIds.push({ entity_type: type, id: e.id, note: '存量同 ID 重复：历史身份已不可恢复，待人工判断，未自动合并/拆分' });
          report.perType[type].duplicates += 1;
          return;
        }
        seen[e.id] = true;
        var res = Identity.registerExisting(registry, legacyIdentity(type, e), String(e.id), legacyContent(type, e));
        if (res.status === 'BOUND') { report.bound += 1; report.perType[type].bound += 1; }
        else if (res.status === 'UNCHANGED') { report.unchanged += 1; report.perType[type].unchanged += 1; }
        else if (res.status === 'CONFLICT') report.conflicts.push({ entity_type: type, id: e.id, conflictId: res.conflictId });
      });
    });
    return report;
  }

  /* R6 第五项：类型感知 ID 键。数字 123 与字符串 '123' 在对象键
     上会被静默合并，完整性检查必须按类型区分；非字符串实体 ID
     另行列入 nonStringIds 报告，不静默吞掉。 */
  function tidKey(id) { return (typeof id === 'string' ? 's:' : typeof id === 'number' ? 'n:' : 'x:') + String(id); }

  /* 关联完整性：只检查计数，不修复。 */
  function checkIntegrity(state) {
    var pIds = Object.create(null), oIds = Object.create(null); /* R5 6.1：同上，原型安全 */
    (state.products || []).forEach(function (p) { pIds[tidKey(p.id)] = true; });
    (state.opportunities || []).forEach(function (o) { oIds[tidKey(o.id)] = true; });
    var r = { products: (state.products || []).length, opportunities: (state.opportunities || []).length, orders: (state.orders || []).length,
      followRecords: 0, logEntries: 0, orphanSelectedProduct: 0, orphanMatchProduct: 0, orphanOrderOpp: 0, duplicateIds: [], nonStringIds: [], typeAnomalies: [] };
    var seen = Object.create(null);
    function noteNonString(coll, e) { if (e && e.id != null && typeof e.id !== 'string') r.nonStringIds.push({ collection: coll, id: e.id, idType: typeof e.id }); }
    /* R7 第六项：关联引用不得再用 truthy 判断——空字符串与数字 0
       都会被 `if (ref && ...)` 静默跳过。现明确区分：字段缺失/
       undefined/null 视为未设置（业务结构允许缺失，不报）；非字符
       串值（含数字 0）进 typeAnomalies 类型异常报告（不与字符串
       '0' 合并、不做引用匹配）；字符串（含空串）按 tidKey 查
       目标集合，不存在即孤儿引用。 */
    function refCheck(coll, e, field, value, idMap, orphanKey) {
      if (value === undefined || value === null) return;
      if (typeof value !== 'string') { r.typeAnomalies.push({ collection: coll, entityId: e ? e.id : undefined, field: field, valueType: Array.isArray(value) ? 'array' : typeof value, value: typeof value === 'number' ? value : undefined, note: '关联 ID 非字符串：未做引用匹配，待人工复核' }); return; }
      if (!idMap[tidKey(value)]) r[orphanKey] += 1;
    }
    (state.opportunities || []).forEach(function (o) {
      noteNonString('opportunities', o);
      if (seen['o|' + tidKey(o.id)]) r.duplicateIds.push({ entity_type: 'opportunity', id: o.id });
      seen['o|' + tidKey(o.id)] = true;
      r.followRecords += (o.followLog || []).length;
      r.logEntries += (o.log || []).length;
      refCheck('opportunities', o, 'selectedProductId', o.selectedProductId, pIds, 'orphanSelectedProduct');
      (o.matches || []).forEach(function (m) { if (m) refCheck('opportunities', o, 'matches.productId', m.productId, pIds, 'orphanMatchProduct'); });
    });
    (state.orders || []).forEach(function (od) { noteNonString('orders', od); refCheck('orders', od, 'oppId', od.oppId, oIds, 'orphanOrderOpp'); });
    (state.products || []).forEach(function (p) { noteNonString('products', p); if (seen['p|' + tidKey(p.id)]) r.duplicateIds.push({ entity_type: 'product', id: p.id }); seen['p|' + tidKey(p.id)] = true; });
    return r;
  }

  function snapshot(state, registry) {
    return { state: JSON.parse(JSON.stringify(state)), registry: Identity.exportState(registry), at: new Date().toISOString() };
  }
  function restoreSnapshot(snap) {
    return { state: JSON.parse(JSON.stringify(snap.state)), registry: Identity.importState(snap.registry) };
  }

  /* R4 第三项：注册表读取三态必须可区分——不存在(absent) / 正常(ok) /
     损坏或不可读(corrupt)。loadRegistry 为兼容既有调用方仍返回注册表
     对象，但损坏时返回的空表带有 registryLoadState='corrupt' 标记，
     且 importState 的结构校验失败同样判 corrupt，不再与 absent 混同。
     事务入口（commitImport / importBatchFile / verifyConsistency /
     checkOnLoad）必须查询 loadRegistryStatus 并在 corrupt 时阻断，
     不得把损坏注册表当作空注册表继续导入；唯一允许在 corrupt 上继续
     的操作是用户显式触发的 legacy 回填（从业务状态重建映射）与
     备份恢复（由备份内容整体替换注册表）。 */
  function loadRegistry(storage) {
    var raw;
    try { raw = storage.getItem(REGISTRY_KEY); } catch (e) {
      var rErr = Identity.createRegistry(); rErr.registryLoadState = 'corrupt'; return rErr;
    }
    if (raw === null || raw === undefined) {
      var rAbs = Identity.createRegistry(); rAbs.registryLoadState = 'absent'; return rAbs;
    }
    try {
      var reg = Identity.importState(raw);
      reg.registryLoadState = 'ok';
      return reg;
    } catch (e) {
      var rBad = Identity.createRegistry(); rBad.registryLoadState = 'corrupt'; return rBad;
    }
  }
  function loadRegistryStatus(storage) {
    var raw;
    try { raw = storage.getItem(REGISTRY_KEY); } catch (e) { return 'corrupt'; }
    if (raw === null || raw === undefined) return 'absent';
    try { Identity.importState(raw); return 'ok'; } catch (e) { return 'corrupt'; }
  }
  function saveRegistry(storage, registry) { storage.setItem(REGISTRY_KEY, Identity.exportState(registry)); }

  /* 身份层导入：batch = { source_system, source_account, records: [{entity_type, external_id_raw, content, sourceVersion?, sourceUpdatedAt?, entity}] }
     opts = { buildEntity(type, content, internalId, record) -> entity, applyContent(entity, content, record), collections: {opportunity:'opportunities',...} }
     在副本上执行；任一异常 → { applied:false } 且原 state/registry 不动。 */
  function importBatch(state, registry, batch, opts) {
    opts = opts || {};
    var coll = opts.collections || { opportunity: 'opportunities', product: 'products', order: 'orders' };
    var workState, workReg;
    try {
      workState = JSON.parse(JSON.stringify(state));
      workReg = Identity.importState(Identity.exportState(registry));
      var results = [];
      (batch.records || []).forEach(function (rec) {
        var idn = { source_system: batch.source_system, source_account: batch.source_account, entity_type: rec.entity_type, external_id_raw: rec.external_id_raw };
        var res = Identity.importRecord(workReg, { identity: idn, content: rec.content || {}, sourceVersion: rec.sourceVersion, sourceUpdatedAt: rec.sourceUpdatedAt });
        var out = { status: res.status, internalId: res.internalId || null, external_id_raw: rec.external_id_raw, entity_type: rec.entity_type };
        if (res.status === 'CREATED') {
          /* R4 第四/五项：CREATED 必须真的产生业务实体，且新内部 ID 不得
             与业务集合中既有 ID 冲突。构建不出实体或 ID 已被占用 →
             抛错使整批失败，绝不留下「注册表有映射、业务无实体」。 */
          if (!opts.buildEntity) throw new Error('created_entity_builder_missing:' + rec.external_id_raw);
          var ent = opts.buildEntity(rec.entity_type, rec.content || {}, res.internalId, rec);
          if (!ent) throw new Error('created_entity_missing:' + rec.external_id_raw);
          ent.id = res.internalId;
          var target = (workState[coll[rec.entity_type]] = workState[coll[rec.entity_type]] || []);
          for (var ci = 0; ci < target.length; ci++) if (target[ci].id === res.internalId) throw new Error('internal_id_conflict_with_state:' + res.internalId);
          target.push(ent);
        } else if (res.status === 'UPDATED') {
          /* R4 第四项：UPDATED 必须命中业务集合中有且仅有一个对应实体。
             找不到（注册表单边更新）或找到多个（重复 ID 无法确定归属）
             → 抛错使整批失败，副本整体丢弃，任何一边都不提交。 */
          if (!opts.applyContent) throw new Error('updated_apply_missing:' + rec.external_id_raw);
          var list = workState[coll[rec.entity_type]] || [];
          var hits = [];
          for (var i = 0; i < list.length; i++) if (list[i].id === res.internalId) hits.push(i);
          if (hits.length === 0) throw new Error('updated_entity_missing:' + res.internalId + ':' + rec.external_id_raw);
          if (hits.length > 1) throw new Error('updated_entity_duplicate:' + res.internalId + ':count=' + hits.length);
          opts.applyContent(list[hits[0]], rec.content || {}, rec);
        }
        if (res.conflictId) out.conflictId = res.conflictId;
        if (res.confirmationReview) out.confirmationReview = true;
        results.push(out);
      });
      return { applied: true, state: workState, registry: workReg, results: results };
    } catch (err) {
      return { applied: false, error: String(err && err.message || err) };
    }
  }

  /* R5 第二项：importBatchFile 不再自行落盘。旧实现先 Core.replaceAll()
     再 saveRegistry()，是两次无事务的独立写入：业务落盘失败被 Core
     吞掉时上层无感、注册表写抛错时业务已换新，两个方向的不一致都
     真实存在，且无 journal、无锁、无崩溃恢复（R7-R1 审查已证实）。
     全站真实导入落盘只有一条事务路径：IdentityTxn.commitImport
     （journal + 锁 + 写后读回 + recover 回滚），app.js 合并导入走的
     正是它。本函数保留签名供既有调用与测试使用，但只做委托：
     事务层不可用时明确拒绝执行真实写入，绝不退回旧双写逻辑，
     杜绝任何绕过事务的导入入口。 */
  function txnLayer() {
    if (typeof window !== 'undefined' && window.IdentityTxn) return window.IdentityTxn;
    if (typeof module !== 'undefined' && module.exports) { try { return require('./identity-txn.js'); } catch (e) { return null; } }
    return null;
  }
  function importBatchFile(Core, fileObj, storage, opts) {
    /* 注册表损坏时拒绝导入，绝不把损坏降级成空表后继续。 */
    if (loadRegistryStatus(storage) === 'corrupt') return { applied: false, error: 'registry_corrupt' };
    var TXN = txnLayer();
    if (!TXN || typeof TXN.commitImport !== 'function') return { applied: false, error: 'transaction_layer_unavailable' };
    var r = TXN.commitImport({ storage: storage, core: Core, batch: fileObj, opts: opts || {} });
    if (!r.applied) return { applied: false, error: r.reason || r.error || 'transaction_failed', stage: r.stage || null, locked: !!r.locked, legacyPending: !!r.legacyPending };
    return { applied: true, counts: r.counts, results: r.results, batchId: r.batchId, via: 'identity_txn' };
  }

  /* 历史重复内部 ID 审计（只读）：为每个同 ID 实体组生成人工裁决证据包。
     绝不合并、绝不改 ID、绝不按数组位置或首命中猜测归属；引用该 ID 的关联
     只能报告"指向该 ID"，无法区分指向组内哪一个实体时如实标注 ambiguous。 */
  function auditDuplicateIds(state) {
    var packs = [];
    COLLECTIONS.forEach(function (pair) {
      var list = Array.isArray(state[pair[0]]) ? state[pair[0]] : [];
      var groups = Object.create(null); /* R5 6.1：ID 为 '__proto__' 时普通对象分组会拿到 Object.prototype 并在其上 push 抛错 */
      list.forEach(function (e, idx) { if (e && e.id != null) { (groups[e.id] = groups[e.id] || []).push({ index: idx, entity: e }); } });
      Object.keys(groups).forEach(function (id) {
        if (groups[id].length < 2) return;
        var members = groups[id].map(function (g) {
          return { index: g.index, id: id, buyerName: (g.entity.buyer && g.entity.buyer.name) || g.entity.buyerName || '', title: g.entity.title || '', createdAt: g.entity.createdAt || '', followRecords: (g.entity.followLog || []).length, logEntries: (g.entity.log || []).length, rawTextHead: String(g.entity.rawText || '').slice(0, 60) };
        });
        var refs = 0;
        (state.opportunities || []).forEach(function (o) { if (o.selectedProductId === id) refs++; (o.matches || []).forEach(function (m) { if (m && m.productId === id) refs++; }); });
        (state.orders || []).forEach(function (od) { if (od.oppId === id) refs++; });
        packs.push({ entity_type: pair[1], id: id, count: groups[id].length, members: members, inboundReferences: refs, referenceAttribution: refs ? 'ambiguous：引用只指向 ID，无法区分组内实体' : 'none', action: 'NEEDS_HUMAN_DECISION', autoMerged: false });
      });
    });
    return packs;
  }

  var api = { backfillLegacy: backfillLegacy, checkIntegrity: checkIntegrity, auditDuplicateIds: auditDuplicateIds, snapshot: snapshot, restoreSnapshot: restoreSnapshot,
    loadRegistry: loadRegistry, loadRegistryStatus: loadRegistryStatus, saveRegistry: saveRegistry, importBatch: importBatch, importBatchFile: importBatchFile,
    legacyIdentity: legacyIdentity, REGISTRY_KEY: REGISTRY_KEY, LEGACY_SOURCE: LEGACY_SOURCE, LEGACY_ACCOUNT: LEGACY_ACCOUNT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.IdentityMigration = api;
})();
