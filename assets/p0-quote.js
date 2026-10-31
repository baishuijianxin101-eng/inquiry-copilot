/* P0 报价护栏：确定性算术 + 底线拦截。
 * 设计约束（见 IMPLEMENTATION_PLAN.md §3.4）：
 *   1. 所有金额、毛利、保本价都由本文件的算式得出，AI 只能改写话术，不能改数字；
 *   2. 成本缺失、低于保本价、低于底价、负毛利，一律 blocked，不允许"看起来成功"；
 *   3. 成本/底价/保本价只进 guard.internal 与 snapshot，publicView 里绝不出现，
 *      前端拿 publicView 就能安全地渲染"给客户看的报价单"。
 * 依赖：pricing.js（Pricing.evaluate）、core.js（数值工具，可选）。
 * 不读 DOM、不发网络、不写存储，纯函数，便于测试与复用。
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : this;
  var C = root.Core || null;
  var Pricing = root.Pricing || null;

  var VERSION = '1.0.0';

  var DEFAULTS = {
    fxRate: 7.1,
    platformFeeRate: 0.05,
    profitRmb: 20,
    quoteStepUsd: 0.1,
    minMarginPct: 8,
    quoteValidDays: 30,
    defaultIncoterm: 'FOB Ningbo',
    paymentTerms: '30% T/T 定金，余款见提单副本',
    paymentTermsEn: '30% T/T deposit, balance against copy of B/L'
  };

  /* ---------- 小工具 ---------- */

  function num(v, d) {
    if (v === '' || v === null || v === undefined) return d === undefined ? 0 : d;
    var n = Number(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  function round(n, d) {
    var p = Math.pow(10, d === undefined ? 2 : d);
    return Math.round((num(n) + Number.EPSILON) * p) / p;
  }

  function ceilTo(n, step) {
    var s = num(step, 0.1);
    if (!(s > 0)) return round(n, 2);
    return round(Math.ceil(num(n) / s - 1e-9) * s, 2);
  }

  function settingsOf(raw) {
    var src = (raw && typeof raw === 'object') ? raw : {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = src[k] === undefined || src[k] === null ? DEFAULTS[k] : src[k];
    });
    out.fxRate = num(out.fxRate, DEFAULTS.fxRate) || DEFAULTS.fxRate;
    out.platformFeeRate = Math.min(0.5, Math.max(0, num(out.platformFeeRate, DEFAULTS.platformFeeRate)));
    out.profitRmb = Math.max(0, num(out.profitRmb, DEFAULTS.profitRmb));
    out.quoteStepUsd = num(out.quoteStepUsd, DEFAULTS.quoteStepUsd) || DEFAULTS.quoteStepUsd;
    out.minMarginPct = Math.max(0, num(out.minMarginPct, DEFAULTS.minMarginPct));
    out.quoteValidDays = Math.max(1, num(out.quoteValidDays, DEFAULTS.quoteValidDays));
    return out;
  }

  function nowIso(input) {
    if (input && typeof input === 'string') return input;
    return new Date().toISOString();
  }

  function productLabel(p) {
    if (!p) return '未指定商品';
    return String(p.sku ? p.sku + ' ' : '') + String(p.title || p.titleEn || '未命名商品');
  }

  function stop(code, message, ask, extra) {
    var out = {
      ok: false,
      blocked: code,
      code: code,
      message: message,
      ask: ask || '',
      warnings: [],
      explain: [],
      quote: null,
      counter: null,
      exception: null
    };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /* ---------- 核心：报价测算与护栏 ---------- */

  /**
   * @param {object} input
   *   product         商品（含 costRmb / shippingRmb / priceUsd / priceFloorUsd / priceTiers）
   *   qty             数量（件）
   *   settings        平台费率、汇率、目标单件利润、最小毛利率等
   *   unitPriceUsd    想报的单价（USD）；缺省用建议价
   *   targetPriceUsd  客户还的目标价（USD）；会额外做"目标价是否触底"的判断
   *   costRmb / shippingRmb  覆盖商品上的成本（用于试算，不写回）
   *   exception       {reason} 特批说明；只能放行 below_floor，且理由 ≥10 字
   *   now             快照时间（测试注入，保证确定性）
   */
  function price(input) {
    input = input || {};
    if (!Pricing || typeof Pricing.evaluate !== 'function') {
      return stop('engine_missing', '报价引擎未加载：缺少 Pricing.evaluate，不能给出任何价格。',
        '请先加载 pricing.js，再重试。');
    }

    var p = input.product || null;
    var s = settingsOf(input.settings);
    var fx = num(input.fxRate, s.fxRate) || s.fxRate;
    var qty = num(input.qty, 0);
    var at = nowIso(input.now);
    var warnings = [];
    var explain = [];

    if (!(qty > 0)) {
      return stop('bad_qty', '数量为空或为 0，无法测算。', '请先确认客户要的数量（例如 2000 pcs）。');
    }

    var base = Pricing.evaluate({
      product: p,
      qty: qty,
      settings: s,
      unitCostRmb: input.costRmb,
      shippingRmb: input.shippingRmb,
      profitRmb: input.profitRmb,
      unitPriceUsd: null
    });

    /* 成本链：只有"一分钱成本都没有"才允许判 no_cost */
    var hasCost = !base.flags.noCost;
    var costUnitRmb = num(base.costUnitRmb, 0);
    var costTotalRmb = num(base.costTotalRmb, 0);

    if (!hasCost) {
      return stop('no_cost', '该商品没有真实采购成本（成本为 0 或未填），任何报价都是猜的。',
        '请先在成本中心补齐该 SKU 的采购成本与国内运费，再报价。', {
          productLabel: productLabel(p),
          quote: null,
          warnings: ['缺成本'],
          explain: ['没有成本就算不出毛利，也无法判断是否低于底价；系统不会猜一个价格。']
        });
    }

    var breakEvenUsd = num(base.floorUsd, 0);          /* 含平台佣金的保本价 */
    var businessFloorUsd = num(p && p.priceFloorUsd, 0); /* 商品上登记的最低价 */
    if (businessFloorUsd > 0 && num(base.listUsd, 0) > 0 && businessFloorUsd > num(base.listUsd, 0)) {
      /* 数据脏了：底价高于挂牌价，按挂牌价处理并提示修数据 */
      warnings.push('底价高于挂牌价，已按挂牌价作为下限，请修正商品资料');
      businessFloorUsd = num(base.listUsd, 0);
    }
    var effectiveFloorUsd = round(Math.max(breakEvenUsd, businessFloorUsd), 2);

    var wantTarget = num(input.targetPriceUsd, 0);
    var wanted = num(input.unitPriceUsd, 0);
    /* 没有指定价格时，按"建议价与底线取高"给默认报价：
       这样默认报价永远合法，不会因为建议价低于底价而假装报不出去。 */
    var candidate = wanted > 0 ? round(wanted, 2)
      : (wantTarget > 0 ? round(wantTarget, 2)
        : round(Math.max(num(base.recommendUsd, 0), ceilTo(effectiveFloorUsd, s.quoteStepUsd)), 2));

    if (!(candidate > 0)) {
      return stop('bad_price', '算不出可报单价（挂牌价与成本同时异常）。', '请检查该商品的挂牌价与成本数据。', {
        productLabel: productLabel(p)
      });
    }

    var q = Pricing.evaluate({
      product: p,
      qty: qty,
      settings: s,
      unitCostRmb: input.costRmb,
      shippingRmb: input.shippingRmb,
      profitRmb: input.profitRmb,
      unitPriceUsd: candidate
    });

    var marginPct = round(num(q.marginOnCost, 0) * 100, 2);
    var netRmb = num(q.netRmb, 0);

    /* 保本价是第一道硬线：低于它就是卖一件亏一件 */
    if (candidate < breakEvenUsd - 0.005) {
      var counterBreak = ceilTo(Math.max(breakEvenUsd, businessFloorUsd), s.quoteStepUsd);
      return stop('below_breakeven',
        '报价 $' + round(candidate, 2) + ' 低于保本价 $' + round(breakEvenUsd, 2) + '，每件净亏 ¥' + round(-netRmb / qty, 2) + '。',
        '保本价是硬线，不能报。最低可报 $' + counterBreak + '。', {
          productLabel: productLabel(p),
          counter: counterOf(counterBreak, candidate),
          guard: internalOf(q, breakEvenUsd, businessFloorUsd, effectiveFloorUsd, s, fx, at),
          snapshot: snapshotOf(q, fx, at, input)
        });
    }

    /* 底价是第二道硬线：可以特批，但必须留理由 */
    if (businessFloorUsd > 0 && candidate < businessFloorUsd - 0.005) {
      var reason = input.exception && String(input.exception.reason || '').trim();
      if (!reason || reason.length < 10) {
        var counterFloor = ceilTo(businessFloorUsd, s.quoteStepUsd);
        return stop('below_floor',
          '报价 $' + round(candidate, 2) + ' 低于该商品底价 $' + round(businessFloorUsd, 2) + '，触及让价红线。',
          '要报这个价必须走特批：填写 ≥10 字的让价理由（例如客户年采购量、老客户返单），否则最低可报 $' + counterFloor + '。', {
            productLabel: productLabel(p),
            counter: counterOf(counterFloor, candidate),
            guard: internalOf(q, breakEvenUsd, businessFloorUsd, effectiveFloorUsd, s, fx, at),
            snapshot: snapshotOf(q, fx, at, input)
          });
      }
      warnings.push('已按特批理由放行低价格：' + reason);
      explain.push('特批只放行"低于底价"，不会放行"低于保本价"，也不改成本数据。');
    }

    if (netRmb < -0.005) {
      return stop('negative_margin', '按 $' + round(candidate, 2) + ' 报，整单净利为 ¥' + round(netRmb, 2) + '（负）。',
        '请提高单价或核对成本，负毛利不能报。', {
          productLabel: productLabel(p),
          guard: internalOf(q, breakEvenUsd, businessFloorUsd, effectiveFloorUsd, s, fx, at),
          snapshot: snapshotOf(q, fx, at, input)
        });
    }

    /* 软提醒：不拦截，但要让人看见 */
    if (marginPct < s.minMarginPct) {
      warnings.push('毛利率 ' + marginPct + '% 低于设定的 ' + s.minMarginPct + '%');
    }
    if (num(q.listUsd, 0) > 0 && candidate < num(q.listUsd, 0) - 0.005) {
      warnings.push('低于挂牌价 $' + round(q.listUsd, 2) + '，让价 ' + round((candidate / num(q.listUsd, 0) - 1) * 100, 1) + '%');
    }
    if (!(businessFloorUsd > 0)) {
      warnings.push('该商品没有登记底价，本次只按保本价守线');
    }
    if (wantTarget > 0 && wantTarget < candidate - 0.005 && candidate > wantTarget) {
      warnings.push('客户目标价 $' + round(wantTarget, 2) + ' 低于可报价格，需谈价');
      explain.push('客户目标价低于可用价格：要么让客户加价，要么走特批，不接受则放弃。');
    }

    explain.push('单价 = 想报价格；净利 = 美元金额 × 汇率 − 平台佣金 − 成本，单位人民币。');
    explain.push('保本价 $' + round(breakEvenUsd, 2) + '，底价 $' + round(businessFloorUsd, 2) + '，本单守住这两条线。');

    var unit = round(candidate, 2);
    var amountUsd = round(unit * qty, 2);

    return {
      ok: true,
      blocked: null,
      code: 'ok',
      message: '可以报价：$' + unit + ' / 件 × ' + qty + ' = $' + amountUsd + '，净利 ¥' + round(netRmb, 2) + '（毛利 ' + marginPct + '%）。',
      ask: '',
      productLabel: productLabel(p),
      exception: (input.exception && String((input.exception.reason || '')).trim().length >= 10) ? { reason: String(input.exception.reason).trim() } : null,
      quote: {
        productId: p && p.id ? p.id : '',
        sku: p && p.sku ? p.sku : '',
        title: p ? String(p.title || p.titleEn || '') : '',
        qty: qty,
        unitPriceUsd: unit,
        amountUsd: amountUsd,
        incoterm: String(input.incoterm || s.defaultIncoterm || ''),
        validDays: s.quoteValidDays,
        paymentTerms: String(input.paymentTerms || s.paymentTerms || ''),
        paymentTermsEn: String(input.paymentTermsEn || s.paymentTermsEn || ''),
        tierLabel: String(q.tierLabel || ''),
        listUsd: round(q.listUsd, 2),
        recommendUsd: round(base.recommendUsd, 2),
        marginPct: marginPct,
        netRmb: round(netRmb, 2),
        fx: round(fx, 4)
      },
      counter: null,
      guard: internalOf(q, breakEvenUsd, businessFloorUsd, effectiveFloorUsd, s, fx, at),
      snapshot: snapshotOf(q, fx, at, input),
      publicView: publicViewOf(p, unit, qty, amountUsd, s, input),
      warnings: warnings,
      explain: explain
    };
  }

  function counterOf(price, wanted) {
    return {
      unitPriceUsd: round(price, 2),
      gapUsd: round(price - num(wanted, 0), 2),
      gapPct: num(wanted, 0) > 0 ? round((price / num(wanted, 0) - 1) * 100, 2) : null
    };
  }

  function internalOf(q, breakEvenUsd, businessFloorUsd, effectiveFloorUsd, s, fx, at) {
    return {
      costUnitRmb: round(q.costUnitRmb, 2),
      costTotalRmb: round(q.costTotalRmb, 2),
      feeRate: q.feeRate,
      breakEvenUsd: round(breakEvenUsd, 2),
      businessFloorUsd: round(businessFloorUsd, 2),
      effectiveFloorUsd: round(effectiveFloorUsd, 2),
      marginOnCost: num(q.marginOnCost, 0),
      minMarginPct: s.minMarginPct,
      fx: round(fx, 4),
      at: at
    };
  }

  /* 服务端留存用：成本和汇率快照，前端不得原样透传 */
  function snapshotOf(q, fx, at, input) {
    return {
      costRmb: round(q.costUnitRmb, 2),
      shippingRmb: round(q.unitShipRmb, 2),
      costTotalRmb: round(q.costTotalRmb, 2),
      fx: round(fx, 4),
      feeRate: q.feeRate,
      at: at,
      override: input && (input.costRmb !== undefined || input.shippingRmb !== undefined) ? true : false
    };
  }

  /* 给客户看的部分：没有成本、没有底价、没有保本价 */
  function publicViewOf(p, unit, qty, amountUsd, s, input) {
    return {
      sku: p && p.sku ? String(p.sku) : '',
      title: p ? String(p.title || p.titleEn || '') : '',
      qty: qty,
      unitPriceUsd: round(unit, 2),
      amountUsd: round(amountUsd, 2),
      incoterm: String(input.incoterm || s.defaultIncoterm || ''),
      validDays: s.quoteValidDays,
      paymentTermsEn: String(input.paymentTermsEn || s.paymentTermsEn || ''),
      leadTimeDays: num(p && p.leadTimeDays, 0),
      moq: num(p && p.moq, 0)
    };
  }

  /* ---------- 报价草稿：把数字变成可发送的文本 ---------- */

  function draft(result, opts) {
    opts = opts || {};
    if (!result || !result.ok || !result.quote) {
      return {
        ok: false,
        blocked: result ? result.blocked : 'no_result',
        text: '',
        lines: [],
        message: result ? result.message : '没有可用的报价结果，不能生成报价草稿。'
      };
    }
    var q = result.quote;
    var lines = [];
    lines.push('Quotation' + (q.title ? ' — ' + q.title : ''));
    if (q.sku) lines.push('Item No.: ' + q.sku);
    lines.push('Quantity: ' + q.qty + ' pcs');
    lines.push('Unit Price: USD ' + q.unitPriceUsd.toFixed(2) + ' / pc');
    lines.push('Total Amount: USD ' + q.amountUsd.toFixed(2));
    if (q.incoterm) lines.push('Trade Term: ' + q.incoterm);
    if (q.leadTimeDays) lines.push('Lead Time: ' + q.leadTimeDays + ' days after deposit');
    if (q.paymentTermsEn) lines.push('Payment: ' + q.paymentTermsEn);
    lines.push('Validity: ' + q.validDays + ' days');
    if (opts.sellerName) lines.push('Best regards,\n' + opts.sellerName);

    return {
      ok: true,
      blocked: null,
      lines: lines,
      text: lines.join('\n'),
      quote: q,
      warnings: result.warnings.slice(),
      note: '数字来自护栏测算结果，改写措辞不影响价格；改动价格必须重新过护栏。'
    };
  }

  /* ---------- 让价阶梯：客户压价时，告诉销售最低能到哪 ---------- */

  function ladder(input) {
    input = input || {};
    var s = settingsOf(input.settings);
    var qty = num(input.qty, 0);
    if (!(qty > 0) || !Pricing) {
      return { ok: false, blocked: 'bad_qty', rows: [] };
    }
    var r = price({ product: input.product, qty: qty, settings: input.settings, costRmb: input.costRmb, shippingRmb: input.shippingRmb, profitRmb: input.profitRmb, now: input.now });
    var floorUsd = r.guard ? r.guard.effectiveFloorUsd : 0;
    if (!(floorUsd > 0)) {
      return { ok: false, blocked: r.blocked || 'no_cost', rows: [], message: r.message };
    }
    var listUsd = num(r.quote && r.quote.listUsd, 0) || floorUsd;
    var steps = [0, 0.25, 0.5, 0.75, 1];
    var rows = steps.map(function (t) {
      var unit = round(listUsd - (listUsd - floorUsd) * t, 2);
      var q = Pricing.evaluate({ product: input.product, qty: qty, settings: s, unitPriceUsd: unit, costRmb: input.costRmb, shippingRmb: input.shippingRmb, profitRmb: input.profitRmb, unitCostRmb: input.costRmb });
      return {
        step: t,
        unitPriceUsd: unit,
        netRmb: round(q.netRmb, 2),
        marginPct: round(num(q.marginOnCost, 0) * 100, 2),
        atFloor: t === 1
      };
    });
    return { ok: true, blocked: null, floorUsd: floorUsd, listUsd: listUsd, rows: rows };
  }

  var api = {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    price: price,
    draft: draft,
    ladder: ladder
  };

  root.P0Quote = api;
})();