/* P1-FIX-02 回归：三个回复入口的缺成本/报价护栏行为统一
   运行：node tests/test-fix02-unified-reply.js
   入口 = 询盘中心（P0Ui.quoteFor/noPriceReplyFor）、决策台
   （DecisionDesk.analyze）、商机详情回复助手（ReplyAssistant.generate，
   即 app.js 详情页实际调用的引擎）。统一口径：
   - 缺成本/零价/低于保本/低于底价时，任何入口都不产生我方价格；
   - 无价草稿统一带「正式报价尚未形成（缺成本或未过报价护栏），
     回复未写任何价格」（ReplyAssistant 同一字符串）；
   - 有安全价时才允许带价草稿。全部虚构数据。 */
'use strict';
var fs = require('fs'), vm = require('vm'), path = require('path');
var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
var sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
sandbox.window = sandbox;
var m = {};
sandbox.localStorage = { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } };
vm.createContext(sandbox);
['assets/core.js', 'assets/pricing.js', 'assets/pricing-unity.js', 'assets/workflow.js',
 'assets/matching.js', 'assets/smart-match.js', 'assets/reply-assistant.js', 'assets/reply.js',
 'assets/p0-parse.js', 'assets/p0-match.js', 'assets/p0-quote.js', 'assets/decision-desk.js',
 'assets/p0-ui.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
});
var P0Ui = sandbox.P0Ui, D = sandbox.DecisionDesk, RA = sandbox.ReplyAssistant;
var Pricing = sandbox.Pricing, PU = sandbox.PricingUnity, P0Parse = sandbox.P0Parse;
ok('0. 三个入口模块已加载', !!P0Ui && !!D && !!RA);

var STD = '正式报价尚未形成（缺成本或未过报价护栏），回复未写任何价格';
function noSellerPrice(text, targetStr) {
  var t = String(text || '');
  if (targetStr) t = t.split(targetStr).join('');
  return !/\$\s*\d/.test(t) && !/USD\s*\d/i.test(t);
}

var prodNoCost = { id: 'NC1', sku: 'NC1', title: 'Fixture Receiver NC', titleEn: 'Fixture Receiver NC', category: '', keywords: [], specs: '2.4GHz ELRS', specsEn: '', certs: [], moq: 1, leadTimeDays: 0, priceUsd: 15.43, priceFloorUsd: 0, costRmb: 0 };
var prodOk = { id: 'OK1', sku: 'OK1', title: 'Fixture Receiver OK', titleEn: 'Fixture Receiver OK', category: '', keywords: [], specs: '2.4GHz ELRS', specsEn: '', certs: [], moq: 1, leadTimeDays: 0, priceUsd: 20, priceFloorUsd: 12, costRmb: 50 };
var LAURA = 'Dear Sales Manager,\n\nWe are interested in Fixture Receiver NC.\n\nQuantity: 100 pcs\nTarget price: USD 16.97 per pc, FOB\nLead time: 30 days\n\nPlease send your best quotation.';
var parsedLaura = P0Parse.extract(LAURA);
var parsedPlain = P0Parse.extract('Please quote 100 pcs of Fixture Receiver NC for resale.');

/* ---------- A. 询盘中心 ---------- */
var a1 = P0Ui.quoteFor(prodNoCost, 100, {});
ok('A1 缺成本：报价被护栏拦截（no_cost）', a1.ok === false && a1.blocked === 'no_cost', JSON.stringify(a1.blocked));
var a1d = P0Ui.noPriceReplyFor(prodNoCost, parsedLaura);
ok('A1 缺成本：生成无价谈判草稿（不再只有警告）', !!a1d && a1d.en.length > 40);
ok('A1 缺成本：草稿未用价（usedPrice=false）', !!a1d && a1d.usedPrice === false);
ok('A1 缺成本：草稿不含我方价格（买家目标价除外）', !!a1d && noSellerPrice(a1d.en, '$16.97'), a1d && a1d.en);
ok('A1 缺成本：统一未确认提示', !!a1d && (a1d.unconfirmed || []).join('；').indexOf(STD) >= 0, a1d && (a1d.unconfirmed || []).join(';'));

var a3 = P0Ui.quoteFor(prodOk, 100, {});
ok('A3 有成本：报价通过护栏', a3.ok === true, JSON.stringify(a3.blocked || a3.message || ''));
var a3r = a3.ok ? P0Ui.replyFor(prodOk, a3, parsedPlain, {}) : '';
ok('A3 有成本：正式报价草稿带护栏价', a3r.indexOf('USD ' + a3.quote.unitPriceUsd.toFixed(2)) >= 0, a3r.slice(0, 120));

var a4 = P0Ui.quoteFor(prodOk, 100, { unitPriceUsd: 5 });
ok('A4 低于保本：报价被拦截', a4.ok === false && a4.blocked === 'below_breakeven', JSON.stringify(a4.blocked));
var a4d = P0Ui.noPriceReplyFor(prodOk, parsedPlain);
ok('A4 低于保本：无价草稿不含任何价格', !!a4d && a4d.usedPrice === false && noSellerPrice(a4d.en), a4d && a4d.en);

