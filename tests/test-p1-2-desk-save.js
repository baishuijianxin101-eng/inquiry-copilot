/* P1-2 批次 1：决策台成果一键沉淀测试（纯 Node，全部虚构数据）
   覆盖：更新既有商机 / 未建档建档 / 演示-真实隔离 / 落盘失败不误报 /
   建档后重绑防重复 / 目标不存在不串写 / 无匹配不动旧选品 /
   草稿场景白名单与中文稿保留 / 无关字段（报价版本、跟进记录）不被破坏。
   运行：node tests/test-p1-2-desk-save.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

function makeWorld(viewPref) {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  var m = {};
  sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  if (viewPref) m['ic_data_view'] = viewPref;
  vm.createContext(sandbox);
  ['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
   'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
   'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  var C = sandbox.Core, D = sandbox.DecisionDesk;
  var st = C.get();
  st.settings = Object.assign({}, st.settings, { fxRate: 7.1, sellerName: 'Test Seller', defaultIncoterm: 'FOB Shenzhen', defaultLeadTimeDays: 15, quoteValidDays: 30 });
  function P(o) { return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '备货' }, o); }
  st.products = [
    P({ sku: 'PA', title: 'RadioMaster XR4 ELRS Receiver 2.4GHz Dual Band', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 12, priceFloorUsd: 10, costRmb: 55, certs: ['CE'] }),
    P({ sku: 'PB', title: 'BAYCK ELRS Nano Receiver 2.4GHz 915MHz', titleEn: 'BAYCK ELRS Nano Receiver', keywords: ['elrs receiver', 'nano receiver'], specs: '2.4GHz 915MHz ELRS', priceUsd: 4.18, priceFloorUsd: 0, costRmb: 20, certs: [] })
  ];
  st.opportunities = [];
  C.persist();
  return { sandbox: sandbox, C: C, D: D, st: st, store: m };
}
var TEXT = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days. Our target price is USD 11 per pc.';
function analyzeInto(D, text) {
  var r = D.analyze(text, null, null, null);
  /* analyze 需要商品与设置：直接用 analyze 的完整签名重跑 */
  return r;
}
function runDesk(D, C, text) {
  var st = C.get();
  var r = D.analyze(text, st.products, st.settings, null);
  D._state.text = text;
  D._state.result = r;
  D._state.draft = r.reply ? (r.reply.en || '') : '';
  D._state.baseDraft = D._state.draft;
  return r;
}
function storedOpp(C, m, id) {
  var raw = m[C.STORE_KEY];
  var s = JSON.parse(raw);
  return s.opportunities.filter(function (o) { return o.id === id; })[0] || null;
}

/* ---------- 场景 1：写入既有商机 ---------- */
(function () {
  var w = makeWorld();
  var opp = w.C.normalizeOpp({ id: 't_opp1', buyer: { name: 'Buyer One', country: '西班牙', channel: 'RFQ' }, rawText: TEXT, quote: { qty: 100, unitPriceUsd: 0 } });
  opp.quoteVersions = [{ at: '2026-01-01T00:00:00.000Z', unitPriceUsd: 13, qty: 100, note: '历史报价' }];
  opp.followLog = [{ at: '2026-01-02T00:00:00.000Z', note: '历史跟进', next: '' }];
  opp.replyDrafts = { first: { en: 'OLD EN', zh: '旧稿中文', edited: false, at: null } };
  w.st.opportunities.push(opp);
  w.C.persist();
  var r = runDesk(w.D, w.C, TEXT);
  ok('1a. 分析有可靠匹配', !r.noMatch && r.top && r.top.product.id === 'PA', r.candidates.map(function (c) { return c.product.id; }).join(','));
  w.D._state.targetOppId = 't_opp1';
  var res = w.D.saveToOpp();
  ok('1b. 保存成功（update）', res.ok === true && res.stage === 'update', JSON.stringify(res));
  var o = w.st.opportunities[0];
  ok('1c. parseEdits 已写（qty=500）', o.parseEdits.qty === 500, JSON.stringify(o.parseEdits));
  ok('1d. parseEdits 键名与详情页一致（modelsText/certsText）', /XR4/.test(o.parseEdits.modelsText || '') && /CE/.test(o.parseEdits.certsText || ''), JSON.stringify(o.parseEdits));
  ok('1e. quote.qty 已按 saveParsed 语义同步', o.quote.qty === 500);
  ok('1f. matches 已写且首选 PA', Array.isArray(o.matches) && o.matches.length > 0 && o.matches[0].productId === 'PA', JSON.stringify(o.matches));
  ok('1g. selectedProductId=PA 且 matchOverride 复位', o.selectedProductId === 'PA' && o.matchOverride === false);
  var slot = o.replyDrafts[r.reply.scenario];
  ok('1h. 草稿已存入解析出的场景槽位', !!slot && slot.en === w.D._state.draft, r.reply.scenario);
  ok('1i. 未编辑草稿时中文稿来自本次生成', !!slot && slot.zh === (r.reply.zh || ''));
  ok('1j. 报价版本未被破坏', o.quoteVersions.length === 1 && o.quoteVersions[0].unitPriceUsd === 13);
  ok('1k. 跟进记录未被破坏', o.followLog.length === 1 && o.followLog[0].note === '历史跟进');
  var so = storedOpp(w.C, w.store, 't_opp1');
  ok('1l. 已真正落盘（存储中可见）', !!so && so.parseEdits.qty === 500 && so.selectedProductId === 'PA');
})();

