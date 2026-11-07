/* P1-23-R7：迁移兼容与单入口接管专项测试（全部虚构数据，sandbox 标记）。
   调用 assets/identity.js + assets/identity-migration.js 的真实函数；
   末尾含一段 DOM 桩启动检查（真实 Core 下 importBatchFile 与 mergeAll 并存）。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

/* ---------- 虚构数据工厂（确定性，全部标记 sandbox） ---------- */
function makeState(nP, nO, nOrd) {
  var products = [], opps = [], orders = [];
  for (var i = 0; i < nP; i++) products.push({ id: 'sbx_p' + i, title: 'Sandbox Product ' + i, model: 'SBX-' + i, category: 'SandboxCat', _sandbox: true });
  for (var j = 0; j < nO; j++) {
    var fl = [];
    for (var k = 0; k < (j % 3); k++) fl.push({ id: 'sbx_fu' + j + '_' + k, at: '2026-10-0' + ((k % 9) + 1), note: 'sandbox follow ' + k });
    opps.push({ id: 'sbx_opp' + j, buyer: { name: 'Sandbox Buyer ' + (j % 40), company: 'Sandbox Co ' + (j % 40), country: 'DE' }, rawText: 'sandbox inquiry ' + j, productName: 'Sandbox Product ' + (j % Math.max(nP, 1)), selectedProductId: 'sbx_p' + (j % Math.max(nP, 1)), matches: [{ productId: 'sbx_p' + (j % Math.max(nP, 1)) }], followLog: fl, log: [{ ts: '2026-10-01', text: 'sandbox log' }], quote: { qty: 100 + j, unit: 'pcs' }, _sandbox: true });
  }
  for (var m = 0; m < nOrd; m++) orders.push({ id: 'sbx_ord' + m, oppId: 'sbx_opp' + (m % Math.max(nO, 1)), buyerName: 'Sandbox Buyer ' + (m % 40), amountCents: 1000 + m, currency: 'USD', status: 'paid', _sandbox: true });
  return { products: products, opportunities: opps, orders: orders };
}
function anomalyState() {
  var s = makeState(3, 3, 1);
  s.opportunities.push({ id: '询盘甲', buyer: { name: '中文买家', company: '', country: '' }, rawText: 'x', followLog: [], log: [], quote: {} });
  s.opportunities.push({ id: 'id with space', buyer: { name: 'Space Buyer', company: '', country: '' }, rawText: 'x', followLog: [], log: [], quote: {} });
  /* 历史 safeId 碰撞的存量形态：两个原始 ID（buyer/A 与 buyerA）已被清洗成同一个存量 ID */
  s.opportunities.push({ id: 'buyerA', buyer: { name: 'Original Slash', company: '', country: '' }, rawText: 'x', followLog: [{ id: 'f1', at: '2026-10-01', note: 'a' }], log: [], quote: {} });
  s.opportunities.push({ id: 'buyerA', buyer: { name: 'Original Plain', company: '', country: '' }, rawText: 'x', followLog: [], log: [], quote: {} });
  s.opportunities.push({ id: 'sbx_orphan', buyer: { name: 'Orphan', company: '', country: '' }, rawText: 'x', selectedProductId: 'sbx_missing_p', matches: [], followLog: [], log: [], quote: {} });
  s.orders.push({ id: 'sbx_ord_orphan', oppId: 'sbx_missing_opp', buyerName: 'Orphan', amountCents: 1, currency: 'USD', status: 'paid' });
  return s;
}

