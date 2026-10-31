/* ===========================================================
   p0-parse.js — 询盘录入与需求提取（P0-A）
   全局暴露：window.P0Parse

   设计原则：
   1. 只从原文里"抽"，不猜。抽不到的字段一律留空并进 needsReview，
      由销售人工确认或先去问客户。
   2. 每个字段都带 evidence（原文片段）与 confidence（0/0.6/0.9），
      UI 必须把 evidence 显示出来，让人能一眼核对。
   3. 纯函数、无 DOM、无网络、无 AI。相同输入永远得到相同输出。
   =========================================================== */
(function () {
  'use strict';

  var P = (typeof window !== 'undefined' ? window : globalThis).P0Parse || {};

  var INCOTERMS = ['FOB', 'CIF', 'EXW', 'DDP', 'CFR', 'CNF', 'FCA', 'CPT', 'CIP'];
  var CERTS = ['CE', 'RoHS', 'FCC', 'FDA', 'REACH', 'ISO', 'UL', 'CCC', 'SGS', 'MSDS', 'EN71', 'ASTM'];
  var COLORS = ['black', 'white', 'red', 'blue', 'green', 'grey', 'gray', 'yellow', 'orange',
    'pink', 'purple', 'brown', 'transparent', 'clear', 'silver', 'gold',
    '黑色', '白色', '红色', '蓝色', '绿色', '灰色', '透明', '黄色'];
  var MATERIALS = ['abs', 'pp', 'pe', 'pc', 'pvc', 'pet', 'silicone', '硅胶', 'stainless steel',
    '不锈钢', 'aluminum', '铝', 'wood', '木', 'bamboo', '竹', 'glass', '玻璃',
    'cotton', '棉', 'leather', '皮革', 'nylon', '尼龙', 'polyester', '涤纶'];
  /* 型号排除词：标准号、单位、贸易术语不能被当成产品型号 */
  var MODEL_EXCLUDE = {
    ISO: 1, IEC: 1, EN: 1, GB: 1, ASTM: 1, DIN: 1, ANSI: 1, JIS: 1, UL: 1, CE: 1,
    ROHS: 1, FCC: 1, FDA: 1, REACH: 1, SGS: 1, MSDS: 1, FOB: 1, CIF: 1, EXW: 1,
    DDP: 1, CFR: 1, CNF: 1, FCA: 1, CPT: 1, CIP: 1, USD: 1, RMB: 1, CNY: 1, EUR: 1,
    MOQ: 1, OEM: 1, ODM: 1, SKU: 1, HS: 1, PCS: 1, SET: 1, CTN: 1, LCL: 1, FCL: 1
  };

  /* ---------------- 工具 ---------------- */

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  /* 全角→半角，统一乘号/空格/大小写处理的基础 */
  function fold(s) {
    var out = str(s).replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    }).replace(/\u3000/g, ' ');
    return out;
  }

  function squeeze(s) { return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim(); }

  /* 数字与单位之间补空格：2000pcs → 2000 pcs；$1.2/pc 保持 */
  function spaced(s) {
    return s
      .replace(/(\d)(pcs|pieces|units|sets|cartons|ctns|days|pairs|bags|boxes)\b/gi, '$1 $2')
      .replace(/(\d)(pcs|个|件|套|只|天|日)/g, '$1 $2');
  }

  function snippet(text, idx, len) {
    var a = Math.max(0, idx - 24), b = Math.min(text.length, idx + len + 24);
    return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
  }

  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (x) { var k = String(x).toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(x); } });
    return out;
  }

  function num(v) { var n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; }

  /* 型号：字母开头 + 至少两位数字，或纯数字串长度≥5 且带连字符 */
  function findModels(raw) {
    var T = fold(raw).toUpperCase();
    var out = [];
    /* 字母与数字之间只允许连字符或斜杠：不能用空格，否则 "need 2000" 会被读成型号 */
    var re = /\b([A-Z]{1,6})[-/]?(\d{2,})([A-Z0-9-]{0,8})\b/g, m;
    while ((m = re.exec(T)) !== null) {
      var token = m[0].replace(/\s+/g, '');
      var prefix = m[1];
      if (MODEL_EXCLUDE[prefix]) continue;
      if (token.replace(/[^0-9]/g, '').length < 2) continue;
      if (token.length < 5) continue;
      out.push({ token: token, evidence: snippet(fold(raw), m.index, m[0].length) });
    }
    /* 纯数字型号：8 位以上（如 20250101 这类料号不取），只在明确带 model/no. 前缀时取 */
    var mre = /(?:model|型号|item\s*(?:no|code)|art\.?\s*no)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{3,})/gi;
    while ((m = mre.exec(fold(raw))) !== null) {
      var t = m[1].toUpperCase();
      if (!/\d/.test(t)) continue;
      /* 带「型号 / model / item no.」显式标记的一律认，不再套排除词，
         否则 SKU-7788、ITEM-4500 这类正常料号会被误杀 */
      out.push({ token: t, evidence: snippet(fold(raw), m.index, m[0].length) });
    }
    var seen = {}, list = [];
    out.forEach(function (x) { if (!seen[x.token]) { seen[x.token] = 1; list.push(x); } });
    return list.slice(0, 3);
  }

  /* ---------------- 主函数 ---------------- */

  function extract(text, opts) {
    opts = opts || {};
    var raw = str(text);
    var folded = squeeze(fold(raw));
    var lower = folded.toLowerCase();
    var spacedTxt = spaced(folded);

    var fields = {
      model: '', models: [], qty: 0, qtyUnit: 'pcs',
      targetPriceUsd: 0, incoterm: '', deadlineDays: 0, deadlineText: '',
      destination: '', certs: [], colors: [], materials: [],
      specs: [], productText: ''
    };
    var evidence = {};
    var confidence = {};
    var m;

    /* 数量 */
    var QRE = [
      /(\d[\d,]*(?:\.\d+)?)\s*(pcs|pieces|units|sets|cartons|ctns|pairs|bags|boxes|个|件|套|只)/i,
      /(?:quantity|qty|order)\D{0,6}(\d[\d,]*)/i,
      /(?:need|want|require|looking for)\D{0,8}(\d[\d,]{1,})/i
    ];
    for (var qi = 0; qi < QRE.length; qi++) {
      m = QRE[qi].exec(spacedTxt);
      if (m && num(m[1]) > 0) {
        fields.qty = num(m[1]);
        fields.qtyUnit = (m[2] || 'pcs').toLowerCase();
        evidence.qty = snippet(spacedTxt, m.index, m[0].length);
        confidence.qty = qi === 0 ? 0.9 : 0.7;
        break;
      }
    }
    if (!fields.qty) confidence.qty = 0;

    /* 目标价 */
    var PRE = [
      /\$\s*(\d+(?:\.\d+)?)/,
      /(\d+(?:\.\d+)?)\s*(?:usd|dollars?|美金|美元)/i,
      /(?:target|best)\s*(?:price)?\D{0,6}(\d+(?:\.\d+)?)/i
    ];
    for (var pi = 0; pi < PRE.length; pi++) {
      m = PRE[pi].exec(spacedTxt);
      if (m && num(m[1]) > 0) {
        fields.targetPriceUsd = num(m[1]);
        evidence.targetPriceUsd = snippet(spacedTxt, m.index, m[0].length);
        confidence.targetPriceUsd = 0.6;
        break;
      }
    }
    if (!fields.targetPriceUsd) confidence.targetPriceUsd = 0;

    /* 贸易术语 */
    var t = lower;
    for (var i = 0; i < INCOTERMS.length; i++) {
      var re = new RegExp('\\b' + INCOTERMS[i].toLowerCase() + '\\b', 'i');
      var mm = re.exec(t);
      if (mm) {
        fields.incoterm = INCOTERMS[i];
        evidence.incoterm = snippet(spacedTxt, mm.index, mm[0].length);
        confidence.incoterm = 0.95;
        break;
      }
    }
    if (!fields.incoterm) confidence.incoterm = 0;

    /* 交期 */
    var DRE = [/(\d{1,3})\s*(?:days?|天|日)/i, /within\s*(\d{1,3})/i, /lead\s*time\D{0,6}(\d{1,3})/i];
    for (var di = 0; di < DRE.length; di++) {
      m = DRE[di].exec(spacedTxt);
      if (m && num(m[1]) > 0) {
        fields.deadlineDays = Math.round(num(m[1]));
        evidence.deadlineDays = snippet(spacedTxt, m.index, m[0].length);
        confidence.deadlineDays = 0.85;
        break;
      }
    }
    var dateM = /\b(?:by|before|deliver(?:y)?\s*(?:by|before)?)\s*([A-Z][a-z]+\s+\d{1,2}(?:,?\s*\d{4})?)/.exec(folded);
    if (dateM) {
      fields.deadlineText = dateM[1];
      evidence.deadlineText = snippet(folded, dateM.index, dateM[0].length);
      confidence.deadlineDays = confidence.deadlineDays || 0.6;
    }
    if (!fields.deadlineDays && !fields.deadlineText) confidence.deadlineDays = 0;

    /* 目的地 */
    var DES = [
      { re: /(?:deliver(?:y)?\s*to|ship(?:ped)?\s*to|port\s*of|destination\s*:?)\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/, conf: 0.8 },
      /* CIF/FOB 后面跟地名：如 "CIF Hamburg" / "FOB Ningbo" */
      { re: /\b(?:FOB|CIF|CFR|CNF|DDP|EXW)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/, conf: 0.75 },
      { re: /\bto\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*(?:port)?\b/, conf: 0.5 }
    ];
    for (var ei = 0; ei < DES.length; ei++) {
      m = DES[ei].re.exec(folded);
      if (m) {
        var cand = m[1].replace(/\s+/g, ' ').trim();
        if (!/^(The|Our|Your|Us|Me|You|It|This|That|Days?|Pcs)$/i.test(cand)) {
          fields.destination = cand;
          evidence.destination = snippet(folded, m.index, m[0].length);
          confidence.destination = DES[ei].conf;
          break;
        }
      }
    }
    if (!fields.destination) confidence.destination = 0;

    /* 认证 */
    var certs = [];
    CERTS.forEach(function (c) {
      var re = new RegExp('(?:^|[^a-z0-9])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)', 'i');
      if (re.test(folded)) certs.push(c);
    });
    fields.certs = uniq(certs);
    confidence.certs = fields.certs.length ? 0.9 : 0;

    /* 颜色 / 材质 */
    fields.colors = uniq(COLORS.filter(function (c) { return new RegExp('(?:^|[^a-z\\u4e00-\\u9fa5])' + c + '(?:$|[^a-z\\u4e00-\\u9fa5])', 'i').test(lower); }));
    fields.materials = uniq(MATERIALS.filter(function (c) { return new RegExp('(?:^|[^a-z\\u4e00-\\u9fa5])' + c + '(?:$|[^a-z\\u4e00-\\u9fa5])', 'i').test(lower); }));

    /* 尺寸：100x50x30mm / 20*15cm */
    var SRE = /(\d+(?:\.\d+)?)\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?)(?:\s*(?:x|×|\*)\s*(\d+(?:\.\d+)?))?\s*(mm|cm|m|inch|in|")\b/i;
    m = SRE.exec(spacedTxt);
    if (m) {
      var dim = m[1] + ' x ' + m[2] + (m[3] ? ' x ' + m[3] : '') + (m[4] ? ' ' + m[4].toLowerCase() : '');
      fields.specs.push({ name: '尺寸', value: dim, evidence: snippet(spacedTxt, m.index, m[0].length) });
    }
    if (fields.materials.length) {
      fields.specs.push({ name: '材质', value: fields.materials.join(' / '), evidence: '' });
    }
    if (fields.colors.length) {
      fields.specs.push({ name: '颜色', value: fields.colors.join(' / '), evidence: '' });
    }

    /* 型号 */
    var models = findModels(raw);
    fields.models = models.map(function (x) { return x.token; });
    fields.model = fields.models[0] || '';
    if (fields.model) {
      evidence.model = models[0].evidence;
      confidence.model = 0.85;
    } else {
      confidence.model = 0;
    }

    /* 产品描述：去掉数量/价格/术语后剩下的第一段，供匹配用 */
    var ptxt = spacedTxt
      .replace(/\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:pcs|pieces|units|sets|cartons|pairs|bags|boxes|个|件|套|只|usd|dollars?)/gi, ' ')
      .replace(/\b(?:fob|cif|exw|ddp|cfr|cnf)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    fields.productText = ptxt.slice(0, 240);
    confidence.productText = ptxt.length >= 6 ? 0.8 : 0;

    /* 需要人工确认的项 */
    var needsReview = [];
    if (!fields.qty) {
      needsReview.push({ field: 'qty', level: 'high', why: '没识别到采购数量', ask: '请确认数量（如 2000 pcs）' });
    }
    if (!fields.model) {
      needsReview.push({ field: 'model', level: 'high', why: '没识别到具体型号', ask: '请让客户提供型号或产品图片，避免报错款' });
    }
    if (!fields.incoterm) {
      needsReview.push({ field: 'incoterm', level: 'mid', why: '没写贸易术语', ask: '确认 FOB / CIF / EXW，运费口径不同' });
    }
    if (!fields.destination && fields.incoterm === 'CIF') {
      needsReview.push({ field: 'destination', level: 'high', why: 'CIF 必须知道目的港', ask: '确认目的港，否则运费无法核算' });
    }
    if (!fields.deadlineDays && !fields.deadlineText) {
      needsReview.push({ field: 'deadline', level: 'mid', why: '客户没提交期', ask: '确认期望交期，与商品 leadTimeDays 比对' });
    }
    if (!fields.targetPriceUsd) {
      needsReview.push({ field: 'targetPriceUsd', level: 'low', why: '客户没给目标价', ask: '可选：问客户目标价位，便于判断是否值得跟' });
    }

    var critical = ['qty', 'model', 'incoterm', 'deadlineDays'];
    var got = critical.filter(function (k) { return confidence[k] > 0; }).length;
    var overall = Math.round((got / critical.length) * 100) / 100;

    var summaryBits = [];
    if (fields.qty) summaryBits.push(fields.qty + ' ' + (fields.qtyUnit === 'pcs' ? 'pcs' : fields.qtyUnit));
    if (fields.model) summaryBits.push('型号 ' + fields.model);
    if (fields.incoterm) summaryBits.push(fields.incoterm);
    if (fields.deadlineDays) summaryBits.push(fields.deadlineDays + ' 天交期');
    if (fields.destination) summaryBits.push('发往 ' + fields.destination);

    var out = {
      ok: true,
      raw: raw,
      normalized: folded,
      fields: fields,
      evidence: evidence,
      confidence: confidence,
      overall: overall,
      needsReview: needsReview,
      blocking: needsReview.filter(function (x) { return x.level === 'high'; }).map(function (x) { return x.field; }),
      summary: summaryBits.length ? summaryBits.join(' · ') : '未识别到结构化信息，请补充或改写询盘',
      signals: {
        hasModel: !!fields.model,
        hasQty: !!fields.qty,
        hasPrice: !!fields.targetPriceUsd,
        hasSpecs: fields.specs.length > 0,
        textLen: folded.length
      }
    };
    return out;
  }

  /* 人工修正：把销售改过的字段合并进来，并保留"已人工确认"标记 */
  function applyEdits(parsed, edits) {
    var out = JSON.parse(JSON.stringify(parsed));
    var changed = [];
    Object.keys(edits || {}).forEach(function (k) {
      var v = edits[k];
      if (v === undefined || v === null || v === '') return;
      if (typeof v === 'number' && !(v > 0)) return;
      if (out.fields[k] !== v) { out.fields[k] = v; changed.push(k); }
    });
    if (changed.length) {
      out.edited = uniq((out.edited || []).concat(changed));
      out.needsReview = out.needsReview.filter(function (x) { return changed.indexOf(x.field) < 0; });
      out.blocking = out.needsReview.filter(function (x) { return x.level === 'high'; }).map(function (x) { return x.field; });
    }
    return out;
  }

  P.extract = extract;
  P.applyEdits = applyEdits;
  P.fold = fold;
  P.findModels = findModels;
  P.VERSION = '1.0.0';

  (typeof window !== 'undefined' ? window : globalThis).P0Parse = P;
})();