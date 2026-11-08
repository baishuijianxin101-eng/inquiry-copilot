/* P1-7 多轮消息闭环专项（纯 Node，全部虚构数据）
   覆盖：messages 清洗与老数据兼容 / 买家追加幂等（seed+dup）/ 意向只读
   最新买家消息 / 卖家消息隔离 / 决策台保存真实链路追加+chg 变更注记 /
   协商条件不自动定案 / 备份恢复时间线完整 / 就绪按新数据重算。
   运行：node tests/test-p1-7-messages.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

function makeWorld(store) {
  var sandbox = { console: console };
  sandbox.window = sandbox;
  var m = store || {};
  sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
  vm.createContext(sandbox);
  ['assets/lang-pack.js', 'assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js',
   'assets/workflow.js', 'assets/matching.js', 'assets/smart-match.js',
   'assets/reply-assistant.js', 'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });
  var C = sandbox.Core, D = sandbox.DecisionDesk;
  var st = C.get();
  st.settings = Object.assign({}, st.settings, { fxRate: 7.1, sellerName: 'Test Seller', defaultIncoterm: 'FOB Shenzhen', defaultLeadTimeDays: 15, quoteValidDays: 30 });
  st.products = [{ id: 'PA', sku: 'PA', category: '', title: 'RadioMaster XR4 ELRS Receiver 2.4GHz Dual Band', titleEn: 'RadioMaster XR4 ELRS Receiver', keywords: ['radiomaster xr4', 'elrs receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', specsEn: '', certs: ['CE'], moq: 10, leadTimeDays: 15, stock: '备货', priceUsd: 12, priceFloorUsd: 10, costRmb: 55 }];
  st.opportunities = [];
  C.persist();
  return { sandbox: sandbox, C: C, D: D, st: st, store: m, RA: sandbox.ReplyAssistant, P0: sandbox.P0Parse };
}
var PROD = { id: 'PA', title: 'RadioMaster XR4 ELRS Receiver', sku: 'SKU-1', certs: ['CE'], moq: 10, leadTimeDays: 15 };
function effOf(w, o) {
  var f = (w.P0.extract(o.rawText || '') || {}).fields || {};
  var e = { qty: f.qty || 0, qtyUnit: 'pcs', models: f.models || [], productName: f.productName || '', country: f.country || '', destination: f.destination || '', leadTimeDays: f.deadlineDays || 0, deadlineText: '', purpose: f.purpose || '', certs: f.certs || [], targetPriceUsd: f.targetPriceUsd > 0 ? f.targetPriceUsd : null, targetQty: null, targetAmbiguous: false, incoterm: f.incoterm || '' };
  var pe = o.parseEdits || {};
  if (pe.qty > 0) e.qty = pe.qty;
  if (pe.targetPriceUsd > 0) e.targetPriceUsd = pe.targetPriceUsd;
  if (pe.destination) e.destination = pe.destination;
  if (pe.incoterm) e.incoterm = pe.incoterm;
  if (pe.country) e.country = pe.country;
  if (pe.leadTimeDays > 0) e.leadTimeDays = pe.leadTimeDays;
  return e;
}
function gen(w, o, latest) {
  var input = { opp: o, eff: effOf(w, o), product: PROD, match: { score: 90, keyConflict: false, conflicts: [] }, price: { unit: 11.5, floor: 10 }, sellerName: 'S', scenario: 'auto', lang: 'en', latestText: latest };
  if (latest != null) { /* 与 app.replyGenFor 同口径：议价意向只看最新消息的目标价 */
    var lf = (w.P0.extract(latest) || {}).fields || {};
    input.latestTargetPriceUsd = lf.targetPriceUsd > 0 ? lf.targetPriceUsd : null;
  }
  return w.RA.generate(input);
}

