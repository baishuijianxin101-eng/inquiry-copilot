/* P1-23-R6：身份映射层专项测试（全部虚构数据，直接调用 assets/identity.js）。 */
'use strict';
var ID = require('../assets/identity.js');
var pass = 0, fail = 0;
function ok(cond, name, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
var ALI = 'alibaba_api', MAN = 'manual_import';
function idn(source, account, type, raw) { return { source_system: source, source_account: account, entity_type: type, external_id_raw: raw }; }
function oppContent(qty) { return { buyerName: 'Fictional Buyer', buyerCompany: 'Fictional Co', productText: 'Fictional Widget X1', qty: qty, unit: 'pcs', destination: 'Hamburg', rawTextHash: 'rh-1' }; }

/* 1 两个不同外部 ID 清洗后相同（buyer/A vs buyerA）→ 不同内部实体 */
var r = ID.createRegistry();
var a1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'buyer/A'), content: oppContent(100), sourceVersion: 1 });
var a2 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'buyerA'), content: oppContent(100), sourceVersion: 1 });
ok(a1.status === 'CREATED' && a2.status === 'CREATED' && a1.internalId !== a2.internalId, 'T01 清洗后相同的不同外部 ID 仍是两个实体');

/* 2 两个账号相同询盘 ID → 不合并 */
var b1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', '17379911544'), content: oppContent(5), sourceVersion: 1 });
var b2 = ID.importRecord(r, { identity: idn(ALI, 'acct-2', 'opportunity', '17379911544'), content: oppContent(5), sourceVersion: 1 });
ok(b1.internalId !== b2.internalId, 'T02 不同账号相同外部 ID 不误合并');

/* 3 同账号询盘 ID 与订单 ID 相同 → 类型区分 */
var c1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'order', '17379911544'), content: { buyerName: 'Fictional Buyer', amountCents: 500, currency: 'USD', statusText: 'paid' }, sourceVersion: 1 });
ok(c1.status === 'CREATED' && c1.internalId !== b1.internalId, 'T03 同账号同号不同实体类型不冲突');

/* 4 同一外部身份重复导入 → UNCHANGED 且内部 ID 不变、无重复实体 */
var d1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(800), sourceVersion: 1 });
var keysBefore = Object.keys(r.byKey).length;
var d2 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(800), sourceVersion: 1 });
ok(d2.status === 'UNCHANGED' && d2.internalId === d1.internalId && Object.keys(r.byKey).length === keysBefore, 'T04 重复导入幂等（UNCHANGED）');

/* 5 新版本更新 → UPDATED、同一内部 ID、内容更新 */
var e1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(1000), sourceVersion: 2 });
ok(e1.status === 'UPDATED' && e1.internalId === d1.internalId && r.byInternal[d1.internalId].content.qty === 1000, 'T05 新版本更新同一实体');

/* 6 旧版本晚到 → STALE、不覆盖 */
var f1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(1), sourceVersion: 1 });
ok(f1.status === 'STALE' && r.byInternal[d1.internalId].content.qty === 1000, 'T06 旧版本晚到不覆盖新数据');

/* 7 同版本不同内容 → CONFLICT + 冲突记录 */
var g1 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(555), sourceVersion: 2 });
ok(g1.status === 'CONFLICT' && !!g1.conflictId && r.byInternal[d1.internalId].content.qty === 1000, 'T07 同版本不同内容进冲突且不覆盖');

/* 8 来源版本缺失（无版本号无更新时间）且内容不同 → NEEDS_REVIEW */
var r8 = ID.createRegistry();
ID.importRecord(r8, { identity: idn(MAN, 'local', 'opportunity', 'NV-1'), content: oppContent(10) });
var h2 = ID.importRecord(r8, { identity: idn(MAN, 'local', 'opportunity', 'NV-1'), content: oppContent(20) });
ok(h2.status === 'NEEDS_REVIEW', 'T08 无可靠版本依据时不擅自更新（NEEDS_REVIEW）');

/* 9 同一客户多个询盘（同一买家外部身份）→ 买家身份同一、询盘各自独立 */
var r9 = ID.createRegistry();
var by1 = ID.importRecord(r9, { identity: idn(ALI, 'acct-1', 'buyer', 'BUYER-77'), content: { displayName: 'Same Name', company: 'Same Co' }, sourceVersion: 1 });
var o91 = ID.importRecord(r9, { identity: idn(ALI, 'acct-1', 'opportunity', 'INQ-1'), content: oppContent(1), sourceVersion: 1 });
var o92 = ID.importRecord(r9, { identity: idn(ALI, 'acct-1', 'opportunity', 'INQ-2'), content: oppContent(2), sourceVersion: 1 });
var by2 = ID.importRecord(r9, { identity: idn(ALI, 'acct-1', 'buyer', 'BUYER-77'), content: { displayName: 'Same Name', company: 'Same Co' }, sourceVersion: 1 });
ok(by2.status === 'UNCHANGED' && by2.internalId === by1.internalId && o91.internalId !== o92.internalId, 'T09 同一买家身份稳定、多个询盘独立');