/* ---------- 存量迁移 1-10 ---------- */
var st = makeState(100, 100, 50);
var idsBefore = JSON.stringify([st.products.map(function (p) { return p.id; }), st.opportunities.map(function (o) { return o.id; }), st.orders.map(function (o) { return o.id; })]);
var integBefore = IM.checkIntegrity(st);
var reg = ID.createRegistry();
var rep1 = IM.backfillLegacy(st, reg);
ok(rep1.bound === 250 && rep1.conflicts.length === 0, 'M01 正常存量回填 250 条映射（100 商品+100 询盘+50 订单）');
ok(JSON.stringify([st.products.map(function (p) { return p.id; }), st.opportunities.map(function (o) { return o.id; }), st.orders.map(function (o) { return o.id; })]) === idsBefore, 'M05 回填后全部内部 ID 不变');
var rep2 = IM.backfillLegacy(st, reg);
ok(rep2.bound === 0 && rep2.unchanged === 250, 'M04 重复回填幂等（0 新增、250 未变化）');
var integAfter = IM.checkIntegrity(st);
ok(integAfter.followRecords === integBefore.followRecords && integAfter.logEntries === integBefore.logEntries && integAfter.orphanSelectedProduct === 0 && integAfter.orphanOrderOpp === 0, 'M06-M09 商品引用/订单/跟进/日志关联完整且数量不变');
var regB = ID.createRegistry(); IM.backfillLegacy(makeState(5, 5, 2), regB);
ok(!!regB.byKey['legacy|local-instance|product|sbx_p0'] && !!regB.byKey['legacy|local-instance|order|sbx_ord0'], 'M02/M03 商品与订单 legacy 映射齐全');
var ast = anomalyState();
var areg = ID.createRegistry();
var arep = IM.backfillLegacy(ast, areg);
ok(arep.duplicateIds.length === 1 && arep.duplicateIds[0].id === 'buyerA', 'M10 存量同 ID 碰撞被识别登记（不自动合并）');
ok(ast.opportunities.filter(function (o) { return o.id === 'buyerA'; }).length === 2, 'M10b 碰撞双方实体原样保留、未被合并或删除');
var ainteg = IM.checkIntegrity(ast);
ok(ainteg.orphanSelectedProduct === 1 && ainteg.orphanOrderOpp === 1, 'M10c 孤立关联被检出计数（不擅自修复）');
ok(!!areg.byKey['legacy|local-instance|opportunity|询盘甲'], 'M10d 纯中文存量 ID 以原文回填 legacy 映射');

/* ---------- 备份恢复 11-16 ---------- */
var snapPre = IM.snapshot(st, ID.createRegistry());
var restoredPre = IM.restoreSnapshot(snapPre);
ok(restoredPre.state.opportunities.length === 100 && restoredPre.state.products.length === 100, 'B11 迁移前旧格式备份可恢复（无映射字段）');
var regAfterRestore = restoredPre.registry;
var repB = IM.backfillLegacy(restoredPre.state, regAfterRestore);
ok(repB.bound === 250, 'B15 旧备份缺失映射字段时可回填兼容');
var snapPost = IM.snapshot(st, reg);
var restoredPost = IM.restoreSnapshot(snapPost);
ok(Object.keys(restoredPost.registry.byKey).length === 250 && restoredPost.state.opportunities[0].id === 'sbx_opp0', 'B12 迁移后新格式备份恢复（映射与内部 ID 一致）');
var repC = IM.backfillLegacy(restoredPost.state, restoredPost.registry);
ok(repC.bound === 0 && repC.unchanged === 250, 'B13 恢复后再次迁移幂等');
/* B14 异常中断：回填一半后以快照回滚，再全量回填 → 最终一致、无半套映射残留为错位状态 */
var regHalf = ID.createRegistry();
var partial = clone(st); partial.opportunities = partial.opportunities.slice(0, 50);
IM.backfillLegacy(partial, regHalf);
var rolled = IM.restoreSnapshot(snapPre);
var repD = IM.backfillLegacy(rolled.state, rolled.registry);
ok(repD.bound === 250 && Object.keys(rolled.registry.byKey).length === 250, 'B14 中断后回滚到迁移前快照再重迁，最终状态完整一致');
/* B16 映射字段不完整：注册表里混入损坏条目 → loadRegistry 损坏 JSON 安全回退为空注册表并可回填 */
var badStorage = { _v: '{broken json', getItem: function () { return this._v; }, setItem: function (k, v) { this._v = v; } };
var regBad = IM.loadRegistry(badStorage);
ok(Object.keys(regBad.byKey).length === 0 && IM.backfillLegacy(makeState(2, 2, 1), regBad).bound === 5, 'B16 注册表损坏时安全回退（空表+可回填），不带毒继续');

