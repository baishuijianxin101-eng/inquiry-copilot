'use strict';
/* P1-9 定点修复测试：型号短型号识别/误报、歧义提示优先、标题随修正值、真实目录排序。
   运行：node tests/test-p1-9-fixes.js（只用虚拟数据 + 包内公开演示目录） */
const fs = require('fs'), vm = require('vm'), path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); } }
const store = new Map();
const sb = { console };
sb.window = sb;
sb.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
vm.createContext(sb);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js', 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js', 'assets/p0-parse.js', 'assets/decision-desk.js', 'assets/seed-state.js']
  .forEach(f => vm.runInContext(R(f), sb, { filename: f }));
const P0 = sb.P0Parse, M = sb.Matching, D = sb.DecisionDesk;
const models = (t) => (P0.extract(t).fields.models || []);

/* ---- 修复 1：型号识别 ---- */
ok('1a. XR4 被识别', models('We need 500 pcs RadioMaster XR4 receiver.').includes('XR4'), JSON.stringify(models('We need 500 pcs RadioMaster XR4 receiver.')));
ok('1b. XR4 Gemini X 文本识别 XR4', models('Please quote XR4 Gemini X receiver, 200 pcs.').includes('XR4'));
ok('1c. RP3 被识别', models('Quote RP3 receiver please.').includes('RP3'));
ok('1d. RP3 V2 识别 RP3（V2 不单独成型号）', (() => { const ms = models('Quote the RP3 V2 version, 100 pcs.'); return ms.includes('RP3') && !ms.includes('V2'); })(), JSON.stringify(models('Quote the RP3 V2 version, 100 pcs.')));
ok('1e. 标点边界：(XR4), 可识别', models('Need (XR4), 100 pcs.').includes('XR4'));
ok('1f. 误报受控：within 25 / USD 12 不成型号（解析侧）', (() => { const ms = models('Please quote the ES900, delivery within 25 days, target USD 12 per pc.'); return ms.includes('ES900') && !ms.some(x => /WITHIN|USD/.test(x)); })(), JSON.stringify(models('Please quote the ES900, delivery within 25 days, target USD 12 per pc.')));
ok('1g. 误报受控：Matching.modelsOf 同文本只剩 es900', JSON.stringify(M.modelsOf('Please quote the ES900 within 25 days, our target is USD 12 per pc.')) === '["es900"]', JSON.stringify(M.modelsOf('Please quote the ES900 within 25 days, our target is USD 12 per pc.')));
ok('1h. 无型号普通询盘不造型号', models('Hello, we need some receivers for FPV drones, please send your catalog.').length === 0, JSON.stringify(models('Hello, we need some receivers for FPV drones, please send your catalog.')));
ok('1i. 多型号文本两个都识别', (() => { const ms = models('Compare XR4 and RP3 receivers, 100 pcs each.'); return ms.includes('XR4') && ms.includes('RP3'); })(), JSON.stringify(models('Compare XR4 and RP3 receivers, 100 pcs each.')));
ok('1j. 商品侧 modelsOf 仍能提 XR4', M.modelsOf('XR4 Gemini X ExpressLRS Plastic Receiver').includes('xr4'));

/* ---- 修复 1：真实演示目录排序 ---- */
const st = sb.Core.get();
const xr = D.analyze('Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days. Our target price is USD 11 per pc.', st.products, st.settings, null);
ok('1k. 真实目录：XR4 商品排第一', /XR4/.test(xr.candidates[0].product.title), xr.candidates[0].product.title);
ok('1l. 真实目录：前两名都是 XR4 商品', /XR4/.test(xr.candidates[1].product.title), xr.candidates[1].product.title);
ok('1m. 真实目录：RP3 V2 不再占据首位', !/RP3/.test(xr.candidates[0].product.title));

