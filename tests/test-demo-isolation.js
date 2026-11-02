/* 阶段六：演示数据隔离测试（纯 Node，全部虚构数据）
   运行：node tests/test-demo-isolation.js
   每个场景用独立 vm 上下文加载 core.js，互不干扰。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'core.js'), 'utf8');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function memStorage() {
  var m = {};
  return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; }, _m: m };
}
function loadCore(storage) {
  var sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
  sandbox.window = sandbox;
  sandbox.localStorage = storage;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'core.js' });
  return sandbox.Core;
}
function realOpp(C, id) {
  return C.normalizeOpp({ id: id, status: 'new', buyer: { name: 'Real Buyer', company: 'Real Co', country: '德国', channel: 'RFQ' }, rawText: 'real inquiry', quote: { qty: 10 }, followLog: [], log: [] });
}

/* 1. 无种子文件的新状态：商机全是演示，真实列表为空 */
var C1 = loadCore(memStorage());
var s1 = C1.get();
ok('种子商机共 3 条且全部带演示标记', s1.opportunities.length === 3 && s1.opportunities.every(function (o) { return C1.isDemoOpp(o); }));
ok('演示商机不出现在真实列表', C1.visibleOpps(s1, 'real').length === 0);
ok('演示列表恰好 3 条', C1.visibleOpps(s1, 'demo').length === 3);
ok('种子商品全部带演示标记', s1.products.length > 0 && s1.products.every(function (p) { return C1.isDemoProduct(p); }));

/* 2. 混合状态：真实商机只进真实列表，互不串 */
var s2 = C1.get();
s2.opportunities.push(realOpp(C1, 'opp_real_1'));
ok('真实商机出现在真实列表', C1.visibleOpps(s2, 'real').length === 1 && C1.visibleOpps(s2, 'real')[0].id === 'opp_real_1');
ok('真实商机不出现在演示列表', C1.visibleOpps(s2, 'demo').every(function (o) { return o.id !== 'opp_real_1'; }));

/* 3. 修改演示记录不改变真实记录 */
var before = JSON.stringify(C1.visibleOpps(s2, 'real')[0]);
var demoOpp = C1.visibleOpps(s2, 'demo')[0];
demoOpp.buyer.name = 'Changed Demo';
demoOpp.quote.qty = 99999;
demoOpp.followLog = [{ at: '2026-11-03T00:00:00.000Z', type: '其他', summary: '演练跟进' }];
ok('改演示商机后真实商机逐字不变', JSON.stringify(C1.visibleOpps(s2, 'real')[0]) === before);

/* 4. 清除演示数据：演示全清、真实保留 */
var counts = C1.purgeDemo(s2);
ok('purge 报告清掉 3 条演示商机', counts.opps === 3, JSON.stringify(counts));
ok('清除后演示列表为空', C1.visibleOpps(s2, 'demo').length === 0);
ok('清除后真实商机仍在', C1.visibleOpps(s2, 'real').length === 1);
ok('清除后真实商品不受影响（演示商品被清、真实商品无）', s2.products.every(function (p) { return !C1.isDemoProduct(p); }));

/* 5. 持久化往返（模拟刷新/重开）：两类数据都还在、隔离不变 */
var storage5 = memStorage();
var C5a = loadCore(storage5);
var s5 = C5a.get();
s5.opportunities.push(realOpp(C5a, 'opp_real_9'));
C5a.persist();
var C5b = loadCore(storage5);
var s5b = C5b.get();
ok('刷新后真实商机仍在真实列表', C5b.visibleOpps(s5b, 'real').some(function (o) { return o.id === 'opp_real_9'; }));
ok('刷新后演示商机仍只在演示列表', C5b.visibleOpps(s5b, 'demo').length === 3 && C5b.visibleOpps(s5b, 'real').length === 1);

/* 6. 旧版数据迁移：无 demo 字段的种子 id 商机自动识别为演示 */
var storage6 = memStorage();
storage6.setItem('ali_commission_copilot_v1', JSON.stringify({
  version: 3, demoMode: false, settings: {},
  products: [],
  opportunities: [
    { id: 'opp_demo_2', status: 'won', buyer: { name: '张先生', company: 'x', country: '美国', channel: 'RFQ' }, rawText: 'old', quote: { qty: 3000 } },
    { id: 'opp_real_old', status: 'won', buyer: { name: 'Old Real', company: 'y', country: '德国', channel: '询盘' }, rawText: 'old real', quote: { qty: 5 } }
  ],
  orders: [
    { id: 'ord_real_1', date: '2026-10-01', amountUsd: 1000, netRmb: 500, costRmb: 100 },
    { id: 'ord_demo_1', date: '2026-10-01', amountUsd: 9999, netRmb: 9999, costRmb: 1, demo: true }
  ],
  logs: []
}));
var C6 = loadCore(storage6);
var s6 = C6.get();
ok('旧版 opp_demo_2 自动识别为演示', C6.isDemoOpp(s6.opportunities.filter(function (o) { return o.id === 'opp_demo_2'; })[0]));
ok('旧版真实商机不被误标', !C6.isDemoOpp(s6.opportunities.filter(function (o) { return o.id === 'opp_real_old'; })[0]));
var st6 = C6.stats();
ok('统计只算真实成交（won=1 而非 2）', st6.wonCount === 1, JSON.stringify({ won: st6.wonCount, total: st6.totalOpps }));
ok('演示订单不计入成交额（GMV=1000 而非 10999）', st6.gmvUsd === 1000, String(st6.gmvUsd));
ok('统计单列演示计数', st6.demoOppCount === 1 && st6.demoOrderCount === 1, JSON.stringify(st6.demoOppCount));

/* 7. 演示数据损坏/缺失不影响真实业务 */
var broken = { opportunities: [null, 42, 'junk', { id: 'opp_demo_1' }], products: [], orders: [] };
var threw = false, realList = null, demoList = null;
try {
  realList = C1.visibleOpps(broken, 'real');
  demoList = C1.visibleOpps(broken, 'demo');
  C1.purgeDemo(broken);
} catch (e) { threw = true; }
ok('损坏数据不抛错', !threw);
ok('损坏条目不进任何列表，半残演示条目归演示侧', realList.length === 0 && demoList.length === 1, JSON.stringify({ r: realList && realList.length, d: demoList && demoList.length }));
ok('无演示数据时真实列表照常为空数组', C1.visibleOpps({ opportunities: [] }, 'demo').length === 0);
ok('state 缺 opportunities 字段不崩溃', C1.visibleOpps({}, 'real').length === 0 && C1.visibleOpps(null, 'demo').length === 0);

/* 8. 演示跟进/草稿只挂在演示商机上，不外溢 */
var C8 = loadCore(memStorage());
var s8 = C8.get();
var d8 = C8.visibleOpps(s8, 'demo')[0];
d8.followLog = [{ at: '2026-11-03T01:00:00.000Z', type: '首次联系', summary: '演示跟进' }];
d8.replyDrafts = { first: { en: 'demo draft', at: '2026-11-03T01:00:00.000Z' } };
ok('演示跟进与草稿不出现在真实商机对象上', C8.visibleOpps(s8, 'real').every(function (o) { return !o.replyDrafts || !o.replyDrafts.first; }));

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
