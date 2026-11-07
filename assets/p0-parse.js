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
  var CERTS = ['CE', 'RoHS', 'FCC', 'FDA', 'REACH', 'ISO', 'UL', 'CCC', 'SGS', 'MSDS', 'EN71', 'ASTM',
    'ATEX', 'EAC', 'UKCA', 'RCM', 'PSE', 'KC', 'NOM', 'SASO'];
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
    WITHIN: 1,
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
    /* 短型号补充：字母≥2 + 一位数字 + 可选 1-2 个字母后缀（XR4 / RP3 / ER4 / RP4TD）。
       本品类大量真实型号只有一位数字，主正则的「至少两位数字」会整批漏掉；
       边界靠 \b 与前缀长度兜底：一位字母（V2/F7）不收、货币与排除词不收、
       数字后紧跟数字或字母长串（XR4GEMINI 这类无空格粘连）不收。 */
    var sre = /\b([A-Z]{2,6})[-]?(\d)([A-Z]{0,2})\b/g;
    while ((m = sre.exec(T)) !== null) {
      if (MODEL_EXCLUDE[m[1]]) continue;
      out.push({ token: m[0].replace(/\s+/g, ''), evidence: snippet(fold(raw), m.index, m[0].length) });
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
      priceMentions: [], priceTargetCandidates: [],
      destination: '', certs: [], certMentions: [], unrecognizedCertMentions: [], colors: [], materials: [],
      specs: [], productText: '', productName: '', purpose: ''
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

    /* 价格提及与角色（P1-17 修复 A）：全量提取文中价格，按所在句的局部语义定角色；
       只有唯一的、高置信的客户目标价（USD、非区间）才写入 targetPriceUsd。
       我方价/竞品价/预算/角色未定/多候选一律不写入，保留在 priceMentions 里供员工确认。
       旧实现按正则优先级取全文第一处价格，多价格询盘会把我方报价误作客户目标价。 */
    /* 句界判定（P1-17 第三阶段修复 A）：数字之间的点是小数点，不是句界；
       其余 . ! ? 。 ！ ？ 与换行仍是句界，不得靠放大关键词窗口掩盖切分错误。 */
    function isTerm(txt, i) {
      var c = txt.charAt(i);
      if (c === '\n' || c === '!' || c === '?' || c === '。' || c === '！' || c === '？') return true;
      if (c === '.') {
        var p = txt.charAt(i - 1), n = txt.charAt(i + 1);
        if (/\d/.test(p) && /\d/.test(n)) return false;
        return true;
      }
      return false;
    }
    function sentenceRange(txt, idx) {
      var st = idx;
      while (st > 0 && !isTerm(txt, st - 1)) st--;
      var en = idx;
      while (en < txt.length && !isTerm(txt, en)) en++;
      return { start: st, end: en };
    }
    function sentenceOf(txt, idx) {
      var r = sentenceRange(txt, idx);
      return txt.slice(r.start, r.end + 1);
    }
    /* 子句切分（逗号/分号/but/while）：角色与语境只看价格/认证所在子句的局部语义，
       不让同句其他子句的关键词污染本价格（修复 B 的局部归属）。 */
    function clauseOf(sent, posInSent) {
      var parts = [], last = 0, mm, cre = /[,;，；、]|\bbut\b|\bwhile\b/gi;
      while ((mm = cre.exec(sent)) !== null) { parts.push([last, mm.index]); last = mm.index + mm[0].length; }
      parts.push([last, sent.length]);
      for (var i = 0; i < parts.length; i++) {
        if (posInSent >= parts[i][0] && posInSent <= parts[i][1]) return { text: sent.slice(parts[i][0], parts[i][1]), start: parts[i][0] };
      }
      return { text: sent, start: 0 };
    }
    function curOf(w) {
      w = String(w || '').toLowerCase();
      if (/eur|欧元/.test(w)) return 'EUR';
      if (/gbp|英镑/.test(w)) return 'GBP';
      return 'USD';
    }
    /* 角色判定（第三阶段修复 B）：全部线索限定在价格所在子句内，
       顺序即优先级——总价/竞品子句先行；被拒（前置否定、紧邻 not、后置 too high 等）与
       历史/现付价不作目标价；我方归属优先于后置拒绝（"Your price ... is too high" 仍是我方报价）；
       句级线索只在全句只有一个价格时兜底；其余一律 UNKNOWN，不猜测。 */
    function priceRole(sentLow, clauseLow, beforeClause, afterClause, sentPriceCount) {
      if (/total|grand\s*total|in\s*all|总价|合计|一共/.test(clauseLow)) return 'UNKNOWN_PRICE';
      if (/competitor|another\s+supplier|other\s+supplier|other\s+sellers?|别家|其他供应商|其它供应商|竞争对手/.test(clauseLow)) return 'COMPETITOR_QUOTE';
      var beforeShort = beforeClause.slice(-20);
      if (/(cannot|can't|can\s*not|won't\s+pay|not\s+pay|不能|无法|付不了)/.test(beforeShort)) return 'UNKNOWN_PRICE';
      if (/(not|n't|never)\s*$/.test(beforeClause.slice(-10))) return 'UNKNOWN_PRICE';
      if (/currently\s+paying|used\s+to\s+(buy|pay)|we\s+pay\s|历史价|之前买/.test(clauseLow)) return 'UNKNOWN_PRICE';
      /* 拒绝动词直接支配该价格（cannot accept/pay/do + 价格，中间可隔副词）→ 被拒价格，
         不得被 accept 等目标线索反转（第四阶段修复 C） */
      if (/(cannot|can't|can\s*not)\s+(\w+\s+){0,2}(accept|pay|do)\s*$/.test(beforeClause)) return 'UNKNOWN_PRICE';
      if (/\byour\b/.test(beforeClause) && /(price|quote|quotation|offer)/.test(clauseLow)) return 'OUR_QUOTE';
      if (/you\s+(quoted|offer|charge)|贵司|贵公司|你们的报价|你们的价格/.test(clauseLow)) return 'OUR_QUOTE';
      if (/\bour\s+(price|quote|quotation)/.test(beforeClause)) return 'OUR_QUOTE';
      if (/too\s+(expensive|high)|cannot\s+be\s+accepted|not\s+acceptable|太贵|太高/.test(afterClause)) return 'UNKNOWN_PRICE';
      if (/budget|预算/.test(beforeClause) || /budget|预算/.test(clauseLow)) return 'CUSTOMER_BUDGET';
      if (/target|meet|accept|afford|can\s+(you\s+)?do|expect|希望|目标价|能接受|做到/.test(clauseLow)) return 'CUSTOMER_TARGET';
      if (sentPriceCount === 1) {
        if (/budget|预算/.test(sentLow)) return 'CUSTOMER_BUDGET';
        if (/target|meet|accept|afford|can\s+(you\s+)?do|目标价|能接受/.test(sentLow)) return 'CUSTOMER_TARGET';
      }
      return 'UNKNOWN_PRICE';
    }
    var rawMentions = [], seenMention = {};
    function addMention(value, currency, idx, rawMatch) {
      if (!(value > 0)) return;
      var key = idx + ':' + value + ':' + currency;
      if (seenMention[key]) return;
      seenMention[key] = 1;
      var after = spacedTxt.slice(idx + rawMatch.length, idx + rawMatch.length + 12);
      var before = spacedTxt.slice(Math.max(0, idx - 12), idx);
      var isRange = /^\s*[-–~]\s*\d/.test(after) || /\d\s*[-–~]\s*$/.test(before);
      rawMentions.push({ value: value, currency: currency, text: rawMatch, range: !!isRange, index: idx,
        snippet: snippet(spacedTxt, idx, rawMatch.length) });
    }
    var pmRe1 = /\$\s*(\d[\d,]*(?:\.\d+)?)/g;
    while ((m = pmRe1.exec(spacedTxt))) addMention(num(m[1]), 'USD', m.index, m[0]);
    var pmRe2 = /(usd|dollars?|eur|gbp|美金|美元|欧元|英镑)\s*(\d[\d,]*(?:\.\d+)?)/gi;
    while ((m = pmRe2.exec(spacedTxt))) addMention(num(m[2]), curOf(m[1]), m.index, m[0]);
    var pmRe3 = /(\d[\d,]*(?:\.\d+)?)\s*(usd|dollars?|eur|gbp|美金|美元|欧元|英镑)/gi;
    while ((m = pmRe3.exec(spacedTxt))) addMention(num(m[1]), curOf(m[2]), m.index, m[0]);
    rawMentions.sort(function (a, b) { return a.index - b.index; });
    var sentCount = {};
    rawMentions.forEach(function (x) {
      var r0 = sentenceRange(spacedTxt, x.index);
      x._sr = r0;
      sentCount[r0.start] = (sentCount[r0.start] || 0) + 1;
    });
    var mentions = rawMentions.map(function (x) {
      var sent = spacedTxt.slice(x._sr.start, x._sr.end + 1);
      var posInSent = x.index - x._sr.start;
      var cl = clauseOf(sent, posInSent);
      var posInClause = posInSent - cl.start;
      var beforeClause = cl.text.slice(Math.max(0, posInClause - 45), posInClause).toLowerCase();
      var afterClause = cl.text.slice(posInClause + x.text.length, posInClause + x.text.length + 30).toLowerCase();
      return { value: x.value, currency: x.currency, text: x.text, snippet: x.snippet, range: x.range, index: x.index,
        role: priceRole(sent.toLowerCase(), cl.text.toLowerCase(), beforeClause, afterClause, sentCount[x._sr.start] || 1) };
    });
    mentions.sort(function (a, b) { return a.index - b.index; });
    fields.priceMentions = mentions.map(function (x) {
      return { value: x.value, currency: x.currency, role: x.role, text: x.text, snippet: x.snippet, range: x.range };
    });
    var targetVals = [];
    mentions.forEach(function (x) {
      if (x.role === 'CUSTOMER_TARGET' && x.currency === 'USD' && !x.range && targetVals.indexOf(x.value) < 0) targetVals.push(x.value);
    });
    fields.priceTargetCandidates = targetVals;
    if (targetVals.length === 1) {
      fields.targetPriceUsd = targetVals[0];
      var tm = mentions.filter(function (x) { return x.role === 'CUSTOMER_TARGET' && x.value === targetVals[0]; })[0];
      evidence.targetPriceUsd = tm ? tm.snippet : '';
      confidence.targetPriceUsd = 0.85;
    } else {
      confidence.targetPriceUsd = 0;
    }

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
      { re: /(?:[Dd]eliver(?:y)?\s*to|[Ss]hip(?:ped)?\s*to|[Pp]ort\s*of|[Dd]estination\s*:?|[Ss]hipping\s+[Aa]ddress\s*:?|[Dd]elivery\s+[Aa]ddress\s*:?)\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/, conf: 0.8 },
      /* CIF/FOB 后面跟地名：如 "CIF Hamburg" / "FOB Ningbo" */
      { re: /\b(?:FOB|CIF|CFR|CNF|DDP|EXW)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/, conf: 0.75 },
      { re: /\bto\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})\s*(?:port)?\b/, conf: 0.5 }
    ];
    /* P1-FIX-01：字段标签不是地名。询盘常把贸易术语单独成句（如
       "…, FOB" 换行 "Lead time: 30 days"），折行后 FOB 模式会把
       "Lead" 误捕为目的地。命中标签词时不采纳、继续试后续模式，
       宁可留空待人工确认，也绝不猜一个目的地。 */
    function isLabelCand(cand) {
      if (/^(The|Our|Your|Us|Me|You|It|This|That|Days?|Pcs)$/i.test(cand)) return true;
      if (/^(Lead|Delivery|Shipping|Transit|Production|Payment)\s+(Time|Terms|Date|Address)$/i.test(cand)) return true;
      if (/^(Lead|Delivery|Shipping|Transit|Production|Payment|Quantity|Price|Target|Total|Unit|Validity|Sample|Order)$/i.test(cand)) return true;
      return false;
    }
    for (var ei = 0; ei < DES.length; ei++) {
      m = DES[ei].re.exec(folded);
      if (m) {
        var cand = m[1].replace(/\s+/g, ' ').trim();
        if (!isLabelCand(cand)) {
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

    /* 认证语境与未识别留痕（P1-17 修复 B）：给每个已识别认证标注所在句语境
       （mandatory 强制 / inquiry 询问 / preference 偏好 / unclear 不明确，同认证多句取最强：
       强制 > 不明确 > 询问 > 偏好，避免一处询问句掩盖另一处强制要求）；
       含认证语境的句子里出现的表外大写缩略词记入 unrecognizedCertMentions，绝不静默丢弃。 */
    /* 语境判定（第三阶段修复 C1）：先看认证所在子句的局部语境，子句无结论时才看整句；
       否定/可选（not required / optional / 不需要）优先于 require 等词本身，
       不得把"明确不需要"判成强制；同认证多句取最强（强制 > 不明确 > 询问 > 偏好 > 不需要）。 */
    /* 语境判定（第四阶段修复 A/B）：判定顺序即优先级——
       1) 否定/不需要：not required、isn't required、not a requirement、no … requirement、
          does/do not need、unnecessary、optional 等先行，避免 require/need 词本身反噬；
       2) 询问：子句带疑问形式（疑问词开头、can/could you、can your、whether 等）时判 inquiry，
          compliance/requirements 等名词不构成强制语义；
       3) 强制：must/require/required/mandatory/compulsory、cannot place an order without、need 等要求语义；
       4) 偏好；5) 其余询问词；6) unclear。
       判定材料为认证所在子句（局部优先），整句仅作问句形式的辅助证据。 */
    function certCtxOf(low, sentLow) {
      var sLow = sentLow || low;
      if (/not\s+required|isn'?t\s+required|do\s+not\s+require|don'?t\s+require|not\s+a\s+requirement|no\s+(\w+\s+)?requirement|not\s+mandatory|not\s+needed|does\s+not\s+need|doesn'?t\s+need|doesn'?t\s+require|do\s+not\s+need|don'?t\s+need|unnecessary|optional|不需要|非强制|可选/.test(low)) return 'not-required';
      var interrog = /^(can|could|do|does|is|are|would)\b/.test(low.trim())
        || /can\s+you|could\s+you|do\s+you|can\s+your|could\s+your|whether|能否|可否|是否/.test(low)
        || (/\?/.test(sLow) && /(provide|supply|meet|comply|available|have)\b/.test(low) && !/require|mandatory|must/.test(low));
      if (interrog) return 'inquiry';
      if (/must|require|required|mandatory|compulsory|cannot\s+place\s+an?\s+order\s+without|need(ed|s)?\s+to\s+have|\bneed\b|必须|强制|要求提供|需提供|须具备/.test(low)) return 'mandatory';
      if (/prefer|if\s+available|preferred|ideally|最好|优先|如有/.test(low)) return 'preference';
      if (/do\s+you\s+have|can\s+you\s+(provide|supply)|could\s+you|is\s+(it|the\s+product)|whether|have\s+you|有没有|是否|能否提供|可否提供/.test(low)) return 'inquiry';
      return 'unclear';
    }
    var CTX_RANK = { 'not-required': 0, preference: 1, inquiry: 2, unclear: 3, mandatory: 4 };
    /* 句切分同样要防小数点误切：先把数字间的小数点换成占位符切分，再还原（占位符等长替换不影响原文） */
    var protTxt = spacedTxt.replace(/(\d)\.(\d)/g, '$1\u0002$2');
    var sentences = protTxt.split(/(?<=[.!?。！？\n])\s*/).filter(function (x) { return x.trim().length > 0; })
      .map(function (x) { return x.replace(/\u0002/g, '.'); });
    function ctxForOccurrence(sent, posInSent) {
      var cl = clauseOf(sent, posInSent);
      var c1 = certCtxOf(cl.text.toLowerCase(), sent.toLowerCase());
      return c1 !== 'unclear' ? c1 : certCtxOf(sent.toLowerCase(), sent.toLowerCase());
    }
    fields.certMentions = fields.certs.map(function (c) {
      /* 第五阶段：同一种认证的每一次出现都独立计算语境并保留证据，不再只取第一次、
         也不再只保留最高优先级而丢弃其余说法。context 仍为最高优先级语境（兼容旧消费者），
         contexts 保存全部不同语境（归纳去重），evidence 逐次保存每次提及的语境、原文片段与句内位置 pos，
         conflict 标记 mandatory 与 not-required 并存的真实冲突。 */
      var best = null, bestRank = -1, bestSnippet = '';
      var contexts = [], evidence = [];
      sentences.forEach(function (sent) {
        var re = new RegExp('(?:^|[^a-z0-9])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)', 'gi');
        var mm;
        while ((mm = re.exec(sent)) !== null) {
          /* 证据定位统一（最终修订 R1–R3）：pos 为 0 基偏移，指向认证名称在 snippet 文本中的
             真实起点。正则匹配 mm[0] 在句中时以一个边界字符开头、在句首（^ 命中）时直接以
             认证名开头，故真实起点 = mm.index + 认证名在 mm[0] 内的偏移（大小写不敏感定位，
             名称长度与原文写法一致），禁止固定 +1。ctxForOccurrence 同样接收真实起点，
             其基准为未 trim 的原句，与 clauseOf 的子句区间基准一致。 */
          var nameOff = mm[0].toLowerCase().indexOf(c.toLowerCase());
          var nameStart = mm.index + (nameOff < 0 ? 0 : nameOff);
          var ctx = ctxForOccurrence(sent, nameStart);
          /* snippet 与 pos 同基准：先按 trim 后的句子计算出现位置；句子不超过 90 字符时
             snippet 即整句（与旧行为一致）；超过时取包含本次出现的 90 字符窗口，
             保证长句后部的提及也能被 snippet.slice(pos, pos + 名称长度) 精确定位。
             snippet 中保留的是原文写法（含原始大小写），pos 定位的也是原文写法。 */
          var trimmedSent = sent.trim();
          var leadWs = sent.length - sent.replace(/^\s+/, '').length;
          var posInTrim = nameStart - leadWs;
          var winStart = 0;
          if (trimmedSent.length > 90) {
            winStart = Math.max(0, Math.min(posInTrim - 20, trimmedSent.length - 90));
            if (posInTrim + c.length > winStart + 90) winStart = posInTrim + c.length - 90;
          }
          var snip = trimmedSent.slice(winStart, winStart + 90);
          /* 证据层逐次保留（第五阶段收尾 R1）：每一次出现都独立成条；去重只发生在
             contexts 归纳层与展示层，不反向删除原始证据。 */
          evidence.push({ context: ctx, snippet: snip, pos: posInTrim - winStart });
          if (contexts.indexOf(ctx) < 0) contexts.push(ctx);
          if (CTX_RANK[ctx] > bestRank) { bestRank = CTX_RANK[ctx]; best = ctx; bestSnippet = snip; }
          if (re.lastIndex === mm.index) re.lastIndex++;
        }
      });
      return {
        name: c, context: best || 'unclear', snippet: bestSnippet,
        contexts: contexts, evidence: evidence,
        conflict: contexts.indexOf('mandatory') >= 0 && contexts.indexOf('not-required') >= 0
      };
    });
    var CERT_STOP = { USD: 1, EUR: 1, GBP: 1, FOB: 1, CIF: 1, EXW: 1, DDP: 1, DAP: 1, MOQ: 1, PCS: 1, LED: 1, LCD: 1, USB: 1, OEM: 1, ODM: 1, SKU: 1, QTY: 1, IP67: 1, IP65: 1, IP68: 1, IP54: 1, DC: 1, AC: 1 };
    var unrec = [], unrecSeen = {}, sentVia = 'trigger';
    function addUnrec(token, sent, posInSent, skipLowerRule) {
      var up = token.toUpperCase().replace(/\s+/g, ' ');
      if (!up || unrecSeen[up]) return;
      if (CERT_STOP[up] || /^IP\d/.test(up)) return;
      /* 已识别认证的排除必须归一化比较：IECEx 大小写、ISO 13485 空格写法都曾漏排（第五阶段修复） */
      var upNorm = up.replace(/[\s-]/g, '');
      if (fields.certs.some(function (cc) { return String(cc).toUpperCase().replace(/[\s-]/g, '') === upNorm; })) return;
      var pos = sent.toUpperCase().indexOf(up);
      var follows = pos >= 0 ? sent.slice(pos + up.length, pos + up.length + 22).toLowerCase() : '';
      if (!skipLowerRule && /^[a-z]/.test(follows)) return;
      var isStdName = /^\s*(certification|certificate|standard|compliance|certified)/.test(follows);
      if (!isStdName && fields.models.some(function (mm) { return String(mm).toUpperCase() === up; })) return;
      /* 紧跟商品名词的缩略词是商品属性而非认证（如 ELRS receiver）：不留痕。
         紧跟 certification/standard 的已由 isStdName 保留，不受此条影响。 */
      if (!isStdName && /^\s*(receiver|sensor|device|unit|product|module|motor|pump|drone|camera|light|protocol|system)\b/.test(follows)) return;
      unrecSeen[up] = 1;
      unrec.push({ token: token.replace(/\s+/g, ' '), snippet: sent.trim().slice(0, 90), context: ctxForOccurrence(sent, posInSent), needsVerify: true, via: sentVia });
    }
    var TRIG_RE = /certificat|certification|compliance|certified|comply|compulsory|require|mandatory|认证|证书|合规|标准/;
    sentences.forEach(function (sent, si) {
      var low = sent.toLowerCase();
      /* 触发语境（第三阶段修复 C2）：不再只认 certification 一词；
         require/compulsory/comply/市场要求等强制语境同样触发扫描，误报由停用词、
         型号排除与"混合词片段"规则控制（普通技术参数句没有这些触发词，不会进入扫描）。 */
      /* 第五阶段跨句留痕：本句与已识别认证同现（co-cert），或相邻句有认证触发词且本句带
         need/require/support/meet/must/also 等认证动词（carry）时也扫描，依据记入 via；
         无任何认证上下文的普通技术句仍不扫描，型号/参数误报防线不变。 */
      var trig = TRIG_RE.test(low);
      var coCert = fields.certs.some(function (c) { return new RegExp('(?:^|[^a-z0-9])' + c + '(?:[^a-z0-9]|$)', 'i').test(sent); });
      var neighborTrig = (si > 0 && TRIG_RE.test(sentences[si - 1].toLowerCase())) || (si < sentences.length - 1 && TRIG_RE.test(sentences[si + 1].toLowerCase()));
      var carry = neighborTrig && /\b(need|needs|require|requires|support|supports|meet|must|also)\b/i.test(sent);
      if (!trig && !coCert && !carry) return;
      sentVia = trig ? 'trigger' : (coCert ? 'co-cert' : 'carry');
      var toks = sent.match(/[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)?/g) || [];
      toks.forEach(function (tk) { addUnrec(tk, sent, sent.toUpperCase().indexOf(tk.toUpperCase()), false); });
      var isoToks = sent.match(/\bISO\s?-?\d{4,5}\b/gi) || [];
      isoToks.forEach(function (tk) { addUnrec(tk.replace(/[\s-]/g, ''), sent, sent.toUpperCase().indexOf(tk.toUpperCase()), true); });
      var mixToks = sent.match(/\b[A-Z]{2,}[a-z]{1,3}\b/g) || [];
      mixToks.forEach(function (tk) { addUnrec(tk, sent, sent.indexOf(tk), true); });
      var exToks = sent.match(/\bEx\s+(ia|ib|ic|IIA|IIB|IIC)\b/g) || [];
      exToks.forEach(function (tk) { addUnrec(tk, sent, sent.indexOf(tk), true); });
    });
    fields.unrecognizedCertMentions = unrec;

    /* 电压 / 功率 / 容量：电子类询盘最常见的三项规格，只认带单位的明确写法 */
    var VRE = /(\d{2,3}(?:\.\d)?)\s*V\b/;
    m = VRE.exec(spacedTxt);
    if (m) fields.specs.push({ name: '电压', value: m[1] + ' V', evidence: snippet(spacedTxt, m.index, m[0].length) });
    var WRE = /(\d+(?:\.\d+)?)\s*W\b/;
    m = WRE.exec(spacedTxt);
    if (m) fields.specs.push({ name: '功率', value: m[1] + ' W', evidence: snippet(spacedTxt, m.index, m[0].length) });
    var CRE = /(\d+(?:\.\d+)?)\s*(mAh|Ah|ml|L)\b/;
    m = CRE.exec(spacedTxt);
    if (m) fields.specs.push({ name: '容量', value: m[1] + ' ' + m[2], evidence: snippet(spacedTxt, m.index, m[0].length) });

    /* 商品名称：只认明确句式（looking for / interested in / we need / 标注行），
       抽不到就留空，绝不拿整段原文冒充商品名 */
    var NRE = [
      /(?:product(?:\s*name)?|item|goods)\s*[:：]\s*([^\n,;]{3,60})/i,
      /(?:looking for|interested in|inquiring about|inquiry (?:for|about)|searching for)\s+(?:about\s+)?(.{3,60})/i,
      /(?:we need|we want to (?:buy|import|order|purchase)|want to buy|please quote(?: us)? for)\s+(?:about\s+)?(.{3,60})/i
    ];
    for (var ni = 0; ni < NRE.length; ni++) {
      m = NRE[ni].exec(folded);
      if (!m) continue;
      var candName = m[1]
        .replace(/^\d[\d,]*\s*(?:pcs|pieces|units|sets|pairs|cartons|boxes)?\s*(?:of\s+)?/i, '')
        .replace(/^(?:your|the|a|an)\s+/i, '')
        .split(/[,;\n]|\.\s|\s+for\s+(?:our|my|the|a|an)\s+|\s+quantity\b|\s+qty\b/i)[0]
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (candName.length >= 3 && candName.length <= 60 &&
        !/^(price|quotation|quote|sample|samples|products?|goods|items?)$/i.test(candName) &&
        !/^(?:some|any|these|those)\s/i.test(candName)) {
        fields.productName = candName;
        evidence.productName = snippet(folded, m.index, m[0].length);
        confidence.productName = ni === 0 ? 0.9 : 0.75;
        break;
      }
    }
    if (!fields.productName) confidence.productName = 0;

    /* 用途 / 销售渠道：只认明说的短语，猜测一律不写 */
    var PURPOSES = [
      { label: '零售转售', re: /\bfor\s+(?:our\s+)?(?:retail|resale)\b|\bresale\b|\bretail\s+(?:chain|stores?|shops?)\b|\bsell\s+in\s+our\s+(?:stores?|shops?|supermarket)\b/i },
      { label: '电商销售', re: /\bamazon\b|\bsell\s+(?:on|online)\b|\bonline\s+(?:store|shop|selling)\b|\be-?commerce\b|\bshopify\b|\bebay\b/i },
      { label: '自用', re: /\bfor\s+(?:personal|our own|internal|company)\s+use\b|\bour\s+own\s+use\b/i },
      { label: '促销礼品', re: /\bpromotion(?:al)?\s+(?:gifts?|items?|products?)\b|\bgiveaways?\b|\bgifts?\s+for\s+(?:our\s+)?(?:customers|clients|employees|staff)\b/i },
      { label: '工程项目', re: /\bfor\s+(?:a|our|the)\s+(?:construction\s+|engineering\s+)?project\b|\bproject\s+use\b/i },
      { label: '定制品牌', re: /\bprivate\s+label\b|\bour\s+(?:own\s+)?brand\b|\bwith\s+our\s+(?:logo|brand)\b|\boem\b/i }
    ];
    for (var ui = 0; ui < PURPOSES.length; ui++) {
      m = PURPOSES[ui].re.exec(folded);
      if (m) {
        fields.purpose = PURPOSES[ui].label;
        evidence.purpose = snippet(folded, m.index, m[0].length);
        confidence.purpose = 0.8;
        break;
      }
    }
    if (!fields.purpose) confidence.purpose = 0;

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
    if (!fields.targetPriceUsd && fields.priceTargetCandidates.length > 1) {
      needsReview.push({ field: 'targetPriceUsd', level: 'mid', why: '文中出现多个客户目标价候选（' + fields.priceTargetCandidates.map(function (v) { return '$' + v; }).join(' / ') + '），无法自动确定', ask: '请确认客户真正的目标价，再写入目标价字段' });
    } else if (!fields.targetPriceUsd) {
      needsReview.push({ field: 'targetPriceUsd', level: 'low', why: '客户没给目标价', ask: '可选：问客户目标价位，便于判断是否值得跟' });
    }
    if (!fields.productName) {
      needsReview.push({ field: 'productName', level: 'mid', why: '没识别到明确商品名称', ask: '确认客户要的具体商品名称，避免匹配错品类' });
    }
    if (!fields.purpose) {
      needsReview.push({ field: 'purpose', level: 'low', why: '客户没写用途 / 销售渠道', ask: '可选：问一句用途或销售渠道，便于推荐款式与包装' });
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
  P.VERSION = '1.1.0';

  (typeof window !== 'undefined' ? window : globalThis).P0Parse = P;
})();