/* ---------- A. 清洗与老数据兼容 ---------- */
(function () {
  var w = makeWorld();
  var legacy = w.C.normalizeOpp({ id: 'a1', buyer: { name: 'L' }, rawText: 'hello 500 pcs' });
  ok('A1 老商机无 messages → 空数组', Array.isArray(legacy.messages) && legacy.messages.length === 0);
  var dirty = w.C.normalizeOpp({ id: 'a2', buyer: { name: 'D' }, rawText: 'x', messages: [
    { at: '2026-11-01T10:00:00.000Z', dir: 'buyer', text: '第一条' },
    { at: '2026-11-01T11:00:00.000Z', dir: 'system', text: '非法方向' },
    { at: 'not-a-date', dir: 'seller', text: '卖家已发' },
    { dir: 'buyer', text: '   ' },
    { at: '2026-11-01T12:00:00.000Z', dir: 'buyer', text: 'x'.repeat(2500), chg: 'y'.repeat(200) }
  ] });
  ok('A2 非法方向/空文本被丢弃', dirty.messages.length === 3, JSON.stringify(dirty.messages.map(function (m) { return m.dir; })));
  ok('A3 超长文本截断 2000、chg 截断 120', dirty.messages[2].text.length === 2000 && dirty.messages[2].chg.length === 120);
  ok('A4 非法 at 被替换为合法时间', /^\d{4}-\d{2}-\d{2}T/.test(dirty.messages[1].at));
  var many = []; for (var i = 0; i < 105; i++) many.push({ at: '2026-11-01T10:00:00.000Z', dir: 'buyer', text: 'm' + i });
  ok('A5 条数上限 100（保留最近）', w.C.normalizeOpp({ id: 'a3', buyer: {}, rawText: 'x', messages: many }).messages.length === 100);
})();

/* ---------- B/C. 追加幂等与最新买家文本 ---------- */
(function () {
  var w = makeWorld();
  var o = w.C.normalizeOpp({ id: 'b1', buyer: { name: 'B' }, rawText: 'We need 500 pcs of XR4 receiver.' });
  ok('C1 无消息时 latestBuyerText = rawText', w.C.latestBuyerText(o) === o.rawText);
  var r1 = w.C.appendBuyerMessage(o, '  Please send the PI for 500 pcs. ');
  ok('B1 正常追加买家消息', r1.added === true && o.messages.length === 1 && o.messages[0].dir === 'buyer');
  ok('C2 latestBuyerText 更新为最新买家消息', w.C.latestBuyerText(o) === 'Please send the PI for 500 pcs.');
  var r2 = w.C.appendBuyerMessage(o, 'Please   send the PI\nfor 500 pcs.');
  ok('B2 规范化重复粘贴被去重', r2.added === false && r2.reason === 'dup' && o.messages.length === 1);
  var r3 = w.C.appendBuyerMessage(o, 'We need 500 pcs of XR4 receiver.');
  ok('B3 与 rawText 相同不重复入线（seed）', r3.added === false && r3.reason === 'seed' && o.messages.length === 1);
  var r4 = w.C.appendSellerMessage(o, 'Our price is $4.20 per pc. Please send the PI to confirm.');
  ok('B4 卖家消息可追加', r4.added === true && o.messages.length === 2);
  ok('C3 卖家消息不影响 latestBuyerText', w.C.latestBuyerText(o) === 'Please send the PI for 500 pcs.');
  ok('F1 卖家价格不污染买家目标价快照', w.C.effSnapshotOf(o).targetPriceUsd == null, JSON.stringify(w.C.effSnapshotOf(o)));
})();

