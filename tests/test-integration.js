/* 发布前整合测试：旧数据兼容 + 五阶段链路联动（纯 Node）
   运行：node tests/test-integration.js
   用仓库自带的 238 条商品种子与「旧格式」商机（五阶段之前的数据形状）
   验证：规范化不丢数据、全链路不报错、往返持久化稳定。 */
'use strict';
global.window = global;
global.localStorage = { _d: {}, getItem: function (k) { return k in this._d ? this._d[k] : null; }, setItem: function (k, v) { this._d[k] = String(v); }, removeItem: function (k) { delete this._d[k]; } };
require('../assets/seed-state.js');
require('../assets/core.js');
require('../assets/matching.js');
require('../assets/p0-parse.js');
require('../assets/smart-match.js');
require('../assets/opp-score.js');
require('../assets/reply-assistant.js');
require('../assets/followup.js');
var Core = global.Core, SM = global.SmartMatch, OS = global.OppScore, RA = global.ReplyAssistant, FU = global.FollowUp;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}

/* 1. 238 条商品：规范化后数量、SKU、公开字段完整，且本来就不含成本字段 */
var raw = global.SEED_STATE.products;
var norm = raw.map(function (p) { return Core.normalizeProduct(JSON.parse(JSON.stringify(p))); });
ok('商品数量仍是 238', norm.length === 238, String(norm.length));
ok('SKU 全部保留', norm.every(function (p, i) { return p.sku === raw[i].sku; }));
ok('种子商品不含成本字段值', raw.every(function (p) { return !(Number(p.costRmb) > 0); }));

/* 2. 旧格式商机（无 parseEdits/valueNote/replyDrafts/followStatus，followLog 只有 at/note） */
var legacy = {
  id: 'opp_legacy', status: 'quoted',
  buyer: { name: 'Old Buyer', company: 'Legacy GmbH', country: '德国', channel: 'RFQ' },
  rawText: 'Hi, we need the ES900 receiver, 500 pcs, with CE certificate to Hamburg. Target USD 9.50. Please quote.',
  quote: { qty: 500, targetPriceUsd: 9.5 },
  followLog: [{ at: '2026-10-01T10:00:00.000Z', note: '旧格式备注' }],
  followCount: 1, log: []
};
var n1 = Core.normalizeOpp(JSON.parse(JSON.stringify(legacy)));
ok('旧商机规范化不报错、旧跟进记录保留', n1.followLog.length === 1 && n1.followLog[0].note === '旧格式备注');
ok('新字段给出安全默认值', n1.parseEdits && typeof n1.parseEdits === 'object' && n1.valueNote === null && n1.replyDrafts && typeof n1.replyDrafts === 'object' && (n1.followStatus === null || n1.followStatus === undefined));

/* 3. 链路联动：解析 → 匹配 → 评分 → 回复 → 跟进（模块级，与页面同口径组装 eff） */
var parsed = global.Matching.parse(legacy);
var fields = global.P0Parse.extract(legacy.rawText, parsed).fields;
var eff = {
  productName: fields.productText || '', productText: fields.productText || '',
  models: fields.models || [], types: fields.types || [], specs: fields.specs || [], specsText: '',
  certs: fields.certs || [], qty: fields.qty || parsed.qty || 0,
  targetPriceUsd: fields.targetPriceUsd || parsed.targetPriceUsd || 0,
  country: fields.country || '', destination: fields.destination || '',
  leadTimeDays: fields.leadTimeDays || 0, deadlineText: fields.deadlineText || '',
  incoterm: fields.incoterm || '', purpose: fields.purpose || '', edited: {}
};
ok('解析拿到型号/数量/目标价', eff.models.indexOf('ES900') >= 0 && eff.qty === 500 && eff.targetPriceUsd === 9.5, JSON.stringify({ m: eff.models, q: eff.qty, t: eff.targetPriceUsd }));
var ranked = SM.rank(eff, legacy.rawText, norm.slice(0, 40).map(function (p) { return { product: p }; }));
ok('匹配跑通且 ES900 商品居前', ranked.length > 0 && /ES900/i.test(ranked[0].product.title), ranked.length && ranked[0].product.title);
var best = ranked[0];
var score = OS.score({ opp: n1, eff: eff, match: { score: best.result.score, keyConflict: best.result.keyConflict }, moq: best.product.moq || 0 });
ok('评分产出完整结构', score.total >= 0 && score.dims.length === 6 && !!score.action);
var draft = RA.generate({ opp: n1, eff: eff, product: best.product, match: { score: best.result.score, keyConflict: best.result.keyConflict, conflicts: best.result.conflicts }, price: null, sellerName: 'Test Seller' });
ok('回复生成成功（谈判场景、无价不乱报）', draft.en.length > 50 && draft.scenario === 'negotiation' && !/\$15/.test(draft.en), draft.scenario);
var recFields = FU.draftRecordFields(draft.scenario, draft.scenarioLabel);
recFields.plannedAt = '2026-11-06T09:00:00.000Z';
var rec = FU.addRecord(n1, recFields, '2026-11-02T10:00:00.000Z', 'fu_integration_1');
ok('跟进记录写入旧商机成功', !!rec && n1.followLog.length === 2 && n1.followUpAt === recFields.plannedAt);

/* 4. 往返持久化：JSON 序列化 → 再规范化，新旧记录都在 */
var n2 = Core.normalizeOpp(JSON.parse(JSON.stringify(n1)));
ok('往返后记录数不变', n2.followLog.length === 2);
ok('往返后结构化记录字段完整', n2.followLog.some(function (x) { return x.id === 'fu_integration_1' && x.type === 'price'; }));

/* 5. 全量商品匹配健壮性：238 条逐个 assess 不抛错 */
var threw = 0;
norm.forEach(function (p) { try { SM.assess(eff, legacy.rawText, p); } catch (e) { threw++; } });
ok('238 条商品逐个评分零异常', threw === 0, 'threw=' + threw);

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
