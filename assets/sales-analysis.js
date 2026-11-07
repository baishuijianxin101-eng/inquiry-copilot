/* =========================================================
   P1-22 第一阶段：客户销售判断（规则型结构化分析，非大模型）
   口径：只使用询盘原文、既有解析（effectiveParsed）与系统记录；
   每项判断区分 明确/推断/未提供/冲突 并附证据原文；
   不生成成交概率，不编造客户未表达的规格、认证、数量、价格与顾虑。
   人工修正走 opp.salesReview 覆盖层，与本分析结果分开保存、互不覆盖。
   ========================================================= */
(function () {
  'use strict';

  var STAGES = ['初步了解', '明确需求', '商品比较', '供应商筛选', '价格谈判', '样品或订单推进', '暂时无法判断'];

  function has(re, text) { return re.test(text || ''); }
  function quoted(text, re) { var m = (text || '').match(re); return m ? m[0] : ''; }

  /* input: { rawText, eff, buyerName, isRepeat, hasPriorOrders, followQuestions,
              certConflict (bool), certConflictText, productName (已匹配商品名|null),
              productCerts (已匹配商品认证数组|null) } */
  function analyze(input) {
    var raw = String(input.rawText || '');
    var eff = input.eff || {};
    var ev = eff.evidence || {};
    var needs = [];

    function need(key, label, value, status, evidence) {
      needs.push({ key: key, label: label, value: value || '', status: status, evidence: evidence || '' });
    }
    /* ---- 1. 需求理解 ---- */
    /* productText 是解析器的弱回退：当它与原文整句相同且无型号/品名佐证时，
       说明原文里根本没有产品信息（如 "Hi, price?"），不能当作已识别产品 */
    var pt = eff.productText || '';
    var productStatus = null;
    if (pt && pt.trim() === raw.trim() && !(eff.models && eff.models.length) && !eff.productName) {
      /* 整句回退里若含明确类目词（如 receivers），记为类目级推断；否则视为无产品信息 */
      var cat = raw.match(/\b(receivers?|transmitters?|sensors?|drones?|cameras?|modules?|controllers?|motors?|batter\w+|chargers?|antennas?|goggles?|frames?|propellers?)\b/i);
      if (cat) { pt = cat[1] + '（类目）'; productStatus = 'inferred'; } else pt = '';
    }
    var productVal = eff.productName || (eff.models && eff.models.length ? eff.models.join(' / ') : '') || pt;
    if (productVal && !productStatus) productStatus = 'stated';
    need('product', '产品', productVal, productVal ? productStatus : 'missing', ev.productName || ev.models || (productStatus === 'inferred' ? raw : ''));
    var specsVal = (eff.specs && eff.specs.length) ? eff.specs.map(function (s) { return s.name ? (s.name + (s.value ? '：' + s.value : '')) : (s.label ? (s.label + (s.value ? ' ' + s.value : '')) : String(s)); }).join('；') : (eff.specsText || '');
    need('specs', '规格参数', specsVal, specsVal ? 'stated' : 'missing', ev.specs || '');
    need('qty', '数量', eff.qty ? String(eff.qty) + (eff.qtyUnit ? ' ' + eff.qtyUnit : ' pcs') : '', eff.qty ? 'stated' : 'missing', ev.qty || '');
    need('purpose', '用途', eff.purpose || '', eff.purpose ? 'inferred' : 'missing', ev.purpose || '');
    var certStatus = 'missing', certVal = (eff.certs || []).join(' / ');
    if (input.certConflict) certStatus = 'conflict';
    else if (certVal) certStatus = 'stated';
    else if (eff.unrecognizedCerts && eff.unrecognizedCerts.length) { certStatus = 'stated'; certVal = eff.unrecognizedCerts.join(' / ') + '（未识别）'; }
    need('certs', '认证要求', certVal, certStatus, input.certConflict ? (input.certConflictText || '') : (ev.certs || ''));
    need('delivery', '交货时间', eff.leadTimeDays ? eff.leadTimeDays + ' 天' : (eff.deadlineText || ''), (eff.leadTimeDays || eff.deadlineText) ? 'stated' : 'missing', ev.deadlineDays || '');
    need('destination', '目的地', eff.destination || eff.country || '', (eff.destination || eff.country) ? 'stated' : 'missing', ev.destination || '');
    var priceStatus = eff.targetPriceUsd ? 'stated' : 'missing';
    if (eff.priceAmbiguous) priceStatus = 'conflict';
    need('targetPrice', '目标价', eff.targetPriceUsd ? '$' + eff.targetPriceUsd : '', priceStatus, ev.targetPriceUsd || '');

    /* ---- 2. 关注点（只认原文信号；无信号记未知，不编造） ---- */
    var concerns = [];
    function concern(topic, level, evidence) { concerns.push({ topic: topic, level: level, evidence: evidence || '' }); }
    var priceEv = quoted(raw, /[^.]*\b(target price|best price|price ?list|too high|expensive|cheaper|discount|competitor|other supplier[^.]*\$?\s*\d|budget)\b[^.]*/i);
    if (eff.targetPriceUsd || priceEv) concern('价格', '明确关注', priceEv || ev.targetPriceUsd || '客户给出了目标价');
    else if (eff.qty >= 1000) concern('价格', '可能关注', '数量较大（' + eff.qty + '），此类订单通常会重点议价——此为经验推断，客户未明说');
    if (certVal || input.certConflict) concern('认证', '明确关注', input.certConflict ? (input.certConflictText || '认证要求存在冲突表述') : '客户明确要求 ' + certVal);
    if (eff.leadTimeDays || eff.deadlineText) concern('交货时间', '明确关注', ev.deadlineDays || eff.deadlineText || '客户给出了交期要求');
    var qualityEv = quoted(raw, /[^.]*\b(quality|defect|failure rate|reliab\w+|durable|warranty)\b[^.]*/i);
    if (qualityEv) concern('产品质量', '明确关注', qualityEv); else concern('产品质量', '未知', '询盘未提及质量要求');
    var moqEv = quoted(raw, /[^.]*\b(MOQ|minimum order|trial order|small quantity)\b[^.]*/i);
    if (moqEv) concern('MOQ', '明确关注', moqEv);
    else if (eff.qty && input.productMoq && eff.qty < input.productMoq) concern('MOQ', '明确关注', '询盘数量 ' + eff.qty + ' 低于商品 MOQ ' + input.productMoq);
    var afterEv = quoted(raw, /[^.]*\b(warranty|after[- ]sales|spare parts|repair|replacement)\b[^.]*/i);
    if (afterEv) concern('售后', '明确关注', afterEv); else concern('售后', '未知', '询盘未提及售后要求');
    var supplierEv = quoted(raw, /[^.]*\b(factory|manufacturer|audit|visit|company profile|export experience|certificate of)\b[^.]*/i);
    if (supplierEv) concern('供应商可靠性', '明确关注', supplierEv); else concern('供应商可靠性', '未知', '询盘未提及验厂/资质类要求');
    var customEv = quoted(raw, /[^.]*\b(OEM|ODM|custom\w*|logo|private label|packaging)\b[^.]*/i);
    if (customEv) concern('定制能力', '明确关注', customEv);

    /* ---- 3. 采购阶段（规则判断 + 证据 + 不确定性） ---- */
    var missingKeys = needs.filter(function (n) { return n.status === 'missing'; }).map(function (n) { return n.key; });
    var stage = '', stageEv = [], uncertainty = '';
    /* 谈判只认议价语义（嫌贵/折扣/竞品比较）；单纯询价或报出目标价不算谈判 */
    var neg = has(/\b(too high|too expensive|discount|competitor|cheaper|elsewhere|other supplier|your price is|reduce the price|price is high)\b/i, raw);
    var sample = has(/\b(sample|samples|trial order)\b/i, raw);
    var comparingSuppliers = has(/\b(quotations? from|other suppliers?|several suppliers|comparing suppliers|your competitors)\b/i, raw);
    var comparingProducts = has(/\b(comparing|compare|difference between|which model|or the \w+ model)\b/i, raw) && !comparingSuppliers;
    var completeness = ['product', 'qty', 'certs', 'delivery'].filter(function (k) { return missingKeys.indexOf(k) < 0; }).length;
    if (neg) { stage = '价格谈判'; stageEv.push(priceEv || '客户给出目标价 ' + (eff.targetPriceUsd ? '$' + eff.targetPriceUsd : '') + ' 并提及比较/议价'); }
    else if (sample) { stage = '样品或订单推进'; stageEv.push(quoted(raw, /[^.]*\bsamples?\b[^.]*/i)); }
    else if (input.isRepeat || input.hasPriorOrders) { stage = '样品或订单推进'; stageEv.push('系统记录：该客户为复购/有历史订单（来自商机记录，非询盘原文）'); }
    else if (comparingSuppliers) { stage = '供应商筛选'; stageEv.push(quoted(raw, /[^.]*\bsuppliers?\b[^.]*/i)); }
    else if (comparingProducts) { stage = '商品比较'; stageEv.push(quoted(raw, /[^.]*\bcompar\w+\b[^.]*/i)); }
    else if (completeness >= 3 && productVal) { stage = '明确需求'; stageEv.push('产品、数量、认证、交期中已有 ' + completeness + ' 项明确'); }
    else if (productVal || eff.qty) { stage = '初步了解'; stageEv.push('已给出部分需求，但关键信息缺失较多'); }
    else { stage = '暂时无法判断'; stageEv.push('询盘未提供可识别的产品与数量信息'); }
    if (stage === '暂时无法判断') uncertainty = '信息严重不足，任何阶段判断都不可靠，先补信息再判断。';
    else if (input.certConflict || priceStatus === 'conflict') uncertainty = '询盘内部存在冲突信息，冲突澄清前阶段判断可能变化。';
    else if (missingKeys.length >= 4) uncertainty = '缺失信息较多（' + missingKeys.length + ' 项未提供），阶段判断仅供参考。';
    else uncertainty = '基于当前询盘原文的规则判断，客户后续回复可能改变阶段。';

    /* ---- 4. 下一步建议（由缺口/冲突/阶段驱动，逐条给理由） ---- */
    var steps = [];
    function step(action, why) { steps.push({ action: action, why: why }); }
    var byKey = {}; needs.forEach(function (n) { byKey[n.key] = n; });
    if (input.certConflict) step('先向客户核实认证要求到底以哪一条为准', '同一询盘中认证要求互相冲突（见证据），冲突未清前报价与选品都可能出错');
    if (priceStatus === 'conflict') step('先确认客户真正的目标价', '文中出现多个价格数字且角色不明确，贸然按某个数字测算会得出错误结论');
    if (byKey.specs.status === 'missing' && byKey.product.status === 'stated' && !/\b(same specs|same as (last|before)|as last order)\b/i.test(raw)) step('先询问关键规格参数再谈价格', '产品已明确但规格未提供，同产品不同规格成本差异大，先报价容易报偏');
    if (byKey.product.status === 'missing') step('先确认客户要买的具体产品/型号', '产品未识别前，匹配与报价都无从谈起');
    if (byKey.qty.status === 'missing' && byKey.product.status !== 'missing') step('确认采购数量', '数量决定单价与 MOQ 可行性，是报价的前置条件');
    if (byKey.destination.status === 'missing' && eff.incoterm && /CIF|DDP|DAP/i.test(eff.incoterm)) step('确认目的港/目的地', '已指定 ' + eff.incoterm + ' 条款时运费计入报价，目的地缺失则运费无法核算');
    if (stage === '价格谈判') step('进入报价测算并准备议价空间说明', '客户已进入议价，先用定价测算核对底线，再决定让步幅度——不要口头直接降价');
    else if (stage === '明确需求' || stage === '供应商筛选' || stage === '样品或订单推进') step('可推进报价/样品流程，先核对右侧定价测算与认证要求', '需求已基本明确，当前主要风险在价格底线与认证符合性');
    else if (stage === '初步了解') step('先发一封澄清型回复，补齐缺失信息后再报价', '信息不足时抢先报价命中率低，先问清 ' + missingKeys.length + ' 项缺失信息');
    if (certVal && input.productCerts && !input.certConflict) {
      var lacking = (eff.certs || []).filter(function (c) { return input.productCerts.indexOf(c) < 0; });
      if (lacking.length) step('先核实所选商品是否具备 ' + lacking.join('/') + ' 认证', '客户明确要求该认证，而当前匹配商品的认证清单未包含，确认前不要承诺');
    }
    if (!steps.length) step('先补齐缺失信息，再决定报价或样品', '当前信息不足以支持可靠的下一步动作');
    steps = steps.slice(0, 5);

    return {
      needs: needs, concerns: concerns,
      stage: { label: stage, evidence: stageEv.filter(Boolean), uncertainty: uncertainty, missing: missingKeys },
      steps: steps,
      capabilityNote: '本分析为规则型结构化分析（非大模型），结论均可追溯到询盘原文或系统记录；无证据处明确标为未知/推断。'
    };
  }

  /* 人工覆盖层合并：review = opp.salesReview；返回展示模型，AI 原结果不被改动 */
  function applyReview(analysis, review) {
    var r = review || {};
    var needs = analysis.needs.map(function (n) {
      var fix = (r.needFix || {})[n.key];
      var flagged = (r.flagged || []).indexOf('need:' + n.key) >= 0;
      if (fix) return { key: n.key, label: n.label, value: fix.value, status: 'confirmed', evidence: '员工人工确认' + (fix.at ? '（' + fix.at + '）' : ''), aiValue: n.value, aiStatus: n.status, flagged: flagged };
      return { key: n.key, label: n.label, value: n.value, status: n.status, evidence: n.evidence, flagged: flagged };
    });
    var concerns = analysis.concerns.map(function (c) {
      var f = (r.concernFix || {})[c.topic];
      if (f === 'confirmed') return { topic: c.topic, level: '明确关注', evidence: c.evidence + '（员工已确认）', aiLevel: c.level };
      if (f === 'dismissed') return { topic: c.topic, level: '未知', evidence: '员工标记：客户并不关注此项', aiLevel: c.level };
      return c;
    });
    var stage = { label: r.stageFix || analysis.stage.label, evidence: analysis.stage.evidence, uncertainty: analysis.stage.uncertainty, missing: analysis.stage.missing, confirmed: !!r.stageFix, flagged: (r.flagged || []).indexOf('stage') >= 0 };
    return { needs: needs, concerns: concerns, stage: stage, steps: analysis.steps, capabilityNote: analysis.capabilityNote, hasReview: !!(r.stageFix || (r.needFix && Object.keys(r.needFix).length) || (r.concernFix && Object.keys(r.concernFix).length) || (r.flagged || []).length) };
  }

  window.SalesAnalysis = { analyze: analyze, applyReview: applyReview, STAGES: STAGES };
})();
