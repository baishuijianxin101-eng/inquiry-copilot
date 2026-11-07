/* ===========================================================
   reply.js — 回复草稿 / 报价单 / 议价话术
   全局暴露：window.Reply
   =========================================================== */
(function () {
  'use strict';

  var C = window.Core;

  function fmtQty(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function certText(list) {
    return (list && list.length) ? list.join(' / ') : '—';
  }

  /* 对外报价一律写 "USD 7.10"，避免 "$" 在多币种语境下的歧义 */
  function um(n) {
    var v = Number(n) || 0;
    return 'USD ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function amountText(unit, qty) {
    return um(Number(unit || 0) * Number(qty || 0));
  }

  /* ---------------- 英文回复 ---------------- */

  function replyEn(ctx) {
    var o = ctx.opp, p = ctx.product, r = ctx.pricing, s = ctx.settings;
    var name = (o.buyer && o.buyer.name) || 'Sir/Madam';
    var firstName = String(name).split(/\s+/)[0] || 'Sir/Madam';
    var country = (ctx.parsed && ctx.parsed.countryEn) || 'your market';
    var qty = r.qty || 0;
    var unit = r.unitPriceUsd;
    var lead = (o.quote && o.quote.leadTimeDays) || (p && p.leadTimeDays) || s.defaultLeadTimeDays;
    var incoterm = (o.quote && o.quote.incoterm) || s.defaultIncoterm;
    /* validDays 来自本地数据，导入的备份里可能是任意字符串，直接拼进报价单就等于开了注入口 */
    var valid = Math.round(C.clamp(C.num((o.quote && o.quote.validDays) || s.quoteValidDays, 30), 1, 3650));
    var lines = [];

    lines.push('Dear ' + firstName + ',');
    lines.push('');
    lines.push('Thank you for your inquiry' + (qty ? ' for ' + fmtQty(qty) + ' pcs' : '') +
      '. We can supply this item for ' + country + '.');
    lines.push('');
    lines.push('Our offer:');
    lines.push('');
    lines.push('• Item: ' + (p ? (p.titleEn || p.title) : '—') + (p && p.sku ? '  (SKU: ' + p.sku + ')' : ''));
    lines.push('• Unit price: ' + um(unit) + ' / pc, ' + incoterm);
    if (qty) lines.push('• Quantity: ' + fmtQty(qty) + ' pcs');
    if (qty) lines.push('• Total amount: ' + amountText(unit, qty) + ' ' + incoterm);
    if (p) lines.push('• MOQ: ' + fmtQty(p.moq) + ' pcs');
    lines.push('• Lead time: ' + (Number(lead) > 0 ? lead + ' days after deposit received' : 'to be confirmed with your order details'));
    if (p && p.certs && p.certs.length) lines.push('• Certification: ' + certText(p.certs));
    lines.push('• Payment: ' + (s.paymentTermsEn || s.paymentTerms));
    lines.push('• Validity: ' + valid + ' days');
    if (p && p.specsEn) {
      lines.push('');
      lines.push('Specifications: ' + p.specsEn);
    }

    /* 只有买家目标价低于底线时才需要解释和让步 */
    if (r.buyerTargetUsd && r.targetGapPct !== null && r.targetGapPct < -0.02) {
      var bigger = null;
      lines.push('');
      lines.push('We noted your target of ' + um(r.buyerTargetUsd) +
        '. Our quotation is based on the material and certification required for this specification, ' +
        'so we cannot match it at ' + fmtQty(qty) + ' pcs without changing the configuration.');
      lines.push('If you can share your target volume, we will re-check our factory price for that quantity and come back within 24 hours.');
      lines.push('Alternatively we can adjust the packaging or the accessory set to get closer to your target — please tell us which direction works better for you.');
    }

    lines.push('');
    lines.push('Samples can be ready in 7 days. Once you confirm the quantity and any logo / packaging requirement, I will send the revised quotation and real photos within 24 hours.');
    lines.push('');
    lines.push('Best regards,');
    lines.push((ctx.sellerName || s.sellerName));
    lines.push('Sales Department');

    return lines.join('\n');
  }

  /* ---------------- 中文回复 ---------------- */

  function replyZh(ctx) {
    var o = ctx.opp, p = ctx.product, r = ctx.pricing, s = ctx.settings;
    var name = (o.buyer && o.buyer.name) || '您好';
    var qty = r.qty || 0;
    var unit = r.unitPriceUsd;
    var lead = (o.quote && o.quote.leadTimeDays) || (p && p.leadTimeDays) || s.defaultLeadTimeDays;
    var incoterm = (o.quote && o.quote.incoterm) || s.defaultIncoterm;
    /* validDays 来自本地数据，导入的备份里可能是任意字符串，直接拼进报价单就等于开了注入口 */
    var valid = Math.round(C.clamp(C.num((o.quote && o.quote.validDays) || s.quoteValidDays, 30), 1, 3650));
    var lines = [];

    lines.push(name + '，您好：');
    lines.push('');
    lines.push('感谢您的询价' + (qty ? '（' + fmtQty(qty) + ' pcs）' : '') + '，这个规格我们可以做。报价如下：');
    lines.push('');
    lines.push('· 产品：' + (p ? p.title : '—') + (p && p.sku ? '（SKU：' + p.sku + '）' : ''));
    lines.push('· 单价：' + um(unit) + ' / pc，' + incoterm);
    if (qty) lines.push('· 数量：' + fmtQty(qty) + ' pcs');
    if (qty) lines.push('· 总金额：' + amountText(unit, qty));
    if (p) lines.push('· 起订量：' + fmtQty(p.moq) + ' pcs');
    lines.push('· 交期：' + (Number(lead) > 0 ? '收到定金后 ' + lead + ' 天' : '待确认'));
    if (p && p.certs && p.certs.length) lines.push('· 认证：' + certText(p.certs));
    lines.push('· 付款方式：' + s.paymentTerms);
    lines.push('· 报价有效期：' + valid + ' 天');
    if (p && p.specs) {
      lines.push('');
      lines.push('规格：' + p.specs);
    }

    if (r.buyerTargetUsd && r.targetGapPct !== null && r.targetGapPct < -0.02) {
      lines.push('');
      lines.push('关于您提到的目标价 ' + um(r.buyerTargetUsd) +
        '，目前报价是按这个规格对应的材质与认证成本核算的，' + fmtQty(qty) + ' pcs 这个数量确实做不到。');
      lines.push('您方便的话告诉我大概的量，我按那个数量再去核一次出厂价，24 小时内给您回复。');
      lines.push('或者调整包装 / 配件配置来贴近您的目标价，您看哪个方向更合适？');
    }

    lines.push('');
    lines.push('样品 7 天可出。您确认数量和 LOGO / 包装要求后，我 24 小时内给您更新报价和实拍图。');
    lines.push('');
    lines.push('顺祝商祺');
    lines.push(s.sellerName);

    return lines.join('\n');
  }

  /* ---------------- 议价话术 ---------------- */

  function negotiation(ctx) {
    var r = ctx.pricing, s = ctx.settings;
    var floor = r.floorUsd;
    var target = r.buyerTargetUsd;
    var rec = r.recommendUsd;
    var list = r.listUsd;
    var out = [];

    if (r.flags.noCost) {
      out.push({
        title: '先别急着报',
        text: '你还不知道这个货多少钱一件。去 1688 / 淘宝搜一下，把成本填进来，' +
          '才知道保本价是多少。不然报出去可能一单亏几百。'
      });
      return out;
    }

    if (!target) {
      out.push({
        title: '买家没给目标价',
        text: '信息在你这边。按建议售价 ' + um(rec) + ' 报出去（保本价 ' + um(floor) +
          '，每件赚 ' + C.money(r.profitPerUnitRmb) + '），把让价空间留到第二轮。'
      });
      out.push(incomeLine(ctx));
      return out;
    }

    if (target >= floor) {
      var profitHere = target * r.qty * r.fx * (1 - r.feeRate) - r.costTotalRmb;
      out.push({
        title: '买家的价高于保本价，能接',
        text: '他出 ' + um(target) + '，你的保本价是 ' + um(floor) +
          '。按他的价接，这一单赚 ' + C.money(profitHere) + '。' +
          (target >= rec ? '而且高于你的建议价，直接答应，别主动降。' : '略低于建议价，可以试着报 ' + um(rec) + '，或者接受把单拿下。')
      });
      out.push({
        title: '接下来锁条件，不是谈价',
        text: '① 确认数量和颜色/包装；② 确认定金比例和到账时间；③ 确认交期起算点；' +
          '④ 报价有效期写清楚 ' + (s.quoteValidDays || 30) + ' 天。' +
          '另外——**下单前再去 1688 核一次实时价格和库存**，别这边答应了那边涨价或没货。'
      });
      out.push(incomeLine(ctx));
      return out;
    }

    var gap = target / floor - 1;

    if (gap > -0.12) {
      out.push({
        title: '低于保本价 ' + Math.abs(gap * 100).toFixed(1) + '%，还有得谈',
        text: '他出 ' + um(target) + '，你保本要 ' + um(floor) + '。差得不多，三条路：' +
          '① 去 1688 再问两家，看有没有更便宜的货源；' +
          '② 换低一档配置或简包装；' +
          '③ 让他加量，用数量换价格。' +
          '不管哪条，最后成交价不能低于保本价 ' + um(floor) + '，再低就是公司倒贴。'
      });
      out.push({
        title: '具体怎么回',
        text: '「Our best price at ' + fmtQty(r.qty) + ' pcs is ' + um(rec) + '. ' +
          'Your target of ' + um(target) + ' is below our cost for this specification, ' +
          'but if you can take ' + fmtQty(r.qty * 2) + ' pcs we can look at it again.」'
      });
    } else {
      out.push({
        title: '低于保本价超过 12%：这单做不了',
        text: '他出 ' + um(target) + '，保本价 ' + um(floor) + '，差 ' +
          Math.abs(gap * 100).toFixed(0) + '%。按这个价接，这一单要亏 ' +
          C.money(Math.abs(target * r.qty * r.fx * (1 - r.feeRate) - r.costTotalRmb)) + '。' +
          '这种单要么换规格，要么直接放弃。'
      });
      out.push({
        title: '体面退出（留个尾巴）',
        text: '「Thank you for sharing your target. At ' + um(target) +
          ' we would have to change the specification, which we do not recommend. ' +
          'Our best is ' + um(floor) + '. If your requirement changes, I am happy to revisit.」'
      });
    }

    out.push(incomeLine(ctx));
    return out;
  }

  function incomeLine(ctx) {
    var r = ctx.pricing, s = ctx.settings;
    return {
      title: '这条单的账',
      text: '售价 ' + um(r.unitPriceUsd) + ' × ' + fmtQty(r.qty) + ' = 收款 ' + C.money(r.gmvRmb) +
        '；平台扣 ' + C.pct(r.feeRate) + ' = ' + C.money(r.feeRmb) +
        '；成本 ' + C.money(r.costTotalRmb) +
        '；' + (r.netRmb < 0 ? '亏 ' : '赚 ') + C.money(Math.abs(r.netRmb)) + '。'
    };
  }
  /* ---------------- 报价单（可打印 HTML） ---------------- */

  function quoteDocument(ctx) {
    var o = ctx.opp, p = ctx.product, r = ctx.pricing, s = ctx.settings;
    var qty = r.qty;
    var unit = r.unitPriceUsd;
    var total = unit * qty;
    /* 无有效报价时报价单不得出现任何金额（线上冒烟发现无价时印出
       USD 0.00）：判定与全站统一护栏一致——优先 ctx.unity.quotable，
       回退 pricing.flags.canQuote；不通过时单价、金额、总额全部
       改为待定文案，本函数只渲染、不写任何状态。 */
    var priceOk = (unit > 0) && (ctx.unity ? !!ctx.unity.quotable : !!(r.flags && r.flags.canQuote));
    var TBD = 'To be confirmed';
    var no = 'Q' + String(o.id).replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
    var date = C.fmtDate(C.nowIso());
    /* validDays 来自本地数据，导入的备份里可能是任意字符串，直接拼进报价单就等于开了注入口 */
    var valid = Math.round(C.clamp(C.num((o.quote && o.quote.validDays) || s.quoteValidDays, 30), 1, 3650));
    var incoterm = (o.quote && o.quote.incoterm) || s.defaultIncoterm;
    var lead = (o.quote && o.quote.leadTimeDays) || (p && p.leadTimeDays) || s.defaultLeadTimeDays;

    var desc = (p ? C.esc(p.titleEn || p.title) : '—') +
      (p && p.sku ? '<br><span style="color:#888;font-size:11px">SKU: ' + C.esc(p.sku) + '</span>' : '');

    var body = '<tr><th style="width:34px">#</th><th>Description</th><th style="width:60px;text-align:right">Qty</th>' +
      '<th style="width:90px;text-align:right">Unit Price</th><th style="width:100px;text-align:right">Amount</th></tr>' +
      '<tr><td>1</td><td>' + desc + '</td>' +
      '<td style="text-align:right">' + fmtQty(qty) + '</td>' +
      '<td style="text-align:right">' + (priceOk ? um(unit) : TBD) + '</td>' +
      '<td style="text-align:right">' + (priceOk ? um(total) : TBD) + '</td></tr>';

    var terms = [
      ['Trade Term', incoterm],
      ['Payment', s.paymentTermsEn || s.paymentTerms],
      ['Lead Time', Number(lead) > 0 ? lead + ' days after deposit' : 'To be confirmed'],
      ['MOQ', p ? fmtQty(p.moq) + ' pcs' : '—'],
      ['Certification', p ? certText(p.certs) : '—'],
      ['HS Code', (p && p.hsCode) || '—'],
      ['Validity', valid + ' days']
    ].map(function (t) {
      return '<tr><td class="tk">' + t[0] + '</td><td>' + C.esc(t[1]) + '</td></tr>';
    }).join('');

    return [
      '<!doctype html><html><head><meta charset="utf-8"><title>Quotation ' + no + '</title>',
      '<style>',
      '@page{size:A4;margin:16mm}',
      '*{box-sizing:border-box}',
      'body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#222;font-size:12px;line-height:1.6;margin:0}',
      '.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #ff6a00;padding-bottom:14px}',
      '.co{font-size:17px;font-weight:700}',
      '.co small{display:block;font-size:11px;color:#777;font-weight:400;margin-top:3px}',
      '.qt{text-align:right}',
      '.qt h1{font-size:20px;margin:0;letter-spacing:2px;color:#ff6a00}',
      '.qt div{font-size:11px;color:#666;margin-top:3px}',
      '.info{display:flex;gap:24px;margin:18px 0}',
      '.info > div{flex:1}',
      '.lbl{font-size:10px;color:#999;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}',
      'table.items{width:100%;border-collapse:collapse;margin-top:6px}',
      'table.items th{background:#f5f5f5;font-size:11px;text-align:left;padding:8px;border-bottom:1px solid #ddd}',
      'table.items td{padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top}',
      '.total{text-align:right;margin-top:10px;font-size:13px;font-weight:700}',
      '.total span{color:#ff6a00}',
      'table.terms{width:100%;border-collapse:collapse;margin-top:20px;font-size:11.5px}',
      'table.terms td{padding:6px 8px;border-bottom:1px dashed #e5e5e5}',
      'table.terms td.tk{color:#888;width:130px}',
      '.note{margin-top:18px;font-size:10.5px;color:#888;line-height:1.7;border-top:1px solid #eee;padding-top:12px}',
      '.sign{margin-top:30px;display:flex;justify-content:space-between;font-size:11px;color:#555}',
      '</style></head><body>',
      '<div class="hd">',
      '  <div class="co">' + C.esc(s.sellerName) + '<small>Export Department · Alibaba.com Supplier</small></div>',
      '  <div class="qt"><h1>QUOTATION</h1><div>No. ' + no + '</div><div>Date: ' + date + '</div></div>',
      '</div>',
      '<div class="info">',
      '  <div><div class="lbl">To</div><strong>' + C.esc((o.buyer && o.buyer.name) || '—') + '</strong><br>' +
      C.esc((o.buyer && o.buyer.company) || '') + '<br>' + C.esc((o.buyer && o.buyer.country) || '') + '</div>',
      '  <div><div class="lbl">From</div><strong>' + C.esc(s.sellerName) + '</strong><br>Sales Department<br>' + C.esc(incoterm) + '</div>',
      '</div>',
      '<table class="items">' + body + '</table>',
      priceOk
        ? '<div class="total">TOTAL: <span>' + um(total) + '</span> ' + C.esc(incoterm) + '</div>'
        : '<div class="total">TOTAL: <span>价格待定 (Price to be confirmed)</span></div>',
      '<table class="terms">' + terms + '</table>',
      '<div class="note">',
      '  <strong>Remarks</strong><br>',
      priceOk
        ? '  1. Prices are quoted in USD and valid for ' + valid + ' days from the date above.<br>'
        : '  1. Prices are to be confirmed; the validity period applies from the date a formal quotation is issued.<br>',
      '  2. Lead time starts from the date the deposit is received and the artwork is confirmed.<br>',
      '  3. Any customization (logo, color, packaging) may affect the price and the lead time.<br>',
      '  4. Bank charges outside the seller\'s bank are for the buyer\'s account.',
      '</div>',
      '<div class="sign"><div>Buyer confirmation: ____________________</div><div>' + C.esc(s.sellerName) + ' (Seal)</div></div>',
      '</body></html>'
    ].join('\n');
  }

  window.Reply = {
    replyEn: replyEn,
    replyZh: replyZh,
    negotiation: negotiation,
    quoteDocument: quoteDocument
  };
})();