/* 10 不同客户名称相同（不同买家原始 ID）→ 不合并 */
var by3 = ID.importRecord(r9, { identity: idn(ALI, 'acct-1', 'buyer', 'BUYER-88'), content: { displayName: 'Same Name', company: 'Same Co' }, sourceVersion: 1 });
ok(by3.internalId !== by1.internalId, 'T10 同名不同买家 ID 不合并');

/* 11 外部 ID 缺失 → INVALID、不建映射、不随机生成 */
var r11 = ID.createRegistry();
var i1 = ID.importRecord(r11, { identity: idn(ALI, 'acct-1', 'opportunity', ''), content: oppContent(1), sourceVersion: 1 });
ok(i1.status === 'INVALID' && Object.keys(r11.byKey).length === 0, 'T11 外部 ID 缺失拒绝建正式映射');

/* 12 外部 ID 纯中文 → 原样保留、重复导入命中同一实体 */
var r12 = ID.createRegistry();
var j1 = ID.importRecord(r12, { identity: idn(MAN, 'local', 'opportunity', '询盘甲'), content: oppContent(3), sourceVersion: 1 });
var j2 = ID.importRecord(r12, { identity: idn(MAN, 'local', 'opportunity', '询盘甲'), content: oppContent(3), sourceVersion: 1 });
ok(j1.status === 'CREATED' && j2.status === 'UNCHANGED' && j2.internalId === j1.internalId && r12.byInternal[j1.internalId].identity.external_id_raw === '询盘甲', 'T12 纯中文外部 ID 身份稳定');

/* 13 外部 ID 含特殊字符 → 原样保留且与近似串区分 */
var r13 = ID.createRegistry();
var k1 = ID.importRecord(r13, { identity: idn(ALI, 'acct-1', 'opportunity', 'a/b"c<d>'), content: oppContent(1), sourceVersion: 1 });
var k2 = ID.importRecord(r13, { identity: idn(ALI, 'acct-1', 'opportunity', 'abcd'), content: oppContent(1), sourceVersion: 1 });
ok(k1.internalId !== k2.internalId && r13.byInternal[k1.internalId].identity.external_id_raw === 'a/b"c<d>', 'T13 特殊字符外部 ID 原样保留不碰撞');

/* 14 手动导入与 API 同步同到（不同来源系统）→ 各自建实体、只提示疑似重复不合并 */
var r14 = ID.createRegistry();
var l1 = ID.importRecord(r14, { identity: idn(MAN, 'local', 'opportunity', 'EXT-9'), content: oppContent(7), sourceVersion: 1 });
var l2 = ID.importRecord(r14, { identity: idn(ALI, 'acct-1', 'opportunity', 'EXT-9'), content: oppContent(7), sourceVersion: 1 });
ok(l1.internalId !== l2.internalId && ID.findPossibleDuplicates(r14).length === 1, 'T14 跨来源不自动合并、疑似重复可提示');

/* 15 员工修正与 API 更新冲突 → 确认值不被覆盖、产生复核事件、展示仍用确认值 */
var r15 = ID.createRegistry();
var m1 = ID.importRecord(r15, { identity: idn(ALI, 'acct-1', 'opportunity', 'CF-1'), content: oppContent(800), sourceVersion: 1 });
ID.setConfirmation(r15, m1.internalId, { qty: 800 }, 'test-operator', r15.byInternal[m1.internalId].contentHash);
var m2 = ID.importRecord(r15, { identity: idn(ALI, 'acct-1', 'opportunity', 'CF-1'), content: oppContent(1200), sourceVersion: 2 });
var ent15 = r15.byInternal[m1.internalId];
ok(m2.status === 'UPDATED' && m2.confirmationReview === true && ent15.confirmedValue.fields.qty === 800 && ID.displayValue(ent15).qty === 800 && r15.reviewEvents.length === 1, 'T15 同步不覆盖员工确认值且生成复核事件');

/* 16 冲突人工确认后重放同一事件 → 不重复建冲突 */
var before16 = r.conflicts.length;
var g2 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(555), sourceVersion: 2 });
ID.resolveConflict(r, g1.conflictId, 'keep_existing', 'test-operator');
var g3 = ID.importRecord(r, { identity: idn(ALI, 'acct-1', 'opportunity', 'RFQ-100'), content: oppContent(555), sourceVersion: 2 });
ok(g2.conflictId === g1.conflictId && g3.conflictId === g1.conflictId && r.conflicts.length === before16, 'T16 冲突重放不重复创建、处理结果可追溯');

/* 17 备份恢复后再次导入 → 命中原映射（UNCHANGED） */
var snap = ID.exportState(r15);
var r17 = ID.importState(snap);
var n1 = ID.importRecord(r17, { identity: idn(ALI, 'acct-1', 'opportunity', 'CF-1'), content: oppContent(1200), sourceVersion: 2 });
ok(n1.status === 'UNCHANGED' && n1.internalId === m1.internalId, 'T17 备份恢复后映射完整、重复导入幂等');

