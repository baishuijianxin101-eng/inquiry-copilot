/* P1-23-R7 性能测量（Node 环境，非真机）：legacy 回填/重复回填/完整性检查/身份导入，100/500/1000/3000 条虚构实体。 */
'use strict';
var ID = require('../assets/identity.js');
var IM = require('../assets/identity-migration.js');
function makeState(n) {
  var products = [], opps = [], orders = [];
  for (var i = 0; i < n; i++) products.push({ id: 'sbx_p' + i, title: 'P' + i, model: 'M' + i, category: 'C' });
  for (var j = 0; j < n; j++) opps.push({ id: 'sbx_o' + j, buyer: { name: 'B' + j, company: '', country: '' }, rawText: 'x', selectedProductId: 'sbx_p' + j, matches: [{ productId: 'sbx_p' + j }], followLog: [{ id: 'f', at: '2026-10-01', note: 'n' }], log: [], quote: { qty: j } });
  for (var m = 0; m < Math.floor(n / 2); m++) orders.push({ id: 'sbx_ord' + m, oppId: 'sbx_o' + m, buyerName: 'B', amountCents: m, currency: 'USD', status: 'paid' });
  return { products: products, opportunities: opps, orders: orders };
}
[100, 500, 1000, 3000].forEach(function (n) {
  var st = makeState(n), reg = ID.createRegistry();
  var t0 = Date.now(); IM.backfillLegacy(st, reg); var tBack = Date.now() - t0;
  t0 = Date.now(); IM.backfillLegacy(st, reg); var tBack2 = Date.now() - t0;
  t0 = Date.now(); IM.checkIntegrity(st); var tInteg = Date.now() - t0;
  var recs = [];
  for (var i = 0; i < n; i++) recs.push({ entity_type: 'opportunity', external_id_raw: 'EXT-' + i, content: { buyerName: 'B', qty: i }, sourceVersion: 1, entity: { buyer: { name: 'B' }, followLog: [], log: [], quote: {} } });
  t0 = Date.now();
  var res = IM.importBatch(makeState(0), ID.createRegistry(), { source_system: 'alibaba_api', source_account: 'a', records: recs }, { buildEntity: function (t, c, iid, rec) { var e = JSON.parse(JSON.stringify(rec.entity)); e.id = iid; return e; }, applyContent: function () {} });
  var tImport = Date.now() - t0;
  var regSize = ID.exportState(reg).length;
  console.log('PERF n=' + n + ' entities=' + (n * 2.5) + ' backfill=' + tBack + 'ms repeatBackfill=' + tBack2 + 'ms integrity=' + tInteg + 'ms importBatch=' + tImport + 'ms registryBytes=' + regSize + ' applied=' + res.applied);
});
console.log('== identity-perf DONE (Node measurements only) ==');
