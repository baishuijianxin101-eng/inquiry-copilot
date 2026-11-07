/* ===========================================================
   smart-match.js — 智能商品匹配（阶段二）
   全局暴露：window.SmartMatch

   设计原则：
   1. 输入是「有效解析结果」（人工修正优先的 eff，来自 app.effectiveParsed）
      + 原始询盘文本（辅助）+ 现有商品库商品，不创造任何商品与属性。
   2. 规则评分，分维度给分：型号 40 / 名称关键词 25 / 品类 15 /
      规格 12 / 认证 8；某维度信息不足以判断时不计入分母，
      并明确列入「未确认」，不猜、不编。
   3. 关键冲突封顶：型号对不上（且商品型号可判定）总分 ≤49；
      品类不符、关键规格不符总分 ≤59；数量低于 MOQ 总分 ≤49。
      关键词再像，也盖不过关键冲突。
   4. 分数只代表「规则匹配程度」，不是成交概率，UI 必须按此口径展示。
   5. 纯函数、无 DOM、无网络；不读成本、不读设置、不写存储。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);
  var SM = {};

  function M() { return root.Matching; }
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function uniq(a) { var s = {}, o = []; (a || []).forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }

  function productText(p) {
    return [p.title || '', p.titleEn || '', p.category || '',
      (p.keywords || []).join(' '), p.specs || '', p.specsEn || '', p.sku || ''].join(' ');
  }

  /* 从文本里抽某类带单位数值，返回归一化字符串数组，如 ['220'] */
  function numSet(text, re) {
    var out = [], m;
    var r = new RegExp(re.source, 'gi');
    while ((m = r.exec(text)) !== null) {
      var n = parseFloat(m[1]);
      if (isFinite(n)) out.push(String(n));
    }
    return uniq(out);
  }

  var VOLT_RE = /(\d{2,3}(?:\.\d+)?)\s*V\b/;
  var WATT_RE = /(\d+(?:\.\d+)?)\s*W\b/;
  /* 容量分两个家族：液体 ml/L 可换算；电池 mAh/Ah 可换算 */
  function capSetMl(text) {
    var out = [], m;
    var re = /(\d+(?:\.\d+)?)\s*(ml|L)\b/gi;
    while ((m = re.exec(text)) !== null) {
      var n = parseFloat(m[1]);
      if (isFinite(n)) out.push(String(m[2].toLowerCase() === 'l' ? n * 1000 : n));
    }
    return uniq(out);
  }
  function capSetMah(text) {
    var out = [], m;
    var re = /(\d+(?:\.\d+)?)\s*(mAh|Ah)\b/gi;
    while ((m = re.exec(text)) !== null) {
      var n = parseFloat(m[1]);
      if (isFinite(n)) out.push(String(m[2].toLowerCase() === 'ah' ? n * 1000 : n));
    }
    return uniq(out);
  }

  /* 询盘规格值 → {num, unit}；抽不到数值返回 null（走文本核对） */
  function specNum(value) {
    var m = /(\d+(?:\.\d+)?)\s*(V|W|mAh|Ah|ml|L)?/i.exec(str(value));
    if (!m) return null;
    return { num: parseFloat(m[1]), unit: (m[2] || '').toLowerCase() };
  }

  var PURPOSE_WORDS = {
    '零售转售': ['retail', 'resale', 'store', 'shop', 'supermarket'],
    '电商销售': ['amazon', 'fba', 'online', 'e-commerce', 'ecommerce'],
    '促销礼品': ['gift', 'promotion', 'giveaway'],
    '定制品牌': ['oem', 'private label', 'logo', 'custom'],
    '工程项目': ['project', 'construction']
  };

  /* ---------------- 单个商品评估 ----------------
     eff: effectiveParsed 的输出（可带 edited 来源标记）
     rawText: 原始询盘文本（名称维度兜底用） */
  function assess(eff, rawText, product) {
    eff = eff || {};
    var edited = eff.edited || {};
    var pText = productText(product);
    var pTextU = pText.toUpperCase();
    var pLow = pText.toLowerCase();

    var dims = {};
    var hits = [], conflicts = [], unconfirmed = [], questions = [];
    var earned = 0, applicable = 0, cap = 100, keyConflict = false;

    function tag(key) { return edited[key] ? '（人工修正）' : ''; }

    /* ---- 型号（40） ---- */
    var inqModels = (eff.models || []).map(function (x) { return String(x).toUpperCase(); });
    if (inqModels.length) {
      var pModels = [];
      try { pModels = M().modelsOf(pText).map(function (x) { return String(x).toUpperCase(); }); } catch (e) { pModels = []; }
      var hitModels = inqModels.filter(function (mm) {
        return pTextU.indexOf(mm) >= 0 || pModels.indexOf(mm) >= 0;
      });
      if (hitModels.length) {
        dims.model = { label: '型号', status: 'hit', score: 40, max: 40 };
        earned += 40; applicable += 40;
        hits.push('型号命中 ' + hitModels.join(' / ') + tag('modelsText'));
      } else if (pModels.length) {
        dims.model = { label: '型号', status: 'conflict', score: 0, max: 40 };
        applicable += 40; keyConflict = true; cap = Math.min(cap, 49);
        conflicts.push('型号不符：客户要 ' + inqModels.join(' / ') + '，该商品型号为 ' + pModels.slice(0, 3).join(' / ') + tag('modelsText'));
        questions.push('向买家确认：是否接受型号 ' + pModels[0] + '，还是必须按 ' + inqModels[0] + ' 另找货源');
      } else {
        dims.model = { label: '型号', status: 'unknown' };
        unconfirmed.push('该商品标题/规格里没写明型号，无法自动核对（客户要 ' + inqModels.join(' / ') + '）');
        questions.push('报价前先向供应商核对该商品实物型号是否为 ' + inqModels[0]);
      }
    } else {
      dims.model = { label: '型号', status: 'na' };
    }

    /* ---- 名称 / 关键词（25） ---- */
    var nameText = eff.productName || eff.productText || '';
    var inqTokens = [];
    try { inqTokens = Object.keys(M().tokenize(nameText)); } catch (e) { inqTokens = []; }
    if (!inqTokens.length && rawText) {
      try { inqTokens = Object.keys(M().tokenize(rawText)); } catch (e) { inqTokens = []; }
    }
    if (inqTokens.length) {
      var pTokens = {};
      try { pTokens = M().tokenize([product.title || '', product.titleEn || '', (product.keywords || []).join(' '), product.category || ''].join(' ')); } catch (e) { pTokens = {}; }
      var matched = inqTokens.filter(function (t) { return pTokens[t]; });
      var ratio = matched.length / inqTokens.length;
      var nameScore = Math.round(25 * ratio);
      dims.name = { label: '名称', status: ratio >= 0.5 ? 'hit' : ratio > 0 ? 'part' : 'miss', score: nameScore, max: 25 };
      earned += nameScore; applicable += 25;
      if (matched.length) hits.push('名称/关键词命中：' + matched.slice(0, 6).join('、') + tag('productName'));
      if (ratio < 0.25 && eff.productName) unconfirmed.push('商品名与客户说的「' + eff.productName + '」重合度低，需人工核对是不是同一类货');
    } else {
      dims.name = { label: '名称', status: 'na' };
    }

    /* ---- 品类（15） ---- */
    var inqTypes = eff.types || [];
    if (inqTypes.length) {
      var pTypes = [];
      try { pTypes = M().typesOf(pText); } catch (e) { pTypes = []; }
      var typeHit = inqTypes.filter(function (t) { return pTypes.indexOf(t) >= 0; });
      if (typeHit.length) {
        dims.type = { label: '品类', status: 'hit', score: 15, max: 15 };
        earned += 15; applicable += 15;
        hits.push('品类一致：' + typeHit.join(' / '));
      } else if (pTypes.length) {
        dims.type = { label: '品类', status: 'conflict', score: 0, max: 15 };
        applicable += 15; keyConflict = true; cap = Math.min(cap, 59);
        conflicts.push('品类不符：客户问的是 ' + inqTypes.join(' / ') + '，该商品属于 ' + pTypes.join(' / '));
      } else {
        dims.type = { label: '品类', status: 'unknown' };
        unconfirmed.push('该商品品类无法自动判定，需人工核对');
      }
    } else {
      dims.type = { label: '品类', status: 'na' };
    }

    /* ---- 规格（12）：逐项核对，可判定的才计分 ---- */
    var specList = (eff.specs || []).slice();
    var specHit = 0, specBad = 0, specTotal = 0;
    specList.forEach(function (sp) {
      var sn = specNum(sp.value);
      var pSet = null, want = null;
      if (sn && sp.name === '电压') { pSet = numSet(pText, VOLT_RE); want = String(sn.num); }
      else if (sn && sp.name === '功率') { pSet = numSet(pText, WATT_RE); want = String(sn.num); }
      else if (sn && sp.name === '容量') {
        if (sn.unit === 'mah' || sn.unit === 'ah') { pSet = capSetMah(pText); want = String(sn.unit === 'ah' ? sn.num * 1000 : sn.num); }
        else { pSet = capSetMl(pText); want = String(sn.unit === 'l' ? sn.num * 1000 : sn.num); }
      }
      if (pSet) {
        specTotal++;
        if (pSet.indexOf(want) >= 0) {
          specHit++;
          hits.push(sp.name + '一致：' + sp.value + tag('specsText'));
        } else if (pSet.length) {
          specBad++;
          keyConflict = true; cap = Math.min(cap, 59);
          conflicts.push(sp.name + '不符：客户要 ' + sp.value + '，该商品为 ' + pSet.join(' / ') + '（同单位口径）');
          questions.push('向买家确认：' + sp.name + '能否接受 ' + pSet[0] + '（其要求 ' + sp.value + '），或需要另找货源');
        } else {
          unconfirmed.push('该商品未标注' + sp.name + '，无法确认是否为 ' + sp.value);
          questions.push('报价前向供应商确认该商品' + sp.name + '是否为 ' + sp.value);
        }
      } else {
        /* 尺寸/材质/颜色等文本规格：商品文本里找得到关键片段就算对上，找不到只列未确认 */
        var frag = str(sp.value).split(/[\/／]/)[0].trim().toLowerCase();
        if (frag && pLow.indexOf(frag) >= 0) {
          specTotal++; specHit++;
          hits.push(sp.name + '一致：' + sp.value);
        } else {
          unconfirmed.push('规格「' + sp.name + '：' + sp.value + '」在该商品信息里无法确认');
        }
      }
    });
    if (eff.specsText) unconfirmed.push('人工补充的规格需人工核对：' + eff.specsText);
    if (specTotal) {
      var specScore = Math.round(12 * (specHit / specTotal));
      dims.specs = { label: '规格', status: specBad ? 'conflict' : 'hit', score: specScore, max: 12 };
      earned += specScore; applicable += 12;
    } else {
      dims.specs = { label: '规格', status: (eff.specs || []).length ? 'unknown' : 'na' };
    }

    /* ---- 认证（8） ---- */
    var inqCerts = (eff.certs || []).map(function (c) { return String(c).toUpperCase(); });
    if (inqCerts.length) {
      var pCerts = (product.certs || []).map(function (c) { return String(c).toUpperCase(); });
      var gotCerts = inqCerts.filter(function (c) { return pCerts.indexOf(c) >= 0 || pTextU.indexOf(c) >= 0; });
      var missCerts = inqCerts.filter(function (c) { return gotCerts.indexOf(c) < 0; });
      if (pCerts.length || gotCerts.length) {
        var certScore = Math.round(8 * (gotCerts.length / inqCerts.length));
        dims.certs = { label: '认证', status: missCerts.length ? 'part' : 'hit', score: certScore, max: 8 };
        earned += certScore; applicable += 8;
        if (gotCerts.length) hits.push('认证具备：' + gotCerts.join(' / '));
        if (missCerts.length) {
          conflicts.push('认证缺失：客户要 ' + missCerts.join(' / ') + '，该商品未标明这些认证');
          questions.push('向买家确认：' + missCerts.join(' / ') + ' 是否为强制要求；同时向供应商确认能否提供');
        }
      } else {
        dims.certs = { label: '认证', status: 'unknown' };
        unconfirmed.push('该商品没有认证信息，客户要的 ' + inqCerts.join(' / ') + ' 无法确认');
        questions.push('报价前向供应商确认该商品是否有 ' + inqCerts.join(' / ') + ' 认证');
      }
    } else {
      dims.certs = { label: '认证', status: 'na' };
    }

    /* ---- 数量 / MOQ 闸门 ---- */
    if (eff.qty > 0 && product.moq > 0) {
      if (eff.qty < product.moq) {
        keyConflict = true; cap = Math.min(cap, 49);
        conflicts.push('数量 ' + eff.qty + ' 低于该商品起订量 MOQ ' + product.moq + tag('qty'));
        questions.push('向买家确认：能否把数量提到 ' + product.moq + ' 以上，或接受小批量加价');
      } else {
        hits.push('数量达到起订量（MOQ ' + product.moq + '）' + tag('qty'));
      }
    }

    /* ---- 用途：只做弱信号核对，不计分 ---- */
    if (eff.purpose) {
      var words = PURPOSE_WORDS[eff.purpose] || [];
      var wHit = words.filter(function (w) { return pLow.indexOf(w) >= 0; });
      if (wHit.length) hits.push('商品描述与用途（' + eff.purpose + '）相符：' + wHit.join('、'));
      else unconfirmed.push('用途（' + eff.purpose + '）在该商品信息里无法确认，需人工判断适配性');
    }

    /* ---- 语言覆盖护栏（P1-4-LANG P4） ----
       原文主要文字尚无分词通道/词汇包（西里尔、阿拉伯、希伯来、
       天城文、泰文、假名、谚文等），且关键需求字段几乎全未解析时，
       型号/认证缩写等少数拉丁 token 不得单独支撑高分：封顶 49 并标
       lowConfidence。这是「信息不足」而非「商品冲突」，不设 keyConflict。
       英/中/西/法文字不触发本护栏，既有结果不变。 */
    var lowConfidence = false;
    var UNSUPPORTED_SCRIPT = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\uAC00-\uD7AF]/;
    if (rawText && UNSUPPORTED_SCRIPT.test(rawText)) {
      var coverage = 0;
      if (eff.qty > 0) coverage++;
      if (eff.productName) coverage++;
      if ((eff.specs || []).length) coverage++;
      if (eff.destination || eff.country) coverage++;
      var typeHit = false;
      try { typeHit = (M().typesOf(rawText) || []).length > 0; } catch (e) { typeHit = false; }
      if (typeHit) coverage++;
      if (coverage <= 1) {
        lowConfidence = true;
        cap = Math.min(cap, 49);
        unconfirmed.push('询盘主要文字暂不支持自动解析（或关键信息过少），当前分数仅由型号/认证等少量可识别信息得出，置信度低，需人工确认需求');
        questions.push('先人工确认买家需求（可借助翻译面板阅读原文），再决定报价商品');
      }
    }

    var score = applicable ? Math.round((earned / applicable) * 100) : 0;
    if (score > cap) score = cap;
    var level = keyConflict ? (score >= 50 ? '中' : '低') : (score >= 75 ? '高' : score >= 50 ? '中' : '低');

    return {
      score: score,
      level: level,
      keyConflict: keyConflict,
      lowConfidence: lowConfidence,
      capped: cap < 100,
      dims: dims,
      hits: hits,
      conflicts: conflicts,
      unconfirmed: unconfirmed,
      questions: uniq(questions),
      earned: earned,
      applicable: applicable
    };
  }

  /* ---------------- 候选排序 ----------------
     items: [{product}]（通常来自现有 Matching 的候选池，SmartMatch 只重排与重评，
     不扩大候选来源）；同分时关键冲突靠后。 */
  function rank(eff, rawText, items) {
    var out = (items || []).map(function (it) {
      return { product: it.product, result: assess(eff, rawText, it.product), base: it };
    });
    out.sort(function (a, b) {
      if (a.result.keyConflict !== b.result.keyConflict) return a.result.keyConflict ? 1 : -1;
      return b.result.score - a.result.score;
    });
    return out;
  }

  SM.assess = assess;
  SM.rank = rank;
  SM.productText = productText;
  SM.VERSION = '1.0.0';
  root.SmartMatch = SM;
})();
