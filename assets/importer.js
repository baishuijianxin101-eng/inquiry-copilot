/* ===========================================================
   importer.js — 从任意表格文本里识别列，再转成商品
   全局暴露：window.Importer

   解决的问题：从阿里后台「商品管理」页面 Ctrl+A / Ctrl+C 出来的
   东西，列的顺序、有没有表头、夹了多少垃圾行，每次都不一样。
   这里用「表头关键词 + 列内容特征」双重判断，猜出每一列是什么，
   猜错了用户在预览里改一下就行。
   =========================================================== */
(function () {
  'use strict';

  var ROLES = [
    { key: 'sku', label: 'SKU / 货号' },
    { key: 'title', label: '商品名（中文）' },
    { key: 'titleEn', label: '商品名（英文）' },
    { key: 'category', label: '类目' },
    { key: 'keywords', label: '关键词' },
    { key: 'specs', label: '规格（中文）' },
    { key: 'specsEn', label: '规格（英文）' },
    { key: 'priceUsd', label: '橱窗价 USD' },
    { key: 'costRmb', label: '成本（元，内部）' },
    { key: 'moq', label: 'MOQ 起订量' },
    { key: 'leadTimeDays', label: '交期（天）' },
    { key: 'certs', label: '认证' },
    { key: 'hsCode', label: 'HS 编码' }
  ];

  /* 表头关键词：越具体越靠前匹配 */
  var HEADER_HINTS = [
    ['titleEn', ['英文名', '英文名称', '英文标题', 'english name', 'en name']],
    ['specsEn', ['英文规格', '英文属性', 'specs en']],
    ['leadTimeDays', ['交期', '货期', '交货期', '交货时间', 'lead time', 'delivery time', 'delivery']],
    ['moq', ['起订量', '最小起订', '起订', 'min order', 'moq', 'minimum order']],
    ['costRmb', ['成本价', '成本', '进价', '拿货价', '采购价', 'cost', 'purchase price', 'supply price']],
    ['priceUsd', ['橱窗价', '价格', '单价', '报价', '售价', 'price', 'unit price']],
    ['category', ['类目', '分类', '行业', 'category', 'industry']],
    ['keywords', ['关键词', '标签', 'keyword', 'tag']],
    ['certs', ['认证', '证书', 'certificate', 'certification', 'cert']],
    ['hsCode', ['海关编码', 'hs 编码', 'hs编码', 'hs code', 'hsn', 'tariff']],
    ['specs', ['规格', '属性', '描述', 'spec', 'attribute', 'description']],
    ['sku', ['sku', '货号', '编号', '型号', '产品编码', 'item no', 'model']],
    ['title', ['商品名称', '产品名称', '商品标题', '标题', '商品', '产品', 'title', 'name', 'product']]
  ];

  var CERT_RE = /(^|[^A-Za-z])(CE|RoHS|REACH|FCC|FDA|LFGB|UL|ETL|GS|PSE|KC|SGS|BSCI|EN71|CPC|ISO\s?\d{3,5})([^A-Za-z]|$)/i;
  var PRICE_RE = /^[\s$€¥￥]*(?:usd|us\$|rmb|cny)?[\s$€¥￥]*([\d][\d,]*(?:\.\d{1,4})?)[\s$€¥￥]*(?:usd|usd\/pc|pcs|\/pc)?\s*$/i;
  var CNY_RE = /[¥￥]|人民币|rmb|cny|\d\s*元/i;

  /* ---------------- 基础解析 ---------------- */

  function splitRow(line, delim) {
    if (delim === '\t') return line.split('\t');
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function parsePrice(v) {
    if (v === null || v === undefined) return 0;
    var s = String(v).replace(/[,，\s]/g, '');
    var m = s.match(/(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    return isFinite(n) ? n : 0;
  }

  function parseInt10(v) {
    if (v === null || v === undefined) return 0;
    var s = String(v).replace(/[,，\s]/g, '');
    var m = s.match(/(\d+)/);
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    return isFinite(n) ? n : 0;
  }

  function isPriceLike(v) {
    var s = String(v || '').trim();
    if (!s) return false;
    if (!/\d/.test(s)) return false;
    if (s.length > 16) return false;
    return PRICE_RE.test(s) || /^[\s$€¥￥]*\d+[\d,]*(\.\d+)?\s*(usd|美元|元)?$/i.test(s);
  }

  function isIntLike(v) {
    return /^\s*\d{1,7}\s*$/.test(String(v || ''));
  }

  function isSkuLike(v) {
    var s = String(v || '').trim();
    if (s.length < 3 || s.length > 24) return false;
    if (!/[A-Za-z]/.test(s)) return false;
    return /^[A-Za-z0-9][A-Za-z0-9\-_.\/]*$/.test(s);
  }

  function hasCJK(s) { return /[\u4e00-\u9fa5]/.test(String(s || '')); }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /* ---------------- 列特征 ---------------- */

  function colStats(rows, ci) {
    var vals = [];
    for (var i = 0; i < rows.length; i++) {
      var v = (rows[i][ci] || '').trim();
      if (v) vals.push(v);
    }
    var n = vals.length;
    if (!n) return { n: 0 };

    var price = 0, ints = 0, certs = 0, sku = 0, cjk = 0, longText = 0, cny = 0;
    var intVals = [];
    var lenSum = 0;

    vals.forEach(function (v) {
      if (isPriceLike(v)) price++;
      if (isIntLike(v)) { ints++; intVals.push(parseInt(v, 10)); }
      if (CERT_RE.test(v)) certs++;
      if (isSkuLike(v)) sku++;
      if (hasCJK(v)) cjk++;
      if (v.length >= 8) longText++;
      if (CNY_RE.test(v)) cny++;
      lenSum += v.length;
    });

    return {
      n: n,
      priceRatio: price / n,
      intRatio: ints / n,
      certRatio: certs / n,
      skuRatio: sku / n,
      cjkRatio: cjk / n,
      longRatio: longText / n,
      cnyRatio: cny / n,
      avgLen: lenSum / n,
      intMedian: median(intVals),
      intMax: intVals.length ? Math.max.apply(null, intVals) : 0
    };
  }

  /* ---------------- 表头识别 ---------------- */

  function looksLikeHeader(row) {
    var hits = 0;
    row.forEach(function (cell) {
      var s = String(cell || '').toLowerCase();
      if (!s) return;
      HEADER_HINTS.forEach(function (pair) {
        pair[1].forEach(function (h) {
          if (s.indexOf(h.toLowerCase()) >= 0) hits++;
        });
      });
    });
    return hits >= 2;
  }

  function roleFromHeader(cell) {
    var s = String(cell || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s || s.length > 24) return null;
    for (var i = 0; i < HEADER_HINTS.length; i++) {
      var role = HEADER_HINTS[i][0];
      var hints = HEADER_HINTS[i][1];
      for (var j = 0; j < hints.length; j++) {
        if (s.indexOf(hints[j].toLowerCase()) >= 0) return role;
      }
    }
    return null;
  }

  /* ---------------- 主识别 ---------------- */

  /**
   * @param {string} text 粘贴的原始文本
   * @returns {{rows:Array, cols:number, header:boolean, mapping:Array, stats:Array}}
   */
  function guess(text) {
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return { rows: [], cols: 0, header: false, mapping: [], stats: [] };

    var delim = lines[0].indexOf('\t') >= 0 ? '\t' : ',';
    var raw = lines.map(function (l) { return splitRow(l, delim); });

    var cols = 0;
    raw.forEach(function (r) { if (r.length > cols) cols = r.length; });
    cols = Math.min(cols, 16);

    var rows = raw.map(function (r) {
      var c = r.slice(0, cols);
      while (c.length < cols) c.push('');
      return c;
    });

    var header = looksLikeHeader(rows[0] || []);
    var mapping = new Array(cols).fill(null);

    /* 第一步：表头精确匹配 */
    if (header) {
      var used = {};
      for (var c = 0; c < cols; c++) {
        var role = roleFromHeader(rows[0][c]);
        if (role && !used[role]) { mapping[c] = role; used[role] = true; }
      }
    }

    /* 第二步：内容特征补齐 */
    var stats = [];
    for (var i = 0; i < cols; i++) stats.push(colStats(rows, i));

    var assigned = {};
    mapping.forEach(function (r) { if (r) assigned[r] = true; });

    function freeCols() {
      var out = [];
      for (var k = 0; k < cols; k++) if (!mapping[k] && stats[k].n > 0) out.push(k);
      return out;
    }

    function pick(role, scorer, threshold) {
      if (assigned[role]) return;
      var best = -1, bestScore = threshold === undefined ? 0 : threshold;
      freeCols().forEach(function (k) {
        var sc = scorer(stats[k]);
        if (sc > bestScore) { bestScore = sc; best = k; }
      });
      if (best >= 0) { mapping[best] = role; assigned[role] = true; }
    }

    // 价格：价格特征最强的列
    pick('priceUsd', function (s) { return s.priceRatio; }, 0.5);

    // MOQ：整数列里中位数比较小的
    pick('moq', function (s) {
      if (s.intRatio < 0.7) return 0;
      if (s.intMedian < 1 || s.intMedian > 500000) return 0;
      return 0.5 + (s.intRatio * 0.3);
    }, 0.6);

    // 交期：另一个整数列，数值小
    pick('leadTimeDays', function (s) {
      if (s.intRatio < 0.7) return 0;
      if (s.intMax > 180) return 0;
      return 0.9 - (s.intMedian / 400);
    }, 0.7);

    // 认证
    pick('certs', function (s) { return s.certRatio * 1.2; }, 0.35);

    // SKU
    pick('sku', function (s) {
      if (s.skuRatio < 0.6) return 0;
      if (s.avgLen > 22) return 0;
      return 0.5 + s.skuRatio * 0.4;
    }, 0.7);

    // 商品名：剩下的列里文字最长的
    pick('title', function (s) {
      if (s.priceRatio > 0.5) return 0;
      if (s.intRatio > 0.8) return 0;
      return Math.min(1, s.avgLen / 14) + (s.cjkRatio > 0.3 ? 0.2 : 0);
    }, 0.45);

    // 类目：剩下的短中文列
    pick('category', function (s) {
      if (s.avgLen > 12) return 0;
      return s.cjkRatio * 0.9;
    }, 0.6);

    return { rows: rows, cols: cols, header: header, mapping: mapping, stats: stats };
  }

  /* ---------------- 转商品 ---------------- */

  function toProducts(rows, mapping, opts) {
    opts = opts || {};
    var startRow = opts.header ? 1 : 0;
    var fx = opts.fxRate || 7.1;
    /* 以前逐格判断有没有 ¥ 符号：1688 导出的表经常整列裸数字（88），
       一列里只要有一格没带符号就按美元入账，¥88 变成 $88，报价直接翻 7 倍。
       现在以整表判断为准：勾了「人民币价」就整列都折算。 */
    var fileHasCny = detectCny(rows, mapping);
    var convertCny = opts.convertCny === undefined ? fileHasCny : !!opts.convertCny;
    var out = [];
    var skipped = { noTitle: 0, noPrice: 0, badPrice: 0 };

    for (var i = startRow; i < rows.length; i++) {
      var rec = {};
      for (var c = 0; c < mapping.length; c++) {
        var role = mapping[c];
        if (!role) continue;
        rec[role] = String(rows[i][c] || '').trim();
      }

      var title = rec.title || rec.titleEn || '';
      if (!title || title.length < 2) { skipped.noTitle++; continue; }

      var rawPriceCell = rec.priceUsd || '';
      var price = parsePrice(rawPriceCell);
      if (!(price > 0)) { skipped.noPrice++; continue; }

      if (convertCny) {
        price = price / fx;
      }
      if (price <= 0 || price > 100000) { skipped.badPrice++; continue; }

      /* 没填就留空（待确认），不要凭空造 100 件 MOQ / 15 天交期：
         这些数会直接写进报价单发给老外。 */
      var moq = parseInt10(rec.moq);
      var lead = parseInt10(rec.leadTimeDays);

      /* 成本列单独解析，且不做汇率折算：表里那列本来就是人民币。
         以前表头的 cost 被当成橱窗价，一份 1688 报价表导进来 $88 变 ¥88。 */
      var costRmb = parsePrice(rec.costRmb || '');
      if (!(costRmb > 0) || costRmb > 1000000) costRmb = 0;

      out.push({
        sku: (rec.sku || '').trim(),
        title: title,
        titleEn: (rec.titleEn || '').trim(),
        category: (rec.category || '').trim(),
        keywords: splitList(rec.keywords),
        specs: (rec.specs || '').trim(),
        specsEn: (rec.specsEn || '').trim(),
        priceUsd: Math.round(price * 100) / 100,
        moq: moq > 0 ? Math.max(1, moq) : 0,
        leadTimeDays: lead > 0 ? Math.max(1, Math.min(365, lead)) : 0,
        certs: splitList(rec.certs).map(function (x) { return x.toUpperCase(); }),
        hsCode: (rec.hsCode || '').trim(),
        stock: '备货',
        note: '',
        /* 只在真的识别出成本时才写，避免给 238 条老商品平白添一个 0 成本 */
        costRmb: costRmb > 0 ? Math.round(costRmb * 100) / 100 : undefined
      });
    }

    window.Importer.lastSkipped = skipped;
    return out;
  }

  function splitList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
    return String(v).split(/[,，;；\/|\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /* 这个粘贴内容里有没有人民币价格 */
  function detectCny(rows, mapping) {
    var ci = mapping.indexOf('priceUsd');
    if (ci < 0) return false;
    for (var i = 0; i < rows.length; i++) {
      if (CNY_RE.test(rows[i][ci] || '')) return true;
    }
    return false;
  }

  window.Importer = {
    ROLES: ROLES,
    guess: guess,
    toProducts: toProducts,
    detectCny: detectCny,
    parsePrice: parsePrice,
    splitRow: splitRow
  };
})();
