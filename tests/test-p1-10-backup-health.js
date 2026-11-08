/* P1-10 备份健康专项（全部虚构数据）
   覆盖：Workflow.backupHealth 三态与 7 天边界、todos 的 backup 待办
   （尚未备份/备份已过期/导出后消失）、既有五类待办不受影响、
   旧数据导入兼容、导出→隔离恢复演练（商品/商机/报价版本计数一致）。
   app 层「导出成功才记录」与页面展示由真实浏览器链路验证（见交付报告）。
   运行：node tests/test-p1-10-backup-health.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function makeSandbox(store) {
  var sb = { console: console };
  sb.window = sb; sb.globalThis = sb;
  sb.localStorage = {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  vm.createContext(sb);
  ['assets/core.js', 'assets/workflow.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
var DAY = 86400000;
function setBackup(store, msAgo) {
  store['ic_backup_health'] = JSON.stringify({ lastExportAt: new Date(Date.now() - msAgo).toISOString() });
}

/* ---- backupHealth 三态与边界 ---- */
var store1 = {};
var sb1 = makeSandbox(store1);
var W = sb1.Workflow;
ok('B1 无记录 → never', W.backupHealth().state === 'never' && W.backupHealth().lastExportAt === null);
setBackup(store1, 0);
ok('B2 刚导出 → fresh，ageDays 0', W.backupHealth().state === 'fresh' && W.backupHealth().ageDays === 0, JSON.stringify(W.backupHealth()));
setBackup(store1, 7 * DAY);
ok('B3 7 天整 → fresh（超过 7 天才过期）', W.backupHealth().state === 'fresh' && W.backupHealth().ageDays === 7, JSON.stringify(W.backupHealth()));
setBackup(store1, 8 * DAY);
ok('B4 8 天 → stale，ageDays 8', W.backupHealth().state === 'stale' && W.backupHealth().ageDays === 8, JSON.stringify(W.backupHealth()));
store1['ic_backup_health'] = 'not-json{{';
ok('B5 损坏值 → never 不抛错', W.backupHealth().state === 'never');
store1['ic_backup_health'] = JSON.stringify({ lastExportAt: 'garbage' });
ok('B6 非法时间 → never', W.backupHealth().state === 'never');

/* ---- todos 接入 ---- */
var C = sb1.Core;
function cleanState() {
  var s = C.get();
  s.opportunities = []; s.products = []; s.orders = [];
  s.settings.fxUpdatedAt = new Date().toISOString();
  return s;
}
delete store1['ic_backup_health'];
var t1 = W.todos(cleanState());
var bk1 = t1.filter(function (t) { return t.key === 'backup'; })[0];
ok('B7 从未备份 → 待办出现且文案为尚未备份', !!bk1 && bk1.label === '数据还没有备份' && bk1.severity === 'high', JSON.stringify(t1.map(function (t) { return t.key; })));
setBackup(store1, 0);
var t2 = W.todos(cleanState());
ok('B8 导出后 → backup 待办消失', !t2.some(function (t) { return t.key === 'backup'; }));
setBackup(store1, 8 * DAY);
var t3 = W.todos(cleanState());
var bk3 = t3.filter(function (t) { return t.key === 'backup'; })[0];
ok('B9 8 天前 → 待办为备份已过期且带天数', !!bk3 && bk3.label === '备份已过期' && bk3.desc.indexOf('8 天前') >= 0, bk3 && bk3.desc);
/* 既有待办共存：有未回复商机时 reply 与 backup 同时在 */
delete store1['ic_backup_health'];
var s4 = cleanState();
s4.opportunities = [C.normalizeOpp({ id: 'o1', buyer: { name: 'T' }, rawText: 'need 10 pcs', status: 'new' })];
var t4 = W.todos(s4);
ok('B10 既有 reply 待办与 backup 待办共存', t4.some(function (t) { return t.key === 'reply'; }) && t4.some(function (t) { return t.key === 'backup'; }), JSON.stringify(t4.map(function (t) { return t.key; })));

/* ---- 旧数据导入兼容 + 恢复演练 ---- */
var storeA = {};
var sbA = makeSandbox(storeA);
var CA = sbA.Core;
var stA = CA.get();
stA.products = [CA.normalizeProduct({ id: 'PA', title: 'Widget A', costRmb: 10, priceUsd: 3 }),
                CA.normalizeProduct({ id: 'PB', title: 'Widget B', costRmb: 20, priceUsd: 5 })];
var oA = CA.normalizeOpp({ id: 'OA', buyer: { name: 'Buyer A' }, rawText: 'need 100 pcs', status: 'quoted' });
oA.quoteVersions = [CA.normalizeQuoteVersion({ at: new Date().toISOString(), unitPriceUsd: 2.8, qty: 100, note: 'v1' }),
                    CA.normalizeQuoteVersion({ at: new Date().toISOString(), unitPriceUsd: 2.6, qty: 100, note: 'v2' })];
stA.opportunities = [oA];
CA.persist();
var exported = storeA[CA.STORE_KEY];
ok('B11 导出内容不含备份健康键（独立存储）', exported.indexOf('ic_backup_health') < 0 && exported.indexOf('lastExportAt') < 0);
/* 隔离环境恢复：全新 sandbox 只喂导出 JSON（模拟旧版本备份，无任何新字段） */
var storeB = {};
var sbB = makeSandbox(storeB);
var CB = sbB.Core;
storeB[CB.STORE_KEY] = exported;
var stB = CB.get();
ok('B12 恢复后商品数一致', stB.products.length === 2, String(stB.products.length));
ok('B13 恢复后商机数一致', stB.opportunities.length === 1, String(stB.opportunities.length));
ok('B14 恢复后报价版本数一致', stB.opportunities[0].quoteVersions.length === 2, String(stB.opportunities[0].quoteVersions.length));
ok('B15 恢复后关键字段一致', stB.opportunities[0].buyer.name === 'Buyer A' && stB.products[1].costRmb === 20);
ok('B16 恢复环境备份状态为 never（不被备份文件污染）', sbB.Workflow.backupHealth().state === 'never');

console.log('\n=== P1-10 backup-health: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