/* ---------- 场景 2：人工编辑过的草稿——保留原中文稿 ---------- */
(function () {
  var w = makeWorld();
  var opp = w.C.normalizeOpp({ id: 't_opp2', buyer: { name: 'Buyer Two' }, rawText: TEXT });
  w.st.opportunities.push(opp);
  w.C.persist();
  var r = runDesk(w.D, w.C, TEXT);
  var key = r.reply.scenario;
  opp.replyDrafts = {}; opp.replyDrafts[key] = { en: 'OLD', zh: '必须保留的中文稿', edited: false, at: null };
  w.D._state.draft = r.reply.en + '\nP.S. 手工加的一行';
  w.D._state.targetOppId = 't_opp2';
  var res = w.D.saveToOpp();
  var slot = w.st.opportunities[0].replyDrafts[key];
  ok('2a. 编辑后保存成功', res.ok === true, JSON.stringify(res));
  ok('2b. 英文稿为人工编辑版且 edited=true', !!slot && slot.edited === true && /手工加的一行/.test(slot.en));
  ok('2c. 原中文稿未被空值覆盖', !!slot && slot.zh === '必须保留的中文稿', slot && slot.zh);
})();

/* ---------- 场景 3：未建档——先建档后保存，且不重复建档 ---------- */
(function () {
  var w = makeWorld();
  runDesk(w.D, w.C, TEXT);
  w.D._state.targetOppId = '';
  var res = w.D.saveToOpp();
  ok('3a. 建档+保存成功（create）', res.ok === true && res.stage === 'create', JSON.stringify(res));
  ok('3b. 恰好新建一条商机', w.st.opportunities.length === 1, String(w.st.opportunities.length));
  var o = w.st.opportunities[0];
  ok('3c. 新商机原文与成果齐全', o.rawText === TEXT && o.parseEdits.qty === 500 && o.selectedProductId === 'PA');
  ok('3d. 目标已重绑到新商机', w.D._state.targetOppId === o.id);
  var res2 = w.D.saveToOpp();
  ok('3e. 再次点击走更新、不再建档', res2.ok === true && res2.stage === 'update' && w.st.opportunities.length === 1, JSON.stringify(res2));
})();

/* ---------- 场景 4：演示视图建档隔离 ---------- */
(function () {
  var w = makeWorld('demo');
  runDesk(w.D, w.C, TEXT);
  var res = w.D.saveToOpp();
  var o = w.st.opportunities[0];
  ok('4a. 演示视图建档成功且 demo=true', res.ok === true && !!o && o.demo === true, JSON.stringify(res));
  ok('4b. 只在演示视图可见', w.C.visibleOpps(w.st, 'demo').length === 1 && w.C.visibleOpps(w.st, 'real').length === 0);
})();

