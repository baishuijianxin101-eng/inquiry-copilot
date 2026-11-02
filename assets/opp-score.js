/* ===========================================================
   opp-score.js — 商机价值判断与跟进优先级（阶段三）
   全局暴露：window.OppScore

   设计原则：
   1. 规则评分，六个维度各有明确分值与理由：
      需求明确 20 / 采购意向 25 / 数量 15 / 商品匹配 20 /
      信息完整 10 / 沟通进展 10，合计 100。
   2. 缺失信息只影响「明确/完整」类维度，不直接判低价值：
      分级有意向门槛——意向信号强时，信息不全也能进高优先级
      （先回复、先补问）；信息再全、意向不明，也进不了高优先级。
   3. 意向只认明说的采购信号（要求报价/下单/索样/问付款等），
      不看询盘长短；目标价高低不影响价值分（只记「有没有给」）。
   4. 分数只代表规则下的处理优先级，不是成交概率，UI 必须按此口径展示。
   5. 纯函数（除 computedAt 时间戳）、无 DOM、无网络；
      不读成本、不读报价金额、不写存储。已成交/已丢单返回 closed，
      不再占用待处理优先级。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);
  var OS = {};

  /* 采购意向信号：只认明说的，不从长度、语气里猜 */
  var SIGNALS = [
    { key: 'quote', label: '明确要求报价', pts: 10, re: /\b(please\s+)?(quote|quotation|send\s+(?:me\s+)?(?:your\s+)?(?:best\s+)?price|price\s+list|your\s+best\s+(?:price|offer))\b|报价|询价/i },
    { key: 'order', label: '明确采购/下单意向', pts: 10, re: /\b(place\s+(?:an?\s+)?order|will\s+order|ready\s+to\s+(?:buy|order)|we\s+will\s+(?:buy|purchase)|want\s+to\s+(?:buy|order|purchase)|purchase\s+order)\b|下单|采购/i },
    { key: 'sample', label: '索要样品', pts: 6, re: /\bsamples?\b|样品/i },
    { key: 'terms', label: '询问付款/合同细节', pts: 5, re: /\b(payment\s+terms?|proforma|pi\b|contract|deposit)\b|付款方式|定金/i },
    { key: 'urgent', label: '时间紧迫', pts: 4, re: /\b(urgent|asap|as\s+soon\s+as\s+possible|immediately)\b|急|尽快/i },
    { key: 'details', label: '索要目录/详细资料', pts: 3, re: /\b(catalog|catalogue|more\s+details|detailed\s+specifications?|brochure)\b|目录|详细资料/i }
  ];

  function score(input) {
    input = input || {};
    var opp = input.opp || {};
    var eff = input.eff || {};
    var match = input.match || null;      /* {score, keyConflict} 选定或最佳候选的 SmartMatch 摘要 */
    var moq = input.moq || 0;
    var raw = String(opp.rawText || '');
    var closed = opp.status === 'won' || opp.status === 'lost';

    var dims = [];
    function dim(key, label, max, got, reasons) {
      dims.push({ key: key, label: label, max: max, score: Math.max(0, Math.min(max, Math.round(got))), reasons: reasons });
      return got;
    }

    /* ---- 1. 需求明确（20） ---- */
    var cGot = 0, cWhy = [];
    if (eff.productName) { cGot += 6; cWhy.push('商品名称明确：' + eff.productName); } else cWhy.push('商品名称未识别');
    if (eff.models && eff.models.length) { cGot += 6; cWhy.push('型号明确：' + eff.models.join(' / ')); } else cWhy.push('型号未提供');
    if (eff.types && eff.types.length) { cGot += 3; cWhy.push('品类可判定：' + eff.types.join(' / ')); }
    if (eff.specs && eff.specs.length >= 2) { cGot += 5; cWhy.push('规格较全：' + eff.specs.length + ' 项'); }
    else if (eff.specs && eff.specs.length === 1) { cGot += 3; cWhy.push('有 1 项规格'); }
    else cWhy.push('规格未提供');
    dim('clarity', '需求明确', 20, cGot, cWhy);

    /* ---- 2. 采购意向（25）：只认明说信号 ---- */
    var iGot = 3, iWhy = ['已主动发来询盘（+3）'], signals = [];
    SIGNALS.forEach(function (s) {
      if (s.re.test(raw)) { iGot += s.pts; signals.push(s.label); iWhy.push(s.label + '（+' + s.pts + '）'); }
    });
    if (!signals.length) iWhy.push('未见明确采购信号：没提报价、下单、样品等动作');
    var intentScore = Math.min(25, iGot);
    dim('intent', '采购意向', 25, intentScore, iWhy);

    /* ---- 3. 数量（15） ---- */
    var qGot = 0, qWhy = [];
    if (eff.qty > 0) {
      qGot += 7; qWhy.push('已提供数量：' + eff.qty);
      if (moq > 0) {
        if (eff.qty >= moq) { qGot += 8; qWhy.push('达到起订量 MOQ ' + moq); }
        else { qGot += 3; qWhy.push('低于起订量 MOQ ' + moq + '，需谈加量或样品价'); }
      } else { qGot += 4; qWhy.push('无 MOQ 可比对，按已提供数量计'); }
    } else qWhy.push('数量未提供：这是最该先补问的一项');
    dim('qty', '采购数量', 15, qGot, qWhy);

    /* ---- 4. 商品匹配（20）：用 SmartMatch 的规则匹配度 ---- */
    var mGot = 0, mWhy = [];
    if (match) {
      mGot = Math.round(match.score * 0.2);
      mWhy.push('匹配度 ' + match.score + '（规则分，来自智能匹配' + (input.matchLabel ? '：' + input.matchLabel : '') + '）');
      if (match.keyConflict) { mGot = Math.min(mGot, 4); mWhy.push('存在关键冲突，匹配维度封顶'); }
    } else mWhy.push('橱窗里还没有可用的匹配结果');
    dim('match', '商品匹配', 20, mGot, mWhy);

    /* ---- 5. 信息完整（10）：只记「有没有」，不评好坏 ---- */
    var fGot = 0, fWhy = [];
    if (eff.country || eff.destination) { fGot += 3; fWhy.push('目的地已知'); } else fWhy.push('目的国/港口未知');
    if (eff.leadTimeDays || eff.deadlineText) { fGot += 2; fWhy.push('交期已知'); } else fWhy.push('交期未知');
    if (eff.purpose) { fGot += 2; fWhy.push('用途已知：' + eff.purpose); } else fWhy.push('用途未知');
    if (eff.targetPriceUsd > 0) { fGot += 2; fWhy.push('给出了目标价（高低不影响价值判断）'); } else fWhy.push('未给目标价');
    if (eff.incoterm) { fGot += 1; fWhy.push('贸易术语已知'); } else fWhy.push('贸易术语未知');
    dim('completeness', '信息完整', 10, fGot, fWhy);

    /* ---- 6. 沟通进展（10）：只记系统里真实发生的动作 ---- */
    var pGot = 0, pWhy = [];
    if (opp.status === 'quoted') { pGot += 4; pWhy.push('已报价'); }
    else if (opp.status === 'matched') { pGot += 2; pWhy.push('已完成匹配'); }
    else pWhy.push('尚未开始处理');
    if (opp.drafts && (opp.drafts.en || opp.drafts.zh)) { pGot += 2; pWhy.push('已有回复草稿'); }
    if ((opp.followCount || 0) > 0) { pGot += 2; pWhy.push('已跟进 ' + opp.followCount + ' 次'); }
    if (opp.followLog && opp.followLog.length) { pGot += 1; pWhy.push('有跟进记录'); }
    if ((opp.log || []).some(function (l) { return /放行|修正/.test(l.text || ''); })) { pGot += 1; pWhy.push('已有人工核对/修正记录'); }
    dim('progress', '沟通进展', 10, pGot, pWhy);

    var total = dims.reduce(function (s, d) { return s + d.score; }, 0);

    /* ---- 分级：意向门槛防止「信息全但没意向」冲高，
       也防止「信息缺但意向强」被埋没 ---- */
    var level, levelLabel;
    if (closed) { level = 'closed'; levelLabel = opp.status === 'won' ? '已成交' : '已丢单'; }
    else if ((total >= 65 && intentScore >= 12) || (intentScore >= 18 && total >= 50)) { level = 'high'; levelLabel = '高优先级'; }
    else if (total >= 40 || intentScore >= 12) { level = 'mid'; levelLabel = '中优先级'; }
    else { level = 'low'; levelLabel = '低优先级'; }

    /* ---- 为什么建议现在处理 ---- */
    var facts = [];
    signals.slice(0, 2).forEach(function (s) { facts.push('买家' + s); });
    if (eff.qty > 0 && moq > 0 && eff.qty >= moq) facts.push('数量达到起订量');
    if (match && match.score >= 75 && !match.keyConflict) facts.push('已有高度匹配的商品可报');
    var whyNow = '';
    if (closed) whyNow = '该商机已关闭，不需要再投入跟进时间。';
    else if (level === 'high') whyNow = facts.length ? facts.join('；') + '，越早回复越容易抢在同行前面。' : '综合信号较强，建议今天内处理。';
    else if (level === 'mid') whyNow = '已有部分明确信息或信号，先补问关键缺口，答复后再投入正式报价。';
    else whyNow = '意向信号和信息都偏弱，先常规触达即可，把时间留给高、中优先级。';

    /* ---- 推荐下一步 ---- */
    var action = '';
    if (closed) action = '无需跟进（已' + (opp.status === 'won' ? '成交' : '丢单') + '），仅保留复盘';
    else if (level === 'high') action = '今天内人工处理：先给出报价结论，同时补问待确认问题，不要等信息齐了才回';
    else if (level === 'mid') action = '先补问关键问题（见解析卡待确认清单），拿到答复再正式报价';
    else action = '常规跟进：一版简短回复保持联系，有新信号再升级处理';

    /* ---- 哪些信息可能改变评分 ---- */
    var changes = [];
    if (!closed) {
      if (!(eff.qty > 0)) changes.push({ text: '补问采购数量', gain: '数量维度最高 +15' });
      else if (moq > 0 && eff.qty < moq) changes.push({ text: '确认数量能否提到 MOQ ' + moq, gain: '数量 +5，且匹配冲突解除' });
      if (!((eff.models && eff.models.length) || eff.productName)) changes.push({ text: '确认具体商品/型号', gain: '明确维度最高 +12' });
      if (match && match.keyConflict) changes.push({ text: '解决型号/规格关键冲突（换对的商品）', gain: '匹配维度最高 +16' });
      if (!signals.length) changes.push({ text: '买家回复并确认采购意向', gain: '意向维度最高 +22' });
      if (!(eff.country || eff.destination)) changes.push({ text: '确认目的国/港口', gain: '完整维度 +3，运费也可核算' });
      if (!(eff.leadTimeDays || eff.deadlineText)) changes.push({ text: '确认期望交期', gain: '完整维度 +2' });
      if (!match) changes.push({ text: '在商品库补上对应商品', gain: '匹配维度最高 +20' });
    }

    return {
      total: total,
      level: level,
      levelLabel: levelLabel,
      dims: dims,
      intentSignals: signals,
      intentScore: intentScore,
      whyNow: whyNow,
      action: action,
      changeFactors: changes.slice(0, 5),
      closed: closed,
      computedAt: new Date().toISOString()
    };
  }

  OS.score = score;
  OS.SIGNALS = SIGNALS;
  OS.VERSION = '1.0.0';
  root.OppScore = OS;
})();
