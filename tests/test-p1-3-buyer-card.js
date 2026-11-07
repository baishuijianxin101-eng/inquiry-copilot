/* P1-3C 专项：详情页买家卡——历史行商品名+商机链接、未知买家隔离、聚合口径提示。
   渲染桩与 test-site-framework 同款（vm + DOM 桩，按 index.html 脚本序整站加载）。
   「统计不变」用 HEAD 版 app.js（改前）同夹具渲染对照证明：统计数字、历史日期
   顺序逐项相等；链接与商品列只应出现在改后版。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path'), cp = require('child_process');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var srcs = [...html.matchAll(/<script[^>]* src="([^"]+)"/g)].map(function (m) { return m[1].split('?')[0]; });
var STORE_KEY = 'ali_commission_copilot_v1';
var pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }

function El() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this._html = ''; this.files = [];
  this.parentNode = { removeChild: function () {}, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; } };
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }; }
El.prototype = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  appendChild: function (c) { this.children.push(c); return c; }, insertBefore: function (c) { this.children.push(c); return c; },
  get firstChild() { return this.children[0] || null; }, remove: function () {}, addEventListener: function () {}, removeEventListener: function () {},
  querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }, focus: function () {}, click: function () {} };

function boot(hash, store, appSrcOverride) {
  var els = new Map();
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
    createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
    addEventListener: function () {}, body: new El(), documentElement: new El() };
  var sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    Date: Date, Math: Math, JSON: JSON, Promise: Promise,
    localStorage: { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } },
    document: documentStub, location: { hash: hash, href: 'http://x/' }, navigator: { onLine: true },
    fetch: function () { return Promise.reject(new Error('no net')); }, URL: URL, Blob: function () {}, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    crypto: require('crypto').webcrypto, addEventListener: function () {}, removeEventListener: function () {},
    dispatchEvent: function () { return true; }, scrollTo: function () {}, scrollY: 0, innerWidth: 1280,
    history: { pushState: function () {}, replaceState: function () {} }, alert: function () {}, confirm: function () { return true; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  var fails = 0;
  srcs.forEach(function (s) {
    try {
      var code = (appSrcOverride && s === 'assets/app.js') ? appSrcOverride : fs.readFileSync(path.join(ROOT, s), 'utf8');
      vm.runInContext(code, sandbox, { filename: s });
    } catch (e) { fails++; console.log('LOAD FAIL', s, e.message); }
  });
  return { sandbox: sandbox, document: documentStub, fails: fails };
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function renderOpp(store, oppId, appSrcOverride) {
  var b = boot('#/opp/' + oppId, store, appSrcOverride || null);
  await sleep(250);
  return { view: b.document.getElementById('view').innerHTML, fails: b.fails };
}
function cardOf(viewHtml) {
  var i = viewHtml.indexOf('这个买家');
  if (i < 0) return '';
  var j = viewHtml.indexOf('</section>', i);
  return j < 0 ? viewHtml.slice(i) : viewHtml.slice(i, j + 10);
}
function statNum(card, label) {
  var m = card.match(new RegExp(label + '<\\/div><div style="font-size:20px;font-weight:700[^"]*">(\\d+) 次'));
  return m ? Number(m[1]) : null;
}
function rowDates(card) { return [...card.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(function (m) { return m[0]; }); }

function opp(id, createdAt, buyer, status, sel, quote, extra) {
  var o = { id: id, createdAt: createdAt, buyer: buyer, status: status, selectedProductId: sel || null,
    rawText: 'inquiry text for ' + id + ' please quote your price for our market', quote: quote || null };
  if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
  return o;
}
var LAURA = { name: 'Laura', company: '', country: 'Germany', channel: '询盘' };
function fixture() {
  var opps = [
    opp('opp_l7', '2026-11-06T10:00:00.000Z', LAURA, 'new', 'p_a', { qty: 100, unitPriceUsd: 9.5, incoterm: 'FOB' }),
    opp('opp_l6', '2026-11-05T10:00:00.000Z', LAURA, 'quoted', 'p_b', { qty: 50, unitPriceUsd: 19, incoterm: 'CIF' }),
    opp('opp_l5', '2026-11-04T10:00:00.000Z', LAURA, 'won', 'p_a', { qty: 200, unitPriceUsd: 9, incoterm: 'FOB' }),
    opp('opp_l4', '2026-11-03T10:00:00.000Z', LAURA, 'lost', null, { qty: 10, unitPriceUsd: 0, incoterm: '' }),
    opp('opp_l3', '2026-11-02T10:00:00.000Z', LAURA, 'quoted', 'p_deleted', { qty: 5, unitPriceUsd: 30, incoterm: 'EXW' }),
    opp('opp_l2', '2026-11-01T10:00:00.000Z', LAURA, 'quoted', 'p_b', null),
    opp('opp_l1', '2026-10-31T10:00:00.000Z', LAURA, 'new', 'p_a', null),
    /* 未知买家三条：不得互相聚合，也不得污染 Laura */
    opp('opp_u1', '2026-11-06T12:00:00.000Z', { name: '未知买家', company: '', country: '', channel: '询盘' }, 'new', 'p_a', null),
    opp('opp_u2', '2026-11-05T12:00:00.000Z', {}, 'quoted', 'p_b', null),
    opp('opp_u3', '2026-11-04T12:00:00.000Z', { name: '', company: '', country: '', channel: '询盘' }, 'won', 'p_a', null),
    /* 公司可识别：称呼是占位、公司真实 → 按公司聚合 */
    opp('opp_c1', '2026-11-03T09:00:00.000Z', { name: '未知买家', company: 'Acme GmbH', country: '', channel: '询盘' }, 'quoted', 'p_b', null),
    opp('opp_c2', '2026-11-06T09:00:00.000Z', { name: 'Bob', company: 'Acme GmbH', country: '', channel: '询盘' }, 'new', 'p_a', null),
    /* 同名演示商机：不得计入真实卡 */
    opp('opp_d1', '2026-11-07T10:00:00.000Z', LAURA, 'quoted', 'p_b', null, { demo: true }),
    opp('opp_d2', '2026-11-06T11:00:00.000Z', LAURA, 'new', 'p_a', null, { demo: true }),
    /* 首次买家 */
    opp('opp_n1', '2026-11-06T08:00:00.000Z', { name: 'NewGuy', company: '', country: '', channel: '询盘' }, 'new', 'p_a', null)
  ];
  return {
    products: [
      { id: 'p_a', title: 'Alpha Widget X1', titleEn: 'Alpha Widget X1', sku: 'A-1', priceUsd: 10 },
      { id: 'p_b', title: 'Beta Gadget Pro', titleEn: 'Beta Gadget Pro', sku: 'B-1', priceUsd: 20 }
    ],
    opportunities: opps,
    orders: [{ id: 'ord_1', buyer: 'Laura', amountUsd: 1000, refundUsd: 100, netRmb: 800 }]
  };
}
function seededStore() { var m = new Map(); m.set(STORE_KEY, JSON.stringify(fixture())); return m; }