/* ---------- D. 意向只读最新买家消息（真实 generate） ---------- */
(function () {
  var w = makeWorld();
  var oPI = w.C.normalizeOpp({ id: 'd1', buyer: { name: 'D' }, rawText: 'Please send the PI for 500 pcs of XR4 receiver, we will arrange the deposit.' });
  ok('D1 旧调用（无 latestText）按 rawText 判 closing', gen(w, oPI).scenario === 'closing', gen(w, oPI).scenario);
  ok('D2 最新消息转冷 → 旧 PI 信号不覆盖', gen(w, oPI, 'Thanks, we are still comparing suppliers this month.').scenario !== 'closing', gen(w, oPI, 'Thanks, we are still comparing suppliers this month.').scenario);
  var oPlain = w.C.normalizeOpp({ id: 'd2', buyer: { name: 'D' }, rawText: 'We need 500 pcs of XR4 receiver with CE, please quote.' });
  ok('D3 首条普通询盘 + 最新 PI 消息 → closing', gen(w, oPlain, 'Please send the PI for 500 pcs.').scenario === 'closing', gen(w, oPlain, 'Please send the PI for 500 pcs.').scenario);
  var oSeller = w.C.normalizeOpp({ id: 'd3', buyer: { name: 'D' }, rawText: 'We need 500 pcs of XR4 receiver with CE, please quote.', messages: [{ at: '2026-11-02T10:00:00.000Z', dir: 'seller', text: 'Please send the PI and arrange the deposit.' }] });
  ok('D4 卖家消息里的 PI 字样不触发 closing', gen(w, oSeller, w.C.latestBuyerText(oSeller)).scenario !== 'closing', gen(w, oSeller, w.C.latestBuyerText(oSeller)).scenario);
  var oHist = w.C.normalizeOpp({ id: 'd4', buyer: { name: 'D' }, rawText: 'We need 500 pcs of XR4 receiver. Our target price is USD 11 per pc. Please send the PI.' });
  ok('D5 历史目标价不劫持意向：最新消息只要 PI → closing', gen(w, oHist, 'Please send the PI for 500 pcs.').scenario === 'closing', gen(w, oHist, 'Please send the PI for 500 pcs.').scenario);
  /* 注：用 parse 能确认为买家目标价的句式——「reduce the price to $X」
     在既有价格安全口径下角色为 UNKNOWN_PRICE、永不写目标价（P0 冻结
     语义），不属于本轮可改范围。 */
  ok('D6 最新消息重新提价 → negotiation', gen(w, oHist, 'Can you do $9.80 per pc?').scenario === 'negotiation', gen(w, oHist, 'Can you do $9.80 per pc?').scenario);
})();

/* ---------- E. 决策台保存真实链路：追加 + chg + 就绪重算 ---------- */
(function () {
  var w = makeWorld();
  var TEXT = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate for Hamburg. Our target price is USD 11 per pc.';
  var opp = w.C.normalizeOpp({ id: 'e1', buyer: { name: 'Juan', country: '德国', channel: '询盘' }, rawText: TEXT, quote: { qty: 500, unitPriceUsd: 0 } });
  opp.quoteVersions = [{ at: '2026-11-01T00:00:00.000Z', unitPriceUsd: 11.8, qty: 500, note: '首轮报价' }];
  w.st.opportunities.push(opp); w.C.persist();
  var MSG2 = 'Actually we now need 800 pcs of the RadioMaster XR4 receiver instead of 500. Please send the PI for 800 pcs.';
  var r = w.D.analyze(MSG2, w.st.products, w.st.settings, null);
  w.D._state.text = MSG2; w.D._state.result = r;
  w.D._state.draft = r.reply ? (r.reply.en || '') : ''; w.D._state.baseDraft = w.D._state.draft;
  w.D._state.targetOppId = 'e1';
  var res = w.D.saveToOpp();
  ok('E1 保存到已有商机成功', res.ok === true, JSON.stringify(res));
  var o = w.st.opportunities[0];
  ok('E2 时间线新增一条买家消息', o.messages.length === 1 && o.messages[0].dir === 'buyer' && o.messages[0].text === MSG2, JSON.stringify(o.messages));
  ok('E3 变更注记含数量 500 → 800', /数量 500 → 800/.test(o.messages[0].chg || ''), o.messages[0].chg || '(无)');
  ok('E4 parseEdits.qty 已更新为 800', o.parseEdits.qty === 800, JSON.stringify(o.parseEdits));
  ok('E5 rawText 未被改写', o.rawText === TEXT);
  ok('E6 旧 quoteVersions 保留为历史', o.quoteVersions.length === 1 && o.quoteVersions[0].qty === 500);
  ok('E7 最新意向经 Core 来源 → closing', gen(w, o, w.C.latestBuyerText(o)).scenario === 'closing', gen(w, o, w.C.latestBuyerText(o)).scenario);
  var r2 = w.D.analyze(MSG2, w.st.products, w.st.settings, null);
  w.D._state.result = r2; w.D._state.draft = r2.reply ? (r2.reply.en || '') : ''; w.D._state.baseDraft = w.D._state.draft;
  w.D.saveToOpp();
  ok('E8 同一条消息重复保存不重复入线', w.st.opportunities[0].messages.length === 1, 'len=' + w.st.opportunities[0].messages.length);
  var snap = w.C.effSnapshotOf(w.st.opportunities[0]);
  ok('E9 有效字段快照按新数据重算（qty=800）', snap.qty === 800, JSON.stringify(snap));
})();