/* ---- 修复 2：歧义/成本四组合 ---- */
const P = (o) => Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 10, leadTimeDays: 15, stock: '' }, o);
const settings = { fxRate: 7.1, sellerName: 'Test Seller' };
const ambText = 'Please quote 300 pcs ELRS nano receiver 2.4GHz for FPV drones. Our target price is USD 4 per pc.';
const pairCost = [P({ sku: 'PB', title: 'BAYCK ELRS Nano Receiver 2.4GHz 915MHz', keywords: ['elrs receiver', 'nano receiver', '2.4ghz receiver'], specs: '2.4GHz 915MHz ELRS', priceUsd: 4.18, priceFloorUsd: 0, costRmb: 20 }),
  P({ sku: 'PE', title: 'Happymodel ELRS Nano Receiver 2.4GHz', keywords: ['elrs receiver', 'nano receiver', '2.4ghz receiver'], specs: '2.4GHz ELRS', priceUsd: 5, priceFloorUsd: 0, costRmb: 22 })];
const pairNoCost = pairCost.map(p => Object.assign({}, p, { costRmb: 0 }));
const cAmbCost = D.analyze(ambText, pairCost, settings, null);
ok('2a. 歧义+有成本 → 需要人工核实', cAmbCost.ambiguous && cAmbCost.readiness.key === 'need-verify', cAmbCost.readiness.key);
const cAmbNoCost = D.analyze(ambText, pairNoCost, settings, null);
ok('2b. 歧义+缺成本 → 仍优先显示需要人工核实', cAmbNoCost.ambiguous && cAmbNoCost.readiness.key === 'need-verify', cAmbNoCost.readiness.key + '|' + cAmbNoCost.readiness.why);
ok('2c. 歧义+缺成本 → why 附带缺成本信息', /缺少采购成本/.test(cAmbNoCost.readiness.why), cAmbNoCost.readiness.why);
ok('2d. 歧义两组合草稿均无我方价格', !/best price is/i.test((cAmbCost.reply || {}).en || '') && !/best price is/i.test((cAmbNoCost.reply || {}).en || ''));
const solo = [P({ sku: 'PA', title: 'RadioMaster XR4 ELRS receiver', keywords: ['xr4', 'elrs receiver'], specs: '2.4GHz', priceUsd: 12.49, priceFloorUsd: 10, costRmb: 55, certs: ['CE'] })];
const soloText = 'Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days.';
const cClearNoCost = D.analyze(soloText, [Object.assign({}, solo[0], { costRmb: 0 })], settings, null);
ok('2e. 无歧义+缺成本 → 缺少成本提示', !cClearNoCost.ambiguous && cClearNoCost.readiness.key === 'missing-cost', cClearNoCost.readiness.key);
const cClearCost = D.analyze(soloText, solo, settings, null);
ok('2f. 无歧义+有成本 → 可以进入报价（原判断不变）', !cClearCost.ambiguous && cClearCost.readiness.key === 'can-quote', cClearCost.readiness.key);

/* ---- 修复 3：标题随修正值 ---- */
ok('3a. 原文摘要含型号与交期', /型号 XR4/.test(xr.summary) && /20 天交期/.test(xr.summary), xr.summary);
const xq = D.analyze('Hello, we need 500 pcs RadioMaster XR4 ELRS receiver 2.4GHz with CE certificate, delivery within 20 days. Our target price is USD 11 per pc.', st.products, st.settings, { qty: '50' });
ok('3b. 改数量 50 → 标题 50 pcs 且与 eff 一致', xq.eff.qty === 50 && /50 pcs/.test(xq.summary) && !/500 pcs/.test(xq.summary), xq.summary);
ok('3c. 买家原文保留未篡改', /500 pcs/.test(xq.rawText));
const nq = D.analyze('Hello, we need some ELRS receivers for FPV drones.', st.products, st.settings, null);
ok('3d. 无数量询盘标题不虚构数量', !/pcs/.test(nq.summary), nq.summary);

console.log('\n== p1-9-fixes: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
