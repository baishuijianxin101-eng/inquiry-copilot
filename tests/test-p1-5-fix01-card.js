/* P1-5-REPLY FIX-01 专项：详情卡已保存发送稿的语言标签与 raSave edited 基线。
   渲染桩与 test-p1-3-buyer-card 同款（vm + DOM 桩，整站按 index.html 脚本序加载），
   另记录 document click 委托以便真实触发 ra-save 动作。
   运行：node tests/test-p1-5-fix01-card.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var srcs = [...html.matchAll(/<script[^>]* src="([^"]+)"/g)].map(function (x) { return x[1].split('?')[0]; });
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
  var handlers = {};
  var documentStub = { getElementById: function (id) { if (!els.has(id)) els.set(id, new El()); return els.get(id); },
    createElement: function () { return new El(); }, querySelector: function () { return new El(); }, querySelectorAll: function () { return []; },
    addEventListener: function (t, fn) { (handlers[t] = handlers[t] || []).push(fn); }, body: new El(), documentElement: new El() };
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
    }
    catch (e) { fails++; console.log('LOAD FAIL', s, e.message); }
  });
  return { sandbox: sandbox, document: documentStub, handlers: handlers, fails: fails };
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var ES_TEXT = 'Hola, necesitamos 500 unidades de receptores ELRS con certificado CE, entrega en 20 días a España.';
var EN_TEXT = 'Hello, we need 500 pcs of ELRS receivers with CE certificate, delivery in 20 days.';
var RU_DRAFT = 'Добрый день!\n\nСпасибо за ваш запрос о receptores ELRS.\n\nС уважением,\nTest Seller';
var ES_DRAFT = 'Hola,\n\nGracias por su consulta sobre receptores ELRS.\n\nSaludos cordiales,\nTest Seller';
var EN_DRAFT = 'Hi,\n\nThanks for your inquiry about ELRS receivers.\n\nBest regards,\nTest Seller';
var ZH_DRAFT = '您好，感谢您的询盘，我先确认后给您正式报价。';
var SCEN = ['first', 'prequote', 'spec', 'moq', 'negotiation', 'sample', 'clarify'];
function drafts(enText) { var o = {}; SCEN.forEach(function (k) { o[k] = { en: enText, zh: ZH_DRAFT, edited: false, at: '2026-11-08T01:00:00.000Z' }; }); return o; }
function makeOpp(id, rawText, savedEn) {
  var o = { id: id, createdAt: '2026-11-08T00:30:00.000Z', buyer: { name: 'Juan', company: '', country: 'Spain', channel: '询盘' },
    status: 'new', selectedProductId: 'p_a', rawText: rawText, quote: null };
  if (savedEn) o.replyDrafts = drafts(savedEn);
  return o;
}
function seededStore(opp) {
  var store = new Map();
  store.set(STORE_KEY, JSON.stringify({
    products: [{ id: 'p_a', title: 'Alpha Receiver X1', titleEn: 'Alpha Receiver X1', sku: 'A-1', priceUsd: 10 }],
    opportunities: [opp], orders: []
  }));
  return store;
}
async function renderOpp(store, oppId, appSrcOverride) {
  var b = boot('#/opp/' + oppId, store, appSrcOverride || null);
  await sleep(250);
  return { view: b.document.getElementById('view').innerHTML, boot: b };
}
function primaryLabel(view) {
  var i = view.indexOf('<textarea id="ra-en"');
  if (i < 0) return '';
  var seg = view.slice(Math.max(0, i - 300), i);
  var mm = seg.match(/<label[^>]*>([^<]*)<\/label>/g);
  return mm ? mm[mm.length - 1].replace(/<[^>]+>/g, '') : '';
}
function primaryContent(view) {
  var i = view.indexOf('<textarea id="ra-en"');
  if (i < 0) return '';
  var j = view.indexOf('</textarea>', i);
  return view.slice(view.indexOf('>', i) + 1, j);
}
function unesc(s) { return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function fireRaSave(b, oppId) {
  var ev = { target: { classList: { contains: function () { return false; } },
    closest: function () { return { getAttribute: function (k) { return k === 'data-action' ? 'ra-save' : (k === 'data-id' ? oppId : null); } }; } },
    preventDefault: function () {} };
  (b.handlers.click || []).forEach(function (fn) { try { fn(ev); } catch (e) { /* 桩环境渲染/提示异常不影响已落盘断言 */ } });
}
function storedDrafts(store, oppId) {
  var data = JSON.parse(store.get(STORE_KEY));
  var o = data.opportunities.filter(function (x) { return x.id === oppId; })[0];
  return o ? (o.replyDrafts || {}) : {};
}

