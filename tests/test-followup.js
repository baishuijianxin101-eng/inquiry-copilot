/* 阶段五：客户跟进记录单元测试（纯 Node，无依赖）
   运行：node tests/test-followup.js
   全部虚构数据；记录内容均模拟用户手动填写，不编造客户行为。 */
'use strict';
global.window = global;
global.localStorage = { _d: {}, getItem: function (k) { return k in this._d ? this._d[k] : null; }, setItem: function (k, v) { this._d[k] = String(v); }, removeItem: function (k) { delete this._d[k]; } };
require('../assets/seed-state.js');
require('../assets/core.js');
require('../assets/followup.js');
var FU = global.FollowUp;
var Core = global.Core;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra || ''); }
}
function freshOpp() {
  return { status: 'new', followLog: [], followCount: 0, followUpAt: null, followStatus: null, lastContactAt: null };
}
var T1 = '2026-11-01T10:00:00.000Z', T2 = '2026-11-02T10:00:00.000Z', T3 = '2026-11-03T10:00:00.000Z';

/* 1. 新增记录：结构化字段齐全、类型白名单、计划时间同步 */
var o1 = freshOpp();
var r1 = FU.addRecord(o1, { type: 'quote', summary: '已把报价单发给客户', feedback: '客户说在比价', nextAction: '等回复后谈样品', plannedAt: '2026-11-06T09:00:00.000Z' }, T1, 'rec1');
ok('记录被创建', !!r1 && o1.followLog.length === 1);
ok('类型与摘要正确', r1.type === 'quote' && r1.summary.indexOf('报价单') >= 0);
ok('客户反馈被保存', r1.feedback === '客户说在比价');
ok('计划时间同步到 followUpAt', o1.followUpAt === '2026-11-06T09:00:00.000Z');
var bad = FU.addRecord(o1, { type: 'nonsense', summary: 'x' }, T2, 'recBad');
ok('非法类型归为 other', bad.type === 'other');
ok('空摘要拒绝写入', FU.addRecord(o1, { type: 'first', summary: '   ' }, T2, 'recEmpty') === null && o1.followLog.length === 2);

/* 2. 倒序展示：最新在前，且不改原数组顺序 */
FU.addRecord(o1, { type: 'first', summary: '第一次联系' }, T3, 'rec3');
var desc = FU.recordsDesc(o1);
ok('倒序第一条是最新', desc[0].id === 'rec3');
ok('原数组仍是正序存储', o1.followLog[0].id === 'rec1');

/* 3. 编辑与删除 */
ok('编辑成功', FU.editRecord(o1, 'rec1', { summary: '已把报价单和规格表发给客户', type: 'spec' }) === true);
var edited = o1.followLog.filter(function (x) { return x.id === 'rec1'; })[0];
ok('编辑后内容更新、时间不变', edited.summary.indexOf('规格表') >= 0 && edited.at === T1 && edited.type === 'spec');
ok('编辑不存在的记录返回 false', FU.editRecord(o1, 'nope', { summary: 'x' }) === false);
ok('删除成功', FU.removeRecord(o1, 'recBad') === true && o1.followLog.length === 2);
ok('重复删除返回 false', FU.removeRecord(o1, 'recBad') === false);

/* 4. 状态推导与人工切换 */
var o4 = freshOpp();
ok('新商机默认待联系', FU.deriveStatus(o4) === 'todo');
o4.status = 'quoted';
ok('已报价默认等待客户回复', FU.deriveStatus(o4) === 'waiting');
o4.followStatus = 'internal';
ok('人工状态优先', FU.deriveStatus(o4) === 'internal');
o4.followStatus = 'planned';
ok('人工切换到计划再次联系', FU.deriveStatus(o4) === 'planned');

/* 5. 逾期判断（按天） */
var now = new Date('2026-11-05T12:00:00').getTime();
var o5 = freshOpp(); o5.followUpAt = '2026-11-03T09:00:00';
ok('两天前到期=逾期', FU.dueState(o5, now).state === 'overdue' && FU.dueState(o5, now).days === 2);
o5.followUpAt = '2026-11-05T09:00:00';
ok('今天到期=today', FU.dueState(o5, now).state === 'today');
o5.followUpAt = '2026-11-08T09:00:00';
ok('未来=future', FU.dueState(o5, now).state === 'future');
o5.followUpAt = null;
ok('未排=none', FU.dueState(o5, now).state === 'none');

/* 6. 已完成商机：状态恒已完成、无逾期、排序沉底、历史保留 */
var o6 = freshOpp(); o6.status = 'won'; o6.followUpAt = '2026-11-01T09:00:00';
o6.followLog = [{ id: 'h1', at: T1, type: 'quote', summary: '历史记录', feedback: '', nextAction: '', plannedAt: null, source: 'manual' }];
ok('已成交状态=done', FU.deriveStatus(o6) === 'done');
ok('已成交不算逾期', FU.dueState(o6, now).state === 'done');
ok('已成交排序沉底', FU.sortRank(o6, now)[0] > FU.sortRank(o5, now)[0]);
ok('历史记录仍可读', FU.recordsDesc(o6).length === 1);

/* 7. 刷新持久化：经 Core.normalizeOpp 往返后结构化字段与状态完整保留 */
var o7 = freshOpp(); o7.id = 'opp_test'; o7.followStatus = 'waiting';
FU.addRecord(o7, { type: 'sample', summary: '样品已寄出（用户填写）', feedback: '', nextAction: '确认收货', plannedAt: '2026-11-09T09:00:00.000Z' }, T2, 'recP');
var round = Core.normalizeOpp(JSON.parse(JSON.stringify(o7)));
ok('持久化后记录保留', round.followLog.length === 1 && round.followLog[0].id === 'recP');
ok('结构化字段完整', round.followLog[0].type === 'sample' && round.followLog[0].nextAction === '确认收货');
ok('followStatus 白名单保留', round.followStatus === 'waiting');
var round2 = Core.normalizeOpp({ id: 'x', followStatus: 'hacked' });
ok('非法 followStatus 被清掉', round2.followStatus === null || round2.followStatus === undefined, String(round2.followStatus));

/* 8. 草稿转记录：字段映射正确且标记来源（仍须 app 层人工确认才调用） */
var df = FU.draftRecordFields('negotiation', '价格谈判回复');
ok('谈判草稿映射价格沟通', df.type === 'price');
ok('草稿记录标明人工确认已发送', df.summary.indexOf('人工确认已实际发送') >= 0 && df.source === 'draft');

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