/* ---------- G. 协商条件不自动定案 ---------- */
(function () {
  var w = makeWorld();
  var o = w.C.normalizeOpp({ id: 'g1', buyer: { name: 'G' }, rawText: 'We need 500 pcs of XR4 receiver with CE for Hamburg.' });
  o.parseEdits = { qty: 500, incoterm: 'FOB' }; /* 模拟「Can you offer FOB Shenzhen?」被解析提及 */
  var g = w.RA.generate({ opp: o, eff: effOf(w, o), product: PROD, match: { score: 90, keyConflict: false, conflicts: [] }, price: null, sellerName: 'S', scenario: 'auto', lang: 'en', latestText: 'Please send the PI for 500 pcs.' });
  ok('G1 closing 稿不把被询问的 FOB Shenzhen 写成已定条件', g.scenario === 'closing' && !/FOB Shenzhen/.test(g.send), g.scenario);
  ok('G2 closing 稿仍把贸易术语列为待确认问题', /trade term/i.test(g.send));
})();

/* ---------- H. 备份/恢复时间线完整 ---------- */
(function () {
  var w = makeWorld();
  var o = w.C.normalizeOpp({ id: 'h1', buyer: { name: 'H' }, rawText: 'We need 500 pcs.' });
  w.C.appendBuyerMessage(o, 'Now 800 pcs please.', '数量 500 → 800');
  w.C.appendSellerMessage(o, 'Quotation sent.');
  w.st.opportunities.push(o); w.C.persist();
  var rawState = JSON.parse(w.store[w.C.STORE_KEY]);
  var so = rawState.opportunities.filter(function (x) { return x.id === 'h1'; })[0];
  ok('H1 落盘数据含完整时间线', so.messages.length === 2 && so.messages[0].chg === '数量 500 → 800');
  var w2 = makeWorld({});
  var restored = w2.C.normalizeOpp(JSON.parse(JSON.stringify(so)));
  ok('H2 恢复清洗后时间线不丢失', restored.messages.length === 2 && restored.messages[1].dir === 'seller' && restored.messages[0].text === 'Now 800 pcs please.');
})();

/* ---------- I. chgNote 规则 ---------- */
(function () {
  var w = makeWorld();
  ok('I1 首次补充不算变更', w.C.chgNote({ qty: null, destination: '', incoterm: '', targetPriceUsd: null }, { qty: 500, destination: '汉堡', incoterm: 'FOB', targetPriceUsd: 3.5 }) === '');
  ok('I2 多字段变更合并注记', w.C.chgNote({ qty: 500, destination: '汉堡', incoterm: 'FOB', targetPriceUsd: 3.5 }, { qty: 800, destination: '鹿特丹', incoterm: 'CIF', targetPriceUsd: 3.2 }) === '数量 500 → 800；目的地 汉堡 → 鹿特丹；贸易术语 FOB → CIF；目标价 $3.50 → $3.20', w.C.chgNote({ qty: 500, destination: '汉堡', incoterm: 'FOB', targetPriceUsd: 3.5 }, { qty: 800, destination: '鹿特丹', incoterm: 'CIF', targetPriceUsd: 3.2 }));
  ok('I3 歧义目标价不生成确定变更', w.C.chgNote({ qty: 500, destination: '', incoterm: '', targetPriceUsd: 3.5 }, { qty: 500, destination: '', incoterm: '', targetPriceUsd: 9.9 }, true) === '');
  ok('I4 值未变不生成注记', w.C.chgNote({ qty: 500, destination: '汉堡', incoterm: '', targetPriceUsd: null }, { qty: 500, destination: '汉堡', incoterm: '', targetPriceUsd: null }) === '');
})();