(async function () {
  /* 1. 西语商机 + 已保存西语稿：中性标签 + 内容为西语稿 */
  var r1 = await renderOpp(seededStore(makeOpp('fx1', ES_TEXT, ES_DRAFT)), 'fx1');
  ok(primaryLabel(r1.view) === '已保存发送稿（发给买家的就是这份）', '1. 已保存西语稿标签为中性', primaryLabel(r1.view));
  ok(primaryContent(r1.view).indexOf('Gracias por su consulta') >= 0, '1b. 内容为已保存西语稿');

  /* 2. 西语商机 + 已保存俄语稿（人工切俄语保存）：内容俄语、标签不得称西班牙语 */
  var r2 = await renderOpp(seededStore(makeOpp('fx2', ES_TEXT, RU_DRAFT)), 'fx2');
  ok(primaryContent(r2.view).indexOf('Спасибо за ваш запрос') >= 0, '2. 内容为已保存俄语稿');
  ok(primaryLabel(r2.view) === '已保存发送稿（发给买家的就是这份）' && primaryLabel(r2.view).indexOf('西班牙语') < 0,
    '2b. 标签与内容不再矛盾', primaryLabel(r2.view));

  /* 3. 无 saved：自动识别行为不变（西语标签 / 英文标签） */
  var r3 = await renderOpp(seededStore(makeOpp('fx3', ES_TEXT, null)), 'fx3');
  ok(primaryLabel(r3.view).indexOf('发送稿（西班牙语') === 0, '3. 无 saved 西语仍标西班牙语', primaryLabel(r3.view));
  var r3b = await renderOpp(seededStore(makeOpp('fx3b', EN_TEXT, null)), 'fx3b');
  ok(primaryLabel(r3b.view) === '英文正文（发给买家的就是这份）', '3b. 无 saved 英文仍标英文正文', primaryLabel(r3b.view));

  /* 4. 历史英文草稿：内容与标签行为（中性标签，内容不变） */
  var r4 = await renderOpp(seededStore(makeOpp('fx4', EN_TEXT, EN_DRAFT)), 'fx4');
  ok(primaryContent(r4.view).indexOf('Thanks for your inquiry') >= 0 && primaryLabel(r4.view) === '已保存发送稿（发给买家的就是这份）',
    '4. 历史英文草稿显示不变', primaryLabel(r4.view));

  /* 5. 打开详情不修改直接保存：edited 不被误标（基线=saved） */
  var store5 = seededStore(makeOpp('fx5', ES_TEXT, RU_DRAFT));
  var r5 = await renderOpp(store5, 'fx5');
  r5.boot.document.getElementById('ra-en').value = RU_DRAFT;
  r5.boot.document.getElementById('ra-zh').value = ZH_DRAFT;
  fireRaSave(r5.boot, 'fx5');
  await sleep(50);
  var d5 = storedDrafts(store5, 'fx5');
  var k5 = Object.keys(d5)[0];
  ok(!!k5 && d5[k5].edited === false && d5[k5].en === RU_DRAFT, '5. 无改动保存 edited 保持 false', JSON.stringify(d5[k5] || {}));

  /* 6. 真正编辑后保存：edited=true 且内容更新 */
  var store6 = seededStore(makeOpp('fx6', ES_TEXT, RU_DRAFT));
  var r6 = await renderOpp(store6, 'fx6');
  r6.boot.document.getElementById('ra-en').value = RU_DRAFT + '\nP.S. ok';
  r6.boot.document.getElementById('ra-zh').value = ZH_DRAFT;
  fireRaSave(r6.boot, 'fx6');
  await sleep(50);
  var d6 = storedDrafts(store6, 'fx6');
  var k6 = Object.keys(d6)[0];
  ok(!!k6 && d6[k6].edited === true && d6[k6].en.indexOf('P.S. ok') >= 0, '6. 编辑后 edited=true 且内容已更新', JSON.stringify(d6[k6] || {}));

  /* 7. 无 saved 时保存行为与生产版逐项一致（同夹具同操作，候选版 vs HEAD 版对照）。
     注：详情渲染会回填商机默认值，使保存时再生成的基线与渲染时不同，
     「原样保存是否标 edited」在生产版即为既有行为，本项只验不回归。 */
  var headApp = require('child_process').execSync('git show HEAD:assets/app.js', { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).toString();
  async function verbatimSave(appSrc) {
    var st = seededStore(makeOpp('fx7', EN_TEXT, null));
    var rr = await renderOpp(st, 'fx7', appSrc);
    var fEn = unesc(primaryContent(rr.view));
    var zI = rr.view.indexOf('<textarea id="ra-zh"');
    var fZh = unesc(rr.view.slice(rr.view.indexOf('>', zI) + 1, rr.view.indexOf('</textarea>', zI)));
    rr.boot.document.getElementById('ra-en').value = fEn;
    rr.boot.document.getElementById('ra-zh').value = fZh;
    fireRaSave(rr.boot, 'fx7');
    await sleep(50);
    var dd = storedDrafts(st, 'fx7');
    var kk = Object.keys(dd)[0];
    return kk ? dd[kk] : null;
  }
  var candSave = await verbatimSave(null);
  var headSave = await verbatimSave(headApp);
  ok(!!candSave && !!headSave && candSave.edited === headSave.edited && candSave.en === headSave.en && candSave.zh === headSave.zh,
    '7. 无 saved 保存行为与生产版一致（edited/en/zh 逐项相同）',
    'cand=' + JSON.stringify(candSave) + ' head=' + JSON.stringify(headSave));

  console.log('\n总计: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.log('ERROR', e && e.stack || e); process.exit(1); });
