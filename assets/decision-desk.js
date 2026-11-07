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
        hits: ds.hits, issues: ds.issues
      };
    });

    /* 报价条件判断（复用 Pricing.evaluate + PricingUnity.resolve，不自创口径） */
    var unity = null, readiness, certGuard = null;
    if (noMatch) {
      readiness = { key: 'not-suitable', label: '当前条件不适合报价', why: '没有可靠匹配的商品，禁止强行推荐报价' };
      /* 认证护栏独立于匹配结果：noMatch 分支同样计算并保留（第三阶段修复 D） */
      certGuard = computeCertGuard(eff, null);
    } else {
      try {
        var ev = root.Pricing ? root.Pricing.evaluate({ product: top.product, qty: eff.qty || top.product.moq || 1, settings: settings || {} }) : null;
        var nego = null;
        try { nego = root.Workflow ? root.Workflow.negotiation({ product: top.product, qty: eff.qty || top.product.moq || 1, settings: settings || {}, unitPriceUsd: ev ? ev.unitPriceUsd : 0, buyerTargetUsd: eff.targetPriceUsd }) : null; } catch (e) { nego = null; }
        var belowMoq = eff.qty > 0 && (top.product.moq || 0) > eff.qty;
        /* 决策台尚无人工报价，工作报价取挂牌价（新询盘的默认报价口径，
           与商机详情里卖家已填报价同位）；系统建议价只作对照展示。 */
        var unitForUnity = ev ? (num(ev.listUsd) > 0 ? num(ev.listUsd) : num(top.product.priceUsd)) : 0;
        if (!(unitForUnity > 0) && ev) unitForUnity = num(ev.unitPriceUsd);
        unity = root.PricingUnity ? root.PricingUnity.resolve({
          evaluate: ev, product: top.product, nego: nego,
          unitUsd: unitForUnity,
          hardFail: !!top.result.keyConflict || belowMoq
        }) : null;
      } catch (e) { unity = null; }
      if (!unity) readiness = { key: 'need-verify', label: '需要人工核实', why: '报价模块未返回结果' };
      /* 歧义优先展示：否则演示数据普遍缺成本时，第 3 区永远只显示缺成本，
         用户看不到「先确认哪一款」这条更靠前的动作（P1-8 验收 3.2）。
         缺成本信息不丢弃，附在 why 里；报价拦截不因此放松——
         safePrice 在歧义或不可报价时本就为空，草稿不会带价。 */
      else if (ambiguous) readiness = { key: 'need-verify', label: '需要人工核实', why: '多个商品匹配接近，先人工确认推荐哪一款' + (unity.noCost ? '；另：' + unity.blockReasons.join('；') : '') };
      else if (unity.noCost) readiness = { key: 'missing-cost', label: '缺少成本或必要报价参数', why: unity.blockReasons.join('；') };
      else if (unity.quotable) readiness = { key: 'can-quote', label: '可以进入报价', why: '成本、保本价与底价校验通过（演示数据口径）' };
      else readiness = { key: 'need-verify', label: '需要人工核实', why: unity.blockReasons.join('；') || '报价条件未全部通过' };
      /* 认证护栏：即使价格口径全部通过，强制认证未核实也不得进入报价 */
      certGuard = computeCertGuard(eff, top.product);
      if (certGuard && readiness.key === 'can-quote') {
        readiness = { key: 'need-verify', label: '需要人工核实', why: certGuard.why };
      }
    }

    /* 回复草稿（复用 ReplyAssistant；价格只在可报价时传入） */
    var reply = null;
    try {
      /* 价格进草稿的门禁：可报价之外还必须匹配无歧义——歧义时第一名
         只是待确认候选，把它的价格写进草稿等于替用户拍板（P1-3 审查 P1-01） */
      var safePrice = (unity && unity.quotable && unity.unitUsd > 0 && !ambiguous && !certGuard)
        ? { unit: unity.unitUsd, floor: unity.quoteFloorUsd, breakEven: unity.breakEvenUsd > 0 ? unity.breakEvenUsd : null } : null;
      reply = root.ReplyAssistant ? root.ReplyAssistant.generate({
        opp: { rawText: text, buyer: { country: eff.country || '' }, quote: { qty: eff.qty || 0 }, status: 'new', followCount: 0 },
        eff: eff,
        product: noMatch ? null : top.product,
        match: top ? { score: top.result.score, keyConflict: top.result.keyConflict, conflicts: top.result.conflicts } : null,
        price: safePrice,
        sellerName: (settings && settings.sellerName) || '',
        scenario: 'auto'
      }) : null;
    } catch (e) { reply = null; }

    /* 工作报价展示门控（方案 1）：只有草稿的完整报价行确实采用了
       safePrice.unit 时，才允许在第 3 区标注「工作报价（草稿采用）」。
       ReplyAssistant 的 usedPrice 只表示价格曾传入（澄清稿也为真），
       不能作依据；这里对报价行原文做严格整行匹配：金额必须是
       money() 的两位小数形态，且只认三类报价句（首次报价行 /
       谈判「当前最优价」/ 谈判「能给到的最优价」），其他文字里
       出现的相同金额（如商品标题）不算采用。无法确认即不标注。 */
    var draftPriced = false;
    if (safePrice && reply && reply.en) {
      var amt = safePrice.unit.toFixed(2).replace(/\./g, '\\.');
      draftPriced = new RegExp('^(?:For (?:\\d+|the quoted) pcs, our price is \\$' + amt + ' per piece(?: \\([^)]*\\))?|Our current best price is \\$' + amt + ' per piece, based on the listed specifications(?: and certifications \\([^)]*\\))?|The best I can offer for the current specification is \\$' + amt + ' per piece)\\.$', 'm').test(reply.en);
    }

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
      if (result.top && result.top.product) selectedProductId = String(result.top.product.id || result.top.product.sku || '') || null;
      if (!matches.length) { matches = null; selectedProductId = null; }
    }
    var draftSlot = null;
    var edited = draft != null && baseDraft != null && draft !== baseDraft;
    if (draft && result && result.reply && REPLY_SCENARIOS.indexOf(result.reply.scenario) >= 0) {
      draftSlot = { key: result.reply.scenario, en: String(draft), zh: edited ? null : (result.reply.zh || null), edited: edited };
    }
    return { parseEdits: pe, matches: matches, selectedProductId: selectedProductId, draftSlot: draftSlot };
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
      if (targetId) {
        var list = C.visibleOpps(st, view);
        for (var i = 0; i < list.length; i++) { if (list[i].id === targetId) { opp = list[i]; break; } }
        if (!opp) {
          saveFeedback('error', '保存失败：目标商机不存在或不在当前视图，未写入任何数据');
          return { ok: false, stage: 'target-missing', message: '目标商机不存在或不在当前视图' };
        }
      } else {
        /* P1-2 批次 2：建档查重闸——与新建商机弹窗同一套 Core 查重，
           命中先让用户裁决（打开已有 / 仍要新建），不自动合并或拒绝；
           查重异常按无命中处理，绝不阻断保存。 */
        var dups = [];
        try { dups = C.findDuplicateOpps ? C.findDuplicateOpps(st, view, { name: '未知买家', company: '' }, S.text) : []; } catch (e) { dups = []; }
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
          buyer: { name: '未知买家', company: '', country: effNow.country || '', channel: '询盘' },
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
      saveFeedback('ok', (created ? '已建档并保存到新商机' : '已保存到商机') + '（' + who + '）：' + written.join('、'));
      if (btn) btn.textContent = '已保存 ✓';
      return { ok: true, stage: created ? 'create' : 'update', oppId: targetId, message: '保存成功' };
    } finally {
      S.saving = false;
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- 3. 页面 ---------- */
  var S = { text: '', result: null, draft: '', baseDraft: '', targetOppId: '', saving: false, dupForce: false, dupCandidates: [], poolError: null };

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
        '</div>';
    });
    if (r.ambiguous) h += '<div class="alert"><span class="ic">i</span><div>前两名候选分数接近，系统不替你拍板，请人工确认选哪一款。</div></div>';
    h += '</section>';

    /* ③ 报价状态 */
    var u = r.unity;
    h += '<section class="card"><div class="card-hd"><div class="card-title">3 · 现在能不能报价</div></div>' +
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
      h += '<div class="mute">场景：' + esc(r.reply.scenarioLabel || '') + '</div>' +
        (r.reply.unconfirmed && r.reply.unconfirmed.length
          ? '<div class="sm-list mute"><span class="sm-list-t">尚未确认（草稿中不会编造）：</span>' + r.reply.unconfirmed.map(esc).join('；') + '</div>' : '') +
        '<textarea id="dd-draft" rows="9" style="width:100%">' + esc(S.draft || r.reply.en || '') + '</textarea>' +
        '<div style="margin-top:8px"><button class="btn" id="dd-copy">复制草稿</button></div>';
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
      '<span id="dd-save-status" style="font-size:13px"></span></div>' +
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
    S.draft = S.result.reply ? (S.result.reply.en || '') : '';
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
    var tg = document.getElementById('dd-target');
    if (tg) tg.addEventListener('change', function () { switchTarget(tg.value, tg); });
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
    S.text = opp.rawText || '';
    S.result = null;
    S.draft = ''; S.baseDraft = '';
    S.dupForce = false; S.dupCandidates = [];
    var v = document.getElementById('view');
    if (v) { v.innerHTML = view(); mount(); }
  }

  root.DecisionDesk = { analyze: analyze, nextSteps: nextSteps, view: view, mount: mount, runAnalysis: runAnalysis, draftEdited: draftEdited, buildSavePayload: buildSavePayload, applySavePayload: applySavePayload, saveToOpp: saveToOpp, poolForView: poolForView, _state: S };
})();
