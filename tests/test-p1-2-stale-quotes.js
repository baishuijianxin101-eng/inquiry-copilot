/* P1-2 批次 3 功能二：「待跟进」推导测试（纯 Node，全部虚构数据）
   FollowUp.staleQuotes —— 已报价 + 最近活动（跟进记录/报价版本取晚）
   超过 7 天才入选；缺失/异常时间不误判；全程只读不回写。
   运行：node tests/test-p1-2-stale-quotes.js */
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
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/followup.js'), 'utf8'), sandbox, { filename: 'followup.js' });
var FU = sandbox.FollowUp;
ok('0. FollowUp.staleQuotes 已导出', !!FU && typeof FU.staleQuotes === 'function');

var NOW = Date.parse('2026-11-07T12:00:00.000Z');
function daysAgo(n, extraMs) { return new Date(NOW - n * 86400000 - (extraMs || 0)).toISOString(); }
function opp(o) {
  return Object.assign({ id: 'x', status: 'quoted', followStatus: null, followLog: [], quoteVersions: [] }, o || {});
}

/* 1. 已报价 8 天、无跟进 → 入选 */
var r1 = FU.staleQuotes([opp({ id: 'a', quoteVersions: [{ at: daysAgo(8), unitPriceUsd: 10 }] })], NOW);
ok('1a. 报价 8 天无跟进入选', r1.length === 1 && r1[0].opp.id === 'a' && r1[0].days === 8, JSON.stringify(r1.map(function (x) { return x.days; })));
ok('1b. quoteAt 来自真实报价版本字段', r1.length === 1 && r1[0].quoteAt === daysAgo(8) && r1[0].lastFollowAt === null);

/* 2. 最近跟进在 7 天内 → 不入选（基准取跟进与报价的较晚者） */
var r2 = FU.staleQuotes([opp({ quoteVersions: [{ at: daysAgo(10) }], followLog: [{ at: daysAgo(3), summary: '刚跟进' }] })], NOW);
ok('2. 报价 10 天但 3 天前跟进过，不入选', r2.length === 0);

/* 3. 跟进在报价之前且已超 7 天 → 以报价时间为基准判断 */
var r3 = FU.staleQuotes([opp({ quoteVersions: [{ at: daysAgo(2) }], followLog: [{ at: daysAgo(9), summary: '报价前联系' }] })], NOW);
ok('3. 跟进 9 天但 2 天前重新报价，不入选', r3.length === 0);
var r3b = FU.staleQuotes([opp({ quoteVersions: [{ at: daysAgo(9) }], followLog: [{ at: daysAgo(8), summary: '报价后跟进' }] })], NOW);
ok('3b. 报价后跟进也已 8 天，入选且基准=跟进时间', r3b.length === 1 && r3b[0].baseAt === daysAgo(8) && r3b[0].days === 8);

/* 4. 状态不符合 → 不入选 */
ok('4a. won 不入选', FU.staleQuotes([opp({ status: 'won', quoteVersions: [{ at: daysAgo(30) }] })], NOW).length === 0);
ok('4b. lost 不入选', FU.staleQuotes([opp({ status: 'lost', quoteVersions: [{ at: daysAgo(30) }] })], NOW).length === 0);
ok('4c. new/matched 不入选', FU.staleQuotes([opp({ status: 'matched', quoteVersions: [{ at: daysAgo(30) }] })], NOW).length === 0);
ok('4d. 人工标跟进已完成（done）不入选', FU.staleQuotes([opp({ followStatus: 'done', quoteVersions: [{ at: daysAgo(30) }] })], NOW).length === 0);

/* 5. 时间缺失/异常 → 不误判超期 */
ok('5a. 无报价版本无跟进记录不入选', FU.staleQuotes([opp({})], NOW).length === 0);
ok('5b. 非法时间字符串不入选', FU.staleQuotes([opp({ quoteVersions: [{ at: 'not-a-date' }], followLog: [{ at: '???' }] })], NOW).length === 0);
ok('5c. 部分非法时用合法的较晚者', FU.staleQuotes([opp({ quoteVersions: [{ at: 'bad' }], followLog: [{ at: daysAgo(8) }] })], NOW).length === 1);

/* 6. 边界：恰好 7 天不入选，7 天 +1ms 入选 */
ok('6a. 恰好 7 天不入选（须超过 7 天）', FU.staleQuotes([opp({ quoteVersions: [{ at: daysAgo(7) }] })], NOW).length === 0);
ok('6b. 7 天多 1 毫秒入选', FU.staleQuotes([opp({ quoteVersions: [{ at: daysAgo(7, 1) }] })], NOW).length === 1);

/* 7. 新增跟进记录后重新计算即移出（同一函数、最新数据） */
var o7 = opp({ quoteVersions: [{ at: daysAgo(10) }] });
var before = FU.staleQuotes([o7], NOW);
o7.followLog.push({ at: daysAgo(0), summary: '今天刚跟进' });
var after = FU.staleQuotes([o7], NOW);
ok('7. 补跟进后移出', before.length === 1 && after.length === 0);

/* 8. 只读：入选计算不改动商机任何字段 */
var o8 = opp({ quoteVersions: [{ at: daysAgo(9) }], followLog: [{ at: daysAgo(9), summary: 'x' }] });
var snap = JSON.stringify(o8);
FU.staleQuotes([o8], NOW);
ok('8. 推导全程只读（商机 JSON 不变）', JSON.stringify(o8) === snap);

/* 9. 多条按沉默天数倒序 */
var r9 = FU.staleQuotes([
  opp({ id: 'd9', quoteVersions: [{ at: daysAgo(9) }] }),
  opp({ id: 'd20', quoteVersions: [{ at: daysAgo(20) }] }),
  opp({ id: 'd12', quoteVersions: [{ at: daysAgo(12) }] })
], NOW);
ok('9. 多条按天数倒序', r9.map(function (x) { return x.opp.id; }).join(',') === 'd20,d12,d9', r9.map(function (x) { return x.opp.id; }).join(','));

console.log('== p1-2-stale-quotes: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