/* ---------- FIX: 详情页追加的 Core 级等价组合（DOM 处理函数由浏览器链路覆盖） ---------- */
function detailAppend(w, o, text) {
  var before = w.C.effSnapshotOf(o);
  var pf = (w.P0.extract(text) || {}).fields || {};
  var ne = {};
  if (pf.productName) ne.productName = String(pf.productName).slice(0, 160);
  if (pf.models && pf.models.length) ne.modelsText = pf.models.join(', ').slice(0, 160);
  if (pf.qty > 0) ne.qty = Math.round(pf.qty);
  if (pf.targetPriceUsd > 0) ne.targetPriceUsd = Math.round(pf.targetPriceUsd * 100) / 100;
  if (pf.country) ne.country = String(pf.country).slice(0, 160);
  if (pf.destination) ne.destination = String(pf.destination).slice(0, 160);
  if (pf.incoterm) ne.incoterm = String(pf.incoterm).slice(0, 160);
  if (pf.certs && pf.certs.length) ne.certsText = pf.certs.join(', ').slice(0, 160);
  if (pf.deadlineDays > 0) ne.leadTimeDays = Math.round(pf.deadlineDays);
  if (pf.purpose) ne.purpose = String(pf.purpose).slice(0, 160);
  o.parseEdits = w.C.mergeParseEdits(o.parseEdits, ne);
  var after = w.C.effSnapshotOf(o);
  var chg = w.C.chgNote(before, after, false);
  return w.C.appendBuyerMessage(o, text, chg);
}
function deskSave(w, o, text) {
  var r = w.D.analyze(text, w.st.products, w.st.settings, null);
  w.D._state.text = text; w.D._state.result = r;
  w.D._state.draft = r.reply ? (r.reply.en || '') : ''; w.D._state.baseDraft = w.D._state.draft;
  w.D._state.targetOppId = o.id;
  return w.D.saveToOpp();
}

/* ---------- T1. 歧义金额端到端 ---------- */
(function () {
  var w = makeWorld();
  var TEXT = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate for Hamburg. Our target price is USD 11 per pc.';
  var o = w.C.normalizeOpp({ id: 't1', buyer: { name: 'T1' }, rawText: TEXT, quote: { qty: 500, unitPriceUsd: 0 } });
  o.parseEdits = { qty: 500, targetPriceUsd: 11 };
  w.st.opportunities.push(o); w.C.persist();
  var AMB = 'Actually, my target is 1.500 USD per pc for 500 pcs of the XR4 receiver.';
  ok('T1a 前提：歧义金额在 parse 层不写目标价', (w.P0.extract(AMB).fields.targetPriceUsd || 0) === 0);
  var ap = detailAppend(w, o, AMB);
  ok('T1b 歧义消息正常入线', ap.added === true && o.messages.length === 1);
  ok('T1c 旧确定目标价保留、歧义值未写入', o.parseEdits.targetPriceUsd === 11 && w.C.effSnapshotOf(o).targetPriceUsd === 11, JSON.stringify(o.parseEdits));
  ok('T1d chg 不报告目标价变化', !/目标价/.test(o.messages[0].chg || ''), o.messages[0].chg || '(无)');
  ok('T1e 最新消息已更新且不误触发 negotiation', w.C.latestBuyerText(o) === AMB && gen(w, o, w.C.latestBuyerText(o)).scenario !== 'negotiation', gen(w, o, w.C.latestBuyerText(o)).scenario);
})();

/* ---------- T2. 跨入口字段连续性 ---------- */
(function () {
  var w = makeWorld();
  var o = w.C.normalizeOpp({ id: 't2', buyer: { name: 'T2' }, rawText: 'We need 500 pcs of RadioMaster XR4 ELRS receiver with CE certificate. Please quote.', quote: { qty: 500, unitPriceUsd: 0 } });
  w.st.opportunities.push(o); w.C.persist();
  detailAppend(w, o, 'Please ship to Rotterdam port.');
  ok('T2a 详情页入口写入目的地 Rotterdam', o.parseEdits.destination === 'Rotterdam', JSON.stringify(o.parseEdits));
  var MSG3 = 'Thanks, the specs are confirmed. Quantity stays 500 pcs of RadioMaster XR4 receiver.';
  var res = deskSave(w, o, MSG3);
  ok('T2b 决策台保存后续消息成功', res.ok === true, JSON.stringify(res));
  ok('T2c 目的地经决策台保存后仍保留', o.parseEdits.destination === 'Rotterdam', JSON.stringify(o.parseEdits));
  ok('T2d 两条消息完整', o.messages.length === 2, 'len=' + o.messages.length);
  ok('T2e 重算 eff.destination 仍为 Rotterdam', effOf(w, o).destination === 'Rotterdam', effOf(w, o).destination);
})();