/* ---------- 场景 5：落盘失败不误报（身份事务锁定） ---------- */
(function () {
  var w = makeWorld();
  var opp = w.C.normalizeOpp({ id: 't_opp5', buyer: { name: 'Buyer Five' }, rawText: TEXT });
  w.st.opportunities.push(opp);
  w.C.persist();
  runDesk(w.D, w.C, TEXT);
  w.D._state.targetOppId = 't_opp5';
  w.sandbox.IdentityTxn = { isLocked: function () { return true; } };
  var res = w.D.saveToOpp();
  ok('5a. 更新落盘失败被如实报告', res.ok === false && res.stage === 'persist-failed', JSON.stringify(res));
  var so = storedOpp(w.C, w.store, 't_opp5');
  ok('5b. 存储中的商机未被写入', !!so && !(so.parseEdits && so.parseEdits.qty === 500));
  var res2 = w.D.saveToOpp();
  ok('5c. 建档落盘失败被如实报告', res2.ok === false, JSON.stringify(res2));
  w.D._state.targetOppId = '';
  var res3 = w.D.saveToOpp();
  ok('5d. 锁定下建档失败且不留残商机', res3.ok === false && res3.stage === 'create-failed' && w.st.opportunities.length === 1, JSON.stringify(res3) + ' n=' + w.st.opportunities.length);
  delete w.sandbox.IdentityTxn;
})();

/* ---------- 场景 6：目标不存在——不串写 ---------- */
(function () {
  var w = makeWorld();
  var opp = w.C.normalizeOpp({ id: 't_opp6', buyer: { name: 'Buyer Six' }, rawText: TEXT });
  w.st.opportunities.push(opp);
  w.C.persist();
  runDesk(w.D, w.C, TEXT);
  w.D._state.targetOppId = 'does-not-exist';
  var res = w.D.saveToOpp();
  var so = storedOpp(w.C, w.store, 't_opp6');
  ok('6a. 目标不存在时明确失败', res.ok === false && res.stage === 'target-missing', JSON.stringify(res));
  ok('6b. 其他商机未被串写', !!so && !(so.parseEdits && so.parseEdits.qty === 500) && w.st.opportunities.length === 1);
})();

/* ---------- 场景 7：无可靠匹配——不动旧选品与旧匹配 ---------- */
(function () {
  var w = makeWorld();
  var opp = w.C.normalizeOpp({ id: 't_opp7', buyer: { name: 'Buyer Seven' }, rawText: 'some text' });
  opp.selectedProductId = 'PB';
  opp.matches = [{ productId: 'PB', score: 88, reason: '旧匹配' }];
  w.st.opportunities.push(opp);
  w.C.persist();
  var r = runDesk(w.D, w.C, 'Please send me your catalog and company profile, we are a distributor looking for new suppliers in general.');
  ok('7a. 该文本无可靠匹配', r.noMatch === true, r.candidates.map(function (c) { return Math.round(c.score); }).join(','));
  w.D._state.targetOppId = 't_opp7';
  var res = w.D.saveToOpp();
  var o = w.st.opportunities[0];
  ok('7b. 保存本身成功（解析修正可写）', res.ok === true, JSON.stringify(res));
  ok('7c. 旧选品与旧匹配原样保留', o.selectedProductId === 'PB' && o.matches.length === 1 && o.matches[0].reason === '旧匹配');
})();

/* ---------- 场景 8：草稿场景白名单 ---------- */
(function () {
  var w = makeWorld();
  var fake = { noMatch: true, candidates: [], top: null, eff: { qty: 10 }, reply: { scenario: 'auto', en: 'x', zh: '' } };
  var p = w.D.buildSavePayload(fake, fake.eff, 'draft text', 'draft text');
  ok('8a. 非白名单场景（auto）不生成草稿槽位', p.draftSlot === null);
  fake.reply.scenario = 'first';
  var p2 = w.D.buildSavePayload(fake, fake.eff, 'draft text', 'draft text');
  ok('8b. 白名单场景生成槽位', !!p2.draftSlot && p2.draftSlot.key === 'first' && p2.draftSlot.en === 'draft text');
  var p3 = w.D.buildSavePayload(fake, fake.eff, '', '');
  ok('8c. 空草稿不生成槽位', p3.draftSlot === null);
})();

console.log('== p1-2-desk-save: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
