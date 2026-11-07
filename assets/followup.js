/* ===========================================================
   followup.js — 客户跟进记录（阶段五）
   全局暴露：window.FollowUp

   与现有架构兼容：记录仍存 opp.followLog（core 对其只做对象过滤，
   结构化字段可完整往返），新记录带 id 与结构化字段，旧记录（只有
   at/note/next）照常展示、不可编辑。本模块只做纯数据操作：
   不发送消息、不编造客户回复——记录内容全部来自用户手动填写，
   或由用户在回复卡上「确认已发送」后从草稿生成（source 标 draft，
   且必须经人工确认，见 app 层弹窗）。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);
  var FU = {};

  FU.TYPES = [
    { key: 'first', label: '首次联系' },
    { key: 'quote', label: '已发送报价' },
    { key: 'spec', label: '规格确认' },
    { key: 'price', label: '价格沟通' },
    { key: 'sample', label: '样品沟通' },
    { key: 'feedback', label: '客户反馈' },
    { key: 'other', label: '其他' }
  ];
  FU.STATUSES = [
    { key: 'todo', label: '待联系' },
    { key: 'waiting', label: '等待客户回复' },
    { key: 'internal', label: '需要内部确认' },
    { key: 'planned', label: '计划再次联系' },
    { key: 'done', label: '已完成' }
  ];

  function typeLabel(key) {
    var t = FU.TYPES.filter(function (x) { return x.key === key; })[0];
    return t ? t.label : '其他';
  }
  function statusLabel(key) {
    var s = FU.STATUSES.filter(function (x) { return x.key === key; })[0];
    return s ? s.label : '待联系';
  }
  function validType(k) { return FU.TYPES.some(function (x) { return x.key === k; }) ? k : 'other'; }
  function validStatus(k) { return FU.STATUSES.some(function (x) { return x.key === k; }) ? k : null; }
  function cap(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }

  /* 构造一条结构化记录；摘要为空则拒绝（不写无内容记录） */
  function makeRecord(fields, atIso, id) {
    fields = fields || {};
    var summary = cap(fields.summary, 500);
    if (!summary) return null;
    return {
      id: id || null,
      at: atIso,
      type: validType(fields.type),
      summary: summary,
      feedback: cap(fields.feedback, 500),
      nextAction: cap(fields.nextAction, 200),
      plannedAt: fields.plannedAt || null,
      source: fields.source === 'draft' ? 'draft' : 'manual'
    };
  }

  /* 追加记录（保持 followLog 时间正序存储，展示时倒序）；
     有计划时间则同步 opp.followUpAt —— 与既有 saveFollow 行为一致 */
  function addRecord(opp, fields, atIso, id) {
    var rec = makeRecord(fields, atIso, id);
    if (!rec || !rec.id) return null;
    opp.followLog = (opp.followLog || []).concat([rec]).slice(-100);
    if (rec.plannedAt) opp.followUpAt = rec.plannedAt;
    return rec;
  }

  function editRecord(opp, id, fields) {
    var log = opp.followLog || [];
    for (var i = 0; i < log.length; i++) {
      if (log[i] && log[i].id === id) {
        var merged = {
          type: fields.type !== undefined ? fields.type : log[i].type,
          summary: fields.summary !== undefined ? fields.summary : log[i].summary,
          feedback: fields.feedback !== undefined ? fields.feedback : log[i].feedback,
          nextAction: fields.nextAction !== undefined ? fields.nextAction : log[i].nextAction,
          plannedAt: fields.plannedAt !== undefined ? fields.plannedAt : log[i].plannedAt,
          source: log[i].source
        };
        var rec = makeRecord(merged, log[i].at, id);
        if (!rec) return false;
        log[i] = rec;
        if (rec.plannedAt) opp.followUpAt = rec.plannedAt;
        return true;
      }
    }
    return false;
  }

  function removeRecord(opp, id) {
    var log = opp.followLog || [];
    var next = log.filter(function (x) { return !(x && x.id === id); });
    if (next.length === log.length) return false;
    opp.followLog = next;
    return true;
  }

  /* 展示用：倒序（最新在前），不动原数组 */
  function recordsDesc(opp) {
    return (opp.followLog || []).slice().sort(function (a, b) {
      return new Date(b.at || 0) - new Date(a.at || 0);
    });
  }

  /* 跟进状态：已成交/丢单恒为已完成（停止提醒，历史保留）；
     人工设置优先；否则按现有事实推导 */
  function deriveStatus(opp) {
    if (!opp) return 'todo';
    if (opp.status === 'won' || opp.status === 'lost') return 'done';
    var manual = validStatus(opp.followStatus);
    if (manual) return manual;
    if (opp.status === 'quoted') return 'waiting';
    if (opp.followUpAt && new Date(opp.followUpAt).getTime() > Date.now()) return 'planned';
    return 'todo';
  }

  /* 到期状态（按天比较，与 workflow.followState 口径一致） */
  function dueState(opp, nowMs) {
    if (!opp || opp.status === 'won' || opp.status === 'lost') return { state: 'done', days: 0 };
    if (!opp.followUpAt) return { state: 'none', days: 0 };
    var due = new Date(opp.followUpAt).getTime();
    if (!isFinite(due)) return { state: 'none', days: 0 };
    var days = Math.round((nowMs - due) / 86400000);
    if (days > 0) return { state: 'overdue', days: days };
    if (days === 0) return { state: 'today', days: 0 };
    return { state: 'future', days: -days };
  }

  /* 排序键：逾期最前 → 今天 → 未来（越近越前）→ 未排 → 已完成最后 */
  function sortRank(opp, nowMs) {
    var d = dueState(opp, nowMs);
    if (d.state === 'done') return [5, 0];
    if (d.state === 'overdue') return [0, -d.days];
    if (d.state === 'today') return [1, 0];
    if (d.state === 'future') return [2, d.days];
    return [3, 0];
  }

  /* 第四阶段草稿 → 跟进记录字段（仅在用户明确确认已发送后由 app 层调用） */
  var DRAFT_TYPE = { first: 'first', prequote: 'other', spec: 'spec', moq: 'other', negotiation: 'price', sample: 'sample', clarify: 'spec' };
  function draftRecordFields(scenario, scenarioLabel) {
    return {
      type: DRAFT_TYPE[scenario] || 'other',
      summary: '已发送英文回复（' + (scenarioLabel || scenario) + '），人工确认已实际发送',
      feedback: '',
      nextAction: '等待客户回复',
      source: 'draft'
    };
  }

  /* P1-2 批次 3：「待跟进」推导（纯计算、只读，绝不回写任何字段）。
     入选条件：状态为已报价（quoted）；跟进状态未被标为已完成；
     以「最近一次有效活动」为基准——最近跟进记录时间（followLog.at）
     与最近报价时间（quoteVersions.at）取较晚者——距今超过 7 天。
     时间字段全部缺失或非法时不入选（缺数据不等于超期）。 */
  function maxValidMs(list, get) {
    var best = 0;
    (list || []).forEach(function (x) {
      var t = Date.parse(get(x) || '');
      if (isFinite(t) && t > best) best = t;
    });
    return best;
  }
  function staleQuotes(opps, nowMs) {
    var out = [];
    (opps || []).forEach(function (o) {
      if (!o || o.status !== 'quoted') return;
      if (deriveStatus(o) === 'done') return;
      var lastFollowMs = maxValidMs(o.followLog, function (r) { return r && r.at; });
      var quoteMs = maxValidMs(o.quoteVersions, function (v) { return v && v.at; });
      var baseMs = Math.max(lastFollowMs, quoteMs);
      if (!baseMs) return;
      var ageMs = nowMs - baseMs;
      if (ageMs > 7 * 86400000) {
        out.push({
          opp: o,
          baseAt: new Date(baseMs).toISOString(),
          lastFollowAt: lastFollowMs ? new Date(lastFollowMs).toISOString() : null,
          quoteAt: quoteMs ? new Date(quoteMs).toISOString() : null,
          days: Math.floor(ageMs / 86400000)
        });
      }
    });
    return out.sort(function (a, b) { return b.days - a.days; });
  }

  FU.typeLabel = typeLabel;
  FU.statusLabel = statusLabel;
  FU.validType = validType;
  FU.validStatus = validStatus;
  FU.makeRecord = makeRecord;
  FU.addRecord = addRecord;
  FU.editRecord = editRecord;
  FU.removeRecord = removeRecord;
  FU.recordsDesc = recordsDesc;
  FU.deriveStatus = deriveStatus;
  FU.dueState = dueState;
  FU.sortRank = sortRank;
  FU.draftRecordFields = draftRecordFields;
  FU.staleQuotes = staleQuotes;
  FU.VERSION = '1.0.0';
  root.FollowUp = FU;
})();
