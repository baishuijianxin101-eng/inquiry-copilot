/* P0 今日销售行动中心 + 经营驾驶舱。
 * 只读聚合：不新造数据，不假装有数据；每条行动的优先级都带可解释的理由。
 * 依赖：无（可选 P0Cost 用于成本体检汇总）。
 * 时间一律由调用方传入 now（默认当前时间），测试里可注入固定时刻。
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : this;
  var Cost = root.P0Cost || null;

  var VERSION = '1.0.0';
  var DAY = 86400000;
  var HOUR = 3600000;

  var DEFAULTS = {
    limit: 10,
    quoteWarnDays: 3,
    staleDays: 3,
    bigQty: 100,
    bigAmountUsd: 5000
  };

  var STATUS_TEXT = {
    new: '待处理', matched: '已匹配', quoted: '已报价', won: '已成单', lost: '已丢单'
  };

  function num(v, d) {
    if (v === '' || v === null || v === undefined) return d === undefined ? 0 : d;
    var n = Number(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  function round(n, d) {
    var p = Math.pow(10, d === undefined ? 2 : d);
    return Math.round((num(n) + Number.EPSILON) * p) / p;
  }

  function ts(v) {
    if (!v) return 0;
    var t = Date.parse(String(v));
    return isFinite(t) ? t : 0;
  }

  function nowMs(opts) {
    var t = ts(opts && opts.now);
    return t || Date.now();
  }

  function nowIso(opts) {
    return new Date(nowMs(opts)).toISOString();
  }

  function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /* 按自然日算差：10-20 到 10-26 就是逾期 6 天，不因当天几点而变成 7 天 */
  function daysBetween(fromMs, toMs) {
    if (!fromMs || !toMs) return 0;
    var a = Date.parse(dayKey(fromMs));
    var b = Date.parse(dayKey(toMs));
    if (!isFinite(a) || !isFinite(b)) return 0;
    return Math.round((b - a) / DAY);
  }

  function lastTouchMs(o) {
    return Math.max(ts(o.lastContactAt), ts(o.updatedAt), ts(o.createdAt));
  }

  function quoteExpiryMs(o) {
    var q = o.quote || {};
    var validDays = num(q.validDays, 30);
    var base = ts(o.updatedAt) || ts(o.createdAt);
    if (!base || !(validDays > 0)) return 0;
    return base + validDays * DAY;
  }

  function amountOf(o) {
    var q = o.quote || {};
    var qty = num(q.qty, 0);
    var price = num(q.unitPriceUsd, 0);
    return qty > 0 && price > 0 ? round(qty * price, 2) : 0;
  }

  function shortName(o) {
    var b = o.buyer || {};
    return String(b.company || b.name || '未知买家');
  }

  /**
   * 单条商机的优先级。
   * @returns {object} {score, level, reasons[], nextAction, ask, dueAt, overdueDays, waitingDays, amountUsd, status}
   */
  function priorityOf(o, opts) {
    opts = opts || {};
    var now = nowMs(opts);
    var o_ = o || {};
    var status = String(o_.status || 'new');
    var reasons = [];
    var score = 0;
    var ask = '';

    if (status === 'won' || status === 'lost') {
      return {
        score: 0, level: 'done', status: status,
        reasons: ['已' + (status === 'won' ? '成单' : '丢单') + '，无需跟进'],
        nextAction: '', ask: '', dueAt: null, overdueDays: 0, waitingDays: 0, amountUsd: amountOf(o_)
      };
    }

    var touch = lastTouchMs(o_);
    var waitingDays = touch ? Math.max(0, daysBetween(touch, now)) : 0;
    var dueMs = ts(o_.followUpAt);
    var overdueDays = 0;

    if (dueMs) {
      var d = daysBetween(dueMs, now);
      if (d > 0) {
        overdueDays = d;
        score += Math.min(45, 30 + Math.min(15, d * 2));
        reasons.push('跟进已逾期 ' + d + ' 天');
        ask = '今天就联系 ' + shortName(o_) + '，先问清卡在哪一步。';
      } else if (d === 0) {
        score += 36;
        reasons.push('今天到期要跟进');
        ask = '今天把这条跟进做完，别拖到明天。';
      } else if (d >= -2) {
        score += 18;
        reasons.push('2 天内要跟进');
      } else {
        reasons.push(d * -1 + ' 天后跟进');
      }
    } else if (status === 'new') {
      score += 16;
      reasons.push('新询盘还没安排跟进');
      ask = '先回一封确认需求的邮件，并约好下次跟进时间。';
    } else if (status === 'quoted') {
      score += 10;
      reasons.push('还没排下一次跟进');
    }

    if (status === 'quoted') {
      var exp = quoteExpiryMs(o_);
      if (exp) {
        var left = Math.ceil((exp - now) / DAY);
        if (left < 0) {
          score += 30;
          reasons.push('报价已过期 ' + (-left) + ' 天');
          ask = '价格失效了，先确认最新成本再重发报价。';
        } else if (left <= num(opts.quoteWarnDays, DEFAULTS.quoteWarnDays)) {
          score += 24;
          reasons.push('报价 ' + (left === 0 ? '今天' : left + ' 天后') + '到期');
          if (!ask) ask = '提醒客户报价有效期，顺便确认有没有卡点。';
        } else {
          reasons.push('报价还剩 ' + left + ' 天有效');
        }
      }
      score += 8;
    }

    if (status === 'new' || status === 'matched') {
      if (!o_.selectedProductId && !(o_.matches || []).length) {
        score += 8;
        reasons.push('还没匹配商品');
        if (!ask) ask = '先做商品匹配，再回复客户，避免报错型号。';
      }
    }

    if (waitingDays >= 7) {
      score += 22;
      reasons.push(waitingDays + ' 天没动静，客户可能已经凉了');
      if (!ask) ask = '发一条不催单的跟进：给资料、给案例，问还需不需要报价。';
    } else if (waitingDays >= num(opts.staleDays, DEFAULTS.staleDays)) {
      score += 14;
      reasons.push(waitingDays + ' 天没联系');
      if (!ask) ask = '今天补一次联系，别让询盘停在半路。';
    }

    var amount = amountOf(o_);
    if (amount >= num(opts.bigAmountUsd, DEFAULTS.bigAmountUsd)) {
      score += 12;
      reasons.push('报价金额 $' + amount + '，值得老板盯');
    }
    var qty = num((o_.quote || {}).qty, 0);
    if (qty >= num(opts.bigQty, DEFAULTS.bigQty)) {
      score += 6;
      reasons.push('数量 ' + qty + ' 件');
    }

    if (!reasons.length) reasons.push('状态正常，按节奏跟进');

    score = Math.min(100, score);
    var level = score >= 60 ? 'urgent' : (score >= 35 ? 'today' : (score >= 15 ? 'watch' : 'later'));

    if (!ask) {
      ask = status === 'quoted'
        ? '问一句报价收到没有、有没有需要调整的地方。'
        : '确认需求细节（型号/数量/交期），给下一步明确时间。';
    }

    return {
      score: score,
      level: level,
      status: status,
      statusText: STATUS_TEXT[status] || status,
      reasons: reasons.slice(0, 5),
      nextAction: ask,
      ask: ask,
      dueAt: o_.followUpAt || null,
      overdueDays: overdueDays,
      waitingDays: waitingDays,
      amountUsd: amount,
      qty: qty
    };
  }

  function vStep(v, base, step) {
    if (v <= base) return 0;
    return Math.min(15, Math.ceil((v - base) / step) * 5);
  }

  /**
   * 今日行动清单。
   * @param {array} opps normalizeOpp 后的商机
   * @param {object} opts {now, limit, quoteWarnDays, staleDays}
   */
  function actions(opps, opts) {
    opts = opts || {};
    var now = nowMs(opts);
    var limit = Math.max(1, num(opts.limit, DEFAULTS.limit));
    var all = (opps || []).map(function (o) {
      var p = priorityOf(o, opts);
      return Object.assign({
        oppId: o && o.id ? o.id : '',
        buyer: shortName(o || {}),
        country: String(((o || {}).buyer || {}).country || ''),
        createdAt: (o || {}).createdAt || null
      }, p);
    });

    /* 今天要做 = 已逾期 / 今天到期 / 从没安排过跟进 / 已有明确动作 */
    var today = all.filter(function (x) {
      if (x.level === 'done') return false;
      if (x.level === 'urgent' || x.level === 'today') return true;
      if (x.overdueDays > 0) return true;
      if (!x.dueAt && (x.status === 'new' || x.status === 'quoted')) return true;
      return false;
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.waitingDays - b.waitingDays;
    });

    var counts = {
      total: all.length,
      open: all.filter(function (x) { return x.level !== 'done'; }).length,
      urgent: all.filter(function (x) { return x.level === 'urgent'; }).length,
      today: all.filter(function (x) { return x.level === 'today'; }).length,
      watch: all.filter(function (x) { return x.level === 'watch'; }).length,
      overdue: all.filter(function (x) { return x.overdueDays > 0; }).length,
      untouched: all.filter(function (x) { return x.status === 'new' && !x.dueAt; }).length,
      done: all.filter(function (x) { return x.level === 'done'; }).length
    };

    var list = today.slice(0, limit);
    var summary = {
      at: nowIso(opts),
      total: counts.total,
      open: counts.open,
      urgent: counts.urgent,
      overdue: counts.overdue,
      untouched: counts.untouched,
      text: counts.overdue > 0
        ? '今天先处理 ' + counts.overdue + ' 条逾期跟进，再看 ' + counts.urgent + ' 条高优先级询盘。'
        : (list.length > 0
          ? '今天要跟 ' + list.length + ' 条，其中 ' + counts.urgent + ' 条最优先。'
          : '今天没有到期跟进，去开发新询盘或补成本。')
    };

    return {
      ok: true,
      at: summary.at,
      summary: summary,
      counts: counts,
      today: list,
      all: all,
      next: today.slice(limit, limit + 5).map(function (x) { return { oppId: x.oppId, buyer: x.buyer, score: x.score }; })
    };
  }

  /**
   * 基于真实记录的经营指标。没有任何数据时 hasData=false，绝不编造曲线。
   */
  function metrics(opps, orders, opts) {
    opts = opts || {};
    var now = nowMs(opts);
    var list = opps || [];
    var ods = orders || [];
    var out = { ok: true, at: nowIso(opts), hasData: list.length > 0 || ods.length > 0 };

    var byStatus = { new: 0, matched: 0, quoted: 0, won: 0, lost: 0, other: 0 };
    list.forEach(function (o) {
      var s = String((o && o.status) || 'new');
      if (byStatus[s] === undefined) byStatus.other++;
      else byStatus[s]++;
    });

    var overdue = 0, dueToday = 0, upcoming = 0, none = 0;
    list.forEach(function (o) {
      if (!o || o.status === 'won' || o.status === 'lost') return;
      var due = ts(o.followUpAt);
      if (!due) { none++; return; }
      var d = daysBetween(due, now);
      if (d > 0) overdue++;
      else if (d === 0) dueToday++;
      else upcoming++;
    });

    /* 首次响应：createdAt → 第一条跟进记录/第一次联系 */
    var respHours = [];
    list.forEach(function (o) {
      var created = ts(o && o.createdAt);
      if (!created) return;
      var first = 0;
      var log = (o.followLog || []);
      for (var i = 0; i < log.length; i++) {
        var t = ts(log[i] && (log[i].at || log[i].ts || log[i].createdAt));
        if (t && t >= created) { first = t; break; }
      }
      if (!first && ts(o.lastContactAt)) first = ts(o.lastContactAt);
      if (first && first >= created) respHours.push(Math.round((first - created) / HOUR * 10) / 10);
    });
    respHours.sort(function (a, b) { return a - b; });
    var median = 0;
    if (respHours.length) {
      var mid = Math.floor(respHours.length / 2);
      median = respHours.length % 2 ? respHours[mid] : round((respHours[mid - 1] + respHours[mid]) / 2, 1);
    }

    var decided = byStatus.won + byStatus.lost;
    var quotedPlus = byStatus.quoted + decided;

    var revenue = { orders: ods.length, amountUsd: 0, netRmb: 0, last30NetRmb: 0, prev30NetRmb: 0, trendPct: null };
    var from30 = now - 30 * DAY, from60 = now - 60 * DAY;
    ods.forEach(function (o) {
      var net = num(o && o.netRmb, 0);
      var at = ts(o && (o.date || o.createdAt));
      revenue.netRmb += net;
      revenue.amountUsd += num(o && o.amountUsd, 0);
      if (at && at > from30) revenue.last30NetRmb += net;
      else if (at && at > from60) revenue.prev30NetRmb += net;
    });
    revenue.amountUsd = round(revenue.amountUsd, 2);
    revenue.netRmb = round(revenue.netRmb, 2);
    revenue.last30NetRmb = round(revenue.last30NetRmb, 2);
    revenue.prev30NetRmb = round(revenue.prev30NetRmb, 2);
    if (revenue.prev30NetRmb > 0) {
      revenue.trendPct = round((revenue.last30NetRmb - revenue.prev30NetRmb) / revenue.prev30NetRmb * 100, 1);
    } else if (revenue.last30NetRmb > 0) {
      revenue.trendPct = null; /* 上期没有数据：不给百分比，避免 100% 的假象 */
    }

    var text;
    if (!out.hasData) {
      text = '还没有商机或订单数据。先录第一条询盘，指标才会有意义。';
    } else if (revenue.orders === 0) {
      text = '有 ' + list.length + ' 条商机，但还没有成交记录，先跑通"报价 → 成单"。';
    } else {
      text = '在手 ' + (byStatus.new + byStatus.matched + byStatus.quoted) + ' 条商机，近 30 天净利 ¥' + revenue.last30NetRmb + '。';
    }

    return {
      ok: true,
      at: out.at,
      hasData: out.hasData,
      pipeline: {
        open: byStatus.new + byStatus.matched + byStatus.quoted,
        new: byStatus.new, matched: byStatus.matched, quoted: byStatus.quoted,
        won: byStatus.won, lost: byStatus.lost, other: byStatus.other, total: list.length
      },
      followUp: { overdue: overdue, dueToday: dueToday, upcoming: upcoming, none: none },
      response: {
        count: respHours.length,
        medianHours: median,
        slowestHours: respHours.length ? respHours[respHours.length - 1] : 0,
        targetHours: 24,
        onTime: respHours.filter(function (h) { return h <= 24; }).length
      },
      conversion: {
        decided: decided,
        winRatePct: decided > 0 ? round(byStatus.won / decided * 100, 1) : null,
        quoteToWinPct: quotedPlus > 0 ? round(byStatus.won / quotedPlus * 100, 1) : null
      },
      revenue: revenue,
      text: text
    };
  }

  /**
   * 驾驶舱：行动清单 + 经营指标 + （可选）成本体检。
   * @param {object} state {opportunities, orders, products, settings}
   */
  function board(state, opts) {
    var s = state || {};
    var a = actions(s.opportunities || [], opts);
    var m = metrics(s.opportunities || [], s.orders || [], opts);
    var cost = null;
    if (Cost && typeof Cost.audit === 'function' && Array.isArray(s.products)) {
      var c = Cost.audit(s.products, { settings: s.settings, now: nowIso(opts) });
      cost = { total: c.total, block: c.summary.block, warn: c.summary.warn, missingCost: c.summary.missingCost, loss: c.summary.loss, text: c.summary.text };
    }
    var headline = [];
    if (cost && cost.block > 0) headline.push(cost.block + ' 个 SKU 报价前必须先修成本');
    if (a.counts.overdue > 0) headline.push(a.counts.overdue + ' 条跟进已逾期');
    if (m.followUp.none > 0) headline.push(m.followUp.none + ' 条商机还没排跟进');
    if (!headline.length) headline.push('没有阻塞项，按今天的清单推进。');

    return {
      ok: true,
      at: a.at,
      headline: headline,
      actions: a,
      metrics: m,
      cost: cost,
      text: headline[0]
    };
  }

  root.P0Cockpit = {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    STATUS_TEXT: STATUS_TEXT,
    priorityOf: priorityOf,
    actions: actions,
    metrics: metrics,
    board: board,
    quoteExpiryMs: quoteExpiryMs,
    amountOf: amountOf
  };
})();