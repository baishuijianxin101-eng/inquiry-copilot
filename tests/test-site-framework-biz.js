/* P1-23-R3：新框架四页业务行为测试（DOM 桩级，非真实浏览器）。
   通过应用自身的 hashchange→render 路径渲染页面，断言聚合数值、口径与安全边界。
   全部虚构数据。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(function (m) { return m[1].split('?')[0]; });
var pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name); } }
function El() { this.children = []; this.style = {}; this.dataset = {}; this.value = ''; this._html = ''; this.files = []; this.textContent = '';
  this.parentNode = { removeChild: function () {}, appendChild: function (c) { return c; }, insertBefore: function (c) { return c; } };
  this.classList = { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } }; }
El.prototype = { set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
  appendChild: function (c) { this.children.push(c); return c; }, insertBefore: function (c) { this.children.push(c); return c; },
  get firstChild() { return this.children[0] || null; }, remove: function () {}, addEventListener: function () {}, removeEventListener: function () {},
  querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
  setAttribute: function () {}, getAttribute: function () { return null; }, focus: function () {}, click: function () {} };
function boot(store) {
  var els = new Map(), winL = {};
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
    createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
    addEventListener: function () {}, body: new El(), documentElement: new El() };
  var sandbox = { console: { log: function () {}, warn: function () {}, error: function () {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval: function () {},
    Date: Date, Math: Math, JSON: JSON, Promise: Promise,
    localStorage: { getItem: function (k) { return store.has(k) ? store.get(k) : null; }, setItem: function (k, v) { store.set(k, String(v)); }, removeItem: function (k) { store.delete(k); } },
    document: documentStub, location: { hash: '#/dashboard', href: 'http://x/' }, navigator: { onLine: true },
    fetch: function () { return Promise.reject(new Error('no net')); }, URL: URL, Blob: function () {}, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
    crypto: require('crypto').webcrypto,
    addEventListener: function (ev, fn) { (winL[ev] = winL[ev] || []).push(fn); }, removeEventListener: function () {},
    dispatchEvent: function () { return true; }, scrollTo: function () {}, scrollY: 0, innerWidth: 1280,
    history: { pushState: function () {}, replaceState: function () {} }, alert: function () {}, confirm: function () { return true; } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  srcs.forEach(function (s) { vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), sandbox, { filename: s }); });
  return { sb: sandbox, doc: documentStub,
    goto: async function (hash) { sandbox.location.hash = hash; (winL['hashchange'] || []).forEach(function (f) { f(); }); await new Promise(function (r) { setTimeout(r, 60); }); },
    view: function () { return documentStub.getElementById('view').innerHTML; },
    crumb: function () { return documentStub.getElementById('crumb').textContent; } };
}
function opp(C, o) { return C.normalizeOpp(o); }
function seed(b, opps) { var st = b.sb.Core.get(); st.opportunities = opps; st.products = []; b.sb.Core.persist(); }

(async function () {
  /* ===== A. 客户中心 ===== */
  var storeA = new Map();
  var bA = boot(storeA); await new Promise(function (r) { setTimeout(r, 120); });
  var C = bA.sb.Core;
  seed(bA, [
    opp(C, { id: 'opp_a1', status: 'new', createdAt: '2026-10-01', buyer: { name: 'Daniel', company: 'FlyMart', country: 'Germany' }, rawText: 'x', quote: {} }),
    opp(C, { id: 'opp_a2', status: 'quoted', createdAt: '2026-11-01', buyer: { name: 'Daniel', company: 'FlyMart', country: 'Germany' }, rawText: 'x', quote: {} }),
    opp(C, { id: 'opp_b1', status: 'new', createdAt: '2026-10-15', buyer: { name: 'Sara', company: 'OtherCo', country: 'Spain' }, rawText: 'x', quote: {} }),
    opp(C, { id: 'opp_c1', status: 'new', createdAt: '2026-10-20', buyer: { name: 'Daniel', company: 'DiffCo', country: 'France' }, rawText: 'x', quote: {} }),
    opp(C, { id: 'opp_d1', status: 'new', createdAt: '2026-10-22', buyer: { name: '', company: '', country: '' }, rawText: 'x', quote: {} }),
    opp(C, { id: 'opp_e1', status: 'new', createdAt: '2026-10-25', buyer: { name: 'DemoDan', company: 'DemoCo', country: 'US' }, rawText: 'x', quote: {}, demo: true })
  ]);
  var beforeA = storeA.get('ali_commission_copilot_v1');
  await bA.goto('#/customers');
  var custHtml = bA.view();
  ok(custHtml.indexOf('2 条（进行中 2)') >= 0, 'A1 同买家两条询盘聚合为一组且计数正确（new 与 quoted 均为进行中）');
  ok(custHtml.indexOf('#/opp/opp_a2') >= 0, 'A2 最近询盘指向较新的 opp_a2');
  ok(custHtml.indexOf('DiffCo') >= 0 && custHtml.indexOf('OtherCo') >= 0, 'A3 同名不同公司、不同买家各自成组');
  ok(custHtml.indexOf('未知买家') >= 0, 'A4 缺失买家名称安全兜底');
  ok(custHtml.indexOf('同名不同人可能被分到一组') >= 0, 'A5 同名同公司身份风险提示在场');
  ok(custHtml.indexOf('DemoDan') < 0, 'A6 真实视图下演示买家不出现（数据视图隔离）');
  ok(storeA.get('ali_commission_copilot_v1') === beforeA, 'A7 客户中心渲染不写回任何数据');

  var storeA2 = new Map(); storeA2.set('ic_data_view', 'demo');
  var bA2 = boot(storeA2); await new Promise(function (r) { setTimeout(r, 120); });
  seed(bA2, [opp(bA2.sb.Core, { id: 'opp_e1', status: 'new', createdAt: '2026-10-25', buyer: { name: 'DemoDan', company: 'DemoCo', country: 'US' }, rawText: 'x', quote: {}, demo: true }),
             opp(bA2.sb.Core, { id: 'opp_a1', status: 'new', createdAt: '2026-10-01', buyer: { name: 'Daniel', company: 'FlyMart', country: 'Germany' }, rawText: 'x', quote: {} })]);
  await bA2.goto('#/customers');
  ok(bA2.view().indexOf('DemoDan') >= 0 && bA2.view().indexOf('FlyMart') < 0, 'A8 演示视图只显示演示买家');

  /* ===== B. 销售分析 ===== */
  var storeB = new Map();
  var bB = boot(storeB); await new Promise(function (r) { setTimeout(r, 120); });
  var CB = bB.sb.Core;
  var fullText = 'Hi, we need 800 pcs of AeroLink XR4 Pro ELRS 2.4GHz receivers for our FPV racing drones. CE and FCC certification required. Please quote CIF Hamburg, Germany. Delivery within 25 days.';
  seed(bB, [
    opp(CB, { id: 'opp_f1', status: 'new', createdAt: '2026-11-01', buyer: { name: 'FullBuyer', company: 'F Co', country: 'Germany' }, rawText: fullText, quote: {} }),
    opp(CB, { id: 'opp_f2', status: 'new', createdAt: '2026-11-01', buyer: { name: 'NoTextBuyer', company: 'N Co', country: 'Spain' }, rawText: '', quote: {} }),
    opp(CB, { id: 'opp_f3', status: 'new', createdAt: '2026-11-01', buyer: { name: 'FixedBuyer', company: 'X Co', country: 'France' }, rawText: fullText, quote: {}, salesReview: { stageFix: '供应商筛选' } }),
    opp(CB, { id: 'opp_f4', status: 'new', createdAt: '2026-11-01', buyer: { name: 'ConflictBuyer', company: 'C Co', country: 'Italy' }, rawText: 'We need CE certified receivers, 200 pcs. Actually CE is not required for this order.', quote: {} })
  ]);
  var beforeB = storeB.get('ali_commission_copilot_v1');
  await bB.goto('#/analysis');
  var anHtml = bB.view();
  ok(anHtml.indexOf('FullBuyer') >= 0 && anHtml.indexOf('明确需求') >= 0, 'B1 有原文询盘进入分析且阶段正确');
  ok(anHtml.indexOf('NoTextBuyer') < 0, 'B2 无原文询盘不进入分析列表');
  ok(anHtml.indexOf('人工确认') >= 0, 'B3 人工修正后的阶段带人工确认标记');
  ok(anHtml.indexOf('有冲突待核实') >= 0, 'B4 认证冲突显示为冲突而非普通缺口');
  ok(storeB.get('ali_commission_copilot_v1') === beforeB, 'B5 销售分析渲染不产生持久化写入');

  /* ===== C. 跟进管理 ===== */
  var storeC = new Map();
  var bC = boot(storeC); await new Promise(function (r) { setTimeout(r, 120); });
  var CC = bC.sb.Core;
  seed(bC, [
    opp(CC, { id: 'opp_g1', status: 'won', createdAt: '2026-10-01', buyer: { name: 'WonBuyer', company: 'W Co', country: 'DE' }, rawText: 'x', quote: {} }),
    opp(CC, { id: 'opp_g2', status: 'quoted', createdAt: '2026-10-02', buyer: { name: 'OpenBuyer', company: 'O Co', country: 'FR' }, rawText: 'x', quote: {},
      followLog: [{ at: '2026-10-01', note: '旧记录AAA' }, { at: '2026-11-03', note: '最新记录BBB' }, { at: '2026-10-20', note: '中间记录CCC' }] }),
    opp(CC, { id: 'opp_g3', status: 'new', createdAt: '2026-10-03', buyer: { name: 'NoLogBuyer', company: 'L Co', country: 'ES' }, rawText: 'x', quote: {}, followLog: [] }),
    opp(CC, { id: 'opp_g4', status: 'new', createdAt: '2026-10-04', buyer: { name: 'BadTimeBuyer', company: 'B Co', country: 'IT' }, rawText: 'x', quote: {},
      followLog: [{ at: 'not-a-date', note: '坏时间DDD' }, { at: '2026-09-01', note: '有效旧记录EEE' }] })
  ]);
  await bC.goto('#/followups');
  var fuHtml = bC.view();
  ok(fuHtml.indexOf('WonBuyer') < 0 && fuHtml.indexOf('OpenBuyer') >= 0, 'C1 已成交不进清单、进行中进入清单');
  ok(fuHtml.indexOf('最新记录BBB') >= 0 && fuHtml.indexOf('中间记录CCC') < 0, 'C2 乱序 followLog 按时间取真正最近一条');
  ok(fuHtml.indexOf('暂无跟进记录') >= 0, 'C3 无记录时显示暂无跟进记录');
  ok(fuHtml.indexOf('有效旧记录EEE') >= 0 && fuHtml.indexOf('坏时间DDD') < 0, 'C4 时间异常条目不冒充最近记录且页面不崩溃');

  /* ===== D. 同步与设置 ===== */
  await bC.goto('#/sync');
  var syHtml = bC.view();
  ok(syHtml.indexOf('RFQ 查询与详情读取') >= 0 && syHtml.indexOf('alibaba.icbu.rfq.search') >= 0, 'D1 RFQ 能力单独成行');
  ok(syHtml.indexOf('非 RFQ 商品页询盘读取') >= 0 && syHtml.indexOf('公开资料尚未确认') >= 0, 'D2 非 RFQ 询盘与 RFQ 明确区分');
  ok(syHtml.indexOf('TM 站内消息读取') >= 0 && syHtml.indexOf('TM 站内消息发送') >= 0, 'D3 TM 读取与发送分别成行');
  ok(syHtml.indexOf('RFQ 报价提交') >= 0 && syHtml.indexOf('不是站内消息发送') >= 0, 'D4 RFQ 报价提交与 TM 发送不混淆');
  ok(syHtml.indexOf('阿里官方接口尚未连接') >= 0 && syHtml.indexOf('同步成功') < 0 && syHtml.indexOf('已接通') < 0, 'D5 未连接状态明确且无误导文案');
  ok(syHtml.indexOf('data-action="export-json"') >= 0 && syHtml.indexOf('data-action="import-json"') >= 0 && syHtml.indexOf('#/settings') >= 0, 'D6 导入导出与设置入口都在');
  ok(syHtml.indexOf('官方暂未找到对应接口') < 0, 'D7 旧的笼统错误文案已消除');

  /* ===== E. fwOppLink 与 ID 边界 ===== */
  var CN = bC.sb.Core;
  [['opp_normal1', true], ['id with space', false], ['id"quote', false], ['id<tag>', false], ['', false], ['a/b?c=d', false]].forEach(function (pair, i) {
    var o = CN.normalizeOpp({ id: pair[0], buyer: { name: 'T' }, rawText: 'x' });
    ok(/^[A-Za-z0-9_-]{1,48}$/.test(o.id) === true && (pair[1] ? o.id === pair[0] : o.id !== pair[0] || pair[0] === ''), 'E' + (i + 1) + ' normalizeOpp 对 ID「' + pair[0] + '」的规范化结果安全');
  });
  var stE = bC.sb.Core.get();
  stE.opportunities.push({ id: 'x" onmouseover="alert(1)', status: 'new', createdAt: '2026-11-04', buyer: { name: 'EvilBuyer', company: 'E Co', country: 'DE' }, rawText: 'x', quote: {}, followLog: [], log: [] });
  stE.opportunities.push({ id: 'opp_legal9', status: 'new', createdAt: '2026-11-04', buyer: { name: 'LegalBuyer', company: 'L Co', country: 'DE' }, rawText: 'x', quote: {}, followLog: [], log: [] });
  await bC.goto('#/customers');
  var evHtml = bC.view();
  ok(evHtml.indexOf('onmouseover') < 0 && evHtml.indexOf('EvilBuyer') >= 0, 'E7 异常 ID 降级为纯文本、不进 href 属性');
  ok(evHtml.indexOf('href="#/opp/opp_legal9"') >= 0, 'E8 合法 ID 链接保持原行为');

  /* ===== F. 导航与面包屑一致性 ===== */
  var crumbs = { '#/opps': '询盘中心', '#/catalog': '商品与报价', '#/analytics': '经营分析', '#/sync': '数据同步与系统设置', '#/settings': '系统设置', '#/customers': '客户中心', '#/followups': '跟进管理', '#/analysis': '销售分析' };
  var keys = Object.keys(crumbs);
  for (var k = 0; k < keys.length; k++) { await bC.goto(keys[k]); ok(bC.crumb() === crumbs[keys[k]] && bC.view().length > 100, 'F' + (k + 1) + ' 路由 ' + keys[k] + ' 可达且面包屑为「' + crumbs[keys[k]] + '」'); }
  await bC.goto('#/desk'); ok(bC.view().length > 100, 'F9 决策台旧路由仍可打开');
  await bC.goto('#/review'); ok(bC.view().length > 100, 'F10 补成本旧路由仍可打开');

  console.log('== site-framework-biz: ' + pass + ' passed, ' + fail + ' failed ==');
  process.exit(fail ? 1 : 0);
})();
