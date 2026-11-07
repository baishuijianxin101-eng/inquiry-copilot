/* ===========================================================
   matching.js — 商机解析 + 商品匹配
   全局暴露：window.Matching

   注意：这是「规则 + 词频」的本地引擎，零依赖、可离线、
   不需要 API Key。它的作用是先把流程跑通；
   后续把 rank() 换成 embedding 检索或 LLM 重排即可，
   接口保持不变。
   =========================================================== */
(function () {
  'use strict';

  var C = window.Core;

  /* ---------------- 停用词 ---------------- */

  var STOP_EN = ('the a an of for with and or to in on at by from as is are be been being ' +
    'we i you he she it they our your their my me us them this that these those ' +
    'please need want looking look would like can could should will shall may might ' +
    'do does did have has had not no yes if then than so such very more most ' +
    'about into over under between during before after above below up down out off again ' +
    'per pcs pc piece pieces unit units set sets qty quantity moq price prices ' +
    'hi hello dear thanks thank best regards sir madam mr ms mrs ' +
    'new good high quality sample samples order orders business company ' +
    'kindly quote quotation offer supply supplier manufacturer factory ' +
    'email contact whatsapp skype tel phone address').split(/\s+/);

  var STOP_ZH_BIGRAM = {};

  function buildStopZh() {
    ['我们', '你们', '他们', '我的', '你的', '这个', '那个', '什么', '怎么', '可以',
      '需要', '请问', '如果', '因为', '所以', '但是', '而且', '或者', '以及', '还有',
      '一个', '一些', '这样', '那样', '已经', '可能', '应该', '现在', '目前', '然后',
      '希望', '麻烦', '谢谢', '您好', '你好', '价格', '数量', '产品', '客户', '订单',
      '采购', '供应', '公司', '工厂', '质量', '要求', '时间', '交期', '认证', '规格'
    ].forEach(function (w) {
      // 把两字词本身作为停用，同时拆成 bigram 也停用
      for (var i = 0; i < w.length - 1; i++) STOP_ZH_BIGRAM[w.slice(i, i + 2)] = true;
    });
  }
  buildStopZh();

  /* ---------------- 分词 ---------------- */

  var CJK = /[\u4e00-\u9fa5]/;

  function tokenize(text) {
    var out = {};
    if (!text) return out;
    var s = String(text).toLowerCase();

    // 英文/数字/型号：500ml、304、tws、usb-c
    var en = s.match(/[a-z0-9][a-z0-9.\-]*/g) || [];
    en.forEach(function (t) {
      var tok = t.replace(/[.\-]+$/, '');
      if (tok.length < 2) return;
      if (/^\d+$/.test(tok) && tok.length < 3) return;   // 纯数字太短，噪声大
      if (STOP_EN.indexOf(tok) >= 0) return;
      out[tok] = (out[tok] || 0) + 1;
    });

    // 中文：连续串取 bigram
    var zhRuns = s.match(/[\u4e00-\u9fa5]+/g) || [];
    zhRuns.forEach(function (run) {
      if (run.length <= 4) {
        if (run.length >= 2) out[run] = (out[run] || 0) + 1;
      }
      for (var i = 0; i < run.length - 1; i++) {
        var bg = run.slice(i, i + 2);
        if (STOP_ZH_BIGRAM[bg]) continue;
        out[bg] = (out[bg] || 0) + 1;
      }
    });

    return out;
  }

  /* ---------------- 型号 / 品类识别 ---------------- */

  /* 尺寸、功率、规格不是型号 */
  var UNIT_RE = /^\d+(\.\d+)?(x\d+(\.\d+)?)?(mm|cm|m|mw|w|v|a|mah|ghz|mhz|ch|s|k|kv|inch|in)?$/;

  /* 英文品类 → 归一化品类 */
  var TYPES = [
    [/\b(receiver|rx|elrs\s*receiver)\b/i, 'rx'],
    [/\b(camera|cam|fpv\s*cam)\b/i, 'camera'],
    [/\b(flight\s*controller|fc|aio|stack|f4\d*|f7\d*|h7\d*)\b/i, 'fc'],
    [/\b(esc|speed\s*control|blheli)\b/i, 'esc'],
    [/\b(vtx|video\s*transmitter|图传)\b/i, 'vtx'],
    [/\b(gps|gnss|compass)\b/i, 'gps'],
    [/\b(antenna|antennae)\b/i, 'ant'],
    [/\b(goggles|goggle|glasses|headset)\b/i, 'goggle'],
    [/\b(battery|batteries|lipo|li-po)\b/i, 'batt'],
    [/\b(motor|motors)\b/i, 'motor'],
    [/\b(frame|frames|机架)\b/i, 'frame'],
    [/\b(charger|charging)\b/i, 'charger'],
    [/\b(servo|servos)\b/i, 'servo'],
    [/\b(radio|transmitter|remote\s*control|tx\b)\b/i, 'tx']
  ];

  function typesOf(text) {
    var out = [];
    var s = String(text || '');
    for (var i = 0; i < TYPES.length; i++) {
      if (TYPES[i][0].test(s) && out.indexOf(TYPES[i][1]) < 0) out.push(TYPES[i][1]);
    }
    return out;
  }

  /* 提型号：带数字的字母数字串，排除尺寸功率 */
  var MODEL_STOP = {
    for: 1, the: 1, in: 1, of: 1, and: 1, with: 1, per: 1, set: 1, pack: 1,
    box: 1, size: 1, color: 1, model: 1, need: 1, want: 1, about: 1, from: 1,
    our: 1, you: 1, are: 1, can: 1, will: 1, we: 1, is: 1, to: 1, at: 1,
    on: 1, by: 1, us: 1, it: 1, as: 1, or: 1, if: 1, each: 1, only: 1,
    within: 1, usd: 1, eur: 1, gbp: 1, cny: 1, rmb: 1, days: 1, day: 1, total: 1
  };

  function modelsOf(text) {
    var out = [];
    var s = String(text || '').toLowerCase();

    /* 「词 + 小数字」组合：Ratel 2 → ratel2、Cobra X 不适用。
       以前不过滤，'for 2 people' 会造出型号 for2，导致「一个型号都没命中」→ 全量判不匹配。 */
    var pairs = s.match(/\b([a-z]{3,})[\s\-]+(\d{1,2})\b/g) || [];
    pairs.forEach(function (p) {
      var mm = p.match(/\b([a-z]{3,})[\s\-]+(\d{1,2})\b/);
      if (!mm) return;
      if (MODEL_STOP[mm[1]]) return;
      var combo = mm[1] + mm[2];
      if (out.indexOf(combo) < 0) out.push(combo);
    });

    var toks = s.match(/[a-z][a-z0-9.\-]*/g) || [];
    toks.forEach(function (raw) {
      var t = raw.replace(/[.\-]+$/, '');
      if (t.length < 3) return;
      if (!/\d/.test(t)) return;
      if (UNIT_RE.test(t)) return;
      if (/^\d+x\d+/.test(t)) return;
      var alpha = t.match(/^[a-z]+/);
      if (alpha && MODEL_STOP[alpha[0]]) return;
      var norm = t.replace(/[.\-]/g, '');
      if (norm.length < 3) return;
      if (out.indexOf(norm) < 0) out.push(norm);
    });
    return out;
  }

  function squash(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, ''); }

  /* ---------------- 商机文本解析 ---------------- */

  var CERT_LIST = ['CE', 'RoHS', 'REACH', 'FCC', 'FDA', 'LFGB', 'UL', 'ETL',
    'ISO9001', 'ISO 9001', 'ISO14001', 'BSCI', 'SGS', 'EN71', 'CPC', 'CPSIA',
    'GS', 'PSE', 'KC', 'INMETRO', 'SASO', 'EAC'];

  var COUNTRY_MAP = [
    ['美国', 'US', ['united states', 'usa', 'u.s.', 'america', '美国', '洛杉矶', 'los angeles', 'new york']],
    ['德国', 'DE', ['germany', 'german', '德国', 'hamburg', '汉堡']],
    ['英国', 'GB', ['united kingdom', 'uk', 'britain', 'england', '英国', 'london']],
    ['法国', 'FR', ['france', 'french', '法国', 'paris']],
    ['西班牙', 'ES', ['spain', 'spanish', 'españa', 'espana', '西班牙', 'madrid']],
    ['意大利', 'IT', ['italy', 'italian', '意大利', 'milan']],
    ['荷兰', 'NL', ['netherlands', 'holland', 'dutch', '荷兰', 'amsterdam']],
    ['波兰', 'PL', ['poland', 'polish', '波兰']],
    ['俄罗斯', 'RU', ['russia', 'russian', '俄罗斯', 'moscow']],
    ['巴西', 'BR', ['brazil', 'brazilian', '巴西', 'são paulo', 'sao paulo']],
    ['墨西哥', 'MX', ['mexico', 'mexican', '墨西哥']],
    ['加拿大', 'CA', ['canada', 'canadian', '加拿大', 'toronto']],
    ['澳大利亚', 'AU', ['australia', 'australian', '澳洲', '澳大利亚', 'sydney']],
    ['日本', 'JP', ['japan', 'japanese', '日本', 'tokyo']],
    ['韩国', 'KR', ['korea', 'korean', '韩国', 'seoul']],
    ['印度', 'IN', ['india', 'indian', '印度', 'mumbai']],
    ['阿联酋', 'AE', ['uae', 'dubai', 'emirates', '阿联酋', '迪拜']],
    ['沙特', 'SA', ['saudi', 'riyadh', '沙特']],
    ['土耳其', 'TR', ['turkey', 'turkish', '土耳其', 'istanbul']],
    ['越南', 'VN', ['vietnam', 'vietnamese', '越南']],
    ['泰国', 'TH', ['thailand', 'thai', '泰国']],
    ['印尼', 'ID', ['indonesia', 'indonesian', '印尼', '印度尼西亚']],
    ['南非', 'ZA', ['south africa', '南非']],
    ['尼日利亚', 'NG', ['nigeria', '尼日利亚']],
    ['埃及', 'EG', ['egypt', '埃及']],
    ['智利', 'CL', ['chile', '智利']],
    ['哥伦比亚', 'CO', ['colombia', '哥伦比亚']],
    ['秘鲁', 'PE', ['peru', '秘鲁']],
    ['阿根廷', 'AR', ['argentina', '阿根廷']],
    ['菲律宾', 'PH', ['philippines', '菲律宾']],
    ['马来西亚', 'MY', ['malaysia', '马来西亚']],
    ['新加坡', 'SG', ['singapore', '新加坡']]
  ];

  var INCOTERMS = ['EXW', 'FOB', 'CFR', 'CIF', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

  /* 英文回复里不能出现中文国名 */
  var COUNTRY_EN = {
    '美国': 'the United States', '德国': 'Germany', '英国': 'the United Kingdom',
    '法国': 'France', '西班牙': 'Spain', '意大利': 'Italy', '荷兰': 'the Netherlands',
    '波兰': 'Poland', '俄罗斯': 'Russia', '巴西': 'Brazil', '墨西哥': 'Mexico',
    '加拿大': 'Canada', '澳大利亚': 'Australia', '日本': 'Japan', '韩国': 'South Korea',
    '印度': 'India', '阿联酋': 'the UAE', '沙特': 'Saudi Arabia', '土耳其': 'Turkey',
    '越南': 'Vietnam', '泰国': 'Thailand', '印尼': 'Indonesia', '南非': 'South Africa',
    '尼日利亚': 'Nigeria', '埃及': 'Egypt', '智利': 'Chile', '哥伦比亚': 'Colombia',
    '秘鲁': 'Peru', '阿根廷': 'Argentina', '菲律宾': 'the Philippines',
    '马来西亚': 'Malaysia', '新加坡': 'Singapore'
  };

  function parse(text) {
    var s = String(text || '');
    var low = s.toLowerCase();
    var r = {
      qty: null,
      targetPriceUsd: null,
      targetCurrency: null,
      leadTimeDays: null,
      certs: [],
      incoterm: null,
      country: null,
      countryCode: null,
      unitHint: null
    };

    /* --- 数量 --- */
    /* 先认 "2K pcs" 这种缩写，否则会掉到兜底的 100 件，单价档位全错 */
    var kMatch = /([\d]+(?:\.\d+)?)\s*k\s*(?:pcs|pieces?|units?|sets?|件|个|套|只|台)/i.exec(s);
    if (kMatch) {
      var kN = parseFloat(kMatch[1]);
      if (isFinite(kN) && kN > 0 && kN < 100000) {
        r.qty = Math.round(kN * 1000);
        r.unitHint = 'pcs';
      }
    }
    var qtyPatterns = [
      /(?:quantity|qty|order|moq)\s*[:：]?\s*(?:about\s*)?([\d][\d,\s]*)\s*(pcs|pieces?|units?|sets?|pairs?|cartons?|boxes?|containers?)/i,
      /([\d][\d,]*)\s*(pcs|pieces?|units?|sets?|pairs?|cartons?|boxes?)/i,
      /(?:数量|采购量|订购量|起订量)\s*[:：]?\s*([\d][\d,\s]*)\s*(件|个|套|只|台|箱|pcs)?/i,
      /([\d][\d,]{2,})\s*(件|个|套|只|台|箱)/i
    ];
    for (var i = 0; i < qtyPatterns.length; i++) {
      if (r.qty) break;
      var m = s.match(qtyPatterns[i]);
      if (m) {
        var n = parseInt(String(m[1]).replace(/[,\s]/g, ''), 10);
        if (isFinite(n) && n > 0) {
          r.qty = n;
          r.unitHint = m[2] || null;
          break;
        }
      }
    }

    /* --- 目标价 --- */
    var fxNow = 7.1;
    try { fxNow = C.num((C.get().settings || {}).fxRate, 7.1) || 7.1; } catch (e) { fxNow = 7.1; }
    /* 人民币价必须排在美元前面：客户写「价格 50 元」时，
       下面的通用模式会把 50 当美元，结论直接从「别接」翻成「预算够」。 */
    var cnyPatterns = [
      /[¥￥]\s*([\d][\d,]*\.?\d*)/,
      /([\d][\d,]*\.?\d*)\s*(?:元|rmb|cny|人民币)/i
    ];
    for (var y = 0; y < cnyPatterns.length; y++) {
      var ym = s.match(cnyPatterns[y]);
      if (ym) {
        var yv = parseFloat(String(ym[1]).replace(/,/g, ''));
        if (isFinite(yv) && yv > 0) {
          r.targetPriceUsd = Math.round((yv / fxNow) * 100) / 100;
          r.targetCurrency = 'CNY';
          break;
        }
      }
    }
    var pricePatterns = [
      /(?:usd|us\$|us\s*\$|\$|美元)\s*([\d][\d,]*\.?\d*)/i,
      /([\d][\d,]*\.?\d*)\s*(?:usd|美元|美金)/i,
      /(?:target\s*price|目标价|价格)\s*[:：]?\s*(?:around\s*|about\s*|约\s*)?(?:usd\s*|\$)?([\d][\d,]*\.?\d*)/i
    ];
    for (var j = 0; j < pricePatterns.length; j++) {
      if (r.targetPriceUsd) break;
      var pm = s.match(pricePatterns[j]);
      if (pm) {
        var pv = parseFloat(String(pm[1]).replace(/,/g, ''));
        if (isFinite(pv) && pv > 0 && pv < 100000) {
          r.targetPriceUsd = pv;
          break;
        }
      }
    }

    /* --- 交期 --- */
    var leadPatterns = [
      /(\d+)\s*(?:-|~|to)\s*(\d+)\s*(?:days?|天|工作日)/i,
      /(?:lead\s*time|delivery|交期|交货期)\D{0,12}?(\d+)\s*(?:days?|天|工作日)?/i,
      /(\d+)\s*(?:days?|天|工作日)/i
    ];
    for (var k = 0; k < leadPatterns.length; k++) {
      var lm = s.match(leadPatterns[k]);
      if (lm) {
        var d = parseInt(lm[lm.length - 1], 10);
        if (isFinite(d) && d > 0 && d < 400) {
          r.leadTimeDays = d;
          break;
        }
      }
    }

    /* --- 认证 --- */
    CERT_LIST.forEach(function (cert) {
      var re = new RegExp('(^|[^A-Za-z0-9])' + cert.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9])', 'i');
      if (re.test(s)) {
        var norm = cert.replace(/\s+/g, '').toUpperCase();
        if (r.certs.indexOf(norm) < 0) r.certs.push(norm);
      }
    });

    /* --- 贸易术语 --- */
    for (var t = 0; t < INCOTERMS.length; t++) {
      var tre = new RegExp('\\b' + INCOTERMS[t] + '\\b', 'i');
      if (tre.test(s)) { r.incoterm = INCOTERMS[t]; break; }
    }

    /* --- 国家/市场 --- */
    /* 别名不能裸做子串匹配：'usa' 会命中 "usage"，'uk' 命中 "ukulele"，
       'peru' 命中 "perusal" —— 一旦判错国家，认证、付款条款、物流全错。
       英文别名按词边界匹配，中文别名（没空格可分）仍用包含。 */
    function aliasHit(text, alias) {
      var a = String(alias || '').trim();
      if (!a) return false;
      if (/[^\x00-\x7f]/.test(a)) return text.indexOf(a.toLowerCase()) >= 0;
      var safe = a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + safe + '([^a-z0-9]|$)', 'i').test(text);
    }
    for (var c = 0; c < COUNTRY_MAP.length; c++) {
      var name = COUNTRY_MAP[c][0];
      var code = COUNTRY_MAP[c][1];
      var aliases = COUNTRY_MAP[c][2];
      var hit = aliases.some(function (a) { return aliasHit(low, a); });
      if (hit) { r.country = name; r.countryCode = code; break; }
    }
    if (r.country) r.countryEn = COUNTRY_EN[r.country] || r.country;

    return r;
  }

  /* ---------------- 商品索引 ---------------- */

  var FIELD_WEIGHT = { title: 3.0, titleEn: 2.4, keywords: 2.6, category: 1.8, specs: 1.1 };

  function buildIndex(product) {
    var idx = {};
    function add(text, w) {
      var toks = tokenize(text);
      Object.keys(toks).forEach(function (tk) {
        if (!idx[tk] || idx[tk] < w) idx[tk] = w;
      });
    }
    add(product.title, FIELD_WEIGHT.title);
    add(product.titleEn, FIELD_WEIGHT.titleEn);
    add((product.keywords || []).join(' '), FIELD_WEIGHT.keywords);
    add(product.category, FIELD_WEIGHT.category);
    add(product.specs, FIELD_WEIGHT.specs);
    add(product.sku, 1.5);
    return idx;
  }

  function normCerts(list) {
    return (list || []).map(function (c) {
      return String(c).replace(/\s+/g, '').toUpperCase();
    }).filter(Boolean);
  }

  /**
   * 给单条商品打分
   */
  function scoreProduct(product, textTokens, parsed) {
    var idx = buildIndex(product);
    var reasons = [];
    var raw = 0;
    var hitTokens = [];

    Object.keys(textTokens).forEach(function (tk) {
      var w = idx[tk];
      if (w) {
        raw += w;
        hitTokens.push({ token: tk, weight: w });
      }
    });

    hitTokens.sort(function (a, b) { return b.weight - a.weight; });
    reasons = hitTokens.slice(0, 6).map(function (h) { return h.token; });

    // 平滑归一化到 0~100
    var score = 100 * (1 - Math.exp(-raw / 7.5));

    /* --- 型号命中：最强信号 --- */
    var pText = squash(product.title + ' ' + (product.titleEn || '') + ' ' + (product.keywords || []).join(' ') + ' ' + product.sku);
    var inqModels = parsed.models || [];
    var modelHits = [];
    if (inqModels.length) {
      inqModels.forEach(function (m) {
        if (pText.indexOf(m) >= 0) modelHits.push(m);
      });
      if (modelHits.length) {
        score = Math.min(100, score + 28 + Math.min(10, (modelHits.length - 1) * 5));
        reasons = modelHits.concat(reasons).slice(0, 6);
      } else {
        score *= 0.35;
      }
    }

    /* --- 品类命中 --- */
    var pTypes = typesOf(product.title + ' ' + (product.titleEn || '') + ' ' + (product.keywords || []).join(' ') + ' ' + product.category);
    var inqTypes = parsed.types || [];
    var typeHit = false;
    if (inqTypes.length) {
      typeHit = inqTypes.some(function (t) { return pTypes.indexOf(t) >= 0; });
      if (typeHit) score = Math.min(100, score + 12);
      else score *= 0.45;
    }

    /* --- 硬条件检查 --- */
    var gaps = [];
    var hardFail = false;

    var needCerts = normCerts(parsed.certs);
    var haveCerts = normCerts(product.certs);
    var missCerts = needCerts.filter(function (c) { return haveCerts.indexOf(c) < 0; });
    if (missCerts.length) {
      gaps.push('缺认证：' + missCerts.join(' / '));
    }

    if (parsed.qty && product.moq && parsed.qty < product.moq) {
      gaps.push('起订量 ' + product.moq + ' > 需求 ' + parsed.qty);
      hardFail = true;
    }

    if (parsed.leadTimeDays && product.leadTimeDays && parsed.leadTimeDays < product.leadTimeDays) {
      gaps.push('交期：需 ' + parsed.leadTimeDays + ' 天 / 供 ' + product.leadTimeDays + ' 天');
    }

    // 缺口扣分
    score = Math.max(0, score - gaps.length * 11);
    /* 认证只记为缺口，不判死：后台认证数据本身是空的，拿空数据判死会误伤全部商品 */

    /* 询盘有型号但整条商品对不上 → 判为不可靠。
       只拿「像型号」的串当依据（含两位以上数字或长度 ≥5），
       否则 "size 2" / "for 2" 这类词会把所有商品判死。 */
    var solidModels = inqModels.filter(function (mm) { return /\d{2,}/.test(mm) || mm.length >= 5; });
    if (solidModels.length && !modelHits.length) hardFail = true;
    if (inqTypes.length && !typeHit) hardFail = true;

    return {
      productId: product.id,
      score: Math.max(0, Math.round(score)),
      reasons: reasons,
      gaps: gaps,
      hardFail: hardFail,
      modelHit: modelHits.length > 0,
      model: modelHits[0] || '',
      typeHit: typeHit,
      quotable: C.num(product.costRmb) > 0
    };
  }

  /**
   * 给整条商机排序
   */
  function rank(opp, products) {
    var text = opp.rawText || '';
    var tokens = tokenize(text);
    var parsed = parse(text);
    parsed.models = modelsOf(text);

    /* 只有在库里确实存在这个品类时，品类才作为约束 */
    var allTypes = typesOf((products || []).map(function (p) {
      return (p.title || '') + ' ' + (p.titleEn || '') + ' ' + (p.category || '');
    }).join(' '));
    parsed.types = typesOf(text).filter(function (t) { return allTypes.indexOf(t) >= 0; });

    var results = (products || []).map(function (p) {
      return scoreProduct(p, tokens, parsed);
    });

    /* 可报价只是小加分，不能盖过匹配质量 */
    results.forEach(function (r) {
      if (r.quotable) r.score = Math.min(100, r.score + 4);
      if (!r.quotable) r.score = Math.max(0, r.score - 2);
    });

    results.sort(function (a, b) {
      if (a.hardFail !== b.hardFail) return a.hardFail ? 1 : -1;
      if (a.modelHit !== b.modelHit) return a.modelHit ? -1 : 1;
      return b.score - a.score;
    });

    return { parsed: parsed, matches: results };
  }

  /* 从历史成交中位数估算市场可接受加价率 */
  function marketMarkupFromHistory(opps, products) {
    var vals = [];
    (opps || []).forEach(function (o) {
      if (o.status !== 'won' || !o.deal || !o.deal.finalAmountUsd) return;
      var p = (products || []).find(function (x) { return x.id === o.selectedProductId; });
      if (!p || !p.priceUsd || !o.quote || !o.quote.qty) return;
      var unit = o.deal.finalAmountUsd / o.quote.qty;
      var m = unit / p.priceUsd - 1;
      if (isFinite(m) && m > -0.9 && m < 3) vals.push(m);
    });
    if (vals.length < 2) return null;
    vals.sort(function (a, b) { return a - b; });
    var mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }

  window.Matching = {
    tokenize: tokenize,
    parse: parse,
    rank: rank,
    modelsOf: modelsOf,
    typesOf: typesOf,
    scoreProduct: scoreProduct,
    marketMarkupFromHistory: marketMarkupFromHistory
  };
})();
