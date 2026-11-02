/* ===========================================================
   pricing-unity.js — 定价口径统一（展示与判定层）
   全局暴露：window.PricingUnity

   背景：同一页曾同时出现四套「底线」——
     保本价   Pricing.evaluate().floorUsd（成本+运费，含平台佣金，亏与不亏的硬线）
     登记底价 商品 priceFloorUsd（价格区间下限，让价红线，可特批）
     谈判底线 Workflow.negotiation().floorUsd（保本价与最低毛利取高，"已经到底"）
     有效底线 P0Quote 的 effectiveFloorUsd = max(保本价, 登记底价)
   每套算法本身没错，错在同名混用、结论打架（建议价低于谈判底线却标"可报"）。

   本模块不改任何计算公式，只做一件事：把各来源的既有结果收拢成
   一份带明确名称与条件的结果，并给出全站唯一的「是否可报价」判定：
     参考售价 listUsd     = 橱窗挂牌价，客户看到的价，不是底线
     系统建议报价 recommendUsd = Pricing 的建议价
     保本价 breakEvenUsd  = Pricing.floorUsd
     登记底价 businessFloorUsd = 商品 priceFloorUsd（0 表示未登记）
     报价底线 quoteFloorUsd = max(保本价, 登记底价)，与 P0Quote 有效底线同定义
     谈判底线 negoFloorUsd = 谈判模块结果（含最低毛利目标），只作提示、不作硬线
   买家目标价不进入本模块：它不是卖家报价，任何情况下不影响判定。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);
  var PU = {};

  function num(x, d) { var n = Number(x); return isFinite(n) ? n : (d || 0); }
  function r2(x) { return Math.round(num(x) * 100) / 100; }

  function resolve(input) {
    input = input || {};
    var r = input.evaluate || null;
    var product = input.product || null;
    var nego = input.nego || null;

    var listUsd = r ? num(r.listUsd) : (product ? num(product.priceUsd) : 0);
    var recommendUsd = r ? num(r.recommendUsd) : 0;
    var breakEvenUsd = r ? num(r.floorUsd) : 0;
    var businessFloorUsd = product ? num(product.priceFloorUsd) : 0;
    var quoteFloorUsd = r2(Math.max(breakEvenUsd, businessFloorUsd));
    var negoFloorUsd = (nego && nego.ok) ? num(nego.floorUsd) : null;
    var minMarginPct = (nego && nego.ok) ? num(nego.minMarginPct) * 100 : null;
    var unitUsd = input.unitUsd != null ? num(input.unitUsd) : (r ? num(r.unitPriceUsd) : 0);
    var qty = r ? num(r.qty) : 0;

    var blockReasons = [];
    var warnings = [];
    var noCost = !r || (r.flags && r.flags.noCost) || !(breakEvenUsd > 0);

    if (noCost) blockReasons.push('缺少采购成本，算不出保本价');
    if (!(unitUsd > 0)) blockReasons.push('尚未形成有效报价');
    if (input.hardFail) blockReasons.push('商品匹配存在关键冲突（型号/品类不符或低于起订量）');
    if (!noCost && unitUsd > 0 && unitUsd < breakEvenUsd - 1e-9) {
      blockReasons.push('当前报价低于保本价');
    }
    if (!noCost && unitUsd > 0 && businessFloorUsd > 0 && unitUsd < businessFloorUsd - 1e-9) {
      blockReasons.push('当前报价低于商品登记底价（价格区间下限），需特批才能报');
    }

    var anomaly = false;
    if (!noCost && recommendUsd > 0 && recommendUsd < breakEvenUsd - 1e-9) {
      anomaly = true;
      warnings.push('定价异常：系统建议价低于保本价，请先核对成本与挂牌价，不要按建议价直接报');
    }
    if (!noCost && recommendUsd > 0 && businessFloorUsd > 0 && recommendUsd < businessFloorUsd - 1e-9) {
      warnings.push('系统建议价低于商品登记底价，按建议价报需走特批');
    }
    if (negoFloorUsd && unitUsd > 0 && unitUsd < negoFloorUsd - 1e-9) {
      warnings.push('当前报价低于谈判底线（含最低毛利' + (minMarginPct != null ? ' ' + Math.round(minMarginPct) + '%' : '') + '），利润低于目标——谈判底线是提示，不是保本硬线');
    }
    if (businessFloorUsd > 0 && listUsd > 0 && businessFloorUsd > listUsd) {
      warnings.push('数据异常：商品登记底价高于挂牌价，请修正商品资料');
    }

    return {
      listUsd: r2(listUsd),
      recommendUsd: r2(recommendUsd),
      breakEvenUsd: r2(breakEvenUsd),
      businessFloorUsd: r2(businessFloorUsd),
      quoteFloorUsd: quoteFloorUsd,
      negoFloorUsd: negoFloorUsd != null ? r2(negoFloorUsd) : null,
      minMarginPct: minMarginPct,
      unitUsd: r2(unitUsd),
      qty: qty,
      feeRate: r ? num(r.feeRate) : 0,
      noCost: !!noCost,
      anomaly: anomaly,
      quotable: blockReasons.length === 0,
      blockReasons: blockReasons,
      warnings: warnings
    };
  }

  PU.resolve = resolve;
  PU.VERSION = '1.0.0';
  root.PricingUnity = PU;
})();