/* ---------- T3. 就绪与报价数量重算 ---------- */
(function () {
  var w = makeWorld();
  var TEXT = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate for Hamburg. Our target price is USD 11 per pc.';
  var o = w.C.normalizeOpp({ id: 't3', buyer: { name: 'T3' }, rawText: TEXT, quote: { qty: 500, unitPriceUsd: 0 } });
  o.quoteVersions = [{ at: '2026-11-01T00:00:00.000Z', unitPriceUsd: 11.8, qty: 500, note: '首轮报价' }];
  w.st.opportunities.push(o); w.C.persist();
  var MSG2 = 'Actually we now need 800 pcs of the RadioMaster XR4 receiver instead of 500. Please send the PI for 800 pcs.';
  var res = deskSave(w, o, MSG2);
  ok('T3a 保存成功', res.ok === true, JSON.stringify(res));
  ok('T3b 存储报价数量同步为 800', o.quote.qty === 800, 'qty=' + o.quote.qty);
  /* 就绪与草稿取 analyze 内部对第一名 conclude 的真实产物（决策台 UI 同源） */
  var r = w.D.analyze(MSG2, w.st.products, w.st.settings, null);
  ok('T3c 就绪判断按新数量链路可报价', !!r.readiness && r.readiness.key === 'can-quote', r.readiness ? r.readiness.key : 'no-readiness');
  ok('T3d 结论草稿按 800 件生成（非旧 500）', !!r.reply && /800 pcs/.test(r.reply.send || r.reply.en || ''), r.reply ? (r.reply.send || '').slice(0, 80) : 'no-reply');
  ok('T3e 旧 quoteVersions 未被改写', o.quoteVersions.length === 1 && o.quoteVersions[0].qty === 500);
})();

/* ---------- X. 合并规则与防复活 ---------- */
(function () {
  var w = makeWorld();
  var m1 = w.C.mergeParseEdits({ qty: 500, destination: 'Rotterdam', bogus: 'x' }, { qty: 800 });
  ok('X1 新值覆盖旧值、未提及保留、白名单外键剔除', m1.qty === 800 && m1.destination === 'Rotterdam' && !('bogus' in m1), JSON.stringify(m1));
  var m2 = w.C.mergeParseEdits({ qty: 500 }, {});
  ok('X2 空新值整表保留旧值', m2.qty === 500);
  var o = w.C.normalizeOpp({ id: 'x3', buyer: { name: 'X' }, rawText: 'We need 500 pcs of RadioMaster XR4 ELRS receiver with CE certificate. Please quote.', quote: { qty: 500, unitPriceUsd: 0 } });
  w.st.opportunities.push(o); w.C.persist();
  detailAppend(w, o, 'Please ship to Rotterdam port.');
  /* 模拟详情页解析修正编辑器显式清空：直接从 parseEdits 删除目的地 */
  delete o.parseEdits.destination;
  var res = deskSave(w, o, 'One more thing: please include the datasheet for the XR4 receiver, 500 pcs.');
  ok('X3 清空后决策台保存不复活已清字段', res.ok === true && !o.parseEdits.destination, JSON.stringify(o.parseEdits));
  var snap1 = JSON.stringify(o.parseEdits);
  deskSave(w, o, 'One more thing: please include the datasheet for the XR4 receiver, 500 pcs.');
  ok('X4 重复保存 parseEdits 幂等', JSON.stringify(o.parseEdits) === snap1, JSON.stringify(o.parseEdits));
})();

console.log('\n=== P1-7 messages: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
