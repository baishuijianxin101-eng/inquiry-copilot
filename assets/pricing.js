/* ===========================================================
   pricing.js — 保本价 / 该卖多少钱
   全局暴露：window.Pricing

   就两个公式
   ----------
   保本价（元） = 采购成本 ÷ (1 − 平台扣费率)
   建议价（元） = (采购成本 + 想赚的利润) ÷ (1 − 平台扣费率)

   0.97 就是 1 − 3%（平台手续费 + 提现费）。
   成本 100 元的东西，卖 97 元平台扣完你只剩 94，亏 6 块；
   卖 103.09 元才刚好不亏。这就是「保本价」。

   报价（美元）= 人民币价 ÷ 汇率
   =========================================================== */
(function () {
  'use strict';

  var C = window.Core;

  /**
   * 按数量取阶梯价。没有阶梯就退回商品的挂牌价。
   * 返回 { price, label }
   */
  function tierFor(product, qty) {
    var list = C.num(product && product.priceUsd);
    var tiers = (product && product.priceTiers) || [];
    if (!tiers.length) return { price: list, label: '' };

    var q = Math.max(0, C.num(qty));
    var sorted = tiers.slice().sort(function (a, b) { return a.min - b.min; });
    var hit = null;
    /* 阶梯价可能是「1–9 / 100–999」这种中间带缝的表，也可能重叠。
       取 min 最大且 ≤ 数量的那档：缝里的数量落回上一档，重叠时拿更便宜的那档，
       绝不能掉回挂牌价（50 件客户按 1 件价，必丢单）。 */
    for (var i = 0; i < sorted.length; i++) {
      var t = sorted[i];
      if (q >= t.min && (!t.max || q <= t.max)) {
        if (!hit || t.min > hit.min) hit = t;
      }
    }
    if (!hit && q > 0) {
      for (var j = sorted.length - 1; j >= 0; j--) {
        if (q >= sorted[j].min) { hit = sorted[j]; break; }
      }
    }
    if (!hit) return { price: list, label: '' };

    var label = hit.min + (hit.max && hit.max !== hit.min ? '–' + hit.max : '') + ' 件';
    return { price: hit.price, label: label };
  }

  function evaluate(opts) {
    opts = opts || {};
    var s = opts.settings || C.get().settings;
    var product = opts.product || null;
    var qty = Math.max(0, C.num(opts.qty));
    var fx = C.num(s.fxRate, 7.1) || 7.1;

    var rawFee = C.feeRateFor(product, s);
    var feeRate = Math.min(0.5, Math.max(0, rawFee));
    var keepRate = 1 - feeRate;

    /* --- 成本 --- */
    var unitCost = (opts.unitCostRmb !== undefined && opts.unitCostRmb !== null && opts.unitCostRmb !== '')
      ? C.num(opts.unitCostRmb)
      : C.num(product && product.costRmb);

    var unitShip = (opts.shippingRmb !== undefined && opts.shippingRmb !== null && opts.shippingRmb !== '')
      ? C.num(opts.shippingRmb)
      : C.num(product && product.shippingRmb);

    var costUnitRmb = unitCost + unitShip;
    /* 只有运费没有进货价也算有成本：否则净利恒 0、还禁止报价 */
    var hasCost = unitCost > 0 || unitShip > 0;
    var costTotalRmb = costUnitRmb * qty;

    /* --- 三个价 --- */
    var breakEvenUnitRmb = hasCost ? costUnitRmb / keepRate : 0;
    var profitPerUnitRmb = C.num(opts.profitRmb, C.num(s.profitRmb));
    var targetUnitRmb = hasCost ? (costUnitRmb + profitPerUnitRmb) / keepRate : 0;

    var breakEvenUsd = breakEvenUnitRmb / fx;
    var targetUsd = targetUnitRmb / fx;

    /* 别的平台卖多少（人民币），换算成美元做参照 */
    var marketRmb = (opts.marketPriceRmb !== undefined && opts.marketPriceRmb !== null && opts.marketPriceRmb !== '')
      ? C.num(opts.marketPriceRmb)
      : C.num(product && product.marketPriceRmb);
    var marketUsd = marketRmb > 0 ? marketRmb / fx : 0;

    /* 按数量取阶梯价（没有阶梯就用挂牌价） */
    var tier = tierFor(product, qty);
    var listUsd = tier.price > 0 ? tier.price : C.num(product && product.priceUsd);
    var listLow = C.num(product && product.priceFloorUsd);
    if (!(listLow > 0) || listLow > listUsd) listLow = listUsd;

    /* --- 建议报价：目标价，但不超过自己挂牌价 --- */
    var step = C.num(s.quoteStepUsd, 0.1);
    var recommendUsd = targetUsd > 0 ? C.roundUpTo(targetUsd, step) : 0;
    if (listUsd > 0 && recommendUsd > listUsd) {
      recommendUsd = C.round(Math.floor(listUsd / step + 1e-9) * step, 2);
    }
    if (hasCost && recommendUsd > 0 && recommendUsd < breakEvenUsd - 1e-9) {
      recommendUsd = C.round(breakEvenUsd, 2);
    }

    /* --- 实际报价 --- */
    var unit = (opts.unitPriceUsd !== undefined && opts.unitPriceUsd !== null && opts.unitPriceUsd !== '')
      ? C.num(opts.unitPriceUsd)
      : recommendUsd;

    var gmvUsd = unit * qty;
    var gmvRmb = gmvUsd * fx;
    var feeRmb = gmvRmb * feeRate;
    var receivedRmb = gmvRmb - feeRmb;
    var netRmb = hasCost ? receivedRmb - costTotalRmb : 0;
    var marginOnCost = costTotalRmb > 0 ? netRmb / costTotalRmb : 0;

    var devPct = listUsd > 0 && unit > 0 ? unit / listUsd - 1 : 0;

    var belowCost = hasCost && unit > 0 && unit < breakEvenUsd - 1e-9;
    var listTooLow = hasCost && listUsd > 0 && listUsd < breakEvenUsd - 1e-9;
    var aboveMarket = marketUsd > 0 && recommendUsd > marketUsd * 1.02;
    var marketGapPct = marketUsd > 0 && recommendUsd > 0 ? recommendUsd / marketUsd - 1 : null;

    return {
      product: product,
      qty: qty,
      fx: fx,
      feeRate: feeRate,

      unitCostRmb: C.round(unitCost, 2),
      unitShipRmb: C.round(unitShip, 2),
      costUnitRmb: C.round(costUnitRmb, 2),
      costTotalRmb: C.round(costTotalRmb, 2),

      breakEvenUnitRmb: C.round(breakEvenUnitRmb, 2),
      floorUsd: C.round(breakEvenUsd, 2),
      recommendUsd: C.round(recommendUsd, 2),
      targetUsd: C.round(targetUsd, 2),
      profitPerUnitRmb: C.round(profitPerUnitRmb, 2),

      marketPriceRmb: C.round(marketRmb, 2),
      marketUsd: C.round(marketUsd, 2),
      marketGapPct: marketGapPct,
      listUsd: C.round(listUsd, 2),
      tierLabel: tier.label,
      listLowUsd: C.round(listLow, 2),
      ceilingUsd: C.round(listUsd, 2),

      unitPriceUsd: C.round(unit, 2),
      devPct: devPct,

      gmvUsd: C.round(gmvUsd, 2),
      gmvRmb: C.round(gmvRmb, 2),
      feeRmb: C.round(feeRmb, 2),
      netRmb: C.round(netRmb, 2),
      marginOnCost: marginOnCost,

      flags: {
        noCost: !hasCost,
        belowCost: belowCost,
        listTooLow: listTooLow,
        aboveMarket: aboveMarket,
        canQuote: hasCost && qty > 0 && unit > 0 && !belowCost
      }
    };
  }

  /* 一行商品的保本价（商品库表格用，按 1 件算） */
  function breakEvenOf(product, settings) {
    var r = evaluate({
      product: product, qty: 1, settings: settings,
      unitCostRmb: product && product.costRmb,
      shippingRmb: product && product.shippingRmb
    });
    return {
      hasCost: !r.flags.noCost,
      breakEvenUsd: r.floorUsd,
      recommendUsd: r.recommendUsd,
      listTooLow: r.flags.listTooLow
    };
  }

  /* 数量阶梯 */
  function ladder(opts) {
    var q = Math.max(1, C.num(opts.qty, 1));
    return [1, 2, 5, 10].map(function (m) {
      var n = Math.round(q * m);
      var r = evaluate(Object.assign({}, opts, { qty: n, unitPriceUsd: null }));
      return { qty: n, unitPriceUsd: r.recommendUsd, netRmb: r.netRmb, costTotalRmb: r.costTotalRmb };
    });
  }

  function sensitivity(opts) {
    var unit = C.num(opts.unitPriceUsd);
    return [-0.10, -0.05, 0, 0.05, 0.10].map(function (d) {
      var r = evaluate(Object.assign({}, opts, { unitPriceUsd: unit * (1 + d) }));
      return { delta: d, unitPriceUsd: r.unitPriceUsd, netRmb: r.netRmb, belowCost: r.flags.belowCost };
    });
  }

  function settleDeal(opts) {
    var s = opts.settings || C.get().settings;
    /* 与 evaluate 同一个兜底：fx 被清成 0 也不能按 ¥1=$1 结账 */
    var fx = C.num(s.fxRate, 7.1) || 7.1;
    var feeRate = Math.min(0.5, Math.max(0, C.feeRateFor(opts.product || null, s)));
    var amountUsd = C.num(opts.amountUsd);
    var costRmb = C.num(opts.costRmb);
    var gmvRmb = amountUsd * fx;
    var feeRmb = gmvRmb * feeRate;
    return {
      amountUsd: C.round(amountUsd, 2),
      feeRmb: C.round(feeRmb, 2),
      costRmb: C.round(costRmb, 2),
      netRmb: C.round(gmvRmb - feeRmb - costRmb, 2)
    };
  }

  window.Pricing = {
    evaluate: evaluate,
    tierFor: tierFor,
    breakEvenOf: breakEvenOf,
    ladder: ladder,
    sensitivity: sensitivity,
    settleDeal: settleDeal
  };
})();
