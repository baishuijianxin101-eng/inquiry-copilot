/* ===========================================================
   reply-assistant.js — AI 英文回复与谈判策略（阶段四）
   全局暴露：window.ReplyAssistant

   硬规则（任何场景都不能破）：
   1. 只写真实已知信息：商品名/型号/规格/认证/起订量/交期全部来自
      传入的商品对象原字段；没有的字段一律不写、不猜、不补。
      库存、公司资质、样品时效这类没有数据支撑的一律不承诺。
   2. 价格只用调用方传入的安全价（现有报价管线算出、且不低于底价的
      unit/floor）。没有安全价时，回复里绝不出现任何价格数字。
   3. 买家目标价永远不承诺接受；目标价低于底价时明确走「守底价」
      策略并给出卖家警告。
   4. 匹配存在关键冲突时，自动切到「先核实」场景：只请买家确认
      差异点，不把不匹配商品当作确定产品推荐。
   5. 本模块只生成草稿（中英对照），不发送、不调用任何外部服务。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);
  var RA = {};

  RA.SCENARIOS = [
    { key: 'first', label: '首次询盘回复' },
    { key: 'prequote', label: '报价前信息确认' },
    { key: 'spec', label: '商品规格解释' },
    { key: 'moq', label: 'MOQ 及数量沟通' },
    { key: 'negotiation', label: '价格谈判回复' },
    { key: 'sample', label: '样品 / 后续沟通' },
    { key: 'clarify', label: '匹配冲突先核实' }
  ];

  function money(n) { return '$' + Number(n).toFixed(2); }
  function firstName(name) {
    var t = String(name || '').trim();
    if (!t || /^(buyer|unknown|客户)/i.test(t)) return '';
    return t.split(/\s+/)[0];
  }

  /* 缺失项（中英）：只看解析结果里真实为空的字段 */
  function missingOf(eff, product) {
    var m = [];
    if (!(eff.qty > 0)) m.push({ key: 'qty', zh: '采购数量', en: 'the quantity you need' });
    if (!((eff.models && eff.models.length) || eff.productName)) m.push({ key: 'product', zh: '具体商品/型号', en: 'the exact model you are looking for' });
    if (!(eff.country || eff.destination)) m.push({ key: 'dest', zh: '目的国/港口', en: 'the destination port or country' });
    if (!(eff.leadTimeDays || eff.deadlineText)) m.push({ key: 'lead', zh: '期望交期', en: 'your expected delivery time' });
    if (!eff.purpose) m.push({ key: 'purpose', zh: '用途', en: 'what the products will be used for' });
    return m;
  }

  function detectScenario(x) {
    var eff = x.eff || {}, opp = x.opp || {}, raw = String(opp.rawText || '');
    if (x.match && x.match.keyConflict) return 'clarify';
    if (eff.targetPriceUsd > 0) return 'negotiation';
    if (eff.qty > 0 && x.product && x.product.moq && eff.qty < x.product.moq) return 'moq';
    if (/\bsamples?\b|样品/i.test(raw)) return 'sample';
    if ((opp.followCount || 0) > 0 && opp.status === 'quoted') return 'sample';
    if (/\b(specifications?|spec\s*sheet|datasheet|parameters?)\b|规格|参数/i.test(raw)) return 'spec';
    var miss = missingOf(eff, x.product);
    if (miss.some(function (m) { return m.key === 'qty' || m.key === 'product' || m.key === 'dest'; })) return 'prequote';
    return 'first';
  }

  function generate(input) {
    input = input || {};
    var opp = input.opp || {};
    var eff = input.eff || {};
    var product = input.product || null;
    var match = input.match || null;
    var price = (input.price && input.price.unit > 0 && input.price.floor > 0 && input.price.unit >= input.price.floor)
      ? input.price : null;
    var scenario = (!input.scenario || input.scenario === 'auto') ? detectScenario(input) : input.scenario;
    /* 安全兜底：有关键冲突时，任何手动场景都先核实，不许把错商品当对的推 */
    if (match && match.keyConflict && scenario !== 'clarify') scenario = 'clarify';

    var buyer = opp.buyer || {};
    var fn = firstName(buyer.name);
    var greetEn = 'Hi' + (fn ? ' ' + fn : '') + ',';
    var greetZh = '您好' + (fn ? ' ' + fn : '') + '，';
    var signEn = '\n\nBest regards,\n' + (input.sellerName || 'Sales Team');
    var signZh = '\n\n祝商祺，\n' + (input.sellerName || '销售团队');
    var pTitle = product ? product.title : '';
    var pRefEn = product ? pTitle + (product.sku ? ' (' + product.sku + ')' : '') : '';
    var specsTxt = product ? String(product.specsEn || product.specs || '').trim() : '';
    var certs = product && product.certs && product.certs.length ? product.certs.join(', ') : '';
    var miss = missingOf(eff, product);

    var unconfirmed = miss.map(function (m) { return m.zh; });
    var warnings = [];
    if (match && match.keyConflict) {
      warnings.push('匹配存在关键冲突（' + (match.conflicts || []).join('；') + '），回复已按「先核实」生成，不能把当前商品当作确定推荐。');
      (match.conflicts || []).forEach(function (c) { if (unconfirmed.indexOf(c) < 0) unconfirmed.push('冲突待核实：' + c); });
    }
    if (product && !certs && scenario === 'spec') unconfirmed.push('商品认证信息未在商品库中登记');
    if (product && !(product.leadTimeDays > 0)) unconfirmed.push('商品交期未在商品库中登记，需内部确认');
    if (!price && (scenario === 'negotiation' || scenario === 'first')) unconfirmed.push('正式报价尚未形成（缺成本或未过报价护栏），回复未写任何价格');

    var en = [], zh = [], purpose = '', strategy = '', strategyLabel = '';

    /* P1-5-REPLY 买家语言发送稿：句库来自 LangPack 对应语言包的 reply 段，
       与 en/zh 共用同一套分支与事实（价格、商品事实、缺失项全部同源）。
       任一句缺失 → 整稿回退英文并标记 degraded，绝不拼混合语言稿。
       lang=en/缺省时 loc 不参与，en/zh 输出与历史逐字一致。 */
    var wantLang = String(input.lang || 'en').toLowerCase();
    if (wantLang.indexOf('zh') === 0) wantLang = 'zh';
    var RP = null;
    if (root.LangPack && root.LangPack.get) {
      var pk = root.LangPack.get(wantLang);
      if (pk && pk.reply) RP = pk.reply;
    }
    var loc = [], locOk = !!RP;
    function L(key, subs) {
      if (!RP) return '';
      var t = RP[key];
      if (typeof t !== 'string') { locOk = false; return ''; }
      return t.replace(/\{(\w+)\}/g, function (mm, k) { return subs && subs[k] != null ? String(subs[k]) : mm; });
    }
    function LP(key, subs) { if (RP) loc.push(L(key, subs)); }
    var greetLoc = RP ? (fn ? L('greetWith', { name: fn }) : L('greetPlain')) : '';
    var signLoc = RP ? L('sign', { seller: input.sellerName || 'Sales Team' }) : '';

    function askLines(items) {
      items.slice(0, 3).forEach(function (m) {
        en.push('- Could you confirm ' + m.en + '?');
        zh.push('- 请确认：' + m.zh + '？');
        if (RP) loc.push(L('askTpl', { item: L('ask_' + m.key) }));
      });
    }

    if (scenario === 'clarify') {
      purpose = '先核实型号/规格差异，避免拿错商品报价';
      strategyLabel = '先核实，再报价';
      strategy = '承认差异点、逐条请买家确认；在确认前不报规格结论、不推荐当前商品为确定选择。';
      en.push(greetEn, '', 'Thanks for your inquiry' + (eff.productName ? ' about the ' + eff.productName : '') + '.');
      en.push('Before I quote, I want to double-check a few points, because part of your requirement does not line up with the product data I have on hand:');
      (match.conflicts || []).slice(0, 3).forEach(function (c) { en.push('- ' + c); });
      en.push('Could you confirm the exact requirement on these points? Once confirmed, I will come back with the correct product and an accurate quotation.');
      if (RP) {
        loc.push(greetLoc, '', L('clarifyThanks', { about: eff.productName ? L('clarifyAbout', { name: eff.productName }) : '' }));
        loc.push(L('clarifyIntro'));
        (match.conflicts || []).slice(0, 3).forEach(function (c) { loc.push('- ' + c); });
        loc.push(L('clarifyAsk'));
      }
      zh.push(greetZh, '', '感谢您的询盘' + (eff.productName ? '（' + eff.productName + '）' : '') + '。');
      zh.push('报价前我想先核实几点，因为您的部分要求与我手头的商品数据对不上：');
      (match.conflicts || []).slice(0, 3).forEach(function (c) { zh.push('- ' + c); });
      zh.push('请您确认这几点的确切要求，确认后我再按正确的商品给您准确报价。');
    } else if (scenario === 'negotiation') {
      var target = eff.targetPriceUsd;
      purpose = '回应买家目标价，守住底价并推进成交条件';
      en.push(greetEn, '', 'Thanks for sharing your target price of ' + money(target) + ' for the ' + (pTitle || eff.productName || 'product') + '.');
      if (RP) loc.push(greetLoc, '', L('negThanks', { target: money(target), product: pTitle || eff.productName || L('negProduct') }));
      zh.push(greetZh, '', '感谢您给出目标价 ' + money(target) + '（' + (pTitle || eff.productName || '该商品') + '）。');
      if (!price) {
        strategyLabel = '先稳住，不承诺';
        strategy = '暂无安全报价可用：只确认已收到目标价、说明正在核算，绝不口头承诺接受，也不报任何数字。';
        en.push('I am checking the cost based on your quantity now and will confirm our best possible price shortly. Please do not treat this as acceptance of the target yet — I want to give you a firm number I can actually hold.');
        LP('negChecking');
        zh.push('我正在按您的数量核算成本，稍后确认我们能给到的最优价格。请不要把这理解为已接受目标价——我想给您一个我们真正能履行的确定数字。');
        warnings.push('当前没有安全报价（缺成本或未达底价），谈判回复未写价格、未承诺目标价。');
      } else if (target >= price.unit) {
        strategyLabel = '接近可接受，留人工确认';
        strategy = '目标价已达到/高于我方当前报价：回复留「内部确认后正式报价」的口子，最终承诺必须由人工在正式报价环节做出。';
        en.push('Your target is close to a workable level for us. Let me confirm it internally together with the final terms, and I will send you a formal quotation for your approval.');
        LP('negCloseOk');
        zh.push('您的目标价已接近我们可以接受的水平。我先内部连同最终条款确认，随后给您正式报价单确认。');
      } else if (target >= price.floor) {
        strategyLabel = '以条件换让步空间';
        strategy = '目标价在我方底价之上、现价之下：亮明当前最优价并说明价值，用数量或条款换空间，不擅自发明新价格。';
        en.push('Our current best price is ' + money(price.unit) + ' per piece, based on the listed specifications' + (certs ? ' and certifications (' + certs + ')' : '') + '.');
        en.push('To move closer to your target, the realistic levers are a larger quantity or more flexible delivery terms. If you can adjust either one, I will re-check the price for you right away.');
        LP('negBestIs', { unit: money(price.unit), certPart: certs ? L('negCertPart', { certs: certs }) : '' });
        LP('negLevers');
        zh.push('我们当前能给的最优价是每件 ' + money(price.unit) + '，依据是商品已登记的规格' + (certs ? '与认证（' + certs + '）' : '') + '。');
        zh.push('想更接近您的目标价，现实的办法是增加数量或放宽交期。您若能调整其中一项，我马上帮您重新核价。');
      } else if (price.breakEven > 0 && target < price.breakEven) {
        /* 只有目标价确实低于保本价时才允许成本措辞（P1-17 修复 C：原实现按
           「低于底价」触发却写「低于生产成本」，保本与底价之间的区间会陈述失实） */
        strategyLabel = '守底价，给替代方案';
        strategy = '目标价低于保本价：礼貌拒绝目标价、说明成本原因，给出当前最优价或调整规格的方向，绝不承诺按目标价成交。';
        en.push('I checked carefully, and I have to be honest: ' + money(target) + ' is below our production cost for this specification, so I cannot accept it without changing the product itself.');
        en.push(price ? 'The best I can offer for the current specification is ' + money(price.unit) + ' per piece.' : 'I will confirm our best possible price for the current specification shortly.');
        en.push('If the budget is fixed, we can look at adjusting the specification or packaging to get closer — please tell me which matters more to you, the spec or the price.');
        LP('negBelowCost', { target: money(target) });
        if (price) LP('negBestOffer', { unit: money(price.unit) }); else LP('negBestConfirm');
        LP('negBudgetAlt');
        zh.push('我认真核算过，必须坦诚说明：' + money(target) + ' 低于我们按此规格的生产成本，所以不改变商品本身的话我无法接受。');
        zh.push(price ? '当前规格我们能给到的最优价是每件 ' + money(price.unit) + '。' : '当前规格能给到的最优价格我确认后马上告诉您。');
        zh.push('如果预算是固定的，我们可以考虑调整规格或包装来靠近——请告诉我您更看重规格还是价格。');
        warnings.push('买家目标价 ' + money(target) + ' 低于保本价 ' + money(price.breakEven) + '，已按守底价策略生成，未承诺接受。');
      } else {
        /* 目标价低于报价底线但不低于保本价（或保本价未知）：只说底线，不声称成本原因 */
        strategyLabel = '守底价，给替代方案';
        strategy = '目标价低于报价底线' + (price.breakEven > 0 ? '（但不低于保本价）' : '（保本价未知）') + '：只说明低于当前可接受的报价底线，不声称低于成本，给出当前最优价或调整规格的方向，绝不承诺按目标价成交。';
        en.push('I checked carefully, and I have to be honest: ' + money(target) + ' is below the lowest price we can accept for this specification, so I cannot accept it as it stands.');
        en.push(price ? 'The best I can offer for the current specification is ' + money(price.unit) + ' per piece.' : 'I will confirm our best possible price for the current specification shortly.');
        en.push('If the budget is fixed, we can look at adjusting the specification or packaging to get closer — please tell me which matters more to you, the spec or the price.');
        LP('negBelowFloor', { target: money(target) });
        if (price) LP('negBestOffer', { unit: money(price.unit) }); else LP('negBestConfirm');
        LP('negBudgetAlt');
        zh.push('我认真核算过，必须坦诚说明：' + money(target) + ' 低于我们对该规格能接受的报价底线，所以目前无法按这个价格确认。');
        zh.push(price ? '当前规格我们能给到的最优价是每件 ' + money(price.unit) + '。' : '当前规格能给到的最优价格我确认后马上告诉您。');
        zh.push('如果预算是固定的，我们可以考虑调整规格或包装来靠近——请告诉我您更看重规格还是价格。');
        warnings.push('买家目标价 ' + money(target) + ' 低于报价底线 ' + money(price.floor) + (price.breakEven > 0 ? '（高于保本价 ' + money(price.breakEven) + '，文案未使用成本理由）' : '（保本价未知，文案未使用成本理由）') + '，已按守底价策略生成，未承诺接受。');
      }
    } else if (scenario === 'moq') {
      purpose = '解释起订量并给出可行路径，避免直接流失小单买家';
      strategyLabel = 'MOQ 说明 + 台阶方案';
      strategy = '先讲清 MOQ 的事实，再给三条路：补到 MOQ、先拿样验证、或按现有数量重新核价，不承诺小单同价。';
      en.push(greetEn, '', 'Thanks for your inquiry about the ' + pRefEn + '.');
      en.push('You mentioned ' + eff.qty + ' pcs. The minimum order quantity for this model is ' + product.moq + ' pcs, mainly because of production and packing setup.');
      en.push('A few options: (1) increase to ' + product.moq + ' pcs so we can keep the standard price; (2) start with samples to check the quality first; (3) if ' + eff.qty + ' pcs is firm, I will re-check what price we can do for that quantity — it would be a bit higher than the standard price.');
      en.push('Which option works better for you?');
      if (RP) {
        loc.push(greetLoc, '', L('moqThanks', { ref: pRefEn }));
        loc.push(L('moqBody', { qty: eff.qty, moq: product.moq }));
        loc.push(L('moqOptions', { qty: eff.qty, moq: product.moq }));
        loc.push(L('moqAsk'));
      }
      zh.push(greetZh, '', '感谢您咨询 ' + pRefEn + '。');
      zh.push('您提到需要 ' + eff.qty + ' 件。这款商品的起订量是 ' + product.moq + ' 件，主要受生产与包装开版影响。');
      zh.push('几个可选方案：(1) 增加到 ' + product.moq + ' 件，可按标准价；(2) 先拿样验证品质；(3) 若数量确定为 ' + eff.qty + ' 件，我重新核这个数量的价格，会比标准价略高。');
      zh.push('您看哪种方案更合适？');
    } else if (scenario === 'sample') {
      var isFollowUp = !/\bsamples?\b|样品/i.test(String(opp.rawText || '')) && (opp.followCount || 0) > 0;
      if (isFollowUp) {
        purpose = '跟进已报价未回复的买家，推动下一步';
        strategyLabel = '轻跟进，给低门槛下一步';
        strategy = '简短提醒 + 给一个低成本的下一步（先看样品或先确认一处关键参数），不催逼、不重复报价承诺。';
        en.push(greetEn, '', 'Just following up on my previous message about the ' + (pTitle || eff.productName || 'product') + '.');
        en.push('If it helps, we can start with a sample so you can check the quality firsthand before deciding on the quantity.');
        en.push('Or if any specification point is still unclear, tell me which one and I will confirm it for you.');
        if (RP) {
          loc.push(greetLoc, '', L('fuFirst', { product: pTitle || eff.productName || L('negProduct') }));
          loc.push(L('fuSample'));
          loc.push(L('fuSpec'));
        }
        zh.push(greetZh, '', '跟进一下我此前关于 ' + (pTitle || eff.productName || '该商品') + ' 的消息。');
        zh.push('如果有帮助，可以先从样品开始，您亲自验过品质再决定数量。');
        zh.push('或者还有哪处规格不清楚，告诉我哪一点，我帮您确认。');
        unconfirmed.push('样品费用与样品交期未确认');
      } else {
        purpose = '回应索样，确认样品细节后安排';
        strategyLabel = '先确认样品细节';
        strategy = '确认样品型号、数量与收货信息后再安排；样品费用与时效没确认前不承诺免费或具体天数。';
        en.push(greetEn, '', 'Thanks for your inquiry' + (product ? ' about the ' + pRefEn : '') + '. We can arrange a sample for you to check the quality.');
        en.push('To prepare it correctly, could you confirm:');
        en.push('- The exact model' + (eff.models && eff.models.length ? ' (you mentioned ' + eff.models.join(' / ') + ')' : '') + ';');
        en.push('- How many sample pieces you need;');
        en.push('- Your delivery address, so I can confirm the sample cost and lead time for you.');
        if (RP) {
          loc.push(greetLoc, '', L('sampleThanks', { about: product ? L('sampleAbout', { ref: pRefEn }) : '' }));
          loc.push(L('sampleConfirm'));
          loc.push(L('sampleModel', { mentioned: (eff.models && eff.models.length) ? L('sampleMentioned', { models: eff.models.join(' / ') }) : '' }));
          loc.push(L('sampleQty'));
          loc.push(L('sampleAddr'));
        }
        zh.push(greetZh, '', '感谢您的询盘' + (product ? '（' + pRefEn + '）' : '') + '。我们可以为您安排样品验货。');
        zh.push('为准确准备，请您确认：');
        zh.push('- 确切型号' + (eff.models && eff.models.length ? '（您提到 ' + eff.models.join(' / ') + '）' : '') + '；');
        zh.push('- 需要的样品数量；');
        zh.push('- 收货地址，我好为您确认样品费用与时效。');
        unconfirmed.push('样品费用与样品交期未确认');
        unconfirmed.push('买家收货地址未提供');
      }
    } else if (scenario === 'spec') {
      purpose = '用商品库已登记的规格正面回答买家，不外推';
      strategyLabel = '只答已登记规格，未登记的明说待确认';
      strategy = '逐项给出商品库登记的规格与认证；买家问到但商品库没登记的，不猜测，列入待确认。';
      en.push(greetEn, '', 'Thanks for asking about the specifications of the ' + (pRefEn || eff.productName || 'product') + '.');
      if (RP) loc.push(greetLoc, '', L('specThanks', { ref: pRefEn || eff.productName || L('negProduct') }));
      if (specsTxt) {
        en.push('As listed for this model: ' + specsTxt + '.');
        LP('specListed', { specs: specsTxt });
        zh.push(greetZh, '', '感谢您询问 ' + (pRefEn || eff.productName || '该商品') + ' 的规格。');
        zh.push('该型号已登记的规格为：' + specsTxt + '。');
      } else {
        en.push('I am confirming the full specification sheet for this model internally and will share only the verified details.');
        LP('specChecking');
        zh.push(greetZh, '', '感谢您询问 ' + (pRefEn || eff.productName || '该商品') + ' 的规格。');
        zh.push('我正在内部确认这款的完整规格表，只给您核实过的细节。');
        unconfirmed.push('商品规格未在商品库中登记');
      }
      if (certs) { en.push('Certifications on file for this model: ' + certs + '.'); zh.push('该型号已登记的认证：' + certs + '。'); LP('specCerts', { certs: certs }); }
      if (product && product.moq) { en.push('Minimum order quantity: ' + product.moq + ' pcs.'); zh.push('起订量：' + product.moq + ' 件。'); LP('specMoq', { moq: product.moq }); }
      if (product && product.leadTimeDays > 0) { en.push('Standard lead time: about ' + product.leadTimeDays + ' days.'); zh.push('标准交期：约 ' + product.leadTimeDays + ' 天。'); LP('specLead', { days: product.leadTimeDays }); }
      en.push('If you need any specific parameter confirmed (for example a test report or a dimension drawing), tell me which one and I will check it for you.');
      LP('specAsk');
      zh.push('如果您需要确认某个具体参数（比如检测报告或尺寸图），告诉我哪一项，我帮您核实。');
    } else if (scenario === 'prequote') {
      purpose = '报价前先把关键信息问清，避免报错价';
      strategyLabel = '先确认，后报价';
      strategy = '明确列出待确认问题并说明原因（数量、目的地决定价格与运费），给买家低压力的回复路径。';
      en.push(greetEn, '', 'Thanks for your inquiry' + (eff.productName ? ' about the ' + eff.productName : '') + (product ? ' — the closest model in our range is the ' + pRefEn + '.' : '.'));
      en.push('So I can quote accurately instead of guessing, could you confirm a few points?');
      if (RP) {
        loc.push(greetLoc, '', L('preThanks', { about: eff.productName ? L('preAbout', { name: eff.productName }) : '', closest: product ? L('preClosest', { ref: pRefEn }) : '' }));
        loc.push(L('preIntro'));
      }
      zh.push(greetZh, '', '感谢您的询盘' + (eff.productName ? '（' + eff.productName + '）' : '') + (product ? '，我们产品线里最接近的是 ' + pRefEn + '。' : '。'));
      zh.push('为了给您准确报价而不是估个大概，请您确认几点：');
      /* askLines 一次调用同时写 en 与 zh 两个数组，本分支只能调用一次：
         曾分英文段/中文段各调用一次，导致双语草稿的问题清单各重复一遍，
         且中文第一份问题被写到了问候语之前（P1-20 / I-1）。 */
      askLines(miss);
      en.push('Once I have these, I will send you a firm quotation rather than a rough estimate.');
      LP('preDone');
      zh.push('信息齐了之后，我给您一份确定的报价，而不是粗略估算。');
    } else { /* first */
      purpose = '首次响应：确认需求、给出已能确认的信息、留好下一步';
      strategyLabel = price ? '快速响应 + 直接给价' : '快速响应 + 确认后报价';
      strategy = price
        ? '信息较全且已有安全报价：直接给价（不低于底价），同时列出仍待确认的事项。'
        : '先响应并确认已知信息，缺失项一次问清，承诺确认后给正式报价——不空报价格。';
      en.push(greetEn, '', 'Thanks for your inquiry' + (product ? ' about the ' + pRefEn : eff.productName ? ' about the ' + eff.productName : '') + '.');
      if (RP) loc.push(greetLoc, '', L('firstThanks', { about: product ? L('firstAbout', { ref: pRefEn }) : (eff.productName ? L('firstAbout', { ref: eff.productName }) : '') }));
      zh.push(greetZh, '', '感谢您的询盘' + (product ? '（' + pRefEn + '）' : eff.productName ? '（' + eff.productName + '）' : '') + '。');
      var known = [];
      if (specsTxt) known.push('Specifications as listed: ' + specsTxt + '.');
      if (certs) known.push('Certifications on file: ' + certs + '.');
      if (product && product.moq) known.push('Minimum order quantity: ' + product.moq + ' pcs.');
      if (product && product.leadTimeDays > 0) known.push('Standard lead time: about ' + product.leadTimeDays + ' days.');
      en = en.concat(known);
      if (RP) {
        var knownLoc = [];
        if (specsTxt) knownLoc.push(L('knownSpec', { specs: specsTxt }));
        if (certs) knownLoc.push(L('knownCerts', { certs: certs }));
        if (product && product.moq) knownLoc.push(L('knownMoq', { moq: product.moq }));
        if (product && product.leadTimeDays > 0) knownLoc.push(L('knownLead', { days: product.leadTimeDays }));
        loc = loc.concat(knownLoc);
      }
      if (specsTxt) zh.push('已登记规格：' + specsTxt + '。');
      if (certs) zh.push('已登记认证：' + certs + '。');
      if (product && product.moq) zh.push('起订量：' + product.moq + ' 件。');
      if (product && product.leadTimeDays > 0) zh.push('标准交期：约 ' + product.leadTimeDays + ' 天。');
      if (price) {
        en.push('For ' + (eff.qty > 0 ? eff.qty : 'the quoted') + ' pcs, our price is ' + money(price.unit) + ' per piece' + (eff.incoterm ? ' (' + eff.incoterm + ')' : '') + '.');
        zh.push((eff.qty > 0 ? eff.qty : '所询') + ' 件的价格为每件 ' + money(price.unit) + (eff.incoterm ? '（' + eff.incoterm + '）' : '') + '。');
        LP('firstPrice', { qty: eff.qty > 0 ? eff.qty : L('qtyQuoted'), unit: money(price.unit), incoterm: eff.incoterm ? L('firstIncoterm', { incoterm: eff.incoterm }) : '' });
      }
      if (miss.length) {
        en.push('To finalize the details, could you confirm:');
        zh.push('为确认最终细节，请您确认：');
        LP('firstFinalize');
        askLines(miss);
      } else if (!price) {
        en.push('I will send you a firm quotation as soon as the final cost check is done on our side.');
        zh.push('我方完成最终成本核算后，马上给您正式报价。');
        LP('firstWillQuote');
      }
      en.push('Looking forward to your reply.');
      zh.push('期待您的回复。');
      LP('firstClosing');
    }

    var enText = en.join('\n') + signEn;
    var zhText = zh.join('\n') + signZh;
    var sendText, sendLang, degraded = false;
    if (wantLang === 'zh') { sendText = zhText; sendLang = 'zh'; }
    else if (RP && locOk) { sendText = loc.join('\n') + signLoc; sendLang = wantLang; }
    else { sendText = enText; sendLang = 'en'; degraded = wantLang !== 'en'; }

    return {
      scenario: scenario,
      scenarioLabel: (RA.SCENARIOS.filter(function (s) { return s.key === scenario; })[0] || {}).label || scenario,
      en: enText,
      zh: zhText,
      send: sendText,
      sendLang: sendLang,
      wantLang: wantLang,
      degraded: degraded,
      purpose: purpose,
      strategy: strategy,
      strategyLabel: strategyLabel,
      unconfirmed: unconfirmed,
      warnings: warnings,
      usedPrice: !!price
    };
  }

  RA.generate = generate;
  RA.detectScenario = detectScenario;
  RA.missingOf = missingOf;
  RA.VERSION = '1.0.0';
  root.ReplyAssistant = RA;
})();
