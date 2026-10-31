/* ===========================================================
   judge.js — 商机判断：像业务员一样先想一遍「这单能不能做」
   纯本地规则，不需要联网。输出结论 + 理由 + 下一步。
   全局暴露：window.Judge
   =========================================================== */
(function () {
  'use strict';

  var C = window.Core;

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var EU = ['德国', '法国', '意大利', '西班牙', '荷兰', '波兰', '比利时', '葡萄牙', '希腊', '瑞典', '奥地利', '丹麦', '芬兰', '爱尔兰', '捷克'];
  var NA = ['美国', '加拿大'];
  var HIGH_RISK = ['尼日利亚', '埃及', '巴基斯坦', '孟加拉', '阿尔及利亚', '安哥拉', '肯尼亚', '加纳'];

  var PAY_RISK = /\b(o\.?a\.?|d\/p|d\/a|net\s*\d+|账期|见提单|后\s*tt|赊销|credit\s*term|after\s+delivery)\b/i;

  function has(arr, v) { return arr.indexOf(v) >= 0; }

  /**
   * @returns {{level:'go'|'warn'|'no', headline:string, sub:string, points:Array, next:Array}}
   */
  function assess(ctx) {
    var r = ctx.pricing || {};
    var s = ctx.settings || {};
    var opp = ctx.opp || {};
    var p = ctx.product || null;
    var qty = C.num(r.qty);
    var unit = C.num(r.unitPriceUsd);
    var floor = C.num(r.floorUsd);
    var recommend = C.num(r.recommendUsd);
    var fx = C.num(r.fx, 7.1);
    var feeRate = C.num(r.feeRate);
    var target = C.num(opp.quote && opp.quote.targetPriceUsd);
    var country = (opp.buyer && opp.buyer.country) || '';
    var raw = String(opp.rawText || '');

    var points = [];
    var level = 'go';

    function add(kind, title, detail) {
      /* 已经判定「别接」的时候，不要再补「这是大单」这种鼓励性绿勾，
         自相矛盾的结论会让业务员照着绿勾去谈。 */
      if (kind === 'good' && level === 'no') return;
      points.push({ kind: kind, title: title, detail: detail || '' });
      if (kind === 'bad') level = 'no';
      else if (kind === 'warn' && level !== 'no') level = 'warn';
    }

    /* ---- 1. 没有成本，后面都算不准 ---- */
    if (!p || !C.num(p.costRmb)) {
      add('warn', '成本还没查', '不知道进货价，报多少都可能亏。先去 1688 / 淘宝 查一件多少钱。');
      return finish(level, points, ['查成本', '再算价', '最后回客户']);
    }

    /* ---- 2. 价格能不能站住 ---- */
    if (unit > 0 && floor > 0) {
      if (unit < floor - 1e-9) {
        var gapPct = ((floor - unit) / floor * 100).toFixed(1);
        var lossPer = (floor - unit) * qty * fx * (1 - feeRate);
        add('bad', '这个价低于保本价 ' + gapPct + '%',
          '按 ' + C.usd(unit) + ' 报，这一单要亏约 ' + C.money(lossPer) + '。要么涨价，要么换更便宜的货源。');
      } else if (recommend > 0 && unit < recommend * 0.92) {
        add('warn', '利润偏薄', '比建议价 ' + C.usd(recommend) + ' 低 ' +
          ((1 - unit / recommend) * 100).toFixed(0) + '%，能接但没什么余量，后面运费涨一点就白干。');
      } else if (recommend > 0 && unit > recommend * 1.15) {
        add('good', '报价有溢价', '比建议价高 ' + ((unit / recommend - 1) * 100).toFixed(0) + '%，客户如果接受，这单赚得不错。');
      }
    }

    /* ---- 3. 客户目标价 vs 我们的底线 ---- */
    if (target > 0 && floor > 0) {
      if (target < floor) {
        add('bad', '客户目标价低于你的保本价',
          '客户想 $' + target + '，你最低要 $' + floor.toFixed(2) + '，差 ' +
          ((floor / target - 1) * 100).toFixed(0) + '%。硬接就是亏，要么降规格，要么放弃。');
      } else if (target < recommend) {
        add('warn', '客户压价，但有得谈',
          '客户出 $' + target + '，你建议 $' + recommend.toFixed(2) + '，中间还有 ' +
          ((recommend - target) / recommend * 100).toFixed(0) + '% 空间，可以拿数量或付款方式换。');
      } else {
        add('good', '客户预算够', '客户出 $' + target + '，你建议 $' + recommend.toFixed(2) + '，还高出一些。');
      }
    }

    /* ---- 4. 数量与起订量 ---- */
    if (p.moq && qty && qty < p.moq) {
      add('warn', '数量低于起订量', '这个货 MOQ 是 ' + p.moq + '，客户只要 ' + qty +
        '。要么让他加到 ' + p.moq + '，要么按样品价报（单价会高）。');
    }
    if (qty && qty <= 10) {
      add('warn', '样品单', '量太小，利润可能不够运费。建议收样品费 + 到付运费，把它当开发客户的成本。');
    } else if (qty >= 1000) {
      add('good', '这是大单', '数量 ' + qty.toLocaleString() + '，值得认真跟。但先确认产能和备货资金，别答应了交不出。');
    }

    /* ---- 5. 认证 ---- */
    var certs = (p.certs || []).map(function (c) { return String(c).toUpperCase(); });
    if (has(EU, country) && certs.indexOf('CE') < 0) {
      add('warn', '欧盟客户，但没有 CE', '发欧盟没有 CE，客户清关可能被卡、被退货。先问清用途，必要时报"不含认证"的价。');
    }
    if (has(NA, country) && certs.indexOf('FCC') < 0) {
      add('warn', '北美客户，但没有 FCC', '带无线发射的产品进美国要有 FCC，没有的话客户可能要求退货。');
    }

    /* ---- 6. 付款风险 ---- */
    if (PAY_RISK.test(raw)) {
      add('bad', '客户提了赊销/账期', '原文里出现了 OA / DP / 账期之类的字眼。首单不要做赊销，坚持 30% 定金 + 见提单付尾款。');
    }
    if (has(HIGH_RISK, country)) {
      add('warn', country + ' 收款风险偏高', '建议 100% 前 TT 或信用证，别接受赊销；金额大的单先查客户背景。');
    }

    /* ---- 7. 买家质量 ---- */
    var company = (opp.buyer && opp.buyer.company) || '';
    if (company && qty >= 100) {
      add('good', '像正经买家', '留了公司名，采购量也不小，可以优先跟。');
    } else if (!company && qty > 0 && qty <= 20) {
      add('warn', '买家信息太少', '没公司名、量也小，先问清用途、网站、要发到哪个国家，再决定投多少时间。');
    }

    /* ---- 8. 交期 ---- */
    if (opp.quote && opp.quote.leadTimeDays) {
      if (opp.quote.leadTimeDays < 10) {
        add('warn', '交期很紧', '客户要 ' + opp.quote.leadTimeDays + ' 天交货，先确认工厂能不能排上，别先答应。');
      }
    }

    /* ---- 9. 利润额兜底 ---- */
    var net = C.num(r.netRmb);
    if (net > 0 && net < 200 && qty > 10) {
      add('warn', '这一单赚得太少', '算下来只赚 ' + C.money(net) + '，扣掉沟通和售后时间，不太划算。');
    }

    return finish(level, points, null);
  }

  function finish(level, points, forcedNext) {
    var bad = points.filter(function (p) { return p.kind === 'bad'; }).length;
    var warn = points.filter(function (p) { return p.kind === 'warn'; }).length;
    var good = points.filter(function (p) { return p.kind === 'good'; }).length;

    var headline, sub;
    if (level === 'no') {
      headline = '这单按现在的条件不能做';
      sub = bad + ' 个硬问题，先把它们解决再谈价。';
    } else if (level === 'warn') {
      headline = '能做，但有 ' + warn + ' 个点要先谈';
      sub = good ? ('另外有 ' + good + ' 个有利条件，可以拿来谈。') : '先把风险点问清楚。';
    } else {
      headline = '能做，条件还不错';
      sub = good ? (good + ' 个有利条件。') : '没有明显风险，正常报价即可。';
    }

    var next = forcedNext || [];
    if (!next.length) {
      if (level === 'no') {
        next = ['先跟客户确认目标价能不能抬', '同时问工厂有没有更便宜的规格', '实在谈不下来就礼貌放弃，别硬接'];
      } else if (level === 'warn') {
        next = ['把风险点逐条问客户（认证 / 付款 / 交期）', '按建议价报，留出谈判空间', '数量大的话争取加量换价'];
      } else {
        next = ['按建议价直接报', '强调交期和品质', '顺手问一句有没有后续订单'];
      }
    }

    return { level: level, headline: headline, sub: sub, points: points, next: next };
  }

  /* ---------------- 渲染 ---------------- */

  var KIND_ICON = { good: '✓', warn: '!', bad: '×' };
  var KIND_COLOR = { good: '#0f9d58', warn: '#b7791f', bad: '#d92d20' };

  function render(ctx) {
    var a = assess(ctx);
    var tone = a.level === 'no' ? 'bad' : a.level === 'warn' ? 'warn' : 'ok';

    var points = a.points.map(function (p) {
      return '<div style="display:flex;gap:9px;padding:9px 0;border-top:1px solid #f2f3f6">' +
        '<span style="flex:none;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;' +
        'font-size:11px;font-weight:700;color:#fff;background:' + KIND_COLOR[p.kind] + ';margin-top:1px">' +
        KIND_ICON[p.kind] + '</span>' +
        '<div><div style="font-size:12.8px;font-weight:600">' + esc(p.title) + '</div>' +
        (p.detail ? '<div style="font-size:11.8px;color:#6b7280;line-height:1.55;margin-top:2px">' +
          esc(p.detail) + '</div>' : '') +
        '</div></div>';
    }).join('');

    var next = a.next.map(function (t, i) {
      return '<div style="display:flex;gap:8px;align-items:flex-start;font-size:12.2px;color:#374151">' +
        '<span style="color:#9aa1ac">' + (i + 1) + '.</span><span>' + esc(t) + '</span></div>';
    }).join('');

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">这单能不能做<span class="card-sub">按外贸实操习惯过一遍：价、量、认证、付款、买家</span></div>' +
      '<span class="badge ' + (tone === 'bad' ? 'red' : tone === 'warn' ? 'amber' : 'green') + '">' +
      (tone === 'bad' ? '别做' : tone === 'warn' ? '谨慎' : '可做') + '</span></div>' +
      '<div class="card-bd">' +
      '<div style="font-size:16px;font-weight:650;margin-bottom:4px">' + esc(a.headline) + '</div>' +
      '<div style="font-size:12px;color:#6b7280;margin-bottom:6px">' + esc(a.sub) + '</div>' +
      (points || '<div style="font-size:12px;color:#8a919e">没有明显的风险点。</div>') +
      '<div style="margin-top:14px;padding:12px 14px;background:#f8f9fb;border-radius:8px">' +
      '<div style="font-size:11.5px;color:#8a919e;margin-bottom:8px">下一步怎么做</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px">' + next + '</div></div>' +
      '</div></section>';
  }

  window.Judge = { assess: assess, render: render };
})();