/* 18 商品身份映射 */
var r18 = ID.createRegistry();
var p1 = ID.importRecord(r18, { identity: idn(ALI, 'acct-1', 'product', 'SKU/001'), content: { title: 'Fictional Widget', model: 'X1', category: 'FPV' }, sourceVersion: 1 });
var p2 = ID.importRecord(r18, { identity: idn(ALI, 'acct-2', 'product', 'SKU/001'), content: { title: 'Fictional Widget', model: 'X1', category: 'FPV' }, sourceVersion: 1 });
ok(p1.status === 'CREATED' && p2.internalId !== p1.internalId, 'T18 商品身份按账号隔离');

/* 19 订单身份映射 */
var od1 = ID.importRecord(r18, { identity: idn(ALI, 'acct-1', 'order', 'ORD#2026-1'), content: { buyerName: 'FB', amountCents: 100, currency: 'USD', statusText: 'paid' }, sourceVersion: 1 });
var od2 = ID.importRecord(r18, { identity: idn(ALI, 'acct-1', 'order', 'ORD#2026-1'), content: { buyerName: 'FB', amountCents: 100, currency: 'USD', statusText: 'paid' }, sourceVersion: 1 });
ok(od2.status === 'UNCHANGED' && od2.internalId === od1.internalId, 'T19 订单身份映射与幂等');

/* 20 三类实体相同字符串 → 类型隔离 */
var r20 = ID.createRegistry();
var s1 = ID.importRecord(r20, { identity: idn(ALI, 'acct-1', 'opportunity', 'SAME-STR'), content: oppContent(1), sourceVersion: 1 });
var s2 = ID.importRecord(r20, { identity: idn(ALI, 'acct-1', 'product', 'SAME-STR'), content: { title: 'T', model: 'M', category: 'C' }, sourceVersion: 1 });
var s3 = ID.importRecord(r20, { identity: idn(ALI, 'acct-1', 'order', 'SAME-STR'), content: { buyerName: 'B', amountCents: 1, currency: 'USD', statusText: 'x' }, sourceVersion: 1 });
ok(new Set([s1.internalId, s2.internalId, s3.internalId]).size === 3, 'T20 相同字符串三类实体互不共用');

/* 21 规范化版本升级（canon-v1 → v2）→ 内容等价不误判更新 */
var r21 = ID.createRegistry();
var u1 = ID.importRecord(r21, { identity: idn(ALI, 'acct-1', 'opportunity', 'CV-1'), content: Object.assign(oppContent(9), { rawTextHash: 'rh-1' }), sourceVersion: 1 });
r21.canonVersion = 'canon-v2';
var u2 = ID.importRecord(r21, { identity: idn(ALI, 'acct-1', 'opportunity', 'CV-1'), content: Object.assign(oppContent(9), { rawTextHash: 'rh-1' }), sourceVersion: 1 });
ok(u2.status === 'UNCHANGED' && u2.note === 'canon_upgraded', 'T21 规范化版本升级不误判内容变化');

/* 22 同一外部身份试图映射到两个内部实体 → CONFLICT */
var bind1 = ID.bindAdditionalIdentity(r, a2.internalId, idn(ALI, 'acct-1', 'opportunity', 'buyer/A'), 'test-operator');
ok(bind1.status === 'CONFLICT' && !!bind1.conflictId, 'T22 一个外部身份不得映射两个内部实体');

/* 23 一个内部实体绑定同来源第二个不同原始 ID → CONFLICT 待人工确认 */
var bind2 = ID.bindAdditionalIdentity(r, a1.internalId, idn(ALI, 'acct-1', 'opportunity', 'buyer/ZZZ'), 'test-operator');
ok(bind2.status === 'CONFLICT' && !!bind2.conflictId, 'T23 同来源双原始 ID 绑定同一实体必须人工确认');

/* 24 不完整身份（缺来源账号）→ NEEDS_REVIEW 待处理、不建正式映射 */
var r24 = ID.createRegistry();
var w1 = ID.importRecord(r24, { identity: idn(ALI, '', 'opportunity', 'X-1'), content: oppContent(1), sourceVersion: 1 });
ok(w1.status === 'NEEDS_REVIEW' && Object.keys(r24.byKey).length === 0 && r24.conflicts.length === 1, 'T24 缺账号进待处理状态、不跨账号猜测');

/* 哈希规范化基本性质：键序无关、缺失与 null 区分、数值格式统一 */
var hA = ID.contentHash({ qty: 800, buyerName: 'A' }, 'opportunity');
var hB = ID.contentHash({ buyerName: 'A', qty: 800 }, 'opportunity');
var hC = ID.contentHash({ buyerName: 'A', qty: 800, unit: null }, 'opportunity');
var hD = ID.contentHash({ buyerName: 'A', qty: 800 }, 'opportunity');
ok(hA === hB && hC !== hD, 'T25 哈希键序无关且缺失≠null');

console.log('== identity-mapping: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
