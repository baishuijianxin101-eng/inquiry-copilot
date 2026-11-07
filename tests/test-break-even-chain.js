/* P1-17 第三阶段修复 E：保本价传递链验证（纯 Node，全部虚构数据）
   链路：product.costRmb/shippingRmb + settings.fxRate/feeRate
     → Pricing.evaluate() breakEvenUsd 计算（floorUsd 字段）
     → PricingUnity.resolve() breakEvenUsd（= evaluate.floorUsd）
     → DecisionDesk safePrice.breakEven（= unity.breakEvenUsd，>0 才传，否则 null）
     → ReplyAssistant.generate(price.breakEven) 决定谈判措辞分支
   运行：node tests/test-break-even-chain.js */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var sandbox = { console: console };
sandbox.window = sandbox;
var m = {};
sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
vm.createContext(sandbox);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js',
 'assets/p0-parse.js', 'assets/decision-desk.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var Pricing = sandbox.Pricing, PU = sandbox.PricingUnity, D = sandbox.DecisionDesk;
var settings = { fxRate: 7.1, sellerName: 'Test Seller' };
/* 虚构商品：成本 ¥58、无运费 → 保本 = 58 / (1-实际费率) / 7.1；费率由 Core.feeRateFor 给出（本链路实测为 0，保本 8.17，与 P1-16 案例 E 记录一致） */
var prod = { id: 'A1', sku: 'A1', title: 'RadioMaster XR4 Pro Receiver', titleEn: 'XR4 Pro Receiver', category: '', keywords: ['radiomaster xr4', 'xr4 pro', 'receiver'], specs: '2.4GHz', specsEn: '', certs: ['CE', 'FCC'], moq: 100, leadTimeDays: 15, stock: '', priceUsd: 12.5, priceFloorUsd: 10.8, costRmb: 58 };

/* 1. Pricing.evaluate 的保本计算与手算一致 */
var ev = Pricing.evaluate({ product: prod, qty: 2000, settings: settings });
var feeRate = sandbox.Core.feeRateFor(prod, settings);
var expect = Math.round((58 / (1 - feeRate)) / 7.1 * 100) / 100;
ok('E1. evaluate.floorUsd = 成本/(1-费率)/汇率（费率=' + feeRate + '）', ev.floorUsd === expect, ev.floorUsd + ' vs ' + expect);

/* 2. PricingUnity 三个口径分立且来源正确 */
var unity = PU.resolve({ evaluate: ev, product: prod, unitUsd: ev.unitPriceUsd });
ok('E2. unity.breakEvenUsd === evaluate.floorUsd', unity.breakEvenUsd === ev.floorUsd, unity.breakEvenUsd + ' vs ' + ev.floorUsd);
ok('E3. unity.businessFloorUsd === 商品登记底价 priceFloorUsd', unity.businessFloorUsd === 10.8, String(unity.businessFloorUsd));
ok('E4. unity.quoteFloorUsd === max(保本, 登记底价)', unity.quoteFloorUsd === Math.max(unity.breakEvenUsd, 10.8), String(unity.quoteFloorUsd));
ok('E5. 三个口径互不相等（本例），未混用', unity.breakEvenUsd !== unity.businessFloorUsd && unity.quoteFloorUsd === 10.8 && unity.breakEvenUsd < 10.8, JSON.stringify({ b: unity.breakEvenUsd, f: unity.businessFloorUsd, q: unity.quoteFloorUsd }));

/* 3. 决策台端到端：目标价介于保本与底价之间 → RA 收到真实保本，草稿用中性措辞且警告引用保本数 */
var rDesk = D.analyze('Hello, we bought your XR4 receiver before and it sold well. Please quote your best price for 2,000 pcs, target USD 10.5 per pc, FCC required.', [prod], settings, null);
var warns = ((rDesk.reply && rDesk.reply.warnings) || []).join(' ');
ok('E6. 端到端 unity 保本与链路一致', rDesk.unity && rDesk.unity.breakEvenUsd === ev.floorUsd, rDesk.unity && rDesk.unity.breakEvenUsd);
ok('E7. RA 警告引用真实保本价（证明 breakEven 已传入）', warns.indexOf('保本价 $' + ev.floorUsd.toFixed(2)) >= 0 || warns.indexOf('高于保本价 $' + ev.floorUsd.toFixed(2)) >= 0, warns);
ok('E8. 草稿不把低于底价说成低于成本', ((rDesk.reply && rDesk.reply.en) || '').indexOf('production cost') < 0, (rDesk.reply && rDesk.reply.en) || '');

/* 4. 成本缺失 → unity.breakEvenUsd=0 → safePrice 为 null，RA 走无价分支（保本不被底价冒充） */
var noCost = Object.assign({}, prod, { id: 'A2', sku: 'A2', costRmb: 0 });
var ev2 = Pricing.evaluate({ product: noCost, qty: 100, settings: settings });
var unity2 = PU.resolve({ evaluate: ev2, product: noCost, unitUsd: 0 });
ok('E9. 无成本时保本为 0 而登记底价仍在（不冒充）', unity2.breakEvenUsd === 0 && unity2.businessFloorUsd === 10.8 && unity2.noCost === true, JSON.stringify({ b: unity2.breakEvenUsd, f: unity2.businessFloorUsd }));

console.log('== break-even-chain: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