(async function () {
  var baseSrc = null;
  try { baseSrc = cp.execSync('git show HEAD:assets/app.js', { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).toString('utf8'); } catch (e) { baseSrc = null; }
  ok(!!baseSrc, '0. 取到 HEAD 版 app.js 作改前对照');

  /* ---- 正常买家：改后渲染 ---- */
  var cur = await renderOpp(seededStore(), 'opp_l7', null);
  ok(cur.fails === 0 && cur.view.length > 500, '1. 详情页渲染成功');
  var card = cardOf(cur.view);
  ok(card.length > 100, '2. 买家卡存在');
  ok(statNum(card, '询盘') === 7, '3. 询盘统计 = 7（不含 2 条演示、3 条未知）', 'got ' + statNum(card, '询盘'));
  ok(statNum(card, '成交') === 1, '4. 成交统计 = 1', 'got ' + statNum(card, '成交'));
  ok(card.indexOf('$900') >= 0, '5. 累计成交额含订单净额 900（1000−100）');
  ok(card.indexOf('<th>商品</th>') >= 0, '6. 历史表含「商品」列');
  ok(card.indexOf('href="#/opp/opp_l6"') >= 0 && card.indexOf('Beta Gadget Pro') >= 0, '7. 第二行商品名 Beta Gadget Pro 且链接指向 opp_l6');
  ok(card.indexOf('href="#/opp/opp_l5"') >= 0 && card.indexOf('Alpha Widget X1') >= 0, '8. 第三行商品名 Alpha Widget X1 且链接指向 opp_l5');
  ok(card.indexOf('href="#/opp/opp_l4"') >= 0 && card.indexOf('href="#/opp/opp_l3"') >= 0, '9. 无选品行与已删商品行仍链接到各自商机');
  ok((card.match(/未记录商品/g) || []).length >= 2, '10. 未选品与已删商品均显示占位「未记录商品」（不显示错误商品）');
  ok(card.indexOf('opp_l2') < 0 && card.indexOf('opp_l1') < 0, '11. 最近五条上限保持：第 6、7 条不出现在历史表');
  ok(card.indexOf('按买家公司/称呼聚合') >= 0 && card.indexOf('同名不同人可能混在一组') >= 0, '12. 聚合口径提示存在');

  /* ---- 改前对照：统计与顺序不变 ---- */
  if (baseSrc) {
    var base = await renderOpp(seededStore(), 'opp_l7', baseSrc);
    var bCard = cardOf(base.view);
    ok(statNum(bCard, '询盘') === statNum(card, '询盘') && statNum(bCard, '成交') === statNum(card, '成交'), '13. 改前/改后统计数字一致');
    ok(JSON.stringify(rowDates(bCard)) === JSON.stringify(rowDates(card)), '14. 改前/改后历史日期顺序一致', JSON.stringify(rowDates(bCard)) + ' vs ' + JSON.stringify(rowDates(card)));
    ok(bCard.indexOf('href="#/opp/opp_l6"') < 0 && bCard.indexOf('Beta Gadget Pro') < 0, '15. 改前版无商品链接（对照成立，本批确有新增）');
  }

  /* ---- 未知买家隔离 ---- */
  var u1 = await renderOpp(seededStore(), 'opp_u1', null);
  var uCard = cardOf(u1.view);
  ok(uCard.indexOf('买家未识别') >= 0, '16. 字面「未知买家」显示未识别卡');
  ok(statNum(uCard, '询盘') === null && uCard.indexOf('累计成交额') < 0, '17. 未识别卡无任何聚合统计（不形成虚假回头客）');
  var u2 = await renderOpp(seededStore(), 'opp_u2', null);
  ok(cardOf(u2.view).indexOf('买家未识别') >= 0, '18. 空买家（规范化后同为未知买家）同样未识别、不与 U1/U3 聚合');

  /* ---- 公司可识别 ---- */
  var c2 = await renderOpp(seededStore(), 'opp_c2', null);
  var cCard = cardOf(c2.view);
  ok(cCard.indexOf('买家未识别') < 0 && statNum(cCard, '询盘') === 2, '19. 称呼占位但公司真实：按公司聚合 = 2，不被误判未识别', 'got ' + statNum(cCard, '询盘'));

  /* ---- 演示隔离（演示卡只计演示） ---- */
  var d1 = await renderOpp(seededStore(), 'opp_d1', null);
  var dCard = cardOf(d1.view);
  ok(statNum(dCard, '询盘') === 2, '20. 演示商机卡只聚合演示同名商机 = 2（不混入真实 7 条）', 'got ' + statNum(dCard, '询盘'));
  ok(dCard.indexOf('href="#/opp/opp_d2"') >= 0 && dCard.indexOf('href="#/opp/opp_l7"') < 0, '21. 演示卡历史行只含演示商机');

  /* ---- 首次买家卡不变 ---- */
  var n1 = await renderOpp(seededStore(), 'opp_n1', null);
  var nCard = cardOf(n1.view);
  ok(nCard.indexOf('第一次来') >= 0 && nCard.indexOf('买家未识别') < 0, '22. 已识别首次买家仍显示「第一次来」引导卡');

  console.log('== p1-3-buyer-card: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
