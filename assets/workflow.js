/* ===========================================================
   workflow.js — 客服一天的闭环
   1) 议价底线：买家还价时，客服不用问老板就知道能让到哪
   2) 跟进：报价后几天没回，自动提醒、给话术
   3) 今日待办：打开就是今天要做的事，不用一个个翻
   全局暴露：window.Workflow
   =========================================================== */
(function () {
  'use strict';

  var C = window.Core;
  var P = window.Pricing;

  var DAY = 86400000;

  function n(v, d) { return C.num(v, d === undefined ? 0 : d); }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
  function stepOf(s) { var st = n(s && s.quoteStepUsd, 0.1); return st > 0 ? st : 0.1; }
  function downTo(v, step) { return Math.floor(v / step + 1e-9) * step; }

  /* =========================================================
     一、议价底线
     给出：挂到多少、能在哪停、还能让几次、每次让掉多少钱
     ========================================================= */
  function negotiation(opts) {
    opts = opts || {};
    var s = opts.settings || C.get().settings;
    var product = opts.product || null;
    var qty = Math.max(0, n(opts.qty));

    var r = P.evaluate({
      product: product, qty: qty, settings: s,
      unitPriceUsd: opts.unitPriceUsd,
      buyerTargetUsd: opts.buyerTargetUsd
    });

    var minMargin = n(s.minMarginPct, 8) / 100;   /* 最低毛利（占成本），0 = 只保本 */
    var step = stepOf(s);

    if (!(qty > 0) || !product || !n(product.costRmb) && !n(r.costUnitRmb)) {
      return { ok: false, reason: 'noCost', r: r };
    }

    /* 有成本才算得出底线 */
    var keep = 1 - r.feeRate;
    var floorByMarginUsd = r.costUnitRmb > 0
      ? (r.costUnitRmb * (1 + minMargin)) / keep / r.fx
      : 0;
    var floorUsd = Math.max(r.floorUsd, round2(floorByMarginUsd));
    floorUsd = round2(Math.ceil(floorUsd / step - 1e-9) * step);

    var askUsd = r.recommendUsd > 0 ? r.recommendUsd : r.listUsd;
    if (askUsd > 0 && askUsd < floorUsd) askUsd = floorUsd;

    var roomUsd = Math.max(0, round2(askUsd - floorUsd));
    var roomPct = askUsd > 0 ? roomUsd / askUsd : 0;

    /* 每让 1 个 step，这单少赚多少人民币 */
    var perStepRmb = step * qty * r.fx * keep;

    /* 三档：让 1/3、让 2/3、到底 */
    var zones = [1 / 3, 2 / 3, 1].map(function (k, i) {
      var price = round2(downTo(askUsd - roomUsd * k, step));
      if (price < floorUsd) price = floorUsd;
      var net = r.costUnitRmb > 0
        ? (price * qty * r.fx * keep - r.costTotalRmb)
        : 0;
      var margin = r.costTotalRmb > 0 ? net / r.costTotalRmb : 0;
      return {
        label: i === 0 ? '第一口' : i === 1 ? '第二口' : '到底',
        priceUsd: price,
        dropUsd: round2(askUsd - price),
        netRmb: round2(net),
        marginOnCost: margin,
        bottom: i === 2
      };
    });

    var target = n(opts.buyerTargetUsd, 0);
    var targetGapUsd = target > 0 ? round2(target - floorUsd) : null;
    var targetVerdict = target <= 0 ? 'unknown'
      : target + 1e-9 >= floorUsd ? (target >= askUsd ? 'easy' : 'workable')
        : (target >= r.floorUsd ? 'thin' : 'no');

    return {
      ok: true,
      r: r,
      askUsd: round2(askUsd),
      floorUsd: floorUsd,
      breakevenUsd: r.floorUsd,
      minMarginPct: minMargin,
      roomUsd: roomUsd,
      roomPct: roomPct,
      perStepRmb: round2(perStepRmb),
      stepUsd: step,
      zones: zones,
      target: target,
      targetGapUsd: targetGapUsd,
      targetVerdict: targetVerdict
    };
  }

  /* 一句话结论，给客服看 */
  function negoHeadline(ng) {
    if (!ng || !ng.ok) return '没有采购成本，算不出底线——先去商品库补成本。';
    if (ng.roomUsd <= 0) {
      return '已经到底 ' + C.usd(ng.floorUsd) + '，一分都别再让。';
    }
    return '报到 ' + C.usd(ng.askUsd) + '，最多让到 ' + C.usd(ng.floorUsd) +
      '（可让 ' + C.usd(ng.roomUsd) + '，约 ' + Math.round(ng.roomPct * 100) + '%）。';
  }

  function targetText(ng) {
    if (!ng || !ng.ok || !(ng.target > 0)) return '';
    if (ng.targetVerdict === 'no') return '买家目标价 ' + C.usd(ng.target) + '，低过保本价，不能接——只能改规格、加数量或换型号。';
    if (ng.targetVerdict === 'thin') return '买家目标价 ' + C.usd(ng.target) + '，比保本价高但低于底线，接了几乎白做。';
    if (ng.targetVerdict === 'workable') return '买家目标价 ' + C.usd(ng.target) + '，在可让范围内，可以谈。';
    return '买家目标价 ' + C.usd(ng.target) + '，比你的报价还高，直接答应也行。';
  }

  /* =========================================================
     二、跟进
     ========================================================= */
  function followInterval(s) { return Math.max(1, n(s && s.followUpDays, 3)); }

  function startFollow(opp, s, days) {
    if (!opp) return null;
    var d = days || followInterval(s);
    var base = Date.now();
    opp.lastContactAt = C.nowIso();
    opp.followUpAt = new Date(base + d * DAY).toISOString();
    opp.followCount = n(opp.followCount, 0) + 1;
    return opp.followUpAt;
  }

  /* 没有下次跟进时间的旧数据：按上次更新 + 间隔推一个 */
  function followState(opp, s) {
    if (!opp) return { none: true, label: '', cls: '' };
    var at = opp.followUpAt;
    if (!at && (opp.status === 'quoted' || opp.status === 'matched')) {
      var base = new Date(opp.lastContactAt || opp.updatedAt || opp.createdAt || Date.now()).getTime();
      if (isFinite(base)) at = new Date(base + followInterval(s) * DAY).toISOString();
    }
    if (!at) return { none: true, label: '', cls: '' };

    var due = new Date(at).getTime();
    if (!isFinite(due)) return { none: true, label: '', cls: '' };
    var days = Math.round((Date.now() - due) / DAY);
    if (days > 0) {
      return { at: at, overdue: true, days: days, label: '逾期 ' + days + ' 天', cls: 'red' };
    }
    if (days === 0) return { at: at, today: true, days: 0, label: '今天该跟', cls: 'amber' };
    return { at: at, days: -days, label: (-days) + ' 天后跟', cls: 'gray' };
  }

  /* 催单话术：看完买家上次怎么回的，直接发 */
  function followDraft(opp, kind, lang) {
    var b = (opp && opp.buyer) || {};
    var q = (opp && opp.quote) || {};
    var name = b.name && b.name !== '未知买家' ? b.name : 'there';
    var qty = n(q.qty) > 0 ? n(q.qty).toLocaleString('en-US') : '';
    var price = n(q.unitPriceUsd) > 0 ? C.usd(q.unitPriceUsd, '$') : '';

    var zh = {
      nudge: '您好 ' + b.name + '，之前给您报的' + (qty ? ' ' + qty + ' 件' : '') +
        (price ? '（' + price + '/件）' : '') + '，想确认一下还在考虑吗？' +
        '如果有价格或交期上的顾虑，可以直接告诉我，我再看看怎么配合。',
      counter: '理解您对价格的顾虑。' + (price ? '按 ' + price + '/件' : '') +
        '这个量我们已经在成本线上。如果数量能到 ' + (qty ? (n(qty) * 2).toLocaleString('en-US') : '更大批量') +
        '，我可以再往下调一点；或者换成同系列的' + '另一款，价格能低一些。',
      sample: '样品可以安排，样品费和运费先由您承担，正式下单后退回。您把收货地址和公司名发我，我这边今天就安排。',
      close: '好的，那我这边按 ' + (price || '报价') + ' 给您做 PI，' +
        '付款方式还是 ' + (q.paymentTerms || '30% 定金 + 见提单付尾款') + '。' +
        '您确认一下公司名、地址和联系人，我今天就把 PI 发您。'
    };

    var en = {
      nudge: 'Hi ' + name + ', just following up on the quotation I sent' +
        (qty ? ' for ' + qty + ' pcs' : '') + (price ? ' at ' + price + '/pc' : '') +
        '. Is it still under consideration? If price or lead time is the issue, let me know and I will see what we can do.',
      counter: 'I understand the concern on price. At ' + (price || 'this level') +
        ' we are already at cost for this quantity. If you can take ' +
        (qty ? (n(qty) * 2).toLocaleString('en-US') + ' pcs' : 'a larger volume') +
        ', I can go a bit lower — or I can recommend a similar model at a better price.',
      sample: 'We can arrange samples. Sample cost and freight are on your side first and refundable against the bulk order. Please send your address and company name and I will arrange it today.',
      close: 'Great — I will prepare the PI at ' + (price || 'the agreed price') +
        ' with ' + (q.paymentTermsEn || '30% T/T deposit, balance against copy of B/L') +
        '. Please confirm your company name, address and contact person, and I will send it today.'
    };

    var pack = lang === 'en' ? en : zh;
    return pack[kind] || pack.nudge;
  }

  /* =========================================================
     三、今日待办
     返回 [{key,label,desc,count,severity,hash,action}]
     ========================================================= */
  function todos(state) {
    var s = state || C.get();
    var settings = s.settings || {};
    var list = [];

    var open = s.opportunities.filter(function (o) { return o.status === 'new' || o.status === 'matched'; });
    if (open.length) {
      list.push({
        key: 'reply', label: '还没回的询盘', count: open.length,
        desc: '放着超过一天，买家就去找别家了', severity: 'high',
        hash: '#/opps'
      });
    }

    var overdue = s.opportunities.filter(function (o) {
      if (o.status === 'won' || o.status === 'lost') return false;
      var f = followState(o, settings);
      return f.overdue;
    });
    if (overdue.length) {
      list.push({
        key: 'follow', label: '该跟进的商机', count: overdue.length,
        desc: '报价发出去了，还没等到回复', severity: 'high',
        hash: '#/opps'
      });
    }

    var noCost = s.products.filter(function (p) { return !(n(p.costRmb) > 0); });
    if (noCost.length) {
      list.push({
        key: 'cost', label: '商品没填成本', count: noCost.length,
        desc: '没成本就算不出保本价，报价等于蒙', severity: 'mid',
        hash: '#/catalog', action: 'only-empty'
      });
    }

    var st = null;
    try { st = C.stats(); } catch (e) { st = null; }
    if (st && st.loss && st.loss.length) {
      list.push({
        key: 'loss', label: '挂牌价低于保本价', count: st.loss.length,
        desc: '按最低价卖会亏，要么改价要么改成本', severity: 'high',
        hash: '#/review'
      });
    }

    var fxAt = settings.fxUpdatedAt;
    var fxAge = fxAt ? (Date.now() - new Date(fxAt).getTime()) / DAY : 999;
    if (fxAge > 7) {
      list.push({
        key: 'fx', label: '汇率该更新了', count: 1,
        desc: fxAt ? '上次更新是 ' + Math.round(fxAge) + ' 天前' : '还没拿到过实时汇率', severity: 'mid',
        action: 'refresh-fx'
      });
    }

    return list;
  }

  /* 老板看的一行数：本周询盘 / 报价 / 成交 / 成交率 / 平均毛利 */
  function weekSummary(state) {
    var s = state || C.get();
    var weekAgo = Date.now() - 7 * DAY;
    var opps = s.opportunities || [];
    /* 「本周」就得是本周：以前 quoted / won / lost 没带日期过滤，
       开单三年的话累计成交会一直挂在“本周成交”上，老板一算账就发现不对。 */
    function ts(o) {
      var d = (o.deal && o.deal.closedAt) || o.updatedAt || o.createdAt;
      var t = new Date(d).getTime();
      return isFinite(t) ? t : 0;
    }
    var fresh = opps.filter(function (o) { return ts(o) >= weekAgo; });
    var quoted = opps.filter(function (o) {
      return (o.status === 'quoted' || o.status === 'won' || o.status === 'lost') && ts(o) >= weekAgo;
    });
    var won = opps.filter(function (o) { return o.status === 'won' && ts(o) >= weekAgo; });
    var lost = opps.filter(function (o) { return o.status === 'lost' && ts(o) >= weekAgo; });
    var decided = won.length + lost.length;

    var net = 0;
    won.forEach(function (o) {
      if (o.deal && o.deal.netRmb) net += n(o.deal.netRmb);
    });

    return {
      weekIn: fresh.length,
      quoted: quoted.length,
      won: won.length,
      lost: lost.length,
      winRate: decided ? won.length / decided : null,
      avgNet: won.length ? net / won.length : null,
      netRmb: net
    };
  }

  window.Workflow = {
    negotiation: negotiation,
    negoHeadline: negoHeadline,
    targetText: targetText,
    followState: followState,
    startFollow: startFollow,
    followDraft: followDraft,
    todos: todos,
    weekSummary: weekSummary
  };
})();