/* ---------- 新导入入口 17-30 ---------- */
function buildEntity(type, content, internalId, rec) { var e = clone(rec.entity || {}); e.id = internalId; return e; }
function applyContent(ent, content) { Object.keys(content || {}).forEach(function (k) { ent[k] = content[k]; }); }
var baseState = makeState(2, 0, 0);
var baseReg = ID.createRegistry();
function batch(records, source, account) { return { source_system: source || 'alibaba_api', source_account: account || 'acct-1', records: records }; }
function oppRec(raw, qty, ver) { return { entity_type: 'opportunity', external_id_raw: raw, content: { buyerName: 'Ext Buyer', buyerCompany: 'Ext Co', productText: 'Widget', qty: qty, unit: 'pcs', destination: 'DE', rawTextHash: 'rh' }, sourceVersion: ver, entity: { buyer: { name: 'Ext Buyer', company: 'Ext Co', country: 'DE' }, rawText: 'ext', followLog: [], log: [], quote: { qty: qty } } }; }

var r17 = IM.importBatch(baseState, baseReg, batch([oppRec('RFQ-1', 100, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r17.applied && r17.results[0].status === 'CREATED' && r17.state.opportunities.length === 1, 'I17 首次导入经身份层创建实体');
var createdId = r17.state.opportunities[0].id;
ok(/^int_opportunity_/.test(createdId), 'I17b 新实体内部 ID 为系统生成（int_ 前缀），非外部 ID 派生');
var r18 = IM.importBatch(r17.state, r17.registry, batch([oppRec('RFQ-1', 100, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r18.results[0].status === 'UNCHANGED' && r18.state.opportunities.length === 1 && r18.state.opportunities[0].id === createdId, 'I18 同身份重复导入命中原内部 ID、不重复建档');
var r19 = IM.importBatch(r18.state, r18.registry, batch([oppRec('RFQ-1', 100, 1)], 'alibaba_api', 'acct-2'), { buildEntity: buildEntity, applyContent: applyContent });
ok(r19.results[0].status === 'CREATED' && r19.state.opportunities.length === 2, 'I19 不同账号相同外部 ID 不误合并');
var r20 = IM.importBatch(r19.state, r19.registry, { source_system: 'alibaba_api', source_account: 'acct-1', records: [{ entity_type: 'order', external_id_raw: 'RFQ-1', content: { buyerName: 'Ext Buyer', amountCents: 5, currency: 'USD', statusText: 'paid' }, sourceVersion: 1, entity: { buyerName: 'Ext Buyer', amountCents: 5, currency: 'USD', status: 'paid' } }] }, { buildEntity: buildEntity, applyContent: applyContent });
ok(r20.results[0].status === 'CREATED' && r20.state.orders.length === 1, 'I20 不同实体类型相同外部 ID 不误合并');
var r21 = IM.importBatch(r20.state, r20.registry, batch([oppRec('询盘乙', 10, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r21.results[0].status === 'CREATED' && r21.registry.byInternal[r21.results[0].internalId].identity.external_id_raw === '询盘乙', 'I21 中文外部 ID 原样登记');
var r22 = IM.importBatch(r21.state, r21.registry, batch([oppRec('a/b"c', 10, 1), oppRec('abc', 10, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r22.results[0].internalId !== r22.results[1].internalId && r22.state.opportunities.length === 5, 'I22/I23 特殊字符与清洗碰撞型 ID 仍是两个实体');
var r24 = IM.importBatch(r22.state, r22.registry, batch([oppRec('RFQ-1', 200, 2)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r24.results[0].status === 'UPDATED' && r24.state.opportunities[0].id === createdId, 'I24 同身份新版本更新同一实体');
var r25 = IM.importBatch(r24.state, r24.registry, batch([oppRec('RFQ-1', 50, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r25.results[0].status === 'STALE', 'I25 旧版本晚到被拒（STALE）');
var r26 = IM.importBatch(r25.state, r25.registry, batch([oppRec('RFQ-1', 999, 2)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r26.results[0].status === 'CONFLICT' && !!r26.results[0].conflictId, 'I26 同版本不同内容进冲突待处理');
var r27 = IM.importBatch(r26.state, r26.registry, { source_system: 'manual_import', source_account: 'local', records: [{ entity_type: 'opportunity', external_id_raw: 'NV-X', content: { buyerName: 'N', qty: 1 }, entity: { buyer: { name: 'N' }, followLog: [], log: [], quote: {} } }, { entity_type: 'opportunity', external_id_raw: 'NV-X', content: { buyerName: 'N', qty: 2 }, entity: { buyer: { name: 'N' }, followLog: [], log: [], quote: {} } }] }, { buildEntity: buildEntity, applyContent: applyContent });
ok(r27.results[0].status === 'CREATED' && r27.results[1].status === 'NEEDS_REVIEW', 'I27 无可靠版本依据的二次变更进 NEEDS_REVIEW 不自动覆盖');
/* I28 员工确认值保护：经 importBatchFile 等价路径在注册表上设确认后，同步新版本不得覆盖确认值 */
var regState28 = r24.registry, state28 = r24.state;
ID.setConfirmation(regState28, createdId, { qty: 200 }, 'test-operator', regState28.byInternal[createdId].contentHash);
var r28 = IM.importBatch(state28, regState28, batch([oppRec('RFQ-1', 300, 3)]), { buildEntity: buildEntity, applyContent: applyContent });
ok(r28.results[0].status === 'UPDATED' && r28.results[0].confirmationReview === true && r28.registry.byInternal[createdId].confirmedValue.fields.qty === 200, 'I28 同步更新不覆盖员工确认值且提示复核');
/* I29 新路径中途失败：buildEntity 第二条抛错 → 整批不落盘 */
var stateBefore29 = JSON.stringify(r28.state), regBefore29 = ID.exportState(r28.registry);
var r29 = IM.importBatch(r28.state, r28.registry, batch([oppRec('OK-1', 1, 1), oppRec('BOOM-1', 1, 1)]), { buildEntity: function (t, c, iid, rec) { if (rec.external_id_raw === 'BOOM-1') throw new Error('factory boom'); return buildEntity(t, c, iid, rec); }, applyContent: applyContent });
ok(r29.applied === false && JSON.stringify(r28.state) === stateBefore29 && ID.exportState(r28.registry) === regBefore29, 'I29 新路径中途失败整批回滚、无半写入、映射不残留');
/* I30 回退后再次导入：失败批次修正后重跑成功且不重复；旧 mergeAll 仍在（函数存在性在下方启动检查验证） */
var r30 = IM.importBatch(r28.state, r28.registry, batch([oppRec('OK-1', 1, 1), oppRec('BOOM-1', 1, 1)]), { buildEntity: buildEntity, applyContent: applyContent });
var okCount = r30.state.opportunities.filter(function (o) { return o.id === r30.results[0].internalId; }).length;
ok(r30.applied && r30.results.every(function (x) { return x.status === 'CREATED'; }) && okCount === 1, 'I30 失败批次修正后重跑成功、无重复实体');

/* ---------- 启动检查：真实 Core 下两条路径并存 ---------- */
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
    var C = sandbox.Core, IMW = sandbox.IdentityMigration;
    ok(typeof C.mergeAll === 'function' && typeof IMW.importBatchFile === 'function', 'I30b 旧 mergeAll 完整保留且身份层接管函数就位');
    var fileObj = { identityBatch: true, source_system: 'alibaba_api', source_account: 'acct-9', records: [{ entity_type: 'opportunity', external_id_raw: 'BOOT-1', content: { buyerName: 'Boot Buyer', productText: 'W', qty: 3 }, sourceVersion: 1, entity: { buyer: { name: 'Boot Buyer', company: '', country: '' }, rawText: 'boot', followLog: [], log: [], quote: {} } }] };
    var opts = { buildEntity: function (t, c, iid, rec) { var e = JSON.parse(JSON.stringify(rec.entity)); e.id = iid; return e; }, applyContent: function () {} };
    var res1 = IMW.importBatchFile(C, fileObj, sandbox.localStorage, opts);
    var after1 = C.get().opportunities.filter(function (o) { return o.id.indexOf('int_opportunity_') === 0; });
    var res2 = IMW.importBatchFile(C, fileObj, sandbox.localStorage, opts);
    ok(res1.applied && after1.length === 1 && res2.counts.UNCHANGED === 1 && C.get().opportunities.filter(function (o) { return o.id.indexOf('int_opportunity_') === 0; }).length === 1, 'I30c 真实 Core 下新入口落盘且重复导入幂等（replaceAll 规范化未破坏 int_ 内部 ID）');
    console.log('== identity-migration: ' + pass + ' passed, ' + fail + ' failed ==');
    process.exit(fail ? 1 : 0);
  }, 150);
})();