/* ---------- B. 决策台 ---------- */
function DP(o) { return Object.assign({ id: o.sku, category: '', keywords: [], specs: '', specsEn: '', certs: [], moq: 1, leadTimeDays: 15, stock: '备货' }, o); }
var deskProducts = [
  DP({ sku: 'DNC', title: 'DeskNoCost ELRS Receiver 2.4GHz', keywords: ['desknocost', 'elrs receiver'], priceUsd: 6, priceFloorUsd: 0, costRmb: 0 }),
  DP({ sku: 'DOK', title: 'DeskOk ELRS Receiver 2.4GHz', keywords: ['deskok', 'elrs receiver'], priceUsd: 12, priceFloorUsd: 10, costRmb: 55 })
];
var deskSettings = { fxRate: 7.1, sellerName: 'Test Seller' };
var b1 = D.analyze('Please quote 100 pcs DeskNoCost ELRS receiver 2.4GHz for resale.', deskProducts, deskSettings, null);
ok('B1 缺成本：决策台草稿未用价', !!b1.reply && b1.reply.usedPrice === false, b1.reply && b1.reply.scenario);
ok('B1 缺成本：决策台草稿不含我方价格', !!b1.reply && noSellerPrice(b1.reply.en), b1.reply && b1.reply.en);
ok('B1 缺成本：统一未确认提示或澄清场景', !!b1.reply && (b1.reply.unconfirmed.join('；').indexOf(STD) >= 0 || b1.reply.scenario === 'prequote' || b1.reply.scenario === 'clarify'), b1.reply && b1.reply.scenario + '/' + b1.reply.unconfirmed.join(';'));
var b3 = D.analyze('Please quote 500 pcs DeskOk ELRS receiver 2.4GHz. Our target price is USD 11 per pc.', deskProducts, deskSettings, null);
ok('B3 有成本：可进入报价且草稿带价', b3.readiness.key === 'can-quote' && !!b3.reply && b3.reply.usedPrice === true, b3.readiness.key + '/' + (b3.reply && b3.reply.usedPrice));
var b4 = D.analyze('Please quote 500 pcs DeskOk ELRS receiver 2.4GHz. Our target price is USD 5 per pc.', deskProducts, deskSettings, null);
/* 决策台 readiness 指「我方能否给出安全报价」，与买家目标价是否可接受是两回事；
   目标价低于保本时，草稿必须走守底价策略：明示低于成本、只给不低于底线的反报价。 */
var b4offer = b4.reply ? /best I can offer for the current specification is \$(\d+\.\d{2})/.exec(b4.reply.en) : null;
ok('B4 目标价低于保本：草稿明示低于成本且反报价不低于底价', !!b4.reply && b4.reply.en.indexOf('below our production cost') >= 0 && !!b4offer && parseFloat(b4offer[1]) >= 10, b4.reply && b4.reply.en.slice(0, 200));
ok('B4 目标价低于保本：警告注明目标价低于保本价', !!b4.reply && (b4.reply.warnings || []).join('；').indexOf('低于保本价') >= 0, b4.reply && (b4.reply.warnings || []).join(';'));

/* ---------- C. 商机详情回复助手（引擎直调，同 app.js:592 路径） ---------- */
var oppC = { buyer: { name: 'Laura', country: 'Spain' }, rawText: LAURA, followCount: 0, status: 'new' };
var effC = { qty: 100, targetPriceUsd: 16.97, productName: 'Fixture Receiver NC', models: [], certs: [], destination: '', country: 'Spain', leadTimeDays: 30, purpose: 'resale' };
var c1 = RA.generate({ opp: oppC, eff: effC, product: prodNoCost, price: null, scenario: 'auto', sellerName: 'Test Seller' });
ok('C1 缺成本：未用价 + 统一未确认提示', c1.usedPrice === false && c1.unconfirmed.join('；').indexOf(STD) >= 0, c1.unconfirmed.join(';'));
ok('C1 缺成本：草稿不含我方价格（买家目标价除外）', noSellerPrice(c1.en, '$16.97'), c1.en);
var c2 = RA.generate({ opp: oppC, eff: effC, product: prodOk, price: { unit: 0, floor: 12, breakEven: 8 }, scenario: 'auto', sellerName: 'Test Seller' });
ok('C2 零价：安全价闸口拒绝 $0（usedPrice=false）', c2.usedPrice === false && noSellerPrice(c2.en, '$16.97'), c2.en);
var effC3 = Object.assign({}, effC, { targetPriceUsd: 13 });
var c3 = RA.generate({ opp: oppC, eff: effC3, product: prodOk, price: { unit: 15, floor: 12, breakEven: 8 }, scenario: 'auto', sellerName: 'Test Seller' });
ok('C3 正常安全价：草稿带价 $15.00', c3.usedPrice === true && c3.en.indexOf('$15.00') >= 0, c3.en.slice(0, 160));
var c4 = RA.generate({ opp: oppC, eff: effC, product: prodOk, price: { unit: 5, floor: 12, breakEven: 8 }, scenario: 'auto', sellerName: 'Test Seller' });
ok('C4 低于底价：安全价闸口拒绝（usedPrice=false）', c4.usedPrice === false && noSellerPrice(c4.en, '$16.97'), c4.en);

/* ---------- D. 共享护栏基线（零价） ---------- */
var settingsD = sandbox.Core.get().settings;
var d0 = Pricing.evaluate({ product: prodOk, qty: 100, settings: settingsD, unitCostRmb: 50, unitPriceUsd: 0 });
ok('D 零价：Pricing 标记 noPrice 且不可报', d0.flags.noPrice === true && d0.flags.canQuote === false);
ok('D 零价：统一口径拦截', PU.resolve({ evaluate: d0, product: prodOk, nego: null }).quotable === false);

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
