/* 阶段二：智能匹配单元测试（纯 Node，无依赖）
   运行：node tests/test-smart-match.js
   商品与询盘全部虚构，不涉及真实商品与成本数据。 */
'use strict';
global.window = global;
require('../assets/matching.js');
require('../assets/smart-match.js');
var SM = global.SmartMatch;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function eq(name, got, want) { ok(name + ' (=' + want + ')', got === want, 'got ' + got); }

var KETTLE_A = { id: 'pA', sku: 'KT-220A', title: 'Electric Kettle 220V 1500W 1.8L Stainless Steel', titleEn: '', category: '电水壶', keywords: ['kettle', 'electric kettle'], specs: '220V 1500W 1.8L', specsEn: '', certs: ['CE', 'RoHS'], moq: 500 };
var KETTLE_B = { id: 'pB', sku: 'KT-110B', title: 'Electric Kettle 110V 1200W 1.7L', titleEn: '', category: '电水壶', keywords: ['kettle'], specs: '110V 1200W 1.7L', specsEn: '', certs: [], moq: 1000 };
var EARBUDS = { id: 'pC', sku: 'EB-01', title: 'TWS Bluetooth Earbuds Wireless Headphones', titleEn: '', category: '耳机', keywords: ['earbuds', 'tws', 'headphones'], specs: '', specsEn: '', certs: ['CE', 'FCC'], moq: 100 };
var RX800 = { id: 'pD', sku: 'ES800', title: 'ELRS Receiver ES800 2.4G', titleEn: '', category: '接收机', keywords: ['receiver', 'elrs'], specs: '', specsEn: '', certs: [], moq: 50 };
var RX900 = { id: 'pE', sku: 'ES900', title: 'ELRS Receiver ES900 2.4G', titleEn: '', category: '接收机', keywords: ['receiver', 'elrs'], specs: '', specsEn: '', certs: [], moq: 50 };

function effBase() {
  return { productName: '', productText: '', models: [], types: [], specs: [], certs: [], qty: 0, purpose: '', edited: {} };
}

/* 1. 规格冲突：同名商品，220V 全中 vs 110V 全错 */
var eff1 = effBase();
eff1.productName = 'electric kettle';
eff1.specs = [{ name: '电压', value: '220 V' }, { name: '功率', value: '1500 W' }, { name: '容量', value: '1.8 L' }];
eff1.qty = 3000; eff1.certs = ['CE'];
var a1 = SM.assess(eff1, '', KETTLE_A);
var b1 = SM.assess(eff1, '', KETTLE_B);
ok('220V 商品规格全命中', a1.conflicts.length === 0, a1.conflicts.join(';'));
ok('220V 商品高匹配', a1.level === '高' && a1.score >= 75, 'score=' + a1.score);
ok('110V 商品关键冲突', b1.keyConflict === true);
ok('110V 商品被封顶 ≤59', b1.score <= 59, 'score=' + b1.score);
ok('冲突写明电压不符', b1.conflicts.some(function (x) { return x.indexOf('电压不符') >= 0; }), b1.conflicts.join(';'));
ok('冲突给出向买家确认的问题', b1.questions.length >= 1);

/* 2. 多候选排序：对的排第一，冲突的排最后 */
var ranked = SM.rank(eff1, '', [{ product: KETTLE_B }, { product: EARBUDS }, { product: KETTLE_A }]);
eq('排序第一是 220V 水壶', ranked[0].product.id, 'pA');
eq('排序最后是 110V 水壶（冲突靠后）', ranked[2].product.id, 'pB');

/* 3. 人工修正优先：原文型号不参与，修正后的型号说了算 */
var eff3 = effBase();
eff3.models = ['ES800'];           /* 模拟 effectiveParsed 已用 parseEdits 覆盖自动识别的 ES900 */
eff3.edited = { modelsText: true };
eff3.types = ['rx'];
eff3.productName = 'ELRS receiver';
var d3 = SM.assess(eff3, 'inquiry about ES900 receiver', RX800);
var e3 = SM.assess(eff3, 'inquiry about ES900 receiver', RX900);
ok('修正型号命中', d3.dims.model.status === 'hit');
ok('命中理由带人工修正来源', d3.hits.some(function (x) { return x.indexOf('人工修正') >= 0; }), d3.hits.join(';'));
ok('与修正型号不符=关键冲突', e3.keyConflict === true && e3.score <= 49, 'score=' + e3.score);
ok('冲突理由写明型号不符', e3.conflicts.some(function (x) { return x.indexOf('型号不符') >= 0; }));

/* 4. 缺失信息：不编造、不误判高分 */
var eff4 = effBase();
var c4 = SM.assess(eff4, '', EARBUDS);
eq('全缺失时分数为 0', c4.score, 0);
eq('全缺失时型号维度为 na', c4.dims.model.status, 'na');
ok('全缺失不产生虚假命中', c4.hits.length === 0, c4.hits.join(';'));
var eff4b = effBase(); eff4b.productName = 'TWS bluetooth earbuds';
var c4b = SM.assess(eff4b, '', EARBUDS);
var a4b = SM.assess(eff4b, '', KETTLE_A);
ok('只有名称时耳机靠名称得分', c4b.score > a4b.score, c4b.score + ' vs ' + a4b.score);
eq('没提认证时认证维度 na', c4b.dims.certs.status, 'na');

/* 5. MOQ 闸门：其它全对，数量不够也被封顶 */
var eff5 = effBase();
eff5.productName = 'electric kettle';
eff5.specs = eff1.specs; eff5.certs = ['CE']; eff5.qty = 100;   /* KETTLE_A 的 MOQ 是 500 */
var a5 = SM.assess(eff5, '', KETTLE_A);
ok('低于 MOQ 为关键冲突', a5.keyConflict === true);
ok('低于 MOQ 封顶 ≤49', a5.score <= 49, 'score=' + a5.score);
ok('冲突写明起订量', a5.conflicts.some(function (x) { return x.indexOf('起订量') >= 0; }));

/* 6. 认证：部分具备扣分并列缺失；完全没信息列未确认 */
var eff6 = effBase(); eff6.productName = 'electric kettle'; eff6.certs = ['CE', 'FDA'];
var a6 = SM.assess(eff6, '', KETTLE_A);
eq('认证维度部分命中', a6.dims.certs.status, 'part');
ok('缺失认证被列出', a6.conflicts.some(function (x) { return x.indexOf('FDA') >= 0; }), a6.conflicts.join(';'));
var b6 = SM.assess(eff6, '', KETTLE_B);
eq('商品无认证信息=未确认', b6.dims.certs.status, 'unknown');
ok('未确认里写明认证', b6.unconfirmed.some(function (x) { return x.indexOf('认证') >= 0; }));

/* 7. 用途弱信号：相符给命中说明，不相符只列未确认、不扣分冤枉 */
var eff7 = effBase(); eff7.productName = 'water bottle'; eff7.purpose = '定制品牌';
var p7 = { id: 'pF', sku: 'WB-1', title: 'Water Bottle OEM Custom Logo', titleEn: '', category: '水杯', keywords: ['bottle'], specs: '', specsEn: '', certs: [], moq: 10 };
var r7 = SM.assess(eff7, '', p7);
ok('用途相符有命中说明', r7.hits.some(function (x) { return x.indexOf('用途') >= 0; }), r7.hits.join(';'));
var r7b = SM.assess(eff7, '', EARBUDS);
ok('用途无法确认只列未确认', r7b.unconfirmed.some(function (x) { return x.indexOf('用途') >= 0; }));

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
