/* ===========================================================
   p0-match.js — 238 条商品候选匹配 + 规格差异解释（P0-B）
   全局暴露：window.P0Match

   复用 Matching.scoreProduct（已验证的本地分词打分），
   在它外面加三件它没做的事：
     1. 把"为什么匹配"翻译成人能看懂的话（型号命中 / 关键词 / 属性一致）；
     2. 抽出商品属性，与询盘要求逐项比对，只比双方都有值的项；
     3. 给出置信分档 direct / review / weak / reject，
        不达标就明说"需人工确认"，不假装匹配成功。

   输出里不含成本与底价：报价所需的成本由 p0-quote 自己从商品对象取，
   匹配结果可以安全地渲染到任何页面。
   =========================================================== */
(function () {
  'use strict';

  var root = (typeof window !== 'undefined' ? window : globalThis);
  var P = root.P0Match || {};
  var M = root.Matching;

  /* 中文标签，UI 直接显示 */
  var FAMILIES = [
    { key: 'freq', label: '频率' },
    { key: 'power', label: '功率' },
    { key: 'lens', label: '镜头' },
    { key: 'capacity', label: '容量' },
    { key: 'size', label: '尺寸' },
    { key: 'channel', label: '通道' },
    { key: 'volt', label: '电压' },
    { key: 'material', label: '材质' },
    { key: 'color', label: '颜色' }
  ];

  var COLORS = ['black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'yellow', 'orange',
    'pink', 'purple', 'brown', 'transparent', 'clear', 'silver', 'gold',
    '黑色', '白色', '红色', '蓝色', '绿色', '灰色', '透明'];
  var MATERIALS = ['abs', 'pp', 'pe', 'pc', 'pvc', 'pet', 'silicone', '硅胶', 'stainless steel',
    '不锈钢', 'aluminum', '铝', 'wood', '木', 'bamboo', '竹', 'glass', '玻璃',
    'cotton', '棉', 'leather', '皮革', 'nylon', '尼龙', 'polyester', '涤纶',
    'carbon fiber', '碳纤维', 'metal', '金属', 'plastic', '塑料'];

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  function textOf(p) {
    return [
      str(p.title), str(p.titleEn), str(p.sku),
      arr(p.keywords).join(' '), str(p.keywords),
      str(p.specs), str(p.specsEn), str(p.category)
    ].join(' ').replace(/\s+/g, ' ').trim();
  }

  function uniqNum(list) {
    var seen = {}, out = [];
    list.forEach(function (n) {
      if (!isFinite(n) || n <= 0) return;
      var k = String(n);
      if (!seen[k]) { seen[k] = 1; out.push(n); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function findWords(text, dict) {
    var low = text.toLowerCase(), out = [];
    dict.forEach(function (w) {
      var re = new RegExp('(?:^|[^a-z\\u4e00-\\u9fa5])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^a-z\\u4e00-\\u9fa5])', 'i');
      if (re.test(low)) out.push(w);
    });
    return out;
  }

  /* 从任意文本抽属性；找不到就是空，绝不用默认值编一个 */
  function attrsOf(p) {
    var t = textOf(p);
    var low = t.toLowerCase();
    var a = {};

    var freq = [];
    var m;
    var reFreq = /(\d{3,4}(?:\.\d+)?)\s*(?:mhz|兆赫)/gi;
    while ((m = reFreq.exec(low)) !== null) freq.push(parseFloat(m[1]));
    var reSlash = /(\d{3,4})\s*\/\s*(\d{3,4})\s*mhz/gi;
    while ((m = reSlash.exec(low)) !== null) { freq.push(parseFloat(m[1])); freq.push(parseFloat(m[2])); }
    var reGHz = /(\d+(?:\.\d+)?)\s*ghz/gi;
    while ((m = reGHz.exec(low)) !== null) freq.push(parseFloat(m[1]) * 1000);
    if (freq.length) a.freq = uniqNum(freq);

    var power = [];
    var reMw = /(\d+(?:\.\d+)?)\s*mw\b/gi;
    while ((m = reMw.exec(low)) !== null) power.push(parseFloat(m[1]));
    var reW = /(\d+(?:\.\d+)?)\s*w\b/gi;
    while ((m = reW.exec(low)) !== null) power.push(parseFloat(m[1]) * 1000);
    if (power.length) a.power = uniqNum(power);

    var lens = [];
    var reLens = /(\d+(?:\.\d+)?)\s*mm\s*(?:lens|镜头|focal)/gi;
    while ((m = reLens.exec(low)) !== null) lens.push(parseFloat(m[1]));
    if (lens.length) a.lens = lens;

    var cap = [];
    var reCap = /(\d+(?:\.\d+)?)\s*(mah|ml|l|liter|litre|kg|oz)\b/gi;
    while ((m = reCap.exec(low)) !== null) cap.push(m[1] + m[2].toLowerCase());
    if (cap.length) a.capacity = cap;

    var size = [];
    var reSize = /(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)(?:\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?))?\s*(mm|cm|inch|in)\b/gi;
    while ((m = reSize.exec(low)) !== null) {
      size.push(m[1] + 'x' + m[2] + (m[3] ? 'x' + m[3] : '') + ' ' + m[4].toLowerCase());
    }
    var reDia = /(\d+(?:\.\d+)?)\s*(mm|cm|inch)\s*(?:dia|diameter|直径)/gi;
    while ((m = reDia.exec(low)) !== null) size.push('Φ' + m[1] + ' ' + m[2].toLowerCase());
    if (size.length) a.size = size;

    var ch = [];
    var reCh = /(\d+)\s*(?:ch|chs|channel|通道)\b/gi;
    while ((m = reCh.exec(low)) !== null) ch.push(parseInt(m[1], 10));
    if (ch.length) a.channel = uniqNum(ch);

    var volt = [];
    var reV = /(\d+(?:\.\d+)?)\s*v\b/gi;
    while ((m = reV.exec(low)) !== null) volt.push(parseFloat(m[1]));
    if (volt.length) a.volt = uniqNum(volt);

    var mat = findWords(t, MATERIALS);
    if (mat.length) a.material = mat;
    var col = findWords(t, COLORS);
    if (col.length) a.color = col;

    return a;
  }

  function fmt(key, v) {
    if (key === 'freq') return v + 'MHz';
    if (key === 'power') return v >= 1000 ? (v / 1000) + 'W' : v + 'mW';
    if (key === 'lens') return v + 'mm';
    if (key === 'channel') return v + 'CH';
    if (key === 'volt') return v + 'V';
    return String(v);
  }

  function fmtList(key, list) {
    return arr(list).map(function (v) { return fmt(key, v); }).join(' / ');
  }

  /* 逐项比对：只比双方都有值的属性；返回 same / conflict */
  function diffAttrs(need, have) {
    var out = { same: [], conflict: [] };
    FAMILIES.forEach(function (f) {
      var nv = need[f.key], hv = have[f.key];
      if (!nv || !nv.length || !hv || !hv.length) return;
      var hit = nv.filter(function (x) {
        return hv.some(function (y) { return String(x).toLowerCase() === String(y).toLowerCase(); });
      });
      if (hit.length) {
        out.same.push(f.label + ' 一致：' + fmtList(f.key, hit));
      } else {
        out.conflict.push(f.label + ' 不一致：客户要 ' + fmtList(f.key, nv) + '，商品是 ' + fmtList(f.key, hv));
      }
    });
    return out;
  }

  function shortTitle(p, n) {
    var t = str(p.titleEn) || str(p.title);
    return t.length > (n || 90) ? t.slice(0, (n || 90)) + '…' : t;
  }

  function gradeOf(score, hardFail, modelHit, conflicts) {
    if (hardFail) return 'reject';
    if (modelHit && score >= 65 && conflicts === 0) return 'direct';
    if (score >= 45) return 'review';
    if (score >= 20) return 'weak';
    return 'reject';
  }

  var GRADE_TEXT = {
    direct: '可直接报（型号与关键属性都对得上，仍需销售点确认）',
    review: '建议核对后报（有命中项，但存在不确定）',
    weak: '匹配弱（只沾到品类或个别词）',
    reject: '不匹配（硬性条件冲突）'
  };

  /* ---------- 主入口 ---------- */

  function search(input, products, opts) {
    opts = opts || {};
    var limit = opts.limit || 5;
    var minScore = opts.minScore || 15;
    var list = arr(products);
    var rawText = str(input && input.raw ? input.raw : (input && input.rawText ? input.rawText : (typeof input === 'string' ? input : '')));
    var fields = (input && input.fields) || {};

    if (!M || typeof M.scoreProduct !== 'function') {
      return { ok: false, error: 'matcher_missing', matches: [], counts: {}, query: { text: rawText } };
    }

    var tokens = M.tokenize(rawText);
    var parsed = M.parse(rawText);
    /* 用 P0Parse 的结果补强：它认得更全（型号/术语/数量/交期） */
    var qModels = [];
    if (fields.models && fields.models.length) {
      /* P0Parse 给的是 {token, evidence}，Matching 只认字符串；
         Matching 内部 squash 成小写再比，所以这里必须先降成小写。 */
      qModels = fields.models.map(function (x) { return typeof x === 'string' ? x : x.token; }).filter(Boolean);
      parsed.models = qModels.map(function (x) { return String(x).toLowerCase(); });
    }
    if (fields.qty) parsed.qty = fields.qty;
    if (fields.targetPriceUsd) parsed.targetPriceUsd = fields.targetPriceUsd;
    if (fields.deadlineDays) parsed.leadTimeDays = fields.deadlineDays;

    var need = attrsOf({ title: rawText, keywords: arr(fields.specs).map(function (s) { return s.value; }) });
    if (arr(fields.materials).length) need.material = fields.materials;
    if (arr(fields.colors).length) need.color = fields.colors;

    var rows = [];
    list.forEach(function (p) {
      var s = M.scoreProduct(p, tokens, parsed);
      var have = attrsOf(p);
      var d = diffAttrs(need, have);
      var adj = s.score + Math.min(9, d.same.length * 3) - Math.min(25, d.conflict.length * 10);
      adj = Math.max(0, Math.min(100, Math.round(adj)));

      var why = [];
      if (s.modelHit) why.push('型号命中：' + s.model + '（型号是最强信号，基本可锁定同款）');
      if (s.reasons && s.reasons.length) {
        why.push('关键词命中 ' + s.reasons.length + ' 个：' + s.reasons.join('、'));
      }
      if (d.same.length) why.push('属性对得上：' + d.same.join('；'));
      if (s.typeHit) why.push('品类对得上');

      var gaps = arr(s.gaps).slice();
      d.conflict.forEach(function (c) { gaps.push(c); });

      /* 硬性不通过只认一件事：客户数量低于该商品起订量。
         Matching.scoreProduct 里的 hardFail 还包含"型号/品类对不上"，
         那是排序用的强信号，不是商品本身不合格 —— 这里不沿用，
         否则 238 条里除同款外全被标成"不匹配"，等于没给候选。 */
      var hardFail = !!(parsed.qty && p.moq && parsed.qty < p.moq);

      if (!why.length) why.push('没有命中型号、关键词或属性，仅因品类相关被列入候选');

      var hasSpecs = str(p.specs).length > 3 || str(p.specsEn).length > 3;
      var needHasSpec = Object.keys(need).length > 0;
      if (!hasSpecs && needHasSpec) {
        gaps.push('商品目录里没有结构化规格，规格只能按标题比对，请人工核对实物参数');
      }
      if (!s.quotable) {
        gaps.push('该商品没有成本数据，不能直接报价，需先补成本');
      }

      rows.push({
        productId: p.id,
        sku: str(p.sku),
        title: shortTitle(p),
        grade: gradeOf(adj, hardFail, s.modelHit, d.conflict.length),
        score: adj,
        baseScore: Math.round(s.score),
        modelHit: !!s.modelHit,
        model: s.model || '',
        why: why,
        gaps: gaps,
        conflictCount: d.conflict.length,
        sameCount: d.same.length,
        attrs: have,
        quotable: !!s.quotable,
        hasFloor: !!(p.priceFloorUsd > 0),
        priceUsd: p.priceUsd || 0,
        moq: p.moq || 1,
        leadTimeDays: p.leadTimeDays || 0,
        stock: str(p.stock)
      });
    });

    rows.sort(function (a, b) {
      var rank = { direct: 0, review: 1, weak: 2, reject: 3 };
      if (rank[a.grade] !== rank[b.grade]) return rank[a.grade] - rank[b.grade];
      if (a.modelHit !== b.modelHit) return a.modelHit ? -1 : 1;
      return b.score - a.score;
    });

    var counts = { total: rows.length, direct: 0, review: 0, weak: 0, reject: 0 };
    rows.forEach(function (r) { counts[r.grade]++; });

    var visible = rows.filter(function (r) { return r.score >= minScore && r.grade !== 'reject'; });
    var top = visible.slice(0, limit);

    var notes = [];
    var review = [];
    if (!rows.length) notes.push('商品库是空的：先在「商品库」导入或同步商品，再做匹配');
    if (fields.model && !rows.some(function (r) { return r.modelHit; })) {
      review.push({
        field: 'model',
        level: 'high',
        why: '目录里没有任何商品命中型号 ' + fields.model,
        ask: '确认型号是否写错，或该款是否需要新开供应商；不要拿相似款硬报价'
      });
    }
    if (rows.length && !top.length) notes.push('没有达到最低匹配分的候选，建议人工检索商品库');
    if (counts.direct === 0 && top.length) notes.push('没有"可直接报"的候选，最上面几条都需要销售核对');
    top.forEach(function (r) {
      if (r.conflictCount) notes.push(r.sku + '：有 ' + r.conflictCount + ' 项规格与客户要求不一致，见差异明细');
    });

    return {
      ok: true,
      query: {
        text: rawText,
        tokens: Object.keys(tokens).slice(0, 20),
        models: qModels,
        qty: parsed.qty || 0,
        incoterm: fields.incoterm || '',
        needAttrs: need
      },
      matches: top,
      all: rows,
      counts: counts,
      notes: notes,
      needsReview: review,
      coverage: {
        withCost: rows.filter(function (r) { return r.quotable; }).length,
        withFloor: rows.filter(function (r) { return r.hasFloor; }).length,
        withSpecs: list.filter(function (p) { return str(p.specs).length > 3 || str(p.specsEn).length > 3; }).length
      }
    };
  }

  /* ---------- 两个商品的规格对比（商品库"对比"用） ---------- */

  function compare(a, b) {
    var A = a || {}, B = b || {};
    var aa = attrsOf(A), ab = attrsOf(B);
    var rows = [
      { label: 'SKU', a: str(A.sku), b: str(B.sku) },
      { label: '标题', a: shortTitle(A, 120), b: shortTitle(B, 120) }
    ];
    FAMILIES.forEach(function (f) {
      var va = aa[f.key], vb = ab[f.key];
      if (!va && !vb) return;
      rows.push({
        label: f.label,
        a: va ? fmtList(f.key, va) : '—',
        b: vb ? fmtList(f.key, vb) : '—',
        same: !!(va && vb && fmtList(f.key, va) === fmtList(f.key, vb))
      });
    });
    rows.push({ label: 'MOQ', a: str(A.moq), b: str(B.moq), same: A.moq === B.moq });
    rows.push({ label: '交期(天)', a: str(A.leadTimeDays), b: str(B.leadTimeDays), same: A.leadTimeDays === B.leadTimeDays });
    rows.push({ label: '挂牌价 USD', a: str(A.priceUsd), b: str(B.priceUsd) });
    rows.push({ label: '库存状态', a: str(A.stock), b: str(B.stock), same: str(A.stock) === str(B.stock) });
    rows.push({ label: '阶梯价档位数', a: str(arr(A.priceTiers).length), b: str(arr(B.priceTiers).length) });
    var diffs = rows.filter(function (r) { return r.same === false; }).map(function (r) { return r.label; });
    return {
      ok: true,
      rows: rows,
      diffCount: diffs.length,
      diffs: diffs,
      summary: diffs.length ? ('有 ' + diffs.length + ' 项不同：' + diffs.join('、')) : '可见字段完全一致'
    };
  }

  P.search = search;
  P.compare = compare;
  P.attrsOf = attrsOf;
  P.GRADE_TEXT = GRADE_TEXT;
  P.FAMILIES = FAMILIES;
  P.VERSION = '1.0.0';
  root.P0Match = P;
})();