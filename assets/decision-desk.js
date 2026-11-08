/* =========================================================
   询盘处理决策台（P1-1 MVP）
   全局暴露：window.DecisionDesk

   一条询盘 → 一份可执行决策：需求分析（P0Parse）→ 商品匹配
   （SmartMatch）→ 报价条件判断（Pricing + PricingUnity）→
   回复草稿（ReplyAssistant，只生成、永不发送）→ 下一步建议
   （规则引擎，基于缺失字段/匹配确定性/报价状态）。

   数据边界：只读当前商品库（演示数据）与设置；不发消息。
   本页所有价格均为演示口径（DEMO）。未知信息一律标记未知，不编造。
   P1-2 批次 1 起：分析成果可由用户人工点击「保存到商机」写入既有
   商机记录（parseEdits / matches / selectedProductId / replyDrafts，
   结构与商机详情页的保存路径完全一致），或先建档再保存；无任何
   自动保存，写入一律走 Core.persist 并检查其返回值。
   ========================================================= */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : globalThis;

  function esc(s) {
    if (root.Core && root.Core.esc) return root.Core.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d || 0); }

  /* ---------- 1. 分析管线（纯逻辑，可独立测试） ---------- */
  function buildEff(p0, edits) {
    var f = (p0 && p0.fields) || {};
    var eff = {
      productName: f.productName || '', purpose: f.purpose || '',
      qty: f.qty || 0, targetPriceUsd: f.targetPriceUsd || 0,
      country: f.country || '', destination: f.destination || '',
      leadTimeDays: f.deadlineDays || 0, deadlineText: f.deadlineText || '',
      certs: f.certs || [], incoterm: f.incoterm || '',
      priceMentions: f.priceMentions || [], priceTargetCandidates: f.priceTargetCandidates || [],
      certMentions: f.certMentions || [], unrecognizedCertMentions: f.unrecognizedCertMentions || [],
      models: f.models || [], types: [], specs: f.specs || [],
      specsText: '', productText: f.productText || '',
      evidence: (p0 && p0.evidence) || {}, edited: {}
    };
    if (edits) {
      if (edits.productName) { eff.productName = edits.productName; eff.edited.productName = true; }
      if (edits.model) { eff.models = [edits.model]; eff.edited.model = true; }
      if (edits.qty) { eff.qty = num(edits.qty); eff.edited.qty = true; }
      if (edits.targetPriceUsd) { eff.targetPriceUsd = num(edits.targetPriceUsd); eff.edited.targetPriceUsd = true; }
      if (edits.leadTimeDays) { eff.leadTimeDays = num(edits.leadTimeDays); eff.edited.leadTimeDays = true; }
      if (edits.certs) { eff.certs = String(edits.certs).split(/[,，、]/).map(function (x) { return x.trim(); }).filter(Boolean); eff.edited.certs = true; }
      if (edits.purpose) { eff.purpose = edits.purpose; eff.edited.purpose = true; }
    }
    return eff;
  }

  function dimsSummary(result) {
    var hits = [], issues = [];
    var dims = (result && result.dims) || {};
    Object.keys(dims).forEach(function (k) {
      var d = dims[k];
      if (d.status === 'hit' || d.status === 'part') hits.push(d.label + (d.status === 'part' ? '（部分）' : ''));
      else issues.push(d.label + (d.status === 'conflict' ? '冲突' : '未命中'));
    });
    (result && result.conflicts || []).forEach(function (c) { issues.push(String(c)); });
    return { hits: hits, issues: issues };
  }

  /* 认证护栏（P1-17 修复 B）：强制/不明确语境的认证要求未被首选商品登记覆盖，
     或文中存在未识别的认证提及 → 不得给出可报价结论，也不得把价格写进草稿。
     商品「未登记」按未核实处理，不等同于明确不具备；询问/偏好语境不触发护栏。 */
  function computeCertGuard(eff, topProduct) {
    /* 第五阶段：同一认证在原文中既被要求又被称不需要（conflict）→ 无论商品是否登记
       该认证，都不得自动报价：矛盾只能由人工核实消除，不能由系统替客户裁决。 */
    var conflicts = (eff.certMentions || []).filter(function (cm) { return cm.conflict; });
    if (conflicts.length) {
      var cNames = conflicts.map(function (cm) { return cm.name; });
      return { type: 'conflict', names: cNames, why: '认证 ' + cNames.join(' / ') + ' 在同一询盘中既被要求又被称不需要（语境冲突），需人工核实客户真实要求后再报价' };
    }
    var unrec = (eff.unrecognizedCertMentions || []).filter(function (u) { return u.context === 'mandatory' || u.context === 'unclear'; });
    if (unrec.length) {
      var names = unrec.map(function (u) { return u.token; });
      return { type: 'unrecognized', names: names, why: '客户提出了认证要求（' + names.join('、') + '），系统未能识别，需人工核实后再报价' };
    }
    var ctxOf = {};
    (eff.certMentions || []).forEach(function (cm) { ctxOf[String(cm.name).toUpperCase()] = cm.context; });
    var requiredCerts = (eff.certs || []).filter(function (c) {
      var ctx = ctxOf[String(c).toUpperCase()] || 'unclear';
      return ctx === 'mandatory' || ctx === 'unclear';
    });
    if (requiredCerts.length) {
      if (!topProduct) {
        /* 第三阶段修复 D：无匹配商品时护栏同样成立——没有商品可核对即未核实，
           不得因 noMatch 分支跳过认证风险（风险与匹配结果相互独立）。 */
        return { type: 'uncovered', names: requiredCerts, why: '客户要求认证 ' + requiredCerts.join(' / ') + '，尚无已确认匹配的商品可核对，该认证未核实，需人工核实后再报价' };
      }
      var pCerts = (topProduct.certs || []).map(function (c) { return String(c).toUpperCase(); });
      var missingCerts = requiredCerts.filter(function (c) { return pCerts.indexOf(String(c).toUpperCase()) < 0; });
      if (missingCerts.length) {
        return { type: 'uncovered', names: missingCerts, why: '客户要求认证 ' + missingCerts.join(' / ') + '，首选商品未登记该认证（未核实），需人工核实后再报价' };
      }
    }
    return null;
  }

  /* 单个候选的报价护栏（P1-3B-1）：第一名原有的护栏计算原样抽出并按
     候选参数化——evaluate → negotiation → unitUsd 回退链 → resolve 的
     顺序、表达式与 hardFail 组成逐字保持，任一步失败 unity=null（与
     第一名原 try/catch 同义）。纯计算：不写状态、不写存储；结果只供
     就绪结论（第一名）与对比展示（第二名），第二名结果不进入草稿链。 */
  function guardrailFor(entry, eff, settings) {
    var product = entry.product;
    var unity = null;
    try {
      var ev = root.Pricing ? root.Pricing.evaluate({ product: product, qty: eff.qty || product.moq || 1, settings: settings || {} }) : null;
      var nego = null;
      try { nego = root.Workflow ? root.Workflow.negotiation({ product: product, qty: eff.qty || product.moq || 1, settings: settings || {}, unitPriceUsd: ev ? ev.unitPriceUsd : 0, buyerTargetUsd: eff.targetPriceUsd }) : null; } catch (e) { nego = null; }
      var belowMoq = eff.qty > 0 && (product.moq || 0) > eff.qty;
      /* 决策台尚无人工报价，工作报价取挂牌价（新询盘的默认报价口径，
         与商机详情里卖家已填报价同位）；系统建议价只作对照展示。 */
      var unitForUnity = ev ? (num(ev.listUsd) > 0 ? num(ev.listUsd) : num(product.priceUsd)) : 0;
      if (!(unitForUnity > 0) && ev) unitForUnity = num(ev.unitPriceUsd);
      unity = root.PricingUnity ? root.PricingUnity.resolve({
        evaluate: ev, product: product, nego: nego,
        unitUsd: unitForUnity,
        hardFail: !!entry.result.keyConflict || belowMoq
      }) : null;
    } catch (e) { unity = null; }
    return { unity: unity, certGuard: computeCertGuard(eff, product) };
  }

  /* 结论链（P1-3B-2）：把「护栏 → 就绪 → safePrice → 草稿 → draftPriced」
     抽成按候选执行的 conclude。analyze 默认以第一名调用（ambiguous 用
     原判定），人工选品以所选候选调用且 ambiguous=false——人工点选即
     拍板，与详情页选品后按所选商品报价的既有模型一致；其余门禁
     （quotable / certGuard / unitUsd / hardFail）全部原样保留。
     entry 为 ranked 条目 {product, result}；noMatch 时 entry 仍传第一名
     （仅供草稿 match 信息），商品传 null，与原实现逐字等价。 */
  function conclude(entry, ctx) {
    var eff = ctx.eff, settings = ctx.settings, text = ctx.text;
    var unity = null, readiness, certGuard = null, reply = null, draftPriced = false;
    if (ctx.noMatch) {
      readiness = { key: 'not-suitable', label: '当前条件不适合报价', why: '没有可靠匹配的商品，禁止强行推荐报价' };
      /* 认证护栏独立于匹配结果：noMatch 分支同样计算并保留（第三阶段修复 D） */
      certGuard = computeCertGuard(eff, null);
    } else {
      var g = guardrailFor(entry, eff, settings);
      unity = g.unity;
      if (!unity) readiness = { key: 'need-verify', label: '需要人工核实', why: '报价模块未返回结果' };
      /* 歧义优先展示：否则演示数据普遍缺成本时，第 3 区永远只显示缺成本，
         用户看不到「先确认哪一款」这条更靠前的动作（P1-8 验收 3.2）。
         缺成本信息不丢弃，附在 why 里；报价拦截不因此放松——
         safePrice 在歧义或不可报价时本就为空，草稿不会带价。 */
      else if (ctx.ambiguous) readiness = { key: 'need-verify', label: '需要人工核实', why: '多个商品匹配接近，先人工确认推荐哪一款' + (unity.noCost ? '；另：' + unity.blockReasons.join('；') : '') };
      else if (unity.noCost) readiness = { key: 'missing-cost', label: '缺少成本或必要报价参数', why: unity.blockReasons.join('；') };
      else if (unity.quotable) readiness = { key: 'can-quote', label: '可以进入报价', why: '成本、保本价与底价校验通过（演示数据口径）' };
      else readiness = { key: 'need-verify', label: '需要人工核实', why: unity.blockReasons.join('；') || '报价条件未全部通过' };
      /* 认证护栏：即使价格口径全部通过，强制认证未核实也不得进入报价 */
      certGuard = g.certGuard;
      if (certGuard && readiness.key === 'can-quote') {
        readiness = { key: 'need-verify', label: '需要人工核实', why: certGuard.why };
      }
    }
    /* 回复草稿（复用 ReplyAssistant；价格只在可报价时传入） */
    try {
      /* 价格进草稿的门禁：可报价之外还必须匹配无歧义——歧义时第一名
         只是待确认候选，把它的价格写进草稿等于替用户拍板（P1-3 审查 P1-01）；
         人工选品路径 ctx.ambiguous 已由点选置 false，不在此放松其他门禁。 */
      var safePrice = (unity && unity.quotable && unity.unitUsd > 0 && !ctx.ambiguous && !certGuard)
        ? { unit: unity.unitUsd, floor: unity.quoteFloorUsd, breakEven: unity.breakEvenUsd > 0 ? unity.breakEvenUsd : null } : null;
      reply = root.ReplyAssistant ? root.ReplyAssistant.generate({
        opp: { rawText: text, buyer: { country: eff.country || '' }, quote: { qty: eff.qty || 0 }, status: 'new', followCount: 0 },
        eff: eff,
        product: ctx.noMatch ? null : entry.product,
        match: entry ? { score: entry.result.score, keyConflict: entry.result.keyConflict, conflicts: entry.result.conflicts } : null,
        price: safePrice,
        sellerName: (settings && settings.sellerName) || '',
        scenario: 'auto',
        lang: effLangOf(text)
      }) : null;
      /* 工作报价展示门控（方案 1）：只有草稿的完整报价行确实采用了
         safePrice.unit 时，才允许在第 3 区标注「工作报价（草稿采用）」。
         ReplyAssistant 的 usedPrice 只表示价格曾传入（澄清稿也为真），
         不能作依据；这里对报价行原文做严格整行匹配。无法确认即不标注。 */
      if (safePrice && reply && reply.en) {
        var amt = safePrice.unit.toFixed(2).replace(/\./g, '\\.');
        draftPriced = new RegExp('^(?:For (?:\\d+|the quoted) pcs, our price is \\$' + amt + ' per piece(?: \\([^)]*\\))?|Our current best price is \\$' + amt + ' per piece, based on the listed specifications(?: and certifications \\([^)]*\\))?|The best I can offer for the current specification is \\$' + amt + ' per piece)\\.$', 'm').test(reply.en);
      }
    } catch (e) { reply = null; draftPriced = false; }
    return { unity: unity, certGuard: certGuard, readiness: readiness, reply: reply, draftPriced: draftPriced };
  }

  function analyze(text, products, settings, edits) {
    text = String(text || '');
    var p0 = root.P0Parse ? root.P0Parse.extract(text) : null;
    var eff = buildEff(p0, edits);
    var missing = [];
    if (!eff.qty) missing.push({ field: 'qty', label: '数量未知' });
    if (!eff.models.length && !(eff.specs && eff.specs.length)) missing.push({ field: 'spec', label: '规格/型号未知' });
    if (!eff.productName && !eff.models.length) missing.push({ field: 'product', label: '商品名称未知' });
    if (!eff.leadTimeDays && !eff.deadlineText) missing.push({ field: 'deadline', label: '交期要求未知' });
    if (((p0 && p0.blocking) || []).length) missing.push({ field: 'blocking', label: '存在高优先级待确认项（见解析提示）' });

    var pool = (products || []).map(function (p) { return { product: p, match: null }; });
    var ranked = (root.SmartMatch && pool.length) ? root.SmartMatch.rank(eff, text, pool) : [];
    var top = ranked[0] || null;
    var second = ranked[1] || null;
    var ambiguous = !!(top && second && !top.result.keyConflict &&
      (top.result.score - second.result.score) < 10 && second.result.score >= 50);
    var noMatch = !top || top.result.score < 40 || !!top.result.keyConflict;

    var candidates = ranked.slice(0, 3).map(function (r) {
      var ds = dimsSummary(r.result);
      return {
        product: r.product, score: r.result.score,
        keyConflict: !!r.result.keyConflict,
        hits: ds.hits, issues: ds.issues,
        assess: r.result
      };
    });

    /* 报价条件判断（复用 Pricing.evaluate + PricingUnity.resolve，不自创口径） */
    var concl = conclude(top, { eff: eff, settings: settings, text: text, ambiguous: ambiguous, noMatch: noMatch });
    var unity = concl.unity, readiness = concl.readiness, certGuard = concl.certGuard;

    /* P1-3B-1：第二名独立护栏——仅供第 2 区对比展示。入选条件与第一名
       同一条可信线（真实存在、与第一名不同 id、分数 ≥ 40、无关键
       冲突），不满足不凑数。计算全程隔离：异常只让第二名标记为未取得
       结果（guardrail=null），不改 unity/readiness/草稿任何第一名产物。 */
    if (!noMatch && second && top && second.product.id !== top.product.id &&
        second.result.score >= 40 && !second.result.keyConflict) {
      var g2 = null;
      try { g2 = guardrailFor(second, eff, settings); } catch (e) { g2 = null; }
      for (var ci = 0; ci < candidates.length; ci++) {
        if (candidates[ci].product.id === second.product.id) { candidates[ci].guardrail = g2; break; }
      }
    }

    var reply = concl.reply, draftPriced = concl.draftPriced;

    /* 摘要按最终 eff（人工修正后）重算，与字段/匹配/报价同源；
       原 p0.summary 来自原文初次解析，改数量后标题会与字段不一致（P1-8 验收 2.9）。
       数量未知时不写数量段，不虚构。 */
    var sumBits = [];
    if (eff.qty) sumBits.push(eff.qty + ' pcs');
    if (eff.models && eff.models.length) sumBits.push('型号 ' + eff.models.join('/'));
    if (eff.leadTimeDays) sumBits.push(eff.leadTimeDays + ' 天交期');
    if (eff.targetPriceUsd) sumBits.push('目标价 $' + eff.targetPriceUsd);

    var out = {
      demo: true,
      rawText: text,
      summary: sumBits.join(' · ') || (p0 ? p0.summary : ''),
      needsReview: p0 ? p0.needsReview : [],
      eff: eff, missing: missing,
      candidates: candidates, top: noMatch ? null : candidates[0],
      selected: noMatch ? null : candidates[0],
      selectionSource: 'auto', selectionAt: null,
      ambiguous: ambiguous, noMatch: noMatch,
      unity: unity, readiness: readiness, certGuard: certGuard,
      reply: reply, draftPriced: draftPriced,
      steps: null
    };
    out.steps = nextSteps(out);
    return out;
  }

  /* ---------- 2. 下一步建议（规则引擎） ---------- */
  function nextSteps(a) {
    var steps = [];
    function add(action, why) {
      if (!steps.some(function (s) { return s.action === action; })) steps.push({ action: action, why: why });
    }
    if (a.noMatch) add('人工确认商品', '没有可靠匹配，先确认买家到底要什么，不要报价');
    if (a.ambiguous) add('在候选商品中人工确认一款', '前两名匹配分接近，自动推荐不可靠');
    a.missing.forEach(function (m) {
      if (m.field === 'qty') add('先确认数量', '数量未知，无法核算报价与运费');
      if (m.field === 'spec') add('先确认规格/型号', '规格型号未知，匹配与报价都可能出错');
      if (m.field === 'deadline') add('确认期望交期', '交期未知，需与商品交期比对');
    });
    if (a.certGuard) add('核实认证要求', a.certGuard.why);
    if (a.eff.certs && a.eff.certs.length && a.top && a.top.product &&
        !(a.top.product.certs || []).length) {
      add('补充/核实认证信息', '买家要求认证 ' + a.eff.certs.join('/') + '，候选商品未登记认证');
    }
    if (a.readiness.key === 'missing-cost') add('核实报价条件（先补成本）', a.readiness.why);
    else if (a.readiness.key === 'need-verify') add('核实报价条件', a.readiness.why);
    else if (a.readiness.key === 'can-quote') add('准备正式报价', '报价条件已通过，人工确认价格后在商机流程中出正式报价');
    if (!steps.length) add('等待买家回复', '信息与报价条件无明显缺口');
    return steps.slice(0, 5);
  }

  /* ---------- 2.5 保存到商机（P1-2 批次 1） ----------
     写入的四类字段与商机详情页既有保存路径同构：
     - parseEdits：键名与 core.sanitizeParseEdits / app.saveParsed 一致
       （型号存 modelsText、认证存 certsText），只写非空项；
     - matches：{productId, score, reason}，与 normalizeOpp 的清洗口径一致；
     - selectedProductId：仅在有可靠匹配时写，并同步 matchOverride=false
       （与详情页人工选品语义一致）；无可靠匹配时不触碰这两个字段；
     - replyDrafts：场景键必须落在 core 的 REPLY_SCENARIOS 白名单内，
       草稿为空不写；人工改过草稿时保留商机上原有的中文稿，不拿空值覆盖。
     parseEdits 的数量/交期同步写回 quote（与 saveParsed 相同，避免解析
     口径与报价口径各说各话）；quoteVersions、followLog、deal 等一律不碰。 */
  var REPLY_SCENARIOS = ['first', 'prequote', 'spec', 'moq', 'negotiation', 'sample', 'clarify'];

  /* 人工选品（P1-3B-2）：在前二候选内切换最终商品，并以所选候选重新
     执行正式 conclude。第一名恒可选；第二名须满足 B-1 可信条件且自身
     护栏已取得（unity 非空），否则拒绝。草稿已被人工编辑时先确认。
     conclude 抛错时进入安全态：清空旧结论、旧就绪与旧草稿，按所选商品
     重新生成无价草稿，绝不保留旧商品的价格与报价状态；本函数不做任何
     持久化写入，保存仍只经 saveToOpp 的既有路径。 */
  function applySelection(productId) {
    var r = S.result;
    if (!r || r.noMatch || !r.candidates || !r.candidates.length) return false;
    var idx = -1, cand = null;
    for (var i = 0; i < r.candidates.length && i < 2; i++) {
      if (String(r.candidates[i].product.id) === String(productId)) { idx = i; cand = r.candidates[i]; break; }
    }
    if (!cand) return false;
    if (idx === 1 && !(('guardrail' in cand) && cand.guardrail && cand.guardrail.unity)) return false;
    if (r.selected && String(r.selected.product.id) === String(productId)) return true;
    if (draftEdited()) {
      var ok = (typeof root.confirm === 'function') ? root.confirm('切换最终商品会按新商品重新生成报价结论与回复草稿，当前草稿的人工修改将丢失，是否继续？') : false;
      if (!ok) return false;
    }
    var settings = {};
    try { settings = (state() && state().settings) || {}; } catch (e) { settings = {}; }
    /* 切回第一名 = 撤销人工拍板、完整恢复默认结论：conclude 重新启用
       原歧义判定，来源标记同步回到 auto；选第二名才是人工拍板。 */
    var isTop = idx === 0;
    var concl = null;
    try {
      concl = conclude({ product: cand.product, result: cand.assess }, { eff: r.eff, settings: settings, text: S.text, ambiguous: isTop ? r.ambiguous : false, noMatch: false });
    } catch (e) { concl = null; }
    if (concl) {
      r.unity = concl.unity; r.certGuard = concl.certGuard; r.readiness = concl.readiness;
      r.reply = concl.reply; r.draftPriced = concl.draftPriced;
    } else {
      r.unity = null; r.certGuard = null; r.draftPriced = false;
      r.readiness = { key: 'need-verify', label: '需要人工核实', why: '所选商品报价计算失败，已清除旧报价与草稿，请核实后重新分析' };
      r.reply = null;
      try {
        r.reply = root.ReplyAssistant ? root.ReplyAssistant.generate({
          opp: { rawText: S.text, buyer: { country: r.eff.country || '' }, quote: { qty: r.eff.qty || 0 }, status: 'new', followCount: 0 },
          eff: r.eff, product: cand.product,
          match: { score: cand.score, keyConflict: cand.keyConflict, conflicts: (cand.assess && cand.assess.conflicts) || [] },
          price: null, sellerName: settings.sellerName || '', scenario: 'auto', lang: effLangOf(S.text)
        }) : null;
      } catch (e) { r.reply = null; }
    }
    r.selected = cand;
    r.selectionSource = isTop ? 'auto' : 'manual';
    r.selectionAt = isTop ? null : ((root.Core && root.Core.nowIso) ? root.Core.nowIso() : null);
    r.steps = nextSteps(r);
    S.draft = r.reply ? (r.reply.send || r.reply.en || '') : '';
    S.baseDraft = S.draft;
    S.lastSavedOppId = '';
    return true;
  }

  function buildSavePayload(result, effNow, draft, baseDraft) {
    var e = effNow || (result && result.eff) || {};
    var pe = {};
    if (e.productName) pe.productName = String(e.productName).slice(0, 160);
    if (e.models && e.models.length) pe.modelsText = e.models.join(', ').slice(0, 160);
    if (num(e.qty) > 0) pe.qty = Math.round(num(e.qty));
    if (num(e.targetPriceUsd) > 0) pe.targetPriceUsd = Math.round(num(e.targetPriceUsd) * 100) / 100;
    if (e.country) pe.country = String(e.country).slice(0, 160);
    if (e.destination) pe.destination = String(e.destination).slice(0, 160);
    if (num(e.leadTimeDays) > 0) pe.leadTimeDays = Math.round(num(e.leadTimeDays));
    if (e.incoterm) pe.incoterm = String(e.incoterm).slice(0, 160);
    if (e.certs && e.certs.length) pe.certsText = e.certs.join(', ').slice(0, 160);
    if (e.purpose) pe.purpose = String(e.purpose).slice(0, 160);
    var matches = null, selectedProductId = null;
    if (result && !result.noMatch && result.candidates && result.candidates.length) {
      matches = result.candidates.map(function (c) {
        return { productId: String((c.product && (c.product.id || c.product.sku)) || ''), score: Math.round(num(c.score)), reason: (c.hits || []).join('、').slice(0, 200) };
      }).filter(function (m) { return m.productId; });
      var selP = (result.selected && result.selected.product) || (result.top && result.top.product);
      if (selP) selectedProductId = String(selP.id || selP.sku || '') || null;
      if (!matches.length) { matches = null; selectedProductId = null; }
    }
    var draftSlot = null;
    var edited = draft != null && baseDraft != null && draft !== baseDraft;
    if (draft && result && result.reply && REPLY_SCENARIOS.indexOf(result.reply.scenario) >= 0) {
      draftSlot = { key: result.reply.scenario, en: String(draft), zh: edited ? null : (result.reply.zh || null), edited: edited };
    }
    return { parseEdits: pe, matches: matches, selectedProductId: selectedProductId, draftSlot: draftSlot,
      selectionSource: (result && result.selectionSource) || 'auto',
      selectionAt: (result && result.selectionAt) || null };
  }

  function applySavePayload(opp, payload) {
    var written = [];
    opp.parseEdits = payload.parseEdits || {};
    written.push('解析修正');
    if (payload.parseEdits.qty) opp.quote.qty = payload.parseEdits.qty;
    if (payload.parseEdits.leadTimeDays) opp.quote.leadTimeDays = payload.parseEdits.leadTimeDays;
    if (payload.matches) { opp.matches = payload.matches; written.push('匹配结果'); }
    if (payload.selectedProductId) {
      opp.selectedProductId = payload.selectedProductId;
      opp.matchOverride = false;
      written.push('选品');
    }
    if (payload.selectionSource) {
      opp.selectionSource = payload.selectionSource;
      opp.selectionAt = payload.selectionAt || null;
    }
    if (payload.draftSlot) {
      opp.replyDrafts = opp.replyDrafts || {};
      var prev = opp.replyDrafts[payload.draftSlot.key] || null;
      opp.replyDrafts[payload.draftSlot.key] = {
        en: payload.draftSlot.en,
        zh: payload.draftSlot.zh != null ? payload.draftSlot.zh : (prev ? prev.zh || '' : ''),
        edited: payload.draftSlot.edited,
        at: root.Core && root.Core.nowIso ? root.Core.nowIso() : null
      };
      written.push('回复草稿');
    }
    return written;
  }

  function currentView() {
    try {
      var v = root.localStorage && root.localStorage.getItem('ic_data_view');
      if (v === 'demo' || v === 'real') return v;
    } catch (e) {}
    var st = state();
    var dv = st && st.uiState && st.uiState.dataView;
    return (dv === 'demo' || dv === 'real') ? dv : 'real';
  }

  /* 商品池视图隔离（DEMO-PRODUCT-ISOLATION-01/02）：与 Core.visibleOpps
     对商机的口径对称——演示视图只允许演示商品、真实视图只允许非演示
     商品，唯一判据是 Core.isDemoProduct（demo 标记或内置演示 ID 集），
     不用名称/价格/前缀猜测。过滤必须发生在匹配与报价计算之前：
     runAnalysis 在调用 analyze 之前先过此函数。
     Fail-closed（02 修复 01 的 fail-open）：判据不存在、不是函数、或对
     任一商品调用时抛错，整个池判定失败并返回 { ok: false, products: [] }，
     绝不返回未经分类的原始池、绝不跳过坏商品保留其余商品。 */
  function poolForView(products, view) {
    var list = Array.isArray(products) ? products : [];
    if (!root.Core || typeof root.Core.isDemoProduct !== 'function') {
      return { ok: false, products: [], reason: 'classifier_unavailable' };
    }
    var kept;
    try {
      kept = list.filter(function (p) {
        var demo = !!root.Core.isDemoProduct(p);
        return view === 'demo' ? demo : !demo;
      });
    } catch (e) {
      return { ok: false, products: [], reason: 'classifier_error' };
    }
    return { ok: true, products: kept };
  }

  function visibleTargets() {
    var st = state();
    if (!st || !root.Core || !root.Core.visibleOpps) return [];
    return root.Core.visibleOpps(st, currentView()).slice().sort(function (a, b) {
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  }

  function el(id) {
    return (typeof document !== 'undefined' && document && document.getElementById) ? document.getElementById(id) : null;
  }

  /* 建档成功后就地刷新目标下拉：让选中项与已重绑的 S.targetOppId 一致，
     避免界面仍显示「新建商机」而实际已绑定新商机（后续点击应走更新）。 */
  function refreshTargetOptions() {
    var tg = el('dd-target');
    if (!tg) return;
    var targets = visibleTargets();
    tg.innerHTML = '<option value="">＋ 新建商机（保存时建档）</option>' + targets.map(function (o) {
      var label = ((o.buyer && o.buyer.name) || '未知买家') + ' · ' + String(o.createdAt || '').slice(0, 10) + ' · ' + String(o.rawText || '').replace(/\s+/g, ' ').slice(0, 36);
      return '<option value="' + esc(o.id) + '">' + esc(label) + '</option>';
    }).join('');
    tg.value = S.targetOppId || '';
  }

  var DUP_STATUS_LABEL = { new: '待处理', matched: '已匹配', quoted: '已报价', won: '已成交', lost: '已丢单' };

  /* 疑似重复候选面板：逐条列出全部候选并可单独打开，或明确仍要新建。
     查重只是提醒——措辞一律「疑似」，不冒充确定重复。 */
  function renderDupPanel() {
    var box = el('dd-dup');
    if (!box) return;
    var dups = S.dupCandidates || [];
    if (!dups.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="alert" style="margin-top:8px"><span class="ic">i</span><div>发现 <b>' + dups.length + '</b> 条与本次粘贴内容相同、买家相同的已有商机（<b>疑似重复</b>，不会自动合并）。打开已有商机继续处理，或确认是新询盘后仍要新建并保存。</div></div>' +
      dups.map(function (d) {
        return '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #eee">' +
          '<div style="min-width:0"><b>' + esc(d.buyerName || '未知买家') + '</b> <span class="badge">' + esc(DUP_STATUS_LABEL[d.status] || d.status) + '</span> <span class="mute">' + esc(String(d.createdAt || '').slice(0, 10)) + '</span>' +
          '<div class="mute" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px">' + esc(d.snippet) + '</div></div>' +
          '<button class="btn sm" data-dd-open="' + esc(d.id) + '">打开已有商机</button></div>';
      }).join('') +
      '<div style="margin-top:8px"><button class="btn primary" id="dd-dup-force">仍要新建并保存</button></div>';
    var opens = box.querySelectorAll('[data-dd-open]');
    for (var i = 0; i < opens.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          S.dupCandidates = [];
          switchTarget(btn.getAttribute('data-dd-open'), null);
        });
      })(opens[i]);
    }
    var force = el('dd-dup-force');
    if (force) force.addEventListener('click', function () {
      S.dupForce = true;
      S.dupCandidates = [];
      var b = el('dd-dup'); if (b) b.innerHTML = '';
      saveToOpp();
    });
  }

  function saveFeedback(kind, msg) {
    var s = el('dd-save-status');
    if (s) {
      s.textContent = msg;
      s.style.color = kind === 'error' ? '#b91c1c' : '#047857';
    }
    return msg;
  }

  /* 保存主流程。返回 {ok, stage, oppId, message}：
     stage: 'update' 直接写入既有商机；'create' 先建档后写入；
     建档成功但成果写入失败时 ok=false 且 stage='created-unsaved'，
     此时目标已绑定到新商机，再次点击只补写成果、不会重复建档。 */
  function saveToOpp() {
    if (S.saving) return { ok: false, stage: 'busy', message: '正在保存，请勿重复点击' };
    if (!S.result) return { ok: false, stage: 'no-result', message: '先完成一次分析再保存' };
    var C = root.Core;
    if (!C || !C.get || !C.persist) return { ok: false, stage: 'no-core', message: '数据模块未就绪，无法保存' };
    var st = C.get();
    if (!st) return { ok: false, stage: 'no-state', message: '数据未就绪，无法保存' };
    S.saving = true;
    var btn = el('dd-save');
    if (btn) btn.disabled = true;
    try {
      var p0 = root.P0Parse ? root.P0Parse.extract(S.text) : null;
      /* 保存时的解析修正取用户当前确认的字段值：浏览器里读七个字段输入框
         （可能改了字段还没点重新分析）；无 DOM 的环境回退到最近一次分析的 eff */
      var effNow = (typeof document !== 'undefined' && document && document.getElementById)
        ? buildEff(p0, collectEdits()) : S.result.eff;
      var payload = buildSavePayload(S.result, effNow, S.draft, S.baseDraft);
      var view = currentView();
      var targetId = S.targetOppId || '';
      var opp = null;
      var created = false;
      /* 新一轮保存尝试开始：清掉上一次的成功跳转入口，避免失败后残留误导 */
      S.lastSavedOppId = '';
      var oo0 = el('dd-open-opp'); if (oo0) oo0.innerHTML = '';
      if (targetId) {
        var list = C.visibleOpps(st, view);
        for (var i = 0; i < list.length; i++) { if (list[i].id === targetId) { opp = list[i]; break; } }
        if (!opp) {
          saveFeedback('error', '保存失败：目标商机不存在或不在当前视图，未写入任何数据');
          return { ok: false, stage: 'target-missing', message: '目标商机不存在或不在当前视图' };
        }
      } else {
        /* P1-3A：建档买家身份——用户在第 6 区可选填写称呼/公司，口径与
           商机页建档一致（company 优先的 buyerKey 归一化不改）；两项
           都为空时与旧行为逐字一致（未知买家、空公司）。 */
        var bn = String(S.buyerName || '').trim();
        var bc = String(S.buyerCompany || '').trim();
        var buyerForCreate = { name: bn || '未知买家', company: bc };
        /* P1-2 批次 2：建档查重闸——与新建商机弹窗同一套 Core 查重，
           命中先让用户裁决（打开已有 / 仍要新建），不自动合并或拒绝；
           查重异常按无命中处理，绝不阻断保存。买家桶用本次填写值
           （都为空时与旧版固定未知买家完全相同）。 */
        var dups = [];
        try { dups = C.findDuplicateOpps ? C.findDuplicateOpps(st, view, buyerForCreate, S.text) : []; } catch (e) { dups = []; }
        if (dups.length && !S.dupForce) {
          S.dupCandidates = dups;
          renderDupPanel();
          saveFeedback('error', '发现 ' + dups.length + ' 条疑似重复询盘，请先在下方确认（只是提醒，不会自动合并）');
          return { ok: false, stage: 'duplicate', oppId: '', message: '疑似重复，待用户确认' };
        }
        S.dupCandidates = [];
        var settings = st.settings || {};
        opp = C.normalizeOpp({
          demo: view === 'demo',
          buyer: { name: buyerForCreate.name, company: buyerForCreate.company, country: effNow.country || '', channel: '询盘' },
          rawText: S.text,
          quote: {
            qty: effNow.qty || 100,
            unitPriceUsd: 0,
            incoterm: settings.defaultIncoterm,
            leadTimeDays: effNow.leadTimeDays || settings.defaultLeadTimeDays,
            validDays: settings.quoteValidDays
          }
        });
        st.opportunities.unshift(opp);
        if (C.addLog) C.addLog(opp, '决策台建档（粘贴询盘保存）');
        if (!C.persist()) {
          var ix = st.opportunities.indexOf(opp);
          if (ix >= 0) st.opportunities.splice(ix, 1);
          saveFeedback('error', '建档失败：本地写入被阻断或失败，未创建商机，请检查后重试');
          return { ok: false, stage: 'create-failed', message: '建档落盘失败，已回滚' };
        }
        created = true;
        S.targetOppId = opp.id;
        targetId = opp.id;
      }
      var written = applySavePayload(opp, payload);
      if (C.addLog) C.addLog(opp, '决策台保存分析成果：' + written.join('、'));
      if (!C.persist()) {
        if (created) {
          saveFeedback('error', '已建档（商机已创建），但分析成果未保存成功，请再次点击保存补写');
          return { ok: false, stage: 'created-unsaved', oppId: targetId, message: '已建档，分析成果未保存' };
        }
        saveFeedback('error', '保存失败：本地写入被阻断或失败，商机数据未变更');
        return { ok: false, stage: 'persist-failed', oppId: targetId, message: '落盘失败' };
      }
      var who = (opp.buyer && opp.buyer.name) || '商机';
      if (created) refreshTargetOptions();
      saveFeedback('ok', (created ? '已建档并保存到新商机' : '已保存到商机') + '（' + who + '）：' + written.join('、') +
        '。下一步：打开该商机核对回复草稿，确认发送时请设定下一次跟进日期。');
      /* P1-3A：保存成功衔接——用本次保存的准确 ID 生成详情页入口
         （现有 #/opp/<id> 路由），不推测、不经列表查找；失败路径已在
         保存开始时清掉该入口，不会残留。 */
      S.lastSavedOppId = targetId;
      var oo = el('dd-open-opp');
      if (oo) oo.innerHTML = '<a class="btn sm primary" href="#/opp/' + esc(targetId) + '">打开该商机 →</a>';
      if (btn) btn.textContent = '已保存 ✓';
      return { ok: true, stage: created ? 'create' : 'update', oppId: targetId, message: '保存成功' };
    } finally {
      S.saving = false;
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- 3. 页面 ---------- */
  var S = { text: '', result: null, draft: '', baseDraft: '', targetOppId: '', saving: false, dupForce: false, dupCandidates: [], poolError: null, buyerName: '', buyerCompany: '', lastSavedOppId: '', replyLang: 'auto', detectedLang: '' };

  /* P1-5-REPLY：买家语言识别与发送稿语言决议。
     自动 = Translate.detect（拉丁语系走 LangPack 启发式）；detect 对中文
     返回 en，这里按 CJK 占比补判 zh。人工选择优先于自动识别。 */
  var LANG_NAMES = { en: '英语', zh: '中文', es: '西班牙语', fr: '法语', de: '德语', ar: '阿拉伯语', hi: '印地语', pt: '葡萄牙语', ru: '俄语', tr: '土耳其语', id: '印尼语', ko: '韩语', ja: '日语', he: '希伯来语', th: '泰语' };
  function langName(code) { return LANG_NAMES[code] || code || '未知'; }
  function buyerLangOf(text) {
    var det = 'en';
    try { det = (root.Translate && root.Translate.detect(text)) || 'en'; } catch (e) { det = 'en'; }
    if (det === 'en') {
      var s = String(text || '');
      var cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
      var lat = (s.match(/[a-zA-Z]/g) || []).length;
      if (cjk > 0 && cjk >= lat) det = 'zh';
    }
    return det;
  }
  function effLangOf(text) {
    var c = S.replyLang || 'auto';
    return c === 'auto' ? buyerLangOf(text) : c;
  }

  /* 人工修改检测：当前草稿与最近一次 AI 生成的原稿内容不一致即视为已人工修改。
     按内容比较：删空、改字算修改；改回与原稿完全一致则不再算修改。 */
  function draftEdited() {
    return !!(S.result && S.draft !== S.baseDraft);
  }
  var DRAFT_WARN = '当前回复草稿包含人工修改。重新分析可能覆盖这些内容，是否继续？';

  function state() {
    try { return root.Core ? root.Core.get() : null; } catch (e) { return null; }
  }

  function fieldRow(label, name, value, unknown) {
    return '<label class="dd-field"><span>' + label + (unknown ? ' <em class="dd-unknown">未知</em>' : '') + '</span>' +
      '<input id="dd-f-' + name + '" value="' + esc(value == null ? '' : value) + '" placeholder="未知（请勿编造）"></label>';
  }

  /* 选品入口（P1-3B-2）：候选卡与对比表共用。当前选中显示徽标；第二名
     护栏未取得结果时明确不可选；第三名及以后不渲染入口。 */
  function pickHtml(c, i, r) {
    if (r.noMatch || i > 1) return '';
    var sel = r.selected && String(r.selected.product.id) === String(c.product.id);
    if (sel) return '<div style="margin-top:6px"><span class="badge" style="background:#dcfce7;color:#166534">当前选中 · ' + (r.selectionSource === 'manual' ? '人工选择' : '系统推荐') + '</span></div>';
    if (i === 1 && !(('guardrail' in c) && c.guardrail && c.guardrail.unity)) {
      return '<div class="mute" style="margin-top:6px">该候选护栏未取得结果，暂不能选为最终商品</div>';
    }
    return '<div style="margin-top:6px"><button class="btn sm" data-dd-pick="' + esc(String(c.product.id)) + '">选为最终商品</button></div>';
  }

  /* 对比区单个候选的护栏结论（P1-3B-1，只读展示口径）：只给结论与
     原因，不显示保本价/报价底线/成本数字（数字只留在第 3 区第一名
     处），不把匹配分数表述为成交概率。 */
  function compareVerdict(unity, certGuard) {
    if (!unity) return '护栏未取得结果（按未核实处理）';
    if (unity.quotable && !certGuard) return '可进入报价（候选自身护栏结论，最终以第 3 区就绪结论为准）';
    var rs = (unity.blockReasons || []).slice();
    if (certGuard) rs.push(certGuard.why);
    return '暂不可报价：' + (rs.join('；') || '报价条件未全部通过');
  }
  function certStatusText(certGuard, eff, guardrailMissing) {
    if (guardrailMissing) return '未核实（护栏未取得结果）';
    if (certGuard) return '未核实：' + certGuard.why;
    if (eff && eff.certs && eff.certs.length) return '买家要求的认证已登记';
    return '买家未提出需核实的认证要求';
  }
  function compareHtml(r) {
    if (r.noMatch || !r.candidates.length) return '';
    var c1 = r.candidates[0];
    var c2 = r.candidates[1] || null;
    if (!c2 || !('guardrail' in c2)) {
      return '<div class="mute" style="margin-top:8px">暂无第二个可信候选（其余候选分数不足、存在关键冲突或与第一名为同一商品，不凑数展示）。</div>';
    }
    function val(x, suffix) { return x > 0 ? String(x) + (suffix || '') : '未提供'; }
    function cell(c, top) {
      var p = c.product;
      var g = top ? { unity: r.unity, certGuard: r.certGuard } : c.guardrail;
      return {
        name: esc(p.title || p.titleEn || p.sku || '未提供') + (p.sku ? '<br><span class="mute">SKU ' + esc(p.sku) + '</span>' : ''),
        score: Math.round(c.score) + ' 分',
        hits: c.hits.length ? c.hits.map(esc).join('、') : '未提供',
        specs: esc(p.specs || p.specsEn || '未提供'),
        issues: c.issues.length ? c.issues.map(esc).join('、') : '未发现',
        moq: val(p.moq),
        lead: val(p.leadTimeDays, ' 天'),
        price: p.priceUsd > 0 ? '$' + p.priceUsd : '未提供',
        verdict: g ? compareVerdict(g.unity, g.certGuard) : '护栏未取得结果（按未核实处理）',
        cert: certStatusText(g ? g.certGuard : null, r.eff, !g)
      };
    }
    var a = cell(c1, true), b = cell(c2, false);
    function row(label, x, y) { return '<tr><th style="white-space:nowrap">' + label + '</th><td>' + x + '</td><td>' + y + '</td></tr>'; }
    var demand = (r.eff.models || []).concat(r.eff.specs || []).join('、');
    return '<div style="margin-top:10px"><b>前二候选对比</b> <span class="mute">买家需求：数量 ' + (r.eff.qty || '未提供') +
      '；型号/规格：' + esc(demand || '未提供') + '。护栏结论为候选自身口径，最终报价以第 3 区为准。</span></div>' +
      '<table class="tbl"><tr><th></th><th>第一候选</th><th>第二候选</th></tr>' +
      row('商品', a.name, b.name) + row('匹配分', a.score, b.score) + row('核心理由', a.hits, b.hits) +
      row('商品规格', a.specs, b.specs) + row('问题与缺失', a.issues, b.issues) + row('MOQ', a.moq, b.moq) +
      row('交期', a.lead, b.lead) + row('挂牌价', a.price, b.price) + row('护栏结论', esc(a.verdict), esc(b.verdict)) +
      row('认证情况', esc(a.cert), esc(b.cert)) + row('最终选品', pickHtml(c1, 0, r), pickHtml(c2, 1, r)) + '</table>';
  }

  function view() {
    var h = '<section class="card"><div class="card-hd"><div class="card-title">询盘处理决策台' +
      '<span class="card-sub">粘贴一条买家询盘，一次得到：需求、推荐商品与理由、能不能报价、回复草稿、下一步</span></div>' +
      '<span class="badge" style="background:#fef3c7;color:#92400e">演示数据 DEMO</span></div>' +
      '<div class="alert" style="margin-bottom:10px"><span class="ic">i</span><div>本台只读当前演示商品库，价格为演示口径；草稿<b>永不自动发送</b>。分析完成后可点第 6 区的「保存到商机」把成果存入商机，只有人工点击才会写入。未知信息会明确标为未知。</div></div>' +
      '<textarea id="dd-text" rows="6" style="width:100%" placeholder="粘贴买家询盘原文（中英文均可）">' + esc(S.text) + '</textarea>' +
      '<div style="margin-top:10px"><button class="btn primary" id="dd-analyze">开始分析</button></div></section>';
    var r = S.result;
    if (!r) {
      /* 分类校验失败的专属提示（与空池提示文案不同，禁止伪装成空池） */
      if (S.poolError) {
        return h + '<section class="card"><div class="alert warn"><span class="ic">!</span><div>商品分类校验失败，已停止分析。请刷新页面或检查数据状态后重试；本提示不是「商品为空」，系统未使用任何未经分类的商品。</div></div></section>';
      }
      return h;
    }

    /* 视图已切换：旧商品池的候选、报价、成本与草稿一律不渲染，
       避免演示/真实跨视图串数据（DEMO-PRODUCT-ISOLATION-01） */
    if (r.poolView && r.poolView !== currentView()) {
      return h + '<section class="card"><div class="alert warn"><span class="ic">!</span><div>视图已切换，请重新分析。上方输入保留，但之前的候选、报价与草稿来自' +
        (r.poolView === 'demo' ? '演示' : '真实') + '视图的商品池，已停止显示。</div></div></section>';
    }
    if (r.poolEmpty) {
      h += '<section class="card"><div class="alert warn"><span class="ic">!</span><div>当前视图没有可用商品，不会使用另一视图的商品。本次分析没有可用的' +
        (r.poolView === 'demo' ? '演示' : '真实') + '商品可匹配，请先在对应视图准备商品数据。</div></div></section>';
    }

    /* ① 买家需求（可修正） */
    var e = r.eff;
    h += '<section class="card"><div class="card-hd"><div class="card-title">1 · 买家需要什么' +
      '<span class="card-sub">' + esc(r.summary || '') + '（字段可修改，改完点「按修正重新分析」）</span></div></div>' +
      '<div class="dd-grid">' +
      fieldRow('商品名称', 'productName', e.productName, !e.productName) +
      fieldRow('型号', 'model', (e.models || []).join(', '), !(e.models || []).length) +
      fieldRow('数量', 'qty', e.qty || '', !e.qty) +
      fieldRow('目标价 USD', 'targetPriceUsd', e.targetPriceUsd || '', !e.targetPriceUsd) +
      fieldRow('交期（天）', 'leadTimeDays', e.leadTimeDays || '', !e.leadTimeDays && !e.deadlineText) +
      fieldRow('认证要求', 'certs', (e.certs || []).join(', '), !(e.certs || []).length) +
      fieldRow('用途/场景', 'purpose', e.purpose, !e.purpose) +
      '</div>' +
      (e.priceMentions && e.priceMentions.length ? '<div class="sm-list" style="margin-top:8px"><span class="sm-list-t">文中价格：</span>' +
        e.priceMentions.map(function (pm) {
          var roleZh = { OUR_QUOTE: '我方报价', COMPETITOR_QUOTE: '竞品报价', CUSTOMER_TARGET: '客户目标价', CUSTOMER_BUDGET: '客户预算', UNKNOWN_PRICE: '角色未定' }[pm.role] || pm.role;
          return esc((pm.currency === 'USD' ? '$' : pm.currency + ' ') + pm.value + '（' + roleZh + (pm.range ? '，区间价' : '') + '）');
        }).join('、') +
        (e.priceTargetCandidates && e.priceTargetCandidates.length > 1 ? '；<b>目标价有多个候选，请确认后填入上方目标价字段</b>' : '') + '</div>' : '') +
      (e.unrecognizedCertMentions && e.unrecognizedCertMentions.length ? '<div class="sm-list" style="margin-top:8px;color:#b45309"><span class="sm-list-t">未识别的认证提及：</span>' +
        e.unrecognizedCertMentions.map(function (u) { return esc(u.token); }).join('、') + '（系统未识别，需人工核实）</div>' : '') +
      (e.certMentions && e.certMentions.some(function (cm) { return cm.conflict; }) ? '<div class="sm-list" style="margin-top:8px;color:#b91c1c"><span class="sm-list-t">认证语境冲突：</span>' +
        e.certMentions.filter(function (cm) { return cm.conflict; }).map(function (cm) {
          /* 展示层合并：同一语境同一原文的重复提及只显示一次（证据层仍逐次保留） */
          var seenEv = {}, evList = (cm.evidence || []).filter(function (ev) { var k = ev.context + '|' + ev.snippet; if (seenEv[k]) return false; seenEv[k] = 1; return true; });
          return esc(cm.name) + '（' + evList.map(function (ev) { return (ev.context === 'mandatory' ? '要求' : ev.context === 'not-required' ? '称不需要' : ev.context) + '：“' + esc(ev.snippet) + '”'; }).join('；') + '）';
        }).join('、') + '——两种说法并存，请人工核实</div>' : '') +
      (r.missing.length ? '<div class="sm-list mute" style="margin-top:8px"><span class="sm-list-t">未知项：</span>' +
        r.missing.map(function (m) { return esc(m.label); }).join('；') + '</div>' : '') +
      '<div style="margin-top:10px"><button class="btn" id="dd-reanalyze">按修正重新分析</button></div></section>';

    /* ② 推荐商品 */
    h += '<section class="card"><div class="card-hd"><div class="card-title">2 · 推荐哪个商品，为什么</div></div>';
    if (r.noMatch) {
      h += '<div class="alert danger"><span class="ic">!</span><div>没有可靠匹配的商品。不要强行推荐，请先人工确认买家需求。</div></div>';
    }
    r.candidates.forEach(function (c, i) {
      h += '<div class="dd-cand' + (i === 0 && !r.noMatch ? ' dd-top' : '') + '">' +
        '<div><b>' + (i === 0 && !r.noMatch ? '最匹配：' : '候选：') + esc(c.product.title || c.product.titleEn || c.product.sku || '') + '</b>' +
        ' <span class="badge">匹配 ' + Math.round(c.score) + ' 分</span>' +
        (c.keyConflict ? ' <span class="badge" style="background:#fee2e2;color:#991b1b">关键冲突</span>' : '') + '</div>' +
        (c.hits.length ? '<div class="sm-list"><span class="sm-list-t">依据：</span>' + c.hits.map(esc).join('、') + '</div>' : '') +
        (c.issues.length ? '<div class="sm-list mute"><span class="sm-list-t">问题：</span>' + c.issues.map(esc).join('、') + '</div>' : '') +
        pickHtml(c, i, r) +
        '</div>';
    });
    if (r.ambiguous) h += '<div class="alert"><span class="ic">i</span><div>前两名候选分数接近，系统不替你拍板，请人工确认选哪一款。</div></div>';
    h += compareHtml(r);
    h += '</section>';

    /* ③ 报价状态 */
    var u = r.unity;
    h += '<section class="card"><div class="card-hd"><div class="card-title">3 · 现在能不能报价</div></div>' +
      (r.selected ? '<div class="mute" style="margin-bottom:6px">当前结论基于：<b>' + esc(r.selected.product.title || r.selected.product.titleEn || r.selected.product.sku || '') + '</b>（' + (r.selectionSource === 'manual' ? '人工选择' : '系统推荐') + '）</div>' : '') +
      '<div style="font-size:16px"><b>' + esc(r.readiness.label) + '</b></div><div class="mute">' + esc(r.readiness.why) + '</div>';
    if (u) {
      h += '<div class="dd-grid" style="margin-top:8px">' +
        '<div>保本价：<b>' + (u.breakEvenUsd > 0 ? '$' + u.breakEvenUsd : '未知（缺成本）') + '</b></div>' +
        '<div>登记底价：<b>' + (u.businessFloorUsd > 0 ? '$' + u.businessFloorUsd : '未登记') + '</b></div>' +
        '<div>报价底线（取高）：<b>$' + u.quoteFloorUsd + '</b></div>' +
        '<div>谈判底线（提示性）：<b>' + (u.negoFloorUsd != null ? '$' + u.negoFloorUsd : '未计算') + '</b></div>' +
        (r.draftPriced ? '<div>工作报价（草稿采用）：<b>$' + u.unitUsd.toFixed(2) + '/件</b></div>' : '') +
        '<div>系统建议价（参考）：<b>' + (u.recommendUsd > 0 ? '$' + u.recommendUsd.toFixed(2) + '/件' : '—') + '</b></div>' +
        '<div>口径：演示数据 DEMO</div></div>' +
        (u.warnings.length ? '<div class="sm-list mute" style="margin-top:6px"><span class="sm-list-t">提醒：</span>' + u.warnings.map(esc).join('；') + '</div>' : '');
    }
    h += '</section>';

    /* ④ 回复草稿 */
    h += '<section class="card"><div class="card-hd"><div class="card-title">4 · 回复草稿（人工确认后自行复制发送）</div></div>';
    if (r.reply) {
      var detL = S.detectedLang || buyerLangOf(S.text);
      var sendL = r.reply.sendLang || 'en';
      var langOpts = [['auto', '自动识别（当前：' + langName(detL) + '）'], ['en', '英语'], ['zh', '中文'], ['es', '西班牙语'], ['pt', '葡萄牙语'], ['ru', '俄语']];
      h += '<div class="mute">场景：' + esc(r.reply.scenarioLabel || '') + '</div>' +
        '<div style="margin-top:4px">买家语言：<b>' + esc(langName(detL)) + '</b>（自动识别） · 发送稿语言：<b>' + esc(langName(sendL)) + '</b>' +
        ' <label style="margin-left:8px">发送稿语言 <select id="dd-lang" style="width:auto;height:30px">' +
        langOpts.map(function (o) { return '<option value="' + o[0] + '"' + ((S.replyLang || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></label></div>' +
        (r.reply.degraded
          ? '<div class="sm-list" style="margin-top:6px;color:#b45309"><span class="sm-list-t">降级提示：</span>买家语言为' + esc(langName(r.reply.wantLang)) + '，暂无该语言回复模板，发送稿已降级为英文，发送前请留意。</div>' : '') +
        (r.reply.unconfirmed && r.reply.unconfirmed.length
          ? '<div class="sm-list mute"><span class="sm-list-t">尚未确认（草稿中不会编造）：</span>' + r.reply.unconfirmed.map(esc).join('；') + '</div>' : '') +
        '<textarea id="dd-draft" rows="9" style="width:100%">' + esc(S.draft || r.reply.send || r.reply.en || '') + '</textarea>' +
        '<div style="margin-top:8px"><button class="btn" id="dd-copy">复制草稿</button></div>' +
        '<label style="margin-top:10px">中文对照（只给你看，不发送）</label>' +
        '<textarea id="dd-draft-zh" rows="7" readonly style="width:100%">' + esc(r.reply.zh || '') + '</textarea>' +
        (sendL !== 'en' && r.reply.en
          ? '<details style="margin-top:8px"><summary class="mute" style="cursor:pointer">英文参考稿（不发送）</summary><textarea rows="7" readonly style="width:100%;margin-top:6px">' + esc(r.reply.en) + '</textarea></details>' : '');
    } else {
      h += '<div class="mute">回复模块未返回草稿。</div>';
    }
    h += '</section>';

    /* ⑤ 下一步 */
    h += '<section class="card"><div class="card-hd"><div class="card-title">5 · 下一步做什么</div></div><ol class="dd-steps">' +
      r.steps.map(function (s) { return '<li><b>' + esc(s.action) + '</b> <span class="mute">— ' + esc(s.why) + '</span></li>'; }).join('') +
      '</ol></section>';

    /* ⑥ 保存到商机（P1-2 批次 1）：目标只能是当前视图内的商机，或新建。
       写入内容：解析修正、匹配结果、选品、回复草稿；不改报价版本与跟进记录。 */
    var targets = visibleTargets();
    var targetStillValid = targets.some(function (o) { return o.id === S.targetOppId; });
    if (S.targetOppId && !targetStillValid) S.targetOppId = '';
    h += '<section class="card"><div class="card-hd"><div class="card-title">6 · 保存到商机' +
      '<span class="card-sub">把本次分析成果存进商机，切换页面或刷新后不丢失；只有点保存才会写入</span></div></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<label>保存到 <select id="dd-target" style="max-width:340px">' +
      '<option value="">＋ 新建商机（保存时建档）</option>' +
      targets.map(function (o) {
        var label = ((o.buyer && o.buyer.name) || '未知买家') + ' · ' + String(o.createdAt || '').slice(0, 10) + ' · ' + String(o.rawText || '').replace(/\s+/g, ' ').slice(0, 36);
        return '<option value="' + esc(o.id) + '"' + (o.id === S.targetOppId ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('') +
      '</select></label>' +
      '<button class="btn primary" id="dd-save">保存到商机</button>' +
      '<span id="dd-save-status" style="font-size:13px"></span>' +
      '<span id="dd-open-opp">' + (S.lastSavedOppId && S.lastSavedOppId === S.targetOppId ? '<a class="btn sm primary" href="#/opp/' + esc(S.lastSavedOppId) + '">打开该商机 →</a>' : '') + '</span></div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">' +
      '<label>买家称呼（新建时可选）<input type="text" id="dd-buyer-name" value="' + esc(S.buyerName) + '" placeholder="买家姓名或称呼" style="margin-left:6px"></label>' +
      '<label>公司（新建时可选）<input type="text" id="dd-buyer-company" value="' + esc(S.buyerCompany) + '" placeholder="公司名称" style="margin-left:6px"></label>' +
      '<span class="mute">仅在新建商机时写入买家信息；留空按「未知买家」建档，与商机页建档口径一致。</span></div>' +
      '<div id="dd-dup"></div>' +
      '<div class="mute" style="margin-top:6px">保存内容：解析修正、匹配与选品、回复草稿（场景：' + esc(r.reply ? (r.reply.scenarioLabel || r.reply.scenario || '') : '无草稿') + '）。不会改动报价版本、跟进记录与成交信息。</div></section>';
    return h;
  }

  function runAnalysis(edits, confirmFn) {
    /* 草稿保护：已生成过分析且草稿被人工修改时，先确认再覆盖；取消则原样保留、不重渲染。 */
    if (draftEdited()) {
      var ok = typeof confirmFn === 'function' ? confirmFn(DRAFT_WARN)
        : (typeof root.confirm === 'function' ? root.confirm(DRAFT_WARN) : false);
      if (!ok) return false;
    }
    var st = state();
    var poolView = currentView();
    var pool = poolForView((st && st.products) || [], poolView);
    if (!pool.ok) {
      /* Fail-closed：分类校验失败 → 不调用 analyze、作废旧结果（含草稿），
         显示与空池不同的失败提示，绝不放行未经分类的商品 */
      S.result = null; S.draft = ''; S.baseDraft = '';
      S.dupForce = false; S.dupCandidates = [];
      S.poolError = pool.reason || 'classifier_unavailable';
      var vf = document.getElementById('view');
      if (vf) { vf.innerHTML = view(); mount(); }
      if (root.App && root.App.toast) root.App.toast('商品分类校验失败，已停止分析');
      return false;
    }
    S.poolError = null;
    var products = pool.products;
    var settings = (st && st.settings) || {};
    S.dupForce = false; S.dupCandidates = [];
    S.result = analyze(S.text, products, settings, edits || null);
    /* 记录本次分析的商品池来源视图与空池状态：视图切换后 view()
       据此拒绝渲染旧结果；空池时明确提示、绝不回退另一视图的商品 */
    S.result.poolView = poolView;
    S.result.poolEmpty = products.length === 0;
    S.lastSavedOppId = '';
    S.detectedLang = buyerLangOf(S.text);
    S.draft = S.result.reply ? (S.result.reply.send || S.result.reply.en || '') : '';
    S.baseDraft = S.draft;
    var v = document.getElementById('view');
    if (v) { v.innerHTML = view(); mount(); }
    return true;
  }

  function collectEdits() {
    function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    return {
      productName: val('dd-f-productName'), model: val('dd-f-model'),
      qty: val('dd-f-qty'), targetPriceUsd: val('dd-f-targetPriceUsd'),
      leadTimeDays: val('dd-f-leadTimeDays'), certs: val('dd-f-certs'),
      purpose: val('dd-f-purpose')
    };
  }

  function mount() {
    var btn = document.getElementById('dd-analyze');
    if (btn) btn.addEventListener('click', function () {
      var t = document.getElementById('dd-text');
      S.text = t ? t.value : '';
      if (!S.text.trim()) { alert('先粘贴一条询盘原文'); return; }
      runAnalysis(null);
    });
    var re = document.getElementById('dd-reanalyze');
    if (re) re.addEventListener('click', function () { runAnalysis(collectEdits()); });
    var lg = document.getElementById('dd-lang');
    if (lg) lg.addEventListener('change', function () {
      S.replyLang = lg.value || 'auto';
      /* 语言切换只影响回复生成，但为保证结论/报价/草稿同源，沿用
         重新分析路径整体重算（已含草稿人工修改确认机制） */
      runAnalysis(collectEdits());
    });
    var cp = document.getElementById('dd-copy');
    if (cp) cp.addEventListener('click', function () {
      var d = document.getElementById('dd-draft');
      if (!d) return;
      S.draft = d.value;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(d.value);
      else { d.select(); document.execCommand && document.execCommand('copy'); }
      cp.textContent = '已复制（请到平台手动发送）';
    });
    var dr = document.getElementById('dd-draft');
    if (dr) dr.addEventListener('input', function () { S.draft = dr.value; });
    var sv = document.getElementById('dd-save');
    if (sv) sv.addEventListener('click', function () { saveToOpp(); });
    var bnEl = document.getElementById('dd-buyer-name');
    if (bnEl) bnEl.addEventListener('input', function () { S.buyerName = bnEl.value; });
    var bcEl = document.getElementById('dd-buyer-company');
    if (bcEl) bcEl.addEventListener('input', function () { S.buyerCompany = bcEl.value; });
    var tg = document.getElementById('dd-target');
    if (tg) tg.addEventListener('change', function () { switchTarget(tg.value, tg); });
    var picks = (typeof document.querySelectorAll === 'function') ? document.querySelectorAll('[data-dd-pick]') : [];
    for (var pi = 0; pi < picks.length; pi++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          if (applySelection(btn.getAttribute('data-dd-pick'))) {
            var v = document.getElementById('view');
            if (v) { v.innerHTML = view(); mount(); }
          }
        });
      })(picks[pi]);
    }
    if (S.dupCandidates && S.dupCandidates.length) renderDupPanel();
  }

  /* 切换保存目标：载入所选商机的原文并清空当前分析，避免把 A 的成果写进 B。
     当前草稿有人工修改时先确认（与重新分析的草稿保护同一口径）。 */
  function switchTarget(newId, selectEl) {
    if (!newId || newId === S.targetOppId) { S.targetOppId = newId || ''; return; }
    var list = visibleTargets();
    var opp = null;
    for (var i = 0; i < list.length; i++) { if (list[i].id === newId) { opp = list[i]; break; } }
    if (!opp) { if (selectEl) selectEl.value = S.targetOppId || ''; return; }
    if (S.result && draftEdited()) {
      var ok = (typeof root.confirm === 'function') ? root.confirm('切换商机将载入所选商机的原文，当前草稿包含人工修改、切换后将清空，是否继续？') : false;
      if (!ok) { if (selectEl) selectEl.value = S.targetOppId || ''; return; }
    }
    S.targetOppId = newId;
    S.lastSavedOppId = '';
    S.text = opp.rawText || '';
    S.result = null;
    S.draft = ''; S.baseDraft = '';
    S.dupForce = false; S.dupCandidates = [];
    var v = document.getElementById('view');
    if (v) { v.innerHTML = view(); mount(); }
  }

  root.DecisionDesk = { analyze: analyze, guardrailFor: guardrailFor, conclude: conclude, applySelection: applySelection, nextSteps: nextSteps, view: view, mount: mount, runAnalysis: runAnalysis, draftEdited: draftEdited, buildSavePayload: buildSavePayload, applySavePayload: applySavePayload, saveToOpp: saveToOpp, poolForView: poolForView, _state: S };
})();
