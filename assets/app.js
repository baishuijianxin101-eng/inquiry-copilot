/* ===========================================================
   app.js — 界面与流程
   =========================================================== */
(function () {
  'use strict';

  var C = window.Core;
  var P = window.Pricing;
  var M = window.Matching;
  var R = window.Reply;
  var W = window.Workflow;

  var esc = C.esc;

  /* P1-23 全站框架导航：八大模块。desk=询盘中心内的决策台、review=商品与报价内的补成本、
     settings=同步与设置内的系统设置，均保留原路由与功能，仅调整归属呈现。 */
  var NAV = [
    { key: 'dashboard', label: '工作台', icon: '◱' },
    { key: 'opps', label: '询盘中心', icon: '✉' },
    { key: 'desk', label: '决策台', icon: '🧭' },
    { key: 'customers', label: '客户中心', icon: '☷' },
    { key: 'analysis', label: '销售分析', icon: '◎' },
    { key: 'catalog', label: '商品与报价', icon: '▤' },
    { key: 'review', label: '补成本', icon: '¥' },
    { key: 'followups', label: '跟进管理', icon: '↻' },
    { key: 'analytics', label: '经营分析', icon: '◔' },
    { key: 'sync', label: '同步与设置', icon: '⚙' }
  ];

  var STATUS = {
    new: { label: '待处理', cls: 'new' },
    matched: { label: '已匹配', cls: 'matched' },
    quoted: { label: '已报价', cls: 'quoted' },
    won: { label: '已成交', cls: 'won' },
    lost: { label: '已丢单', cls: 'lost' }
  };

  /* 搜索防抖：打字时不要每次都重画 238 行 */
  var searchTimer = null;
  function debounceSearch(fn) {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(fn, 120);
  }

  var S = { tab: 'en', cache: {}, scoreCache: {}, catQ: '', catOnlyEmpty: false, revQ: '', revOnlyPending: true,
    bulkFactor: 1, bulkUndo: [],
    catType: '',
    oppQ: '', oppCountry: '', oppType: '', oppTier: '', oppStatus: '',
    oppSort: 'default', oppTodoOnly: false, oppOverdueOnly: false, replyScenario: 'auto',
    oppLang: 'zh', oppTextZh: null, oppId: '', dataView: 'real' };
  /* 数据视图偏好单独存，不进业务数据：切换视图永远不改动商机本身 */
  try { var dvPref = localStorage.getItem('ic_data_view'); if (dvPref === 'demo' || dvPref === 'real') S.dataView = dvPref; } catch (e) {}
  var toastTimer = null;

  /* =========================================================
     基础工具
     ========================================================= */

  function st() { return C.get(); }

  function productById(id) {
    return st().products.find(function (p) { return p.id === id; }) || null;
  }

  function oppById(id) {
    return st().opportunities.find(function (o) { return o.id === id; }) || null;
  }

  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function openModal(html, wide) {
    document.getElementById('modal-root').innerHTML =
      '<div class="modal-mask" data-mask="1"><div class="modal' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
  }

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  function modalHead(title) {
    return '<div class="modal-hd"><div class="modal-title">' + esc(title) +
      '</div><button class="icon-btn" data-action="close-modal" aria-label="关闭">×</button></div>';
  }

  function badge(status) {
    var s = STATUS[status] || STATUS.new;
    return '<span class="badge ' + s.cls + '">' + s.label + '</span>';
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('已复制到剪贴板');
      }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); }
    catch (e) { toast('复制失败，请手动选中'); }
    document.body.removeChild(ta);
  }

  function invalidate() { S.cache = {}; S.scoreCache = {}; }

  /* =========================================================
     商机分析
     ========================================================= */

  function cacheKey(opp) {
    return opp.id + '|' + (opp.rawText || '').length + '|' + st().products.length +
      '|' + st().products.map(function (p) { return p.id; }).join(',');
  }

  function analyzeOpp(opp) {
    var k = cacheKey(opp);
    if (S.cache[k]) return S.cache[k];
    var res = M.rank(opp, st().products);
    res.ordered = res.matches.map(function (m) {
      return { match: m, product: productById(m.productId) };
    }).filter(function (x) { return !!x.product; });
    S.cache[k] = res;
    return res;
  }

  /* =========================================================
     阶段一：询盘解析结果（结构化展示 / 人工修正 / 待确认问题）

     口径：Matching.parse 是主解析（匹配、报价都在用，不动它）；
     P0Parse 补商品名、用途、规格、目的地与原文证据；
     opp.parseEdits 是人工修正层，只覆盖解析展示与待确认问题，
     其中数量/市场/交期/术语在保存时同步写回 quote/buyer 的真实字段。
     ========================================================= */

  function effectiveParsed(opp, a) {
    var mp = (a && a.parsed) || {};
    var p0 = null;
    try { p0 = window.P0Parse ? window.P0Parse.extract(opp.rawText || '') : null; } catch (e) { p0 = null; }
    var f = (p0 && p0.fields) || {};
    var eff = {
      productName: f.productName || '',
      purpose: f.purpose || '',
      qty: mp.qty || f.qty || 0,
      targetPriceUsd: mp.targetPriceUsd || f.targetPriceUsd || 0,
      country: mp.country || opp.buyer.country || '',
      destination: f.destination || '',
      leadTimeDays: mp.leadTimeDays || f.deadlineDays || 0,
      deadlineText: f.deadlineText || '',
      certs: (mp.certs && mp.certs.length ? mp.certs : f.certs) || [],
      incoterm: mp.incoterm || f.incoterm || '',
      models: mp.models || f.models || [],
      types: mp.types || [],
      specs: f.specs || [],
      specsText: '',
      productText: f.productText || '',
      evidence: (p0 && p0.evidence) || {},
      edited: {}
    };
    var ed = opp.parseEdits || {};
    Object.keys(ed).forEach(function (k) { eff.edited[k] = true; });
    if (ed.productName) eff.productName = ed.productName;
    if (ed.purpose) eff.purpose = ed.purpose;
    if (ed.qty) eff.qty = ed.qty;
    if (ed.targetPriceUsd) eff.targetPriceUsd = ed.targetPriceUsd;
    if (ed.country) eff.country = ed.country;
    if (ed.destination) eff.destination = ed.destination;
    if (ed.leadTimeDays) eff.leadTimeDays = ed.leadTimeDays;
    if (ed.incoterm) eff.incoterm = ed.incoterm;
    if (ed.certsText) eff.certs = ed.certsText.split(/[,，/、\s]+/).filter(Boolean);
    if (ed.modelsText) eff.models = ed.modelsText.split(/[,，、\s]+/).filter(Boolean);
    if (ed.specsText) eff.specsText = ed.specsText;
    return eff;
  }

  /* 缺什么就问什么：问题给买家看的英文 + 给卖家看的中文，
     只生成清单供人工复制发送，系统不自动发任何消息 */
  function followQuestions(eff) {
    var q = [];
    if (!eff.productName && !eff.models.length) q.push({ must: true, zh: '确认具体商品 / 型号', en: 'Could you please share the exact product name or model number (a product photo would also help), so we can quote the right item?' });
    if (!eff.qty) q.push({ must: true, zh: '确认采购数量', en: 'What quantity do you need for this order?' });
    if (!eff.country && !eff.destination) q.push({ must: true, zh: '确认目的国 / 目的港', en: 'Which country and port should we ship the goods to?' });
    if (!eff.leadTimeDays && !eff.deadlineText) q.push({ must: false, zh: '确认期望交期', en: 'When do you need the goods to be delivered?' });
    if (!eff.certs.length) q.push({ must: false, zh: '确认认证要求', en: 'Do you need any certificates for your market, such as CE or RoHS?' });
    if (!eff.purpose) q.push({ must: false, zh: '确认用途 / 销售渠道', en: 'May I know the end use or sales channel (retail, online selling, promotion, etc.)? It helps us recommend the right option and packing.' });
    if (!eff.targetPriceUsd) q.push({ must: false, zh: '试探目标价位', en: 'Do you have a target price range in mind for this product?' });
    return q;
  }

  function parseCard(opp, a, effIn) {
    var eff = effIn || effectiveParsed(opp, a);
    function row(label, value, editKey, evKey) {
      var v = value
        ? '<span class="pv-val">' + esc(value) + '</span>' + (editKey && eff.edited[editKey] ? ' <span class="badge amber">已修正</span>' : '')
        : '<span class="pv-none">未识别</span>';
      var ev = evKey && eff.evidence[evKey]
        ? '<div class="pv-ev">原文：' + esc(eff.evidence[evKey]) + '</div>' : '';
      return '<div class="pv-row"><div class="pv-label">' + label + '</div>' +
        '<div class="pv-main">' + v + ev + '</div></div>';
    }
    var specsText = eff.specs.map(function (s) { return s.name + ' ' + s.value; }).join('；');
    if (eff.specsText) specsText = specsText ? specsText + '；' + eff.specsText : eff.specsText;
    var rows =
      row('商品名称', eff.productName, 'productName', 'productName') +
      row('型号', eff.models.join(' / '), 'modelsText', 'model') +
      row('品类', eff.types.join(' / '), '', '') +
      row('数量', eff.qty ? eff.qty.toLocaleString() + ' pcs' : '', 'qty', 'qty') +
      row('目标价', eff.targetPriceUsd ? C.usd(eff.targetPriceUsd) : '', 'targetPriceUsd', 'targetPriceUsd') +
      row('目标市场', eff.country, 'country', '') +
      row('目的地', eff.destination, 'destination', 'destination') +
      row('交期', eff.leadTimeDays ? eff.leadTimeDays + ' 天' : (eff.deadlineText || ''), 'leadTimeDays', 'deadlineDays') +
      row('贸易术语', eff.incoterm, 'incoterm', 'incoterm') +
      row('认证', eff.certs.join(' / '), 'certsText', '') +
      row('规格', specsText, 'specsText', '') +
      row('用途', eff.purpose, 'purpose', 'purpose');

    var qs = followQuestions(eff);
    var qHtml = '';
    if (qs.length) {
      qHtml = '<div class="pv-questions"><div class="pv-q-title">需要向买家确认（' + qs.length + ' 项）</div>' +
        qs.map(function (x) {
          return '<div class="pv-q"><span class="badge ' + (x.must ? 'red' : 'gray') + '">' +
            (x.must ? '必问' : '可选') + '</span><div><div>' + esc(x.zh) + '</div>' +
            '<div class="pv-q-en">' + esc(x.en) + '</div></div></div>';
        }).join('') +
        '<div class="row" style="margin-top:10px"><button class="btn sm" data-action="copy-questions" data-id="' + safeActionId(opp.id) + '">复制全部问题（英文）</button>' +
        '<span class="card-sub">复制后由你粘贴到阿里后台发送，系统不会自动发消息</span></div></div>';
    } else {
      qHtml = '<div class="pv-questions"><span class="badge green">信息完整</span> <span style="font-size:12px;color:var(--ink-2)">关键字段都识别到了，没有必须向买家补问的项。</span></div>';
    }

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">解析结果<span class="card-sub">自动识别 + 原文证据，识别错了可以修正</span></div>' +
      '<button class="btn sm" data-action="edit-parsed" data-id="' + safeActionId(opp.id) + '">修正解析</button></div>' +
      '<div class="card-bd"><div class="pv-grid">' + rows + '</div>' + qHtml + '</div></section>';
  }

  function openEditParsed(id) {
    var opp = oppById(id);
    if (!opp) return;
    var eff = effectiveParsed(opp, analyzeOpp(opp));
    function fld(label, inputHtml, hint) {
      return '<div class="field"><label>' + label + '</label>' + inputHtml +
        (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
    }
    function txt(idAttr, val, ph) {
      return '<input type="text" id="' + idAttr + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">';
    }
    function numI(idAttr, val, ph) {
      return '<input type="number" min="0" step="any" id="' + idAttr + '" value="' + (val || '') + '" placeholder="' + esc(ph || '') + '">';
    }
    var html = modalHead('修正解析结果') +
      '<div class="modal-bd">' +
      '<div class="alert info" style="margin-bottom:12px"><span class="ic">i</span><div>' +
      '只改识别错的字段就行，<strong>留空 = 恢复自动识别</strong>。数量、市场、交期、术语保存时会同步到报价与买家信息；其余字段用于解析展示和待确认问题。</div></div>' +
      '<div class="form-grid">' +
      fld('商品名称', txt('pp-name', eff.productName, '如 TWS bluetooth earbuds')) +
      fld('型号（多个用 / 分开）', txt('pp-models', eff.models.join(' / '), '如 ES900')) +
      fld('数量 (pcs)', numI('pp-qty', eff.qty)) +
      fld('目标价 (USD)', numI('pp-price', eff.targetPriceUsd)) +
      fld('目标市场 / 国家', txt('pp-country', eff.country, '如 德国')) +
      fld('目的地 / 港口', txt('pp-dest', eff.destination, '如 Hamburg')) +
      fld('交期（天）', numI('pp-lead', eff.leadTimeDays)) +
      fld('贸易术语', txt('pp-incoterm', eff.incoterm, '如 FOB / CIF')) +
      fld('认证（多个用 / 分开）', txt('pp-certs', eff.certs.join(' / '), '如 CE / RoHS')) +
      fld('用途 / 销售渠道', txt('pp-purpose', eff.purpose, '如 零售转售 / 电商销售 / 自用')) +
      '<div class="field full"><label>规格补充</label>' +
      '<input type="text" id="pp-specs" value="' + esc(eff.specsText || '') + '" placeholder="自动识别的规格会照常显示，这里只填要补充的，如 壳体颜色：曜石黑"></div>' +
      '</div></div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-parsed" data-id="' + safeActionId(opp.id) + '">保存修正</button>' +
      '</div>';
    openModal(html, true);
  }

  function saveParsed(id) {
    var opp = oppById(id);
    if (!opp) return;
    function v(attr) { var el = document.getElementById(attr); return el ? el.value.trim() : ''; }
    function n(attr) { var x = parseFloat(v(attr)); return isFinite(x) && x > 0 ? x : 0; }
    var ed = {};
    if (v('pp-name')) ed.productName = v('pp-name');
    if (v('pp-models')) ed.modelsText = v('pp-models');
    if (n('pp-qty')) ed.qty = Math.round(n('pp-qty'));
    if (n('pp-price')) ed.targetPriceUsd = Math.round(n('pp-price') * 100) / 100;
    if (v('pp-country')) ed.country = v('pp-country');
    if (v('pp-dest')) ed.destination = v('pp-dest');
    if (n('pp-lead')) ed.leadTimeDays = Math.round(n('pp-lead'));
    if (v('pp-incoterm')) ed.incoterm = v('pp-incoterm').toUpperCase();
    if (v('pp-certs')) ed.certsText = v('pp-certs');
    if (v('pp-purpose')) ed.purpose = v('pp-purpose');
    if (v('pp-specs')) ed.specsText = v('pp-specs');
    opp.parseEdits = ed;
    /* 有真实落点的字段同步写回，避免解析卡和报价口径各说各话 */
    if (ed.qty) opp.quote.qty = ed.qty;
    if (ed.country) opp.buyer.country = ed.country;
    if (ed.leadTimeDays) opp.quote.leadTimeDays = ed.leadTimeDays;
    if (ed.incoterm) opp.quote.incoterm = ed.incoterm;
    C.addLog(opp, '人工修正解析结果' + (Object.keys(ed).length ? '：' + Object.keys(ed).join('、') : '（全部恢复自动识别）'));
    closeModal();
    invalidate();
    C.persist();
    render();
    toast(Object.keys(ed).length ? '解析修正已保存' : '已恢复自动识别');
  }

  /* =========================================================
     P1-22 第一阶段：客户销售判断（SalesAnalysis）
     分析 = 规则型结构化分析（原文+有效解析+系统记录），实时重算不落库；
     人工修正只写 opp.salesReview 覆盖层，与 AI 结果分开保存、互不覆盖。
     ========================================================= */

  function salesInputFor(opp, a, effP) {
    var p0 = null;
    try { p0 = window.P0Parse ? window.P0Parse.extract(opp.rawText || '') : null; } catch (e) { p0 = null; }
    var mentions = (p0 && p0.fields && p0.fields.certMentions) || [];
    var conflict = mentions.filter(function (m) { return m.conflict; })[0] || null;
    var top = (a && a.ordered && a.ordered[0]) ? a.ordered[0].product : null;
    var all = st().opps || [];
    var sameBuyer = (opp.buyer && opp.buyer.name) ? all.filter(function (o) { return o.id !== opp.id && o.buyer && o.buyer.name && o.buyer.name.toLowerCase() === opp.buyer.name.toLowerCase(); }).length : 0;
    var eff = Object.assign({}, effP, { unrecognizedCerts: (p0 && p0.fields && p0.fields.unrecognizedCertMentions || []).map(function (m) { return m.name; }) });
    return {
      rawText: opp.rawText || '', eff: eff,
      buyerName: (opp.buyer && opp.buyer.name) || '',
      isRepeat: sameBuyer > 0,
      hasPriorOrders: ((st().orders || []).filter(function (o) { return o.oppId === opp.id; }).length > 0),
      certConflict: !!conflict, certConflictText: conflict ? conflict.evidence.map(function (e2) { return e2.snippet; }).join(' ／ ') : '',
      productName: top ? (top.name || top.title || '') : null,
      productCerts: top && Array.isArray(top.certs) ? top.certs : null,
      productMoq: top ? (top.moq || 0) : 0
    };
  }

  function saChip(status) {
    var map = { stated: ['明确', '#0f9d58'], inferred: ['推断', '#b07d10'], missing: ['未提供', '#9aa0a6'], conflict: ['冲突', '#d93025'], confirmed: ['人工确认', '#7b1fa2'] };
    var m = map[status] || [status, '#666'];
    return '<span style="font-size:11px;color:#fff;background:' + m[1] + ';border-radius:8px;padding:1px 7px;white-space:nowrap">' + m[0] + '</span>';
  }
  function saLevelChip(level) {
    var c = level === '明确关注' ? '#d93025' : (level === '可能关注' ? '#b07d10' : '#9aa0a6');
    return '<span style="font-size:11px;color:#fff;background:' + c + ';border-radius:8px;padding:1px 7px;white-space:nowrap">' + level + '</span>';
  }

  function salesCard(opp, a, effP) {
    if (!window.SalesAnalysis) return '';
    var disp = window.SalesAnalysis.applyReview(window.SalesAnalysis.analyze(salesInputFor(opp, a, effP)), opp.salesReview);
    var needRows = disp.needs.map(function (n) {
      return '<tr><td style="white-space:nowrap;color:#5f6368">' + esc(n.label) + '</td>' +
        '<td>' + (n.value ? esc(n.value) : '<span style="color:#9aa0a6">尚未提供</span>') +
        (n.flagged ? ' <span style="color:#d93025;font-size:11px">（员工标记不准确）</span>' : '') +
        (n.evidence ? '<div style="font-size:11.5px;color:#8a919e">依据：' + esc(n.evidence) + '</div>' : '') + '</td>' +
        '<td>' + saChip(n.status) + '</td></tr>';
    }).join('');
    var concernRows = disp.concerns.map(function (c) {
      return '<div class="row" style="gap:8px;align-items:flex-start"><span style="min-width:74px;color:#5f6368">' + esc(c.topic) + '</span>' + saLevelChip(c.level) +
        '<span style="font-size:12.5px">' + esc(c.evidence) + '</span></div>';
    }).join('');
    var stepRows = disp.steps.map(function (s, i) {
      return '<div style="margin-bottom:6px"><b>' + (i + 1) + '.</b> ' + esc(s.action) + '<div style="font-size:12px;color:#8a919e">为什么：' + esc(s.why) + '</div></div>';
    }).join('');
    var body = '<div class="stack" style="gap:12px">' +
      '<div style="background:#f6f9ff;border:1px solid #d7e3fc;border-radius:10px;padding:10px 12px">' +
      '<div style="font-size:15px"><b>采购阶段：' + esc(disp.stage.label) + '</b>' + (disp.stage.confirmed ? ' ' + saChip('confirmed') : '') + (disp.stage.flagged ? ' <span style="color:#d93025;font-size:11px">员工标记不准确</span>' : '') + '</div>' +
      (disp.stage.evidence.length ? '<div style="font-size:12.5px;color:#5f6368;margin-top:4px">证据：' + disp.stage.evidence.map(esc).join('；') + '</div>' : '') +
      '<div style="font-size:12.5px;color:#b07d10;margin-top:2px">不确定性：' + esc(disp.stage.uncertainty) + '</div></div>' +
      '<div><div style="font-weight:600;margin-bottom:6px">客户需求理解</div><table class="table"><tbody>' + needRows + '</tbody></table></div>' +
      '<div><div style="font-weight:600;margin-bottom:6px">客户关注点与潜在顾虑</div><div class="stack" style="gap:6px">' + concernRows + '</div></div>' +
      '<div><div style="font-weight:600;margin-bottom:6px">下一步销售建议</div>' + stepRows + '</div>' +
      '<div style="font-size:11.5px;color:#8a919e">' + esc(disp.capabilityNote) + (disp.hasReview ? ' 本页含员工人工确认内容（紫色标记），与系统分析分开保存。' : '') + '</div>' +
      '</div>';
    var sid = safeActionId(opp.id);
    return card('客户销售判断', '帮你快速看懂客户要什么、在哪一步、下一步做什么', body,
      sid ? '<button class="btn sm ghost" data-action="sales-edit" data-id="' + sid + '">修正判断</button>'
        : '<span style="font-size:12px;color:#b91c1c">商机 ID 异常，已禁用修正入口</span>');
  }

  function openSalesEdit(id) {
    var opp = oppById(id);
    if (!opp || !window.SalesAnalysis) return;
    var a = analyzeOpp(opp);
    var base = window.SalesAnalysis.analyze(salesInputFor(opp, a, effectiveParsed(opp, a)));
    var r = opp.salesReview || {};
    var needFields = [['product', '产品'], ['specs', '规格参数'], ['qty', '数量'], ['purpose', '用途'], ['certs', '认证要求'], ['delivery', '交货时间'], ['destination', '目的地'], ['targetPrice', '目标价']];
    var byKey = {}; base.needs.forEach(function (n) { byKey[n.key] = n; });
    var rows = needFields.map(function (f) {
      var fix = (r.needFix || {})[f[0]];
      return '<tr><td style="white-space:nowrap">' + f[1] + '</td>' +
        '<td><input id="sa-n-' + f[0] + '" value="' + esc(fix ? fix.value : '') + '" placeholder="' + esc(byKey[f[0]] ? (byKey[f[0]].value || '（未识别）') : '') + '" style="width:100%"></td>' +
        '<td><label style="font-size:12px"><input type="checkbox" id="sa-f-' + f[0] + '"' + ((r.flagged || []).indexOf('need:' + f[0]) >= 0 ? ' checked' : '') + '> 标记不准确</label></td></tr>';
    }).join('');
    var stageOpts = [''].concat(window.SalesAnalysis.STAGES).map(function (s) {
      return '<option value="' + esc(s) + '"' + ((r.stageFix || '') === s ? ' selected' : '') + '>' + (s || '（保持系统判断）') + '</option>';
    }).join('');
    var concernRows = base.concerns.map(function (c, i) {
      var f = (r.concernFix || {})[c.topic] || '';
      return '<tr><td>' + esc(c.topic) + '（系统：' + esc(c.level) + '）</td><td><select id="sa-c-' + i + '" data-topic="' + esc(c.topic) + '">' +
        '<option value=""' + (!f ? ' selected' : '') + '>保持系统判断</option>' +
        '<option value="confirmed"' + (f === 'confirmed' ? ' selected' : '') + '>确认：客户确实关注</option>' +
        '<option value="dismissed"' + (f === 'dismissed' ? ' selected' : '') + '>客户并不关注</option></select></td></tr>';
    }).join('');
    openModal(modalHead('修正客户销售判断') +
      '<div class="stack" style="gap:10px"><div style="font-size:12.5px;color:#8a919e">这里保存的是员工人工确认，与系统分析分开存放、互不覆盖；留空表示沿用系统判断。</div>' +
      '<table class="table"><tbody>' + rows + '</tbody></table>' +
      '<table class="table"><tbody>' + concernRows + '</tbody></table>' +
      '<div class="row" style="gap:10px;align-items:center"><span>采购阶段</span><select id="sa-stage">' + stageOpts + '</select>' +
      '<label style="font-size:12px"><input type="checkbox" id="sa-f-stage"' + ((r.flagged || []).indexOf('stage') >= 0 ? ' checked' : '') + '> 标记阶段判断不准确</label></div>' +
      '<div class="row">' + (safeActionId(opp.id)
        ? '<button class="btn primary" data-action="sales-save" data-id="' + safeActionId(opp.id) + '">保存人工确认</button>'
        : '<span style="font-size:12px;color:#b91c1c">商机 ID 异常，已禁用保存</span>') +
      '<button class="btn ghost" data-action="close-modal">取消</button></div></div>', true);
  }

  function saveSalesEdit(id) {
    var opp = oppById(id);
    if (!opp) return;
    function v(i) { var el = document.getElementById(i); return el ? String(el.value || '').trim() : ''; }
    function ck(i) { var el = document.getElementById(i); return !!(el && el.checked); }
    var needFix = {}, flagged = [];
    ['product', 'specs', 'qty', 'purpose', 'certs', 'delivery', 'destination', 'targetPrice'].forEach(function (k) {
      if (v('sa-n-' + k)) needFix[k] = { value: v('sa-n-' + k), at: new Date().toISOString().slice(0, 10) };
      if (ck('sa-f-' + k)) flagged.push('need:' + k);
    });
    if (ck('sa-f-stage')) flagged.push('stage');
    var concernFix = {};
    var a = analyzeOpp(opp);
    var base = window.SalesAnalysis.analyze(salesInputFor(opp, a, effectiveParsed(opp, a)));
    base.concerns.forEach(function (c, i) {
      var sel = document.getElementById('sa-c-' + i);
      if (sel && sel.value) concernFix[c.topic] = sel.value;
    });
    var review = {};
    if (Object.keys(needFix).length) review.needFix = needFix;
    if (v('sa-stage')) review.stageFix = v('sa-stage');
    if (Object.keys(concernFix).length) review.concernFix = concernFix;
    if (flagged.length) review.flagged = flagged;
    if (Object.keys(review).length) { review.at = new Date().toISOString().slice(0, 10); opp.salesReview = review; }
    else delete opp.salesReview;
    C.addLog(opp, '人工修正客户销售判断' + (Object.keys(review).length ? '' : '（已清空，恢复系统判断）'));
    closeModal();
    C.persist();
    /* R3-08（第五节）：成功提示必须在落盘确认之后。落盘失败时 Core 已回滚内存，
       这里只给失败提示并按真实状态重渲染，绝不显示成功。 */
    if (C.persistOk && !C.persistOk()) {
      invalidate(); render();
      toast('保存失败：人工修正未能写入，已回滚到上次保存的状态');
      return;
    }
    render();
    toast(Object.keys(review).length ? '人工确认已保存（与系统分析分开）' : '已恢复系统判断');
  }

  /* =========================================================
     阶段三：商机价值判断（OppScore）

     评分输入 = 有效解析（人工修正优先）+ SmartMatch 结果 + 商机自身进展，
     每次渲染实时重算：解析被修正、选品变化后分数自动更新。
     人工判断（valueNote）只改「有效优先级」的展示与排序，不改系统原始分。
     ========================================================= */

  function scoreForOpp(o) {
    if (!window.OppScore || !window.SmartMatch) return null;
    var key = o.id + '|' + (o.updatedAt || '') + '|' + (o.selectedProductId || '');
    if (S.scoreCache[key]) return S.scoreCache[key];
    var a = analyzeOpp(o);
    var eff = effectiveParsed(o, a);
    var pool = a.ordered.slice(0, 10);
    if (o.selectedProductId && !pool.some(function (x) { return x.product.id === o.selectedProductId; })) {
      var sp = productById(o.selectedProductId);
      if (sp) pool.push({ product: sp, match: null });
    }
    var ranked = window.SmartMatch.rank(eff, o.rawText || '', pool);
    var pick = null;
    if (o.selectedProductId) ranked.forEach(function (x) { if (x.product.id === o.selectedProductId) pick = x; });
    if (!pick) pick = ranked[0] || null;
    var res = window.OppScore.score({
      opp: o, eff: eff,
      match: pick ? { score: pick.result.score, keyConflict: pick.result.keyConflict } : null,
      matchLabel: pick ? (o.selectedProductId === pick.product.id ? '已选商品' : '最佳候选') : '',
      moq: pick ? (pick.product.moq || 0) : 0
    });
    res.eff = eff;
    res.pick = pick;
    S.scoreCache[key] = res;
    return res;
  }

  /* 有效优先级：人工标了重点/搁置就按人工的来，并明确标注是人工判断 */
  function effLevelOf(o, res) {
    if (!res || res.level === 'closed') return { level: res ? res.level : 'low', label: res ? res.levelLabel : '', manual: false };
    var v = o.valueNote && o.valueNote.verdict;
    if (v === 'focus') return { level: 'high', label: '高优先级', manual: true };
    if (v === 'defer') return { level: 'low', label: '低优先级', manual: true };
    return { level: res.level, label: res.levelLabel, manual: false };
  }

  function oppScoreCard(opp) {
    var res = scoreForOpp(opp);
    if (!res) return '';
    var el = effLevelOf(opp, res);
    var badgeCls = el.level === 'high' ? 'red' : el.level === 'mid' ? 'amber' : 'gray';
    var dims = res.dims.map(function (d) {
      var pct = d.max ? Math.round(d.score / d.max * 100) : 0;
      return '<div class="os-dim"><div class="os-dim-hd"><span>' + d.label + '</span>' +
        '<b>' + d.score + ' / ' + d.max + '</b></div>' +
        '<div class="os-bar"><div style="width:' + pct + '%"></div></div>' +
        '<div class="os-why">' + d.reasons.map(esc).join('；') + '</div></div>';
    }).join('');
    var changes = res.changeFactors.length
      ? '<div class="os-sec"><div class="os-sec-t">哪些信息可能改变评分</div>' +
        res.changeFactors.map(function (c) {
          return '<div class="os-change">' + esc(c.text) + '<span>' + esc(c.gain) + '</span></div>';
        }).join('') + '</div>'
      : '';
    var qCount = followQuestions(res.eff).length;
    var vn = opp.valueNote || {};
    var vnText = vn.verdict
      ? '<div style="font-size:12px;color:var(--ink-2);margin-top:6px">你的人工判断：<b>' +
        ({ focus: '重点跟进', normal: '正常跟进', defer: '暂时搁置' })[vn.verdict] + '</b>' +
        (vn.note ? ' · ' + esc(vn.note) : '') +
        (vn.at ? ' <span style="color:var(--ink-3)">' + C.fmtDate(vn.at, true) + '</span>' : '') + '</div>'
      : '';
    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">价值判断<span class="card-sub">规则评分，代表处理优先级，不是成交概率</span></div>' +
      '<span class="badge ' + badgeCls + '">' + el.label + ' · ' + res.total + ' 分' + (el.manual ? '（人工）' : '') + '</span></div>' +
      '<div class="card-bd">' +
      '<div class="os-action"><div><b>推荐下一步：</b>' + esc(res.action) + '</div>' +
      '<div style="margin-top:4px"><b>为什么现在处理：</b>' + esc(res.whyNow) + '</div>' +
      (qCount ? '<div style="margin-top:4px">还有 ' + qCount + ' 个待确认问题，清单在下方「解析结果」卡里，可一键复制发给买家。</div>' : '') +
      '</div>' +
      '<div class="os-grid">' + dims + '</div>' +
      changes +
      '<div class="os-sec"><div class="os-sec-t">记录人工判断</div>' +
      '<div class="row" style="gap:8px">' +
      '<select id="vn-verdict" style="width:150px;flex:none">' +
      '<option value="">按系统评分</option>' +
      ['focus', 'normal', 'defer'].map(function (v) {
        return '<option value="' + v + '"' + (vn.verdict === v ? ' selected' : '') + '>' +
          ({ focus: '重点跟进', normal: '正常跟进', defer: '暂时搁置' })[v] + '</option>';
      }).join('') + '</select>' +
      '<input type="text" id="vn-note" style="flex:1;min-width:140px" maxlength="200" placeholder="备注：为什么这样判断（可选）" value="' + esc(vn.note || '') + '">' +
      '<button class="btn sm" data-action="save-value-note" data-id="' + safeActionId(opp.id) + '">保存判断</button>' +
      '</div>' + vnText +
      '<div style="font-size:11px;color:var(--ink-3);margin-top:8px">评分按当前解析与匹配结果实时计算 · 更新于 ' + C.fmtDate(res.computedAt, true) + '；商机状态仍用页面顶部按钮调整（标记已报价 / 成交 / 丢单）。</div>' +
      '</div></div></section>';
  }

  function saveValueNote(id) {
    var opp = oppById(id);
    if (!opp) return;
    var sel = document.getElementById('vn-verdict');
    var noteEl = document.getElementById('vn-note');
    var verdict = sel ? sel.value : '';
    var note = noteEl ? noteEl.value.trim() : '';
    opp.valueNote = verdict ? { verdict: verdict, note: note, at: C.nowIso() } : null;
    C.addLog(opp, verdict ? '记录人工判断：' + ({ focus: '重点跟进', normal: '正常跟进', defer: '暂时搁置' })[verdict] + (note ? '（' + note + '）' : '') : '清除人工判断，恢复系统评分');
    S.scoreCache = {};
    C.persist();
    render();
    toast('人工判断已保存');
  }

  /* =========================================================
     阶段四：AI 回复助手（ReplyAssistant）

     输入全部来自已落地的管线：有效解析 + SmartMatch + 现有报价结果。
     价格只在现有定价不低于底价时才传给生成器；草稿按场景存
     opp.replyDrafts，人工编辑后刷新保留；本卡只生成草稿，永不发送。
     ========================================================= */

  function replyGenFor(opp, ctx, forceNoPrice) {
    if (!window.ReplyAssistant) return null;
    var res = scoreForOpp(opp);
    var pick = res && res.pick;
    var pr = ctx && ctx.pricing;
    /* forceNoPrice：调用方已按统一护栏（PricingUnity）判定不可报价时，
       强制不传价——回复助手据此只产出无价谈判草稿，绝不写任何价格。
       P1-FIX-03：传价判定改用全站统一护栏——优先 ctx.unity.quotable
       （含登记底价与特批规则），unity 不可用时按既有兼容规则回退
       ctx.pricing.flags.canQuote；不再自行只比保本价（旧实现下导入
       旧数据的报价落在保本价与登记底价之间时会漏过带价）。传给回复
       助手的 floor 同步用统一报价底线 quoteFloorUsd（保本与登记取高）。 */
    var quotable = ctx && ctx.unity ? !!ctx.unity.quotable
      : !!(pr && pr.flags && pr.flags.canQuote);
    var quoteFloor = (ctx && ctx.unity && ctx.unity.quoteFloorUsd > 0)
      ? ctx.unity.quoteFloorUsd : (pr ? pr.floorUsd : 0);
    var price = (!forceNoPrice && quotable && pr && pr.unitPriceUsd > 0 && quoteFloor > 0 && pr.unitPriceUsd >= quoteFloor)
      ? { unit: pr.unitPriceUsd, floor: quoteFloor } : null;
    return window.ReplyAssistant.generate({
      opp: opp,
      eff: res ? res.eff : effectiveParsed(opp, ctx),
      product: ctx ? ctx.product : null,
      match: pick ? { score: pick.result.score, keyConflict: pick.result.keyConflict, conflicts: pick.result.conflicts } : null,
      price: price,
      sellerName: st().settings.sellerName || '',
      scenario: S.replyScenario
    });
  }

  function replyAssistantCard(opp, ctx) {
    var gen = replyGenFor(opp, ctx);
    if (!gen) return '';
    var saved = (opp.replyDrafts || {})[gen.scenario] || null;
    var en = saved ? saved.en : gen.en;
    var zh = saved ? saved.zh : gen.zh;
    var stale = saved && opp.updatedAt && saved.at && new Date(opp.updatedAt) > new Date(saved.at);
    var warnHtml = gen.warnings.length
      ? gen.warnings.map(function (w) {
        return '<div class="alert danger" style="margin-bottom:8px"><span class="ic">!</span><div>' + esc(w) + '</div></div>';
      }).join('')
      : '';
    var uncHtml = gen.unconfirmed.length
      ? '<div class="sm-list mute"><span class="sm-list-t">尚未确认：</span>' + gen.unconfirmed.map(esc).join('；') + '</div>'
      : '';
    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">AI 回复助手<span class="card-sub">只生成草稿，不自动发送；内容只用已确认的商品信息</span></div>' +
      '<select id="ra-scenario" style="width:auto;height:32px">' +
      '<option value="auto"' + (S.replyScenario === 'auto' ? ' selected' : '') + '>自动场景（当前：' + gen.scenarioLabel + '）</option>' +
      window.ReplyAssistant.SCENARIOS.map(function (s) {
        return '<option value="' + s.key + '"' + (S.replyScenario === s.key ? ' selected' : '') + '>' + s.label + '</option>';
      }).join('') + '</select></div>' +
      '<div class="card-bd">' + warnHtml +
      '<div class="os-action"><div><b>回复目的：</b>' + esc(gen.purpose) + '</div>' +
      '<div style="margin-top:4px"><b>谈判策略（' + esc(gen.strategyLabel) + '）：</b>' + esc(gen.strategy) + '</div>' +
      uncHtml + '</div>' +
      '<div style="margin-top:12px;font-size:12px;color:var(--ink-3)">' +
      (saved
        ? '已保存草稿 · ' + C.fmtDate(saved.at, true) + (saved.edited ? ' · 已人工编辑' : '') + (stale ? ' · <b style="color:#8a5209">询盘信息在此之后有更新，建议重新生成</b>' : '')
        : '当前是实时生成的预览，编辑后点「保存编辑」才会存下来') +
      '</div>' +
      '<label style="margin-top:10px">英文正文（发给买家的就是这份）</label>' +
      '<textarea id="ra-en" style="min-height:170px">' + esc(en) + '</textarea>' +
      '<label style="margin-top:10px">中文对照（只给你看，不发送）</label>' +
      '<textarea id="ra-zh" style="min-height:150px">' + esc(zh) + '</textarea>' +
      '<div class="row" style="gap:8px;margin-top:12px">' +
      '<button class="btn primary" data-action="ra-generate" data-id="' + safeActionId(opp.id) + '">' + (saved ? '重新生成' : '生成并保存') + '</button>' +
      '<button class="btn" data-action="ra-save" data-id="' + safeActionId(opp.id) + '">保存编辑</button>' +
      '<button class="btn" data-action="ra-copy" data-id="' + safeActionId(opp.id) + '">复制英文</button>' +
      (saved ? '<button class="btn" data-action="ra-sent-open" data-id="' + safeActionId(opp.id) + '">记为已发送跟进</button>' : '') +
      '<span style="font-size:11.5px;color:var(--ink-3)">复制后到阿里后台粘贴发送，发送动作始终由你完成；发完回来点「记为已发送跟进」留痕</span>' +
      '</div></div></section>';
  }

  function raGenerate(id) {
    var opp = oppById(id);
    if (!opp) return;
    var ctx = analyzeOpp(opp);
    var gen = replyGenFor(opp, ctx);
    if (!gen) return;
    opp.replyDrafts = opp.replyDrafts || {};
    opp.replyDrafts[gen.scenario] = { en: gen.en, zh: gen.zh, edited: false, at: C.nowIso() };
    C.addLog(opp, 'AI 回复助手生成草稿：' + gen.scenarioLabel + '（策略：' + gen.strategyLabel + '，未发送）');
    S.scoreCache = {};
    C.persist();
    render();
    toast('草稿已生成并保存（未发送）');
  }

  function raSave(id) {
    var opp = oppById(id);
    if (!opp) return;
    var ctx = analyzeOpp(opp);
    var gen = replyGenFor(opp, ctx);
    if (!gen) return;
    var enEl = document.getElementById('ra-en');
    var zhEl = document.getElementById('ra-zh');
    if (!enEl) return;
    var en = enEl.value, zh = zhEl ? zhEl.value : '';
    opp.replyDrafts = opp.replyDrafts || {};
    opp.replyDrafts[gen.scenario] = { en: en, zh: zh, edited: en !== gen.en || zh !== gen.zh, at: C.nowIso() };
    C.addLog(opp, '保存回复草稿编辑：' + gen.scenarioLabel);
    C.persist();
    render();
    toast('草稿编辑已保存');
  }

  /* 补齐默认值：选品、数量、成本、单价 */
  function prepareOpp(opp) {
    var a = analyzeOpp(opp);
    var changed = false;

    if (!opp.selectedProductId && a.ordered.length) {
      /* 自动选品跳过硬性冲突（型号/品类不符、低于起订量）的商品；
         全部冲突时宁可不选，也不能默认把错货设成报价对象 */
      var firstOk = null;
      a.ordered.forEach(function (x) { if (!firstOk && !x.match.hardFail) firstOk = x; });
      if (firstOk) {
        opp.selectedProductId = firstOk.product.id;
        changed = true;
      }
    }

    if (!opp.quote.qty) {
      opp.quote.qty = a.parsed.qty || 100;
      changed = true;
    }

    if (!opp.quote.incoterm) {
      opp.quote.incoterm = st().settings.defaultIncoterm;
    }
    if (!opp.quote.leadTimeDays) {
      var p0 = productById(opp.selectedProductId);
      /* 商品没配交期就保持 0（待确认），不要编一个数字去承诺客户 */
      opp.quote.leadTimeDays = (p0 && Number(p0.leadTimeDays) > 0) ? Number(p0.leadTimeDays) : 0;
    }

    var p1 = productById(opp.selectedProductId);

    /* 采购成本：商品上填过就带出来；商品也没填就保持 null（待确认），
       不要写 0——0 会被定价模块当成「没有成本」，保本价和建议价全变 0 */
    if ((opp.quote.costRmb === undefined || opp.quote.costRmb === null) && p1 && C.num(p1.costRmb) > 0) {
      opp.quote.costRmb = C.num(p1.costRmb);
      changed = true;
    }
    if (opp.quote.shippingRmb === undefined || opp.quote.shippingRmb === null) {
      opp.quote.shippingRmb = p1 && C.num(p1.shippingRmb) > 0
        ? C.num(p1.shippingRmb)
        : C.num(st().settings.domesticShippingRmb);
      changed = true;
    }

    if (!opp.quote.unitPriceUsd || opp.quote.autoPrice === undefined) {
      var rec = P.evaluate({
        product: p1,
        qty: opp.quote.qty,
        settings: st().settings,
        unitPriceUsd: null,
        buyerTargetUsd: a.parsed.targetPriceUsd
      }).recommendUsd;
      if (rec > 0) {
        opp.quote.unitPriceUsd = rec;
        opp.quote.autoPrice = true;
        changed = true;
      }
    }

    if (changed) C.persist();
    return opp;
  }

  /* 报价拦截：所选商品与询盘硬性冲突时（型号/品类对不上，或数量低于起订量，
     即 Matching 的 hardFail），禁止生成回复、报价单与标记已报价，
     避免把错货的名字写进发给客户的材料。销售人工核对后可显式放行
     （matchOverride，会记进操作记录；换商品自动失效）。 */
  function quoteBlock(opp) {
    if (!opp || opp.matchOverride || !opp.selectedProductId) return null;
    var a = analyzeOpp(opp);
    var sel = null;
    a.ordered.forEach(function (x) { if (x.product.id === opp.selectedProductId) sel = x; });
    if (!sel || !sel.match.hardFail) return null;
    var reasons = [];
    (sel.match.gaps || []).forEach(function (g) {
      if (g.indexOf('起订量') === 0) reasons.push(g);
    });
    if (!sel.match.modelHit && a.parsed.models && a.parsed.models.length) {
      reasons.push('客户询盘的型号（' + a.parsed.models.join('、') + '）在所选商品上对不上');
    }
    if (!sel.match.typeHit && a.parsed.types && a.parsed.types.length) {
      reasons.push('客户询盘的品类与所选商品对不上');
    }
    if (!reasons.length) reasons.push('所选商品与客户需求存在硬性冲突');
    return { product: sel.product, reasons: reasons };
  }

  function openQuoteBlock(opp) {
    var b = quoteBlock(opp);
    if (!b) return;
    var html = modalHead('已拦截：所选商品对不上') +
      '<div class="modal-bd">' +
      '<div class="alert danger"><span class="ic">!</span><div>' +
      '当前选中的商品 <strong>' + esc(b.product.title || b.product.sku || '') + '</strong> 与这条询盘硬性冲突：' +
      '<br>· ' + b.reasons.map(esc).join('<br>· ') +
      '<br>继续报价很可能把错货报给客户，所以「生成回复 / 报价单 / 标记已报价」已先拦下。' +
      '</div></div>' +
      '<div style="margin-top:12px;font-size:13px;color:var(--ink-2)">' +
      '建议先在下方「橱窗匹配」里换一个对得上的商品，或到商品库补充正确货源。' +
      '如果你已经人工核对过实物、确认就是这一款，可以放行一次（会记进操作记录）。</div>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">先不报，去换商品</button>' +
      '<button class="btn danger" data-action="force-quote" data-id="' + safeActionId(opp.id) + '">已人工核对，放行报价</button>' +
      '</div>';
    openModal(html);
  }

  function quoteBannerHtml(opp) {
    var b = quoteBlock(opp);
    if (b) {
      return '<div class="alert danger"><span class="ic">!</span><div>' +
        '<strong>报价已拦截：</strong>所选商品「' + esc(b.product.title || '') + '」与询盘对不上（' +
        b.reasons.map(esc).join('；') +
        '）。生成回复、报价单、标记已报价都已停用，先在下方「橱窗匹配」换商品，或点生成按钮时选择人工放行。</div></div>';
    }
    if (opp.matchOverride && opp.selectedProductId) {
      return '<div class="alert warn"><span class="ic">!</span><div>' +
        '<strong>已人工放行：</strong>所选商品与询盘存在硬性冲突，你已确认核对无误。发出前请再检查一遍商品名和规格。</div></div>';
    }
    return '';
  }

  function ctxFor(opp) {
    var p = productById(opp.selectedProductId);
    var s = st().settings;
    var a = analyzeOpp(opp);

    var pricing = P.evaluate({
      product: p,
      qty: opp.quote.qty,
      settings: s,
      unitCostRmb: opp.quote.costRmb,
      shippingRmb: opp.quote.shippingRmb,
      unitPriceUsd: opp.quote.unitPriceUsd
    });

    /* 定价口径统一：全站只认 ctx.unity 这一份结果（来源仍是各自原算法，
       本层只收拢命名与可报价判定，不改任何公式） */
    var nego = null;
    try {
      nego = window.Workflow ? window.Workflow.negotiation({
        product: p, qty: opp.quote.qty, settings: s,
        unitPriceUsd: opp.quote.unitPriceUsd, buyerTargetUsd: a.parsed.targetPriceUsd
      }) : null;
    } catch (e) { nego = null; }
    var selEntry = null;
    (a.ordered || []).forEach(function (x) { if (x.product && x.product.id === opp.selectedProductId) selEntry = x; });
    var unity = null;
    try {
      unity = window.PricingUnity ? window.PricingUnity.resolve({
        evaluate: pricing, product: p, nego: nego,
        unitUsd: pricing.unitPriceUsd,
        hardFail: !!(selEntry && selEntry.match && selEntry.match.hardFail)
      }) : null;
    } catch (e) { unity = null; }

    return {
      opp: opp,
      product: p,
      settings: s,
      parsed: a.parsed,
      matches: a.ordered,
      pricing: pricing,
      nego: nego,
      unity: unity,

      sellerName: s.sellerName
    };
  }


  /* =========================================================
     通用 HTML 片段
     ========================================================= */

  function card(title, sub, body, actions) {
    return '<section class="card">' +
      '<div class="card-hd"><div class="card-title">' + title +
      (sub ? '<span class="card-sub">' + sub + '</span>' : '') + '</div>' +
      (actions || '') + '</div>' +
      '<div class="card-bd">' + body + '</div></section>';
  }

  function metric(label, value, foot, cls) {
    return '<div class="metric"><div class="metric-label">' + label + '</div>' +
      '<div class="metric-val ' + (cls || '') + '">' + value + '</div>' +
      (foot ? '<div class="metric-foot">' + foot + '</div>' : '') + '</div>';
  }

  /* 售价构成条：成本 / 平台扣费 / 你赚的 */
  /* 一条钱怎么分的：成本 / 平台扣 / 你赚 */
  function rangeBarHtml(ctx) {
    var r = ctx.pricing;
    if (r.flags.noCost || !r.gmvRmb) return '';

    var total = r.gmvRmb || 1;
    var costW = Math.max(0, Math.min(100, r.costTotalRmb / total * 100));
    var feeW = Math.max(0, Math.min(100, r.feeRmb / total * 100));
    var profitW = Math.max(0, 100 - costW - feeW);

    return '<div class="ratebar">' +
      '<div class="rb-cost" style="flex:0 0 ' + costW.toFixed(1) + '%;background:#94a3b8">' +
      (costW > 16 ? '成本 ' + C.pct(costW / 100) : '') + '</div>' +
      '<div class="rb-fee" style="flex:0 0 ' + feeW.toFixed(1) + '%;background:#d97706">' +
      (feeW > 12 ? '平台 ' + C.pct(feeW / 100) : '') + '</div>' +
      (profitW > 0.5
        ? '<div class="rb-commission" style="flex:0 0 ' + profitW.toFixed(1) + '%;background:' +
        (r.netRmb < 0 ? '#d92d20' : '#0f9d58') + '">' +
        (profitW > 14 ? (r.netRmb < 0 ? '亏 ' : '赚 ') + C.pct(profitW / 100) : '') + '</div>'
        : '') +
      '</div>' +
      '<div class="legend">' +
      '<span><span class="sw" style="background:#94a3b8"></span>成本 ' + C.money(r.costTotalRmb) + '</span>' +
      '<span><span class="sw" style="background:#d97706"></span>平台扣 ' + C.money(r.feeRmb) + '</span>' +
      '<span><span class="sw" style="background:' + (r.netRmb < 0 ? '#d92d20' : '#0f9d58') + '"></span>' +
      (r.netRmb < 0 ? '亏 ' : '赚 ') + C.money(Math.abs(r.netRmb)) + '</span>' +
      '</div>';
  }
  function feeBarHtml(s, exampleRmb) {
    var fee = C.num(s.platformFeeRate);
    var cost = exampleRmb || 100;
    var price = cost / (1 - fee);
    var feeRmb = price - cost;

    var feeW = price > 0 ? (feeRmb / price) * 100 : 0;
    var costW = 100 - feeW;

    return '<div class="ratebar">' +
      '<div class="rb-cost" style="flex:0 0 ' + costW.toFixed(1) + '%;background:#94a3b8">成本 ' + C.money(cost) + '</div>' +
      '<div class="rb-fee" style="flex:0 0 ' + feeW.toFixed(1) + '%;background:#d97706">' +
      (feeW > 10 ? '平台 ' + C.money(feeRmb) : '') + '</div>' +
      '</div>' +
      '<div class="legend">' +
      '<span>成本 ' + C.money(cost) + '</span>' +
      '<span>平台扣 ' + C.pct(fee) + ' → ' + C.money(feeRmb) + '</span>' +
      '<span>保本售价 ' + C.money(price) + '</span>' +
      '</div>';
  }

  function flagsHtml(ctx) {
    var r = ctx.pricing;
    var s = ctx.settings;
    var out = '';

    if (r.flags.noCost) {
      out += '<div class="alert info"><span class="ic">i</span><div>' +
        '<strong>先填采购成本。</strong>去 1688 / 淘宝查一下这个货多少钱一件，填到上面，' +
        '系统立刻算出「卖多少钱才不亏」。' +
        '<div class="row" style="margin-top:8px">' + searchLinks(ctx) + '</div>' +
        '</div></div>';
      return out;
    }

    if (r.flags.noPrice) {
      out += '<div class="alert danger"><span class="ic">✕</span><div><strong>无法报价：</strong>' +
        '当前没有有效报价（报价必须大于 0）。请先填写有效报价，再进行保本校验。' +
        '</div></div>';
      return out;
    }

    if (r.flags.belowCost) {
      out += '<div class="alert danger"><span class="ic">✕</span><div><strong>这个价要亏：</strong>' +
        '成本 ' + C.money(r.costUnitRmb) + '/件，平台扣 ' + C.pct(r.feeRate) +
        '，保本价是 ' + C.usd(r.floorUsd) + '。你报 ' + C.usd(r.unitPriceUsd) +
        '，一件亏 ' + C.money(Math.abs((r.unitPriceUsd - r.floorUsd) * r.fx * (1 - r.feeRate))) + '。' +
        '<br>想不亏，至少报到 ' + C.usd(r.floorUsd) + '。' +
        '</div></div>';
    } else {
      out += '<div class="alert ok"><span class="ic">✓</span><div><strong>可以报：</strong>' +
        '保本价 ' + C.usd(r.floorUsd) + '，你报 ' + C.usd(r.unitPriceUsd) +
        '，这一单赚 ' + C.money(r.netRmb) + '。' +
        '</div></div>';
    }

    if (r.flags.aboveMarket) {
      out += '<div class="alert warn"><span class="ic">!</span><div><strong>比市场价贵：</strong>' +
        '别家卖 ' + C.usd(r.marketUsd) + '（' + C.money(r.marketPriceRmb) + '/件），' +
        '你建议卖 ' + C.usd(r.recommendUsd) + '，贵了 ' + Math.abs(r.marketGapPct * 100).toFixed(1) + '%。' +
        '客户比价就会发现，要么压利润，要么找到更便宜的货源。' +
        '</div></div>';
    }

    if (r.flags.listTooLow) {
      out += '<div class="alert danger"><span class="ic">✕</span><div><strong>你的挂牌价本身就亏：</strong>' +
        '阿里上挂的 ' + C.usd(r.listUsd) + ' 低于保本价 ' + C.usd(r.floorUsd) +
        '，这个商品挂上去就是亏本卖。要么调价，要么换货源。' +
        '</div></div>';
    } else if (r.listUsd > 0 && r.recommendUsd > 0 && r.recommendUsd >= r.listUsd - 1e-9) {
      out += '<div class="alert warn"><span class="ic">!</span><div><strong>挂牌价压住了利润：</strong>' +
        '想赚 ' + C.money(r.profitPerUnitRmb) + '/件 得卖 ' + C.usd(C.round((r.costUnitRmb + r.profitPerUnitRmb) / (1 - r.feeRate) / r.fx, 2)) +
        '，但你挂牌价只有 ' + C.usd(r.listUsd) + '。只能赚到 ' +
        C.money(Math.max(0, r.listUsd * r.fx * (1 - r.feeRate) - r.costUnitRmb)) + '/件。' +
        '</div></div>';
    }

    return out;
  }
  /* 一键去 1688 / 淘宝 搜这个商品 */
  function searchLinks(ctx) {
    var p = ctx.product;
    var kw = p ? (p.titleEn || p.title) : '';
    var q = encodeURIComponent(String(kw).slice(0, 60));
    return '<a class="btn sm" target="_blank" rel="noopener" href="https://s.1688.com/selloffer/offer_search.htm?keywords=' + q + '">去 1688 查</a>' +
      '<a class="btn sm" target="_blank" rel="noopener" href="https://s.taobao.com/search?q=' + q + '">去淘宝查</a>' +
      '<a class="btn sm" target="_blank" rel="noopener" href="https://www.goofish.com/search?q=' + q + '">去闲鱼查</a>';
  }


  /* =========================================================
     路由
     ========================================================= */

  function render() {
    var hash = (location.hash || '#/dashboard').replace(/^#\/?/, '');
    var seg = hash.split('/').filter(Boolean);
    var page = seg[0] || 'dashboard';
    var id = seg[1] || null;

    var VIEWS = ['dashboard', 'desk', 'opps', 'catalog', 'analytics', 'settings', 'opp', 'review', 'customers', 'analysis', 'followups', 'sync'];
    if (VIEWS.indexOf(page) < 0) page = 'dashboard';

    var html = '';
    var crumb = '';

    if (page === 'dashboard') { html = viewDashboard(); crumb = '工作台'; }
    else if (page === 'desk') {
      html = window.DecisionDesk ? window.DecisionDesk.view() : '<section class="card">决策台模块未加载</section>';
      crumb = '询盘决策台';
      setTimeout(function () { if (window.DecisionDesk) window.DecisionDesk.mount(); }, 30);
    }
    else if (page === 'opps') { html = viewOpps(); crumb = '询盘中心'; }
    else if (page === 'catalog') { html = viewCatalog(); crumb = '商品与报价'; }
    else if (page === 'review') { html = viewReview(); crumb = '补成本'; }
    else if (page === 'analytics') {
      html = viewAnalytics();
      crumb = '经营分析';
      setTimeout(function () {
        var o = document.getElementById('fx-shock-out');
        var i = document.getElementById('fx-shock');
        if (o && i && !o.innerHTML) o.innerHTML = fxShockResult(C.num(i.value, 7.1));
      }, 60);
    }
    else if (page === 'settings') { html = viewSettings(); crumb = '系统设置'; }
    else if (page === 'customers') { html = viewCustomers(); crumb = '客户中心'; }
    else if (page === 'analysis') { html = viewAnalysis(); crumb = '销售分析'; }
    else if (page === 'followups') { html = viewFollowups(); crumb = '跟进管理'; }
    else if (page === 'sync') { html = viewSync(); crumb = '数据同步与系统设置'; }
    else if (page === 'opp') {
      html = viewOppDetail(id);
      crumb = '商机详情';
      setTimeout(function () { ensureTranslation(oppById(id)); initSandbox(id); }, 80);
    }

    renderNav(page === 'opp' ? 'opps' : (page === 'settings' ? 'sync' : page));
    document.getElementById('crumb').textContent = crumb;
    document.getElementById('view').innerHTML = html;

    var key = page + '/' + (id || '');
    if (S.lastKey !== key) {
      S.lastKey = key;
      window.scrollTo(0, 0);
    }
    syncSidebar();
  }

  function renderNav(page) {
    var openCount = st().opportunities.filter(function (o) {
      return o.status === 'new' || o.status === 'matched';
    }).length;

    document.getElementById('nav').innerHTML = NAV.map(function (n) {
      var count = '';
      if (n.key === 'opps' && openCount) count = '<span class="nav-count">' + openCount + '</span>';
      return '<a class="nav-item' + (n.key === page ? ' active' : '') + '" href="#/' + n.key + '">' +
        '<span class="nav-icon">' + n.icon + '</span>' + n.label + count + '</a>';
    }).join('');
  }

  /* ---------------- 实时汇率 ---------------- */
  var fxBusy = false;

  function refreshFx(manual) {
    if (fxBusy) return;
    if (typeof fetch !== 'function' || typeof location === 'undefined' || !location.href) return;
    fxBusy = true;
    fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var rate = j && j.rates && j.rates.CNY;
        if (!(rate > 0)) throw new Error('no rate');
        var s = st().settings;
        var old = C.num(s.fxRate);
        var next = Math.round(rate * 100) / 100;

        /* 跳变超过 20% 先不覆盖，避免拿到异常数据把报价全算错 */
        if (old > 0 && Math.abs(next / old - 1) > 0.2) {
          if (manual) toast('汇率跳变太大（' + old + ' → ' + next + '），已保留原值，请手动确认');
          return;
        }

        s.fxRate = next;
        s.fxUpdatedAt = C.nowIso();
        invalidate(); C.persist(); render();
        if (manual) toast('汇率已更新：1 USD = ' + s.fxRate + ' CNY');
      })
      .catch(function () {
        if (manual) toast('联网失败，继续用 ' + st().settings.fxRate);
      })
      .then(function () { fxBusy = false; });
  }

  function fxAgeText() {
    var at = st().settings.fxUpdatedAt;
    if (!at) return '还没更新过';
    return '更新于 ' + C.relTime(at);
  }

  /* ---------------- 本地桥：阿里登录状态 ---------------- */
  var BRIDGE = 'http://127.0.0.1:7788';
  var bridgeTimer = null;

  function paintBridge(st) {
    var dot = document.getElementById('bridge-dot');
    var txt = document.getElementById('bridge-text');
    if (!dot || !txt) return;
    if (!st) {
      dot.style.background = '#c9ced6';
      txt.textContent = '阿里：未连接（同步没开）';
      return;
    }
    if (st.login) {
      dot.style.background = '#0f9d58';
      txt.textContent = '阿里：已登录';
    } else {
      dot.style.background = '#f0b429';
      txt.textContent = '阿里：登录已失效';
    }
  }

  function pollBridge() {
    if (typeof fetch !== 'function' || typeof location === 'undefined' || !location.href) return;
    fetch(BRIDGE + '/api/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (st) { paintBridge(st); })
      .catch(function () { paintBridge(null); });
  }

  /* 本机如果跑着 LibreTranslate，就自动用它（不限量） */
  function detectLocalTranslate() {
    if (typeof fetch !== 'function' || typeof location === 'undefined' || !location.href) return;
    var s = st().settings;
    if (s.translateEndpoint) return;
    fetch('http://127.0.0.1:5000/languages', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) return;
        st().settings.translateEndpoint = 'http://127.0.0.1:5000';
        C.persist();
      })
      .catch(function () { });
  }

  function startBridge() {
    pollBridge();
    if (!bridgeTimer && typeof setInterval === 'function') bridgeTimer = setInterval(pollBridge, 30000);
  }

  function syncSidebar() {
    var s = st().settings;
    document.getElementById('sidebar-rate').textContent = C.pct(s.platformFeeRate);
    var note = document.getElementById('sidebar-health');
    note.className = 'sf-note good';
    note.textContent = '平台扣费 · 保本价 = 成本 ÷ ' + (1 - C.num(s.platformFeeRate)).toFixed(2);
  }

  /* =========================================================
     P1-23 全站框架新视图（只读聚合，不新增数据结构，不改旧逻辑）
     ========================================================= */

  /* 链接边界校验：id 只允许与 safeId 同字符集的安全串进入 href 属性；
     异常 id（未经规范化的内存对象等）安全降级为纯文本，宁可不跳也不拼错链接。 */
  function fwOppLink(o, text) {
    var id = o && o.id != null ? String(o.id) : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return esc(text);
    return '<a href="#/opp/' + id + '" style="color:#2563eb;text-decoration:none">' + esc(text) + '</a>';
  }

  /* R3-06：写入 HTML 属性的操作 ID 必须先过全站统一的安全 ID 校验
     （与 fwOppLink / safeId 同字符集）。非法 ID 返回 null，调用方不得
     生成可触发编辑/保存的按钮——不清洗后继续用（防不同原始 ID 清洗成
     同一 ID 的身份冲突），也不靠转义掩盖。 */
  function safeActionId(id) {
    var s = id != null ? String(id) : '';
    /* R5 第五项修正：不合规时返回空串而非 null。R4 版返回 null，
       字符串拼接后属性值变成字面量 "null"——它恰好通过字符集校验，
       点击后以 id='null' 进入业务分发：saveOpp 靠查无此人兜底，
       saveProduct 则会对 undefined 执行 Object.assign 抛错，且新
       建商品的保存按钮同样中招（data-id="null" 使新建流程误入
       编辑分支）。返回空串后：属性为空、守卫可区分「属性存在但
       被收口为空」与「属性缺失」、双用途保存回到空 id 语义。 */
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
  }

  /* 最近一条跟进记录：followLog 写入为追加序，但导入数据不保证顺序，
     故按有效时间字段取最大；无有效时间时回退数组最后一项（不改原始数据）。 */
  function fwLastFollow(opp) {
    var log = (opp && opp.followLog) || [];
    var best = null, bestT = -Infinity;
    for (var i = 0; i < log.length; i++) {
      var t = Date.parse(log[i] && log[i].at);
      if (!isNaN(t) && t >= bestT) { bestT = t; best = log[i]; }
    }
    return best || log[log.length - 1] || null;
  }

  /* 客户中心：按买家聚合当前可见商机。无稳定平台 ID 时只按 名称+公司 分组并明示需人工确认，不自动合并。 */
  function viewCustomers() {
    var s = st();
    var opps = C.visibleOpps(s, S.dataView).slice().sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    var groups = {}, order = [];
    opps.forEach(function (o) {
      /* R3-07：分组键改结构化复合键（JSON 编码二元组），杜绝 name/company
         内容含分隔符时的拼接碰撞（如 name="A|B",company="C" 与
         name="A",company="B|C"）。显示名仍用原始字段，空名显示「未知买家」，
         但分组按原始空值区分，不与字面「未知买家」合并。 */
      var gName = String((o.buyer && o.buyer.name) || '');
      var gCompany = String((o.buyer && o.buyer.company) || '');
      var key = JSON.stringify([gName, gCompany]);
      if (!groups[key]) { groups[key] = { buyer: o.buyer || {}, list: [] }; order.push(key); }
      groups[key].list.push(o);
    });
    var rows = order.map(function (key) {
      var g = groups[key], latest = g.list[0];
      var open = g.list.filter(function (o) { return o.status !== 'won' && o.status !== 'lost'; }).length;
      return '<tr><td><strong>' + esc(g.buyer.name || '未知买家') + '</strong><div style="color:#8a919e;font-size:12px">' +
        esc(g.buyer.company || '') + (g.buyer.country ? ' · ' + esc(g.buyer.country) : '') + '</div></td>' +
        '<td>' + g.list.length + ' 条（进行中 ' + open + ')</td>' +
        '<td>' + esc(String(latest.createdAt || '').slice(0, 10)) + '</td>' +
        '<td>' + fwOppLink(latest, '查看最近询盘') + '</td></tr>';
    }).join('');
    return '<section class="card"><div class="card-head"><h3>客户中心</h3><span class="sub">同一买家的历史询盘聚合</span></div>' +
      '<div class="alert warn" style="margin:0 18px 12px"><span class="ic">!</span><div>当前按「买家名称 + 公司」聚合：系统尚无阿里买家稳定 ID，同名不同人可能被分到一组、同一人改名可能被拆开。正式客户档案与人工确认合并将在接入稳定标识后启用，本页不自动合并、不改动任何商机数据。</div></div>' +
      (order.length ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>客户</th><th>询盘</th><th>最近询盘</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty"><strong>还没有客户</strong>询盘进入后会在这里按买家聚合。</div>') + '</section>';
  }

  /* 销售分析：对当前可见商机批量运行 P1-22 规则分析，给出阶段与缺口总览（只读，点击进详情修正）。 */
  function viewAnalysis() {
    var s = st();
    if (!window.SalesAnalysis) return '<section class="card"><div class="empty"><strong>销售分析模块未加载</strong></div></section>';
    var opps = C.visibleOpps(s, S.dataView).filter(function (o) { return o.rawText; });
    var rows = opps.map(function (o) {
      var a = analyzeOpp(o);
      var disp = window.SalesAnalysis.applyReview(window.SalesAnalysis.analyze(salesInputFor(o, a, effectiveParsed(o, a))), o.salesReview);
      var missing = disp.needs.filter(function (n) { return n.status === 'missing'; }).map(function (n) { return n.label; });
      var hasConflict = disp.needs.some(function (n) { return n.status === 'conflict'; });
      return '<tr><td>' + fwOppLink(o, (o.buyer && o.buyer.name) || '未知买家') + '</td>' +
        '<td>' + esc(disp.stage.label) + (disp.stage.confirmed ? ' <span class="badge" style="background:#eef4ff;color:#2563eb">人工确认</span>' : '') + '</td>' +
        '<td>' + (hasConflict ? '<span style="color:#b91c1c">有冲突待核实</span>' : (missing.length ? '缺：' + esc(missing.slice(0, 3).join('、')) : '信息较完整')) + '</td>' +
        '<td>' + esc(String(o.createdAt || '').slice(0, 10)) + '</td></tr>';
    }).join('');
    return '<section class="card"><div class="card-head"><h3>销售分析</h3><span class="sub">规则分析总览 · 非大模型</span></div>' +
      '<p style="padding:0 18px;color:#667085;font-size:13px">以下判断由规则引擎基于询盘原文与系统记录生成，均可在询盘详情的「客户销售判断」卡中查看证据并人工修正；这里不产生新的分析数据。</p>' +
      (opps.length ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>客户</th><th>采购阶段</th><th>缺口 / 冲突</th><th>询盘日期</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty"><strong>暂无可分析的询盘</strong>有原文的询盘会出现在这里。</div>') + '</section>';
  }

  /* 跟进管理：聚合 FollowUp 的状态与到期信息，形成跨询盘跟进清单（只读）。 */
  function viewFollowups() {
    var s = st();
    if (!window.FollowUp) return '<section class="card"><div class="empty"><strong>跟进模块未加载</strong></div></section>';
    var opps = C.visibleOpps(s, S.dataView).filter(function (o) { return o.status !== 'won' && o.status !== 'lost'; });
    var items = opps.map(function (o) {
      var fuSt = window.FollowUp.deriveStatus(o);
      var fuDue = window.FollowUp.dueState(o, Date.now());
      return { o: o, rank: window.FollowUp.sortRank(o, Date.now()), label: window.FollowUp.statusLabel(fuSt), due: fuDue };
    }).sort(function (a, b) { return a.rank - b.rank; });
    var rows = items.map(function (it) {
      var last = fwLastFollow(it.o);
      return '<tr><td>' + fwOppLink(it.o, (it.o.buyer && it.o.buyer.name) || '未知买家') + '</td>' +
        '<td>' + esc(it.label) + '</td>' +
        '<td>' + (it.due && it.due.state === 'overdue' ? '<span style="color:#b91c1c">已逾期</span>' : esc((it.due && it.due.label) || '—')) + '</td>' +
        '<td style="color:#667085">' + (last ? esc(String(last.at || '').slice(0, 10)) + ' ' + esc(String(last.note || '').slice(0, 40)) : '暂无跟进记录') + '</td></tr>';
    }).join('');
    /* P1-2 批次 3：「待跟进」推导区——已报价且最近活动（跟进记录或
       报价版本）超过 7 天的商机。纯推导展示，不回写商机任何字段。 */
    var stale = window.FollowUp.staleQuotes ? window.FollowUp.staleQuotes(C.visibleOpps(s, S.dataView), Date.now()) : [];
    var staleHtml = '';
    if (stale.length) {
      var srows = stale.map(function (it) {
        return '<tr><td>' + fwOppLink(it.opp, (it.opp.buyer && it.opp.buyer.name) || '未知买家') + '</td>' +
          '<td>' + (it.quoteAt ? esc(String(it.quoteAt).slice(0, 10)) : '—') + '</td>' +
          '<td>' + (it.lastFollowAt ? esc(String(it.lastFollowAt).slice(0, 10)) : '暂无跟进记录') + '</td>' +
          '<td><span style="color:#b91c1c">已 ' + it.days + ' 天无活动</span></td></tr>';
      }).join('');
      staleHtml = '<div style="padding:0 18px 6px"><h4 style="margin:8px 0 4px">待跟进（已报价超 7 天无活动）</h4>' +
        '<p style="color:#667085;font-size:12.5px;margin:0 0 6px">由报价版本与跟进记录实时推导，只提示、不改变商机状态；在详情里补一条跟进记录后会自动移出。</p></div>' +
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>客户</th><th>最近报价</th><th>最近跟进</th><th>沉默时长</th></tr></thead><tbody>' + srows + '</tbody></table></div>';
    }
    return '<section class="card"><div class="card-head"><h3>跟进管理</h3><span class="sub">跨询盘跟进清单</span></div>' +
      '<p style="padding:0 18px;color:#667085;font-size:13px">按跟进紧急度排序；记录与提醒的维护在各询盘详情内完成，本页只做聚合查看，不新增待办数据。</p>' +
      staleHtml +
      (items.length ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>客户</th><th>跟进状态</th><th>到期</th><th>最近记录</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty"><strong>暂无进行中的询盘</strong></div>') + '</section>';
  }

  /* 同步与设置：阿里官方同步的真实能力状态 + 现有手动导入导出入口。不伪造连接状态。 */
  function viewSync() {
    var s = st();
    var capRow = function (name, state, note) {
      return '<tr><td>' + esc(name) + '</td><td>' + state + '</td><td style="color:#667085">' + esc(note) + '</td></tr>';
    };
    return '<section class="card"><div class="card-head"><h3>数据同步与系统设置</h3><span class="sub">阿里国际站官方连接</span></div>' +
      '<div class="alert warn" style="margin:0 18px 12px"><span class="ic">!</span><div><strong>阿里官方接口尚未连接。</strong>本系统未取得阿里开放平台 ISV 应用与卖家授权，当前所有数据来自手动录入与文件导入。下方为官方文档核查结论，不代表已开通能力。</div></div>' +
      (window.IdentityTxn && window.IdentityTxn.isLocked() ? '<div class="alert warn" style="margin:0 18px 12px"><span class="ic">!</span><div><strong>身份数据待恢复：写入已阻断。</strong>检测到未完成的身份导入事务（批次 ' + esc(String((window.IdentityTxn.lockReason() || {}).batchId || '')) + '）。恢复将按事务日志回滚该批次，完成后自动解除阻断。<div style="margin-top:8px"><button class="btn sm" data-action="identity-recover">执行恢复并校验</button></div></div></div>' : '') +
      (window.IdentityTxn && window.IdentityTxn.readLegacyPending(window.localStorage) ? '<div class="alert warn" style="margin:0 18px 12px"><span class="ic">!</span><div><strong>旧格式备份待迁移：</strong>最近恢复的备份不含身份注册表。在完成存量身份回填前，身份层导入会被拒绝（不会静默创建新注册表）。</div></div>' : '') +
      '<div class="hint" style="margin:0 18px 12px">运行前提：本系统按<strong>单标签页</strong>设计，多标签页同时操作不受支持（检测到其他标签页改动身份数据时，本页会立即阻断写入）。</div>' +
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>能力</th><th>官方状态</th><th>说明</th></tr></thead><tbody>' +
      capRow('账号授权（OAuth / session)', '官方已确认存在', '淘宝开放平台（TOP）承载国际站 ICBU API，需 ISV 应用 AppKey + 卖家授权换取 session；本系统尚未申请') +
      capRow('商品读取', '官方已确认存在', 'alibaba.icbu.product.list / get 等，需授权；可用于商品库同步') +
      capRow('订单读取', '官方已确认存在', 'alibaba.seller.order.list / get，需授权') +
      capRow('订单变更通知', '官方已确认存在', '消息服务 TMC 的 icbu_trade_OrderNotify，需另行申请消息权限') +
      capRow('买家基础信息', '官方已确认存在（收费）', 'alibaba.buyer.companyprofile.find 等为收费 API，且不等同于询盘买家数据') +
      capRow('RFQ 查询与详情读取', '官方文档已确认存在 · 本项目未授权未调用', 'alibaba.icbu.rfq.search / rfqdetail.get 等可按 ID 逐条读取 RFQ；仅覆盖 RFQ 渠道，不等于全部询盘') +
      capRow('非 RFQ 商品页询盘读取', '公开资料尚未确认', '商品详情页发起的询盘，在官方公开 API 列表中尚未找到逐条读取接口，不能确认存在，也未证实不存在') +
      capRow('TM 站内消息读取', '公开资料尚未确认', '尚未找到聊天消息内容读取接口；订单变更通知（icbu_trade_OrderNotify）是订单事件消息，不是询盘消息') +
      capRow('TM 站内消息发送', '公开资料尚未确认', '尚未找到卖家消息发送接口；且对外沟通由员工在阿里卖家后台人工完成，不属于本产品自动执行范围') +
      capRow('RFQ 报价提交', '官方文档已确认存在 · 本项目未授权未调用', 'alibaba.icbu.quotation.post 是向 RFQ 提交报价的接口，不是站内消息发送；本产品不自动提交，报价一律人工确认') +
      '</tbody></table></div>' +
      '<div style="padding:14px 18px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn sm" data-action="export-json">导出数据备份（JSON)</button>' +
      '<button class="btn sm" data-action="import-json">导入数据（JSON)</button>' +
      '<a class="btn sm" href="#/settings" style="text-decoration:none">打开系统设置</a></div>' +
      '<p style="padding:0 18px 14px;color:#667085;font-size:13px">同步日志：暂无记录（从未执行官方同步）。手动导入的数据与未来接口数据将走同一套标准化与去重流程，员工人工修正受同步保护、不会被覆盖（设计见数据架构文档）。当前商机 ' + s.opportunities.length + ' 条、商品 ' + s.products.length + ' 个，均为本地数据。</p></section>';
  }

  /* =========================================================
     视图：工作台
     ========================================================= */

  function viewDashboard() {
    var s = st();
    var kpi = C.stats();
    var demo = !!s.demoMode;
    var productCount = s.products.length;

    var open = s.opportunities.filter(function (o) {
      /* 工作台只推真实待办，演示商机不混进来 */
      return !C.isDemoOpp(o) && (o.status === 'new' || o.status === 'matched');
    }).sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

    /* ---- 最顶上：进阿里卖家后台 ---- */
    var sellerBar = '<section class="card" style="border-left:3px solid var(--brand)">' +
      '<div class="card-bd row" style="gap:10px">' +
      '<span style="font-size:13px;font-weight:650">阿里卖家</span>' +
      '<span style="font-size:12px;color:var(--ink-3)">回询盘、看订单、核成本，都在这</span>' +
      '<span class="spacer"></span>' +
      '<button class="btn sm primary" data-action="open-seller-app">打开电脑版</button>' +
      '<button class="btn sm" data-action="open-seller-web">网页版</button>' +
      '</div></section>';

    /* ---- 顶部横幅：还在用演示数据时提醒 ---- */
    var demoBanner = demo
      ? '<div class="alert warn"><span class="ic">!</span><div>' +
      '<strong>现在用的是演示商品，不是你的。</strong>先把自己的橱窗导进来，算出来的价才是真能用的。' +
      '<button class="btn sm primary" style="margin-left:10px" data-action="import-products">导入我的商品</button>' +
      '</div></div>'
      : '';

    /* ---- Hero ---- */
    var hero = '<section class="card"><div style="padding:26px 26px 22px">' +
      '<div style="font-size:12px;color:var(--ink-3);margin-bottom:4px">现在有</div>' +
      '<div style="font-size:30px;font-weight:750;letter-spacing:-.6px">' +
      (open.length ? open.length + ' 条商机等你回' : '还没有待处理的商机') + '</div>' +
      '<div style="color:var(--ink-2);margin-top:6px;font-size:13px">' +
      '把买家发来的原文整段粘进来，30 秒给你：报多少、能不能接、回什么话。</div>' +
      '<div class="row" style="margin-top:18px">' +
      '<button class="btn primary" style="height:42px;padding:0 22px;font-size:14px" data-action="new-opp">粘贴一条新询盘</button>' +
      '<button class="btn" style="height:42px" data-action="quick-demo">先看一个例子</button>' +
      '</div></div></section>';

    /* ---- 三步 ---- */
    function stepCard(n, title, desc, btnLabel, action, state) {
      var badgeHtml = state === 'ok'
        ? '<span class="badge green">已完成</span>'
        : state === 'warn'
          ? '<span class="badge amber">待完成</span>'
          : '<span class="badge gray">随时可做</span>';
      return '<section class="card"><div class="card-bd">' +
        '<div class="row" style="justify-content:space-between;margin-bottom:8px">' +
        '<span style="font-family:var(--mono);font-weight:700;color:var(--brand);font-size:13px">第 ' + n + ' 步</span>' +
        badgeHtml + '</div>' +
        '<div style="font-weight:650;font-size:14px">' + title + '</div>' +
        '<div style="color:var(--ink-3);font-size:12px;margin:5px 0 14px;min-height:34px">' + desc + '</div>' +
        '<button class="btn sm" data-action="' + action + '">' + btnLabel + '</button>' +
        '</div></section>';
    }

    var steps = '<div class="grid grid-3">' +
      stepCard(1, '把你的橱窗导进来',
        demo ? '现在还是演示商品，换成你自己的商品，算出来的价才有意义。'
          : '已导入 ' + productCount + ' 个商品，可以随时补充。',
        demo ? '导入商品' : '管理商品',
        'import-products',
        demo ? 'warn' : 'ok') +
      stepCard(2, '粘一条询盘进来',
        open.length ? '有 ' + open.length + ' 条待处理，点开任意一条就能看结论。'
          : '把买家原文粘进来，自动识别数量、目标价、认证、市场。',
        '新建商机',
        'new-opp',
        'todo') +
      stepCard(3, '看结论，复制回复',
        '详情页第一眼就告诉你：能不能报、报多少、你赚多少。',
        '打开商机列表',
        'goto-opps',
        'todo') +
      '</div>';

    /* ---- 待处理列表 ---- */
    var rows = open.slice(0, 8).map(function (o) {
      prepareOpp(o);
      var a = analyzeOpp(o);
      var top = a.ordered[0];
      var p = top ? top.product : null;
      var pr = P.evaluate({
        product: p, qty: o.quote.qty, settings: s.settings,
        unitPriceUsd: o.quote.unitPriceUsd,
        buyerTargetUsd: a.parsed.targetPriceUsd
      });
      return '<tr class="clickable" data-action="open-opp" data-id="' + safeActionId(o.id) + '">' +
        '<td><strong>' + esc(o.buyer.name) + '</strong><br><span style="color:#8a919e;font-size:11px">' +
        esc(o.buyer.country) + ' · ' + esc(o.buyer.channel) + '</span></td>' +
        '<td>' + (p ? esc(p.title) : '<span style="color:#d92d20">没匹配到商品</span>') + '</td>' +
        '<td class="num">' + (o.quote.qty ? o.quote.qty.toLocaleString() : '—') + '</td>' +
        '<td class="num">' + (pr.unitPriceUsd ? C.usd(pr.unitPriceUsd) : '—') + '</td>' +
        '<td class="num">' + (pr.flags.noPrice ? '<span style="color:#d97706">无挂牌价</span>' : C.money(pr.netRmb)) + '</td>' +
        '<td>' + (pr.flags.canQuote ? '<span class="badge green">可报</span>' : '<span class="badge red">不能报</span>') + '</td>' +
        '<td class="actions"><button class="btn sm" data-action="open-opp" data-id="' + safeActionId(o.id) + '">打开</button></td>' +
        '</tr>';
    }).join('');

    var queue = '<section class="card">' +
      '<div class="card-hd"><div class="card-title">待处理商机' +
      '<span class="card-sub">点任意一行打开</span></div>' +
      '<button class="btn sm primary" data-action="new-opp">+ 新建商机</button></div>' +
      '<div class="card-bd tight"><div class="table-wrap">' +
      (rows
        ? '<table class="table"><thead><tr><th>买家</th><th>匹配商品</th><th class="num">数量</th>' +
        '<th class="num">建议价</th><th class="num">净赚</th><th>结论</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="empty"><strong>还没有商机</strong>点「粘贴一条新询盘」，或者先点「先看一个例子」。</div>') +
      '</div></div></section>';

    /* ---- 底部一句话：费率 ---- */
    var cs = s.settings;
    var feeP = C.num(cs.platformFeeRate);
    var moneyLine = '<section class="card"><div class="card-bd row" style="gap:14px">' +
      '<span style="font-size:12.5px;color:var(--ink-2)">平台扣 <b>' + C.pct(feeP) +
      '</b> · 成本 100 元的货，<b style="color:var(--ok);font-family:var(--mono)">' +
      C.money(100 / (1 - feeP)) + '</b> 才不亏；想赚 ' + C.money(cs.profitRmb) +
      ' 就卖 <b style="font-family:var(--mono)">' + C.money((100 + C.num(cs.profitRmb)) / (1 - feeP)) + '</b></span>' +
      '<span class="spacer"></span>' +
      '<a href="#/settings" style="font-size:12px;color:var(--ink-3)">改汇率 / 利润 →</a>' +
      '</div></section>';

    var demoOppHint = kpi.demoOppCount > 0
      ? '<div class="alert info"><span class="ic">i</span><div>另有 <strong>' + kpi.demoOppCount + ' 条演示商机</strong>未计入上面的真实待办与统计，在「商机」页切到「演示数据」查看。</div></div>'
      : '';
    return '<div class="stack">' + sellerBar + demoBanner + demoOppHint + hero + todoCard() + bossStrip() + steps + queue + moneyLine + '</div>';
  }


  /* =========================================================
     视图：商机列表
     ========================================================= */

  /* ---------------- 商机自动分类 ---------------- */

  var TYPE_CN = {
    rx: '接收机', camera: '摄像头', fc: '飞控', esc: '电调', vtx: '图传',
    gps: 'GPS', ant: '天线', goggle: '眼镜', batt: '电池', motor: '电机',
    frame: '机架', charger: '充电器', servo: '舵机', tx: '遥控器'
  };

  function tierOf(qty) {
    if (!qty) return '未填数量';
    if (qty <= 10) return '样品单';
    if (qty <= 100) return '小批量';
    if (qty <= 1000) return '批量单';
    return '大单';
  }

  function oppClass(o) {
    var raw = o.rawText || '';
    var qty = (o.quote && o.quote.qty) || 0;

    var a = analyzeOpp(o);
    var top = a.ordered[0];
    var pid = o.selectedProductId || (top && top.product.id);
    var p = pid ? productById(pid) : null;

    var src = p ? (p.title + ' ' + (p.titleEn || '') + ' ' + (p.category || '') + ' ' + (p.keywords || []).join(' ')) : raw;
    var types = window.Matching.typesOf(src);
    if (!types.length) types = window.Matching.typesOf(raw);

    return {
      country: o.buyer.country || '未知',
      type: types.length ? (TYPE_CN[types[0]] || types[0]) : '未分类',
      tier: tierOf(qty),
      status: o.status,
      qty: qty
    };
  }

  function oppFiltered() {
    var s = st();
    /* 演示隔离：先按数据视图（真实/演示）分区，再套其余筛选与排序 */
    return C.visibleOpps(s, S.dataView).filter(function (o) {
      var c = oppClass(o);
      if (S.oppCountry && c.country !== S.oppCountry) return false;
      if (S.oppType && c.type !== S.oppType) return false;
      if (S.oppTier && c.tier !== S.oppTier) return false;
      if (S.oppStatus && c.status !== S.oppStatus) return false;
      if (S.oppTodoOnly) {
        if (o.status === 'won' || o.status === 'lost') return false;
        var fs = W.followState(o, s.settings);
        if (!(o.status === 'new' || (fs && (fs.overdue || fs.today)))) return false;
      }
      if (S.oppOverdueOnly) {
        if (!window.FollowUp) return false;
        if (window.FollowUp.dueState(o, Date.now()).state !== 'overdue') return false;
      }
      if (S.oppQ) {
        var hay = [o.buyer.name, o.buyer.company, o.buyer.country, o.rawText].join(' ').toLowerCase();
        var words = S.oppQ.toLowerCase().split(/\s+/).filter(Boolean);
        for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return false;
      }
      return true;
    });
  }

  function oppRows() {
    var list = oppFiltered().slice();
    if (S.oppSort === 'priority') {
      var rank = { high: 0, mid: 1, low: 2, closed: 3 };
      list.sort(function (a, b) {
        var ra = scoreForOpp(a), rb = scoreForOpp(b);
        var la = rank[effLevelOf(a, ra).level], lb = rank[effLevelOf(b, rb).level];
        if (la !== lb) return la - lb;
        var ta = ra ? ra.total : 0, tb = rb ? rb.total : 0;
        if (tb !== ta) return tb - ta;
        return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
      });
    } else if (S.oppSort === 'follow' && window.FollowUp) {
      list.sort(function (a, b) {
        var ra = window.FollowUp.sortRank(a, Date.now());
        var rb = window.FollowUp.sortRank(b, Date.now());
        if (ra[0] !== rb[0]) return ra[0] - rb[0];
        if (ra[1] !== rb[1]) return ra[1] - rb[1];
        return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
      });
    } else if (S.oppSort === 'recent') {
      list.sort(function (a, b) {
        var ca = (a.status === 'won' || a.status === 'lost') ? 1 : 0;
        var cb = (b.status === 'won' || b.status === 'lost') ? 1 : 0;
        if (ca !== cb) return ca - cb;
        var ka = new Date(a.lastTouchAt || a.lastContactAt || a.updatedAt || a.createdAt);
        var kb = new Date(b.lastTouchAt || b.lastContactAt || b.updatedAt || b.createdAt);
        return kb - ka;
      });
    } else {
      list.sort(function (a, b) {
        var order = { new: 0, matched: 1, quoted: 2, won: 3, lost: 4 };
        var d = (order[a.status] || 9) - (order[b.status] || 9);
        if (d !== 0) return d;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
    }

    if (!list.length) {
      return '<tr><td colspan="7"><div class="empty">没有符合条件的商机</div></td></tr>';
    }

    return list.map(function (o) {
      var a = analyzeOpp(o);
      var top = a.ordered[0];
      var c = oppClass(o);
      var tierCls = c.tier === '大单' ? 'green' : c.tier === '批量单' ? 'green' :
        c.tier === '小批量' ? 'amber' : 'gray';

      var sc = scoreForOpp(o);
      var scEl = sc ? effLevelOf(o, sc) : null;
      var scBadge = scEl && scEl.level !== 'closed'
        ? ' <span class="badge ' + (scEl.level === 'high' ? 'red' : scEl.level === 'mid' ? 'amber' : 'gray') + '" title="价值评分 ' + sc.total + '（规则优先级分）">' +
          ({ high: '高优先', mid: '中优先', low: '低优先' })[scEl.level] + ' ' + sc.total + '</span>'
        : '';
      var fuLine = '';
      if (window.FollowUp) {
        var fuSt = window.FollowUp.deriveStatus(o);
        var fuDue = window.FollowUp.dueState(o, Date.now());
        if (fuSt === 'done') {
          fuLine = '<br><span style="color:#8a919e;font-size:11px">跟进：已完成</span>';
        } else {
          var fuTxt = '跟进：' + window.FollowUp.statusLabel(fuSt) +
            (o.followUpAt ? ' · 下次 ' + C.fmtDate(o.followUpAt) : ' · 未排下次');
          if (fuDue.state === 'overdue') fuTxt += ' · 逾期 ' + fuDue.days + ' 天';
          fuLine = '<br><span style="font-size:11px;color:' + (fuDue.state === 'overdue' ? '#b3352c' : '#8a919e') + '">' + esc(fuTxt) + '</span>';
        }
      }
      return '<tr>' +
        '<td>' + badge(o.status) + followChip(o) + scBadge + (C.isDemoOpp(o) ? ' <span class="badge amber">演示</span>' : '') + '</td>' +
        '<td><strong>' + esc(o.buyer.name) + '</strong><br>' +
        '<span style="color:#8a919e;font-size:11px">' + esc(o.buyer.company || '—') + '</span>' + fuLine + '</td>' +
        '<td>' + esc(c.country) + '<br><span style="color:#8a919e;font-size:11px">' + esc(o.buyer.channel || '') + '</span></td>' +
        '<td><span class="badge gray">' + esc(c.type) + '</span> ' +
        '<span class="badge ' + tierCls + '">' + esc(c.tier) + '</span></td>' +
        '<td>' + (top
          ? esc(top.product.title.slice(0, 42)) + ' <span class="badge ' +
          (top.match.modelHit ? 'green' : top.match.score > 55 ? 'amber' : 'gray') + '">' +
          (top.match.modelHit ? '型号 ' + top.match.score : top.match.score) + '</span>'
          : '<span style="color:#d92d20">无匹配</span>') + '</td>' +
        '<td class="num">' + (c.qty ? c.qty.toLocaleString() : '—') + '</td>' +
        '<td class="num">' + (o.deal && o.deal.netRmb ? C.money(o.deal.netRmb) : '—') + '</td>' +
        '<td class="actions"><button class="btn sm" data-action="open-opp" data-id="' + safeActionId(o.id) + '">打开</button></td>' +
        '</tr>';
    }).join('');
  }

  function oppSummary() {
    var s = st();
    /* 汇总口径跟随当前视图：真实视图不统计演示，演示视图不混真实 */
    var all = C.visibleOpps(s, S.dataView);
    if (!all.length) {
      return '<div class="card-bd" style="border-bottom:1px solid #f0f1f4">' +
        '<div class="grid grid-3" style="gap:16px">' +
        '<div><div style="font-size:11.5px;color:#8a919e;margin-bottom:6px">按国家</div><div class="chips">' +
        '<span class="chip" style="color:#b0b6c0">还没有数据</span></div></div>' +
        '<div><div style="font-size:11.5px;color:#8a919e;margin-bottom:6px">按品类</div><div class="chips">' +
        '<span class="chip" style="color:#b0b6c0">还没有数据</span></div></div>' +
        '<div><div style="font-size:11.5px;color:#8a919e;margin-bottom:6px">按订单量级</div><div class="chips">' +
        '<span class="chip" style="color:#b0b6c0">还没有数据</span></div></div>' +
        '</div>' +
        '<div class="alert info" style="margin-top:12px"><span class="ic">i</span><div>' +
        '新建一条商机后，系统会自动识别 <strong>国家</strong>、按匹配商品判断 <strong>品类</strong>、' +
        '按数量分出 <strong>样品单 / 小批量 / 批量单 / 大单</strong>。' +
        '</div></div></div>';
    }

    var byCountry = {}, byType = {}, byTier = {};
    all.forEach(function (o) {
      var c = oppClass(o);
      byCountry[c.country] = (byCountry[c.country] || 0) + 1;
      byType[c.type] = (byType[c.type] || 0) + 1;
      byTier[c.tier] = (byTier[c.tier] || 0) + 1;
    });

    function chips(map, sep) {
      return Object.keys(map).sort(function (a, b) { return map[b] - map[a]; }).slice(0, 8).map(function (k) {
        return '<span class="chip">' + esc(k) + ' <b>' + map[k] + '</b></span>';
      }).join(sep || ' ');
    }

    function block(title, map) {
      return '<div style="margin-bottom:10px"><div style="font-size:11.5px;color:#8a919e;margin-bottom:6px">' + title + '</div>' +
        '<div class="chips" style="gap:6px">' + chips(map) + '</div></div>';
    }

    return '<div class="card-bd" style="border-bottom:1px solid #f0f1f4">' +
      '<div class="grid grid-3" style="gap:16px">' +
      block('按国家', byCountry) + block('按品类', byType) + block('按订单量级', byTier) +
      '</div></div>';
  }

  function oppSelect(id, label, value, options) {
    return '<select id="' + id + '" style="height:32px;width:auto;min-width:120px;max-width:180px;flex:none">' +
      '<option value="">' + label + '</option>' +
      options.map(function (v) {
        return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(v) + '</option>';
      }).join('') + '</select>';
  }

  function viewOpps() {
    var s = st();
    var countries = [], types = [], tiers = [];
    C.visibleOpps(s, S.dataView).forEach(function (o) {
      var c = oppClass(o);
      if (countries.indexOf(c.country) < 0) countries.push(c.country);
      if (types.indexOf(c.type) < 0) types.push(c.type);
      if (tiers.indexOf(c.tier) < 0) tiers.push(c.tier);
    });

    var filters = '<div class="card-bd" style="padding:12px 18px">' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<input type="text" id="opp-search" value="' + esc(S.oppQ) + '" placeholder="搜买家 / 公司 / 原文" style="width:240px;flex:none;height:32px">' +
      oppSelect('opp-f-country', '全部国家', S.oppCountry, countries.sort()) +
      oppSelect('opp-f-type', '全部品类', S.oppType, types.sort()) +
      oppSelect('opp-f-tier', '全部量级', S.oppTier, ['样品单', '小批量', '批量单', '大单', '未填数量']) +
      oppSelect('opp-f-status', '全部状态', S.oppStatus, ['new', 'matched', 'quoted', 'won', 'lost']) +
      '<select id="opp-sort" style="width:auto;height:32px">' +
      [['default', '默认排序'], ['priority', '按优先级'], ['recent', '按最近活动'], ['follow', '按跟进时间']].map(function (x) {
        return '<option value="' + x[0] + '"' + (S.oppSort === x[0] ? ' selected' : '') + '>' + x[1] + '</option>';
      }).join('') + '</select>' +
      '<button class="btn sm' + (S.oppTodoOnly ? ' primary' : '') + '" data-action="toggle-todo">只看待跟进</button>' +
      '<button class="btn sm' + (S.oppOverdueOnly ? ' primary' : '') + '" data-action="toggle-overdue">只看已逾期</button>' +
      '<span id="opp-count" style="color:#8a919e;font-size:12px">显示 ' + oppFiltered().length + ' / ' + C.visibleOpps(s, S.dataView).length + ' 条（' + (S.dataView === 'demo' ? '演示数据' : '真实商机') + '）</span>' +
      '</div></div>';

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">商机<span class="card-sub">自动分类：国家 / 品类 / 订单量级</span></div>' +
      '<div class="row" style="gap:6px">' +
      '<button class="btn sm' + (S.dataView === 'real' ? ' primary' : '') + '" data-action="dataview" data-view="real">真实商机</button>' +
      '<button class="btn sm' + (S.dataView === 'demo' ? ' primary' : '') + '" data-action="dataview" data-view="demo">演示数据（' + C.visibleOpps(s, 'demo').length + '）</button>' +
      '<button class="btn sm primary" data-action="new-opp">+ 新建商机</button></div></div>' +
      (S.dataView === 'demo' ? '<div class="alert warn" style="margin:12px 18px 0"><span class="ic">!</span><div><strong>正在看演示数据。</strong>这些商机是示例，不计入经营统计，也不是真实客户；在演示里做的修改不会影响真实商机。</div></div>' : '') +
      oppSummary() + filters +
      '<div class="card-bd tight"><div class="table-wrap">' +
      '<table class="table"><thead><tr><th>状态</th><th>买家</th><th>市场</th><th>分类</th>' +
      '<th>匹配商品</th><th class="num">数量</th><th class="num">利润</th><th></th></tr></thead>' +
      '<tbody id="opp-body">' + (C.visibleOpps(s, S.dataView).length ? oppRows() : '<tr><td colspan="8"><div class="empty"><strong>' + (S.dataView === 'demo' ? '还没有演示商机' : '还没有商机') + '</strong>' + (S.dataView === 'demo' ? '演示数据来自示例集，可在工作台点「先看一个例子」生成。' : '从右上角新建。') + '</div></td></tr>') +
      '</tbody></table></div></div></section>';
  }
  /* =========================================================
     视图：商机详情
     ========================================================= */

  var tr = { status: 'idle', msg: '', done: 0, total: 0 };

  function paintTr() {
    var el = document.getElementById('tr-state');
    if (!el) return;
    if (tr.status === 'loading') {
      el.innerHTML = '<span style="color:#b7791f">翻译中' +
        (tr.total > 1 ? ' ' + tr.done + '/' + tr.total : '') + '…</span>';
    } else if (tr.status === 'ok') {
      el.innerHTML = '<span style="color:#0f9d58">已译成中文</span>';
    } else if (tr.status === 'error') {
      el.innerHTML = '<span style="color:#d92d20">翻译失败：' + esc(tr.msg) + '</span> ' +
        '<button class="btn sm ghost" data-action="tr-zh">重试</button>';
    } else {
      el.textContent = '';
    }
  }

  function paintRawText() {
    var el = document.getElementById('raw-block');
    if (!el) return;
    var opp = oppById(S.oppId);
    if (!opp) return;
    el.textContent = (S.oppLang === 'zh' && S.oppTextZh) ? S.oppTextZh : opp.rawText;
  }

  function runTranslation(opp) {
    tr = { status: 'loading', msg: '', done: 0, total: 0 };
    paintTr();

    window.Translate.text(opp.rawText, 'zh-CN', function (err, res) {
      if (S.oppId !== opp.id) return;
      if (err) {
        tr = { status: 'error', msg: err.message || '未知错误', done: 0, total: 0 };
        S.oppTextZh = null;
        S.oppLang = 'raw';
        paintTr();
        paintRawText();
        return;
      }
      S.oppTextZh = res.text;
      tr = { status: 'ok', msg: '', done: 0, total: 0 };
      paintTr();
      paintRawText();
    }, function (done, total) {
      if (S.oppId !== opp.id) return;
      tr = { status: 'loading', msg: '', done: done, total: total };
      paintTr();
    });
  }

  function ensureTranslation(opp) {
    if (!window.Translate || !opp) return;
    if (S.oppId === opp.id && (S.oppTextZh || tr.status === 'loading')) return;
    S.oppId = opp.id;
    S.oppTextZh = null;
    if (!window.Translate.needsTranslation(opp.rawText, 'zh-CN')) {
      tr = { status: 'idle', msg: '', done: 0, total: 0 };
      paintTr();
      return;
    }
    runTranslation(opp);
  }

  /* ---------------- 报价沙盘 ---------------- */

  function sandboxCard(ctx) {
    var r = ctx.pricing;
    if (!r || (r.flags && r.flags.noCost) || !(r.qty > 0)) return '';
    var fx = C.num(r.fx, 7.1);
    var fee = C.num(r.feeRate);
    var cost = C.num(ctx.product && ctx.product.costRmb) + C.num(ctx.opp.quote.shippingRmb);
    var qty = C.num(r.qty);
    var floor = C.num(r.floorUsd);
    var rec = C.num(r.recommendUsd) || floor * 1.1;

    var minP = Math.max(0.01, Math.round(floor * 0.85 * 100) / 100);
    var maxP = Math.round(Math.max(rec * 1.4, floor * 1.6) * 100) / 100;
    var curP = C.num(r.unitPriceUsd) || rec;

    return '<section class="card" data-pf="sandbox"><div class="card-hd">' +
      '<div class="card-title">报价沙盘<span class="card-sub">拖一下，看这一单赚多少、最多能让到哪</span></div>' +
      '</div><div class="card-bd">' +
      '<div class="grid grid-2" style="gap:18px">' +
      '<div><label style="font-size:11.5px;color:#8a919e">单价 USD <b id="sb-price-out" style="color:#111">' +
      C.usd(curP) + '</b></label>' +
      '<input type="range" id="sb-price" min="' + minP + '" max="' + maxP + '" step="0.01" value="' + curP +
      '" style="width:100%" data-opp="' + safeActionId(ctx.opp.id) + '"></div>' +
      '<div><label style="font-size:11.5px;color:#8a919e">数量 <b id="sb-qty-out" style="color:#111">' +
      qty.toLocaleString() + '</b></label>' +
      '<input type="range" id="sb-qty" min="1" max="' + Math.max(qty * 3, 100) + '" step="1" value="' + qty +
      '" style="width:100%" data-opp="' + safeActionId(ctx.opp.id) + '"></div>' +
      '</div>' +
      '<div id="sb-result" style="margin-top:16px"></div>' +
      '<div style="font-size:11px;color:#8a919e;margin-top:10px">保本价 ' + C.usd(floor) +
      ' · 平台扣费 ' + C.pct(fee) + ' · 成本 ' + C.money(cost) + '/件</div>' +
      '</div></section>';
  }

  function sandboxResult(ctx, price, qty) {
    var fx = C.num(ctx.pricing.fx, 7.1);
    var fee = C.num(ctx.pricing.feeRate);
    var cost = C.num(ctx.product && ctx.product.costRmb) + C.num(ctx.opp.quote.shippingRmb);
    var floor = C.num(ctx.pricing.floorUsd);

    var revenue = price * qty * fx * (1 - fee);
    var costTotal = cost * qty;
    var net = C.round2(revenue - costTotal);
    var perUnit = qty > 0 ? C.round2(net / qty) : 0;
    var margin = costTotal > 0 ? net / costTotal : 0;

    /* 每件至少赚 20 元时的最高让价 */
    var keep20 = C.round2((cost + 20) / (fx * (1 - fee)));

    var bad = net < 0;
    return '<div class="grid grid-3" style="gap:14px">' +
      '<div><div style="font-size:11px;color:#8a919e">这一单净利</div>' +
      '<div style="font-size:24px;font-weight:700;color:' + (bad ? '#d92d20' : '#0f9d58') + '">' +
      C.money(net) + '</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">每件赚</div>' +
      '<div style="font-size:24px;font-weight:700;color:' + (perUnit < 0 ? '#d92d20' : '#111') + '">' +
      C.money(perUnit) + '</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">毛利率</div>' +
      '<div style="font-size:24px;font-weight:700">' + C.pct(margin) + '</div></div>' +
      '</div>' +
      '<div class="alert ' + (bad ? 'warn' : 'info') + '" style="margin-top:14px"><span class="ic">i</span><div>' +
      (bad
        ? '低于保本价，这一单要亏 <b>' + C.money(Math.abs(net)) + '</b>。<br>'
        : '') +
      '这个数量下，<b>最低不能低于 ' + C.usd(floor) + '</b>（保本）。' +
      '想每件至少赚 ¥20，最多只能让到 <b>' + C.usd(keep20) + '</b>。' +
      '</div></div>';
  }

  /* ---------------- 客户档案 ---------------- */

  function buyerKey(o) {
    var b = (o && o.buyer) || {};
    return String(b.company || b.name || '').trim().toLowerCase();
  }

  function buyerProfile(opp) {
    var key = buyerKey(opp);
    var s = st();
    /* 往来记录不跨隔离聚合：演示买家与真实买家同名也不合并 */
    var mine = (s.opportunities || []).filter(function (o) { return buyerKey(o) === key && C.isDemoOpp(o) === C.isDemoOpp(opp); });
    var names = [buyerKey(opp), String((opp.buyer && opp.buyer.name) || '').trim().toLowerCase()]
      .filter(Boolean);
    var orders = (s.orders || []).filter(function (o) {
      var ob = String(o.buyer || '').trim().toLowerCase();
      return ob && names.indexOf(ob) >= 0 && C.isDemoOrder(o) === C.isDemoOpp(opp);
    });

    var won = mine.filter(function (o) { return o.status === 'won'; });
    var lost = mine.filter(function (o) { return o.status === 'lost'; });
    var gmv = orders.reduce(function (a, o) { return a + C.num(o.amountUsd) - Math.min(C.num(o.refundUsd), C.num(o.amountUsd)); }, 0);
    var profit = orders.reduce(function (a, o) { return a + C.num(o.netRmb); }, 0);

    return {
      key: key,
      inquiries: mine.length,
      won: won.length,
      lost: lost.length,
      orders: orders.length,
      gmv: C.round2(gmv),
      profit: C.round2(profit),
      list: mine.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, 5)
    };
  }

  function buyerCard(opp) {
    /* P1-3C：买家未识别隔离。聚合键为空或字面「未知买家」时不聚合——
       所有未命名商机共用同一个键，聚合会把它们捏成一个虚假回头客
       （客户中心 R3-07 已避开此合并，详情卡在此对齐）。 */
    var bKey = buyerKey(opp);
    if (!bKey || bKey === '未知买家') {
      return '<section class="card"><div class="card-hd">' +
        '<div class="card-title">这个买家<span class="card-sub">买家未识别</span></div></div>' +
        '<div class="card-bd"><div style="font-size:12.5px;color:#6b7280">' +
        '这条商机还没有填写买家称呼或公司，无法关联同一买家的历史询盘。补填买家称呼或公司后，才能按买家聚合其历史询盘、成交与利润。' +
        '</div></div></section>';
    }
    var p = buyerProfile(opp);
    if (p.inquiries <= 1 && p.orders === 0) {
      return '<section class="card"><div class="card-hd">' +
        '<div class="card-title">这个买家<span class="card-sub">第一次来</span></div></div>' +
        '<div class="card-bd"><div style="font-size:12.5px;color:#6b7280">' +
        '之前没有记录。先把需求问清楚：用途、数量、目标市场、要不要认证。' +
        '</div></div></section>';
    }

    var rows = p.list.map(function (o) {
      var qty = (o.quote && o.quote.qty) || 0;
      var price = (o.quote && o.quote.unitPriceUsd) || 0;
      /* P1-3C：历史行补商品名，商品名即链接（fwOppLink 跳该行商机本身）。
         商品名只认该行商机自己的 selectedProductId 在实时目录中的记录；
         未选或商品已删除时显示占位「未记录商品」，绝不回退其他候选，
         以免在历史里显示错误商品。 */
      var prod = o.selectedProductId ? productById(o.selectedProductId) : null;
      var prodName = prod ? (prod.title || prod.titleEn || prod.sku || '未记录商品') : '未记录商品';
      return '<tr><td style="color:#8a919e;font-size:11px">' + esc(C.fmtDate(o.createdAt)) + '</td>' +
        '<td>' + fwOppLink(o, prodName) + '</td>' +
        '<td>' + esc((o.quote && o.quote.incoterm) || '') + ' ' +
        (price ? C.usd(price) : '—') + '</td>' +
        '<td class="num">' + (qty ? qty.toLocaleString() : '—') + '</td>' +
        '<td>' + badge(o.status) + '</td></tr>';
    }).join('');

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">这个买家<span class="card-sub">' + esc(opp.buyer.company || opp.buyer.name) + '</span></div>' +
      '</div><div class="card-bd">' +
      '<div class="grid grid-4" style="gap:12px">' +
      '<div><div style="font-size:11px;color:#8a919e">询盘</div><div style="font-size:20px;font-weight:700">' + p.inquiries + ' 次</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">成交</div><div style="font-size:20px;font-weight:700">' + p.won + ' 次</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">累计成交额</div><div style="font-size:20px;font-weight:700">' + C.usd(p.gmv) + '</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">累计利润</div>' +
      '<div style="font-size:20px;font-weight:700;color:' + (p.profit < 0 ? '#d92d20' : '#0f9d58') + '">' +
      C.money(p.profit) + '</div></div>' +
      '</div>' +
      (rows ? '<div class="table-wrap" style="margin-top:14px"><table class="table">' +
        '<thead><tr><th>时间</th><th>商品</th><th>报价</th><th class="num">数量</th><th>状态</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>' : '') +
      '<div style="margin-top:10px;font-size:11px;color:#8a919e">按买家公司/称呼聚合：同名不同人可能混在一组，同一人改名可能被拆开；正式客户档案将在接入稳定标识后启用。</div>' +
      '</div></section>';
  }

  function ctxWithQty(opp, qty) {
    var clone = JSON.parse(JSON.stringify(opp));
    clone.quote.qty = qty;
    return ctxFor(clone);
  }

  function initSandbox(oppId) {
    var box = document.getElementById('sb-result');
    if (!box) return;
    var opp = oppById(oppId);
    if (!opp) return;
    var price = C.num((document.getElementById('sb-price') || {}).value);
    var qty = C.num((document.getElementById('sb-qty') || {}).value);
    if (!(price > 0)) return;
    box.innerHTML = sandboxResult(ctxWithQty(opp, qty), price, qty);
  }

  function marketLine(p, r) {
    var m = marketRefOf(p);
    var fx = C.num(st().settings.fxRate, 7.1);
    if (!m) return '';

    var marketUsd = m.median / fx;
    var quote = C.num(r && r.unitPriceUsd);
    var cmp = '';
    if (quote > 0 && marketUsd > 0) {
      var d = (quote / marketUsd - 1) * 100;
      if (d > 12) cmp = '<span style="color:#d92d20">你的报价比市场高 ' + d.toFixed(0) + '%</span>';
      else if (d < -12) cmp = '<span style="color:#0f9d58">比市场低 ' + Math.abs(d).toFixed(0) + '%</span>';
      else cmp = '<span style="color:#8a919e">和市场差不多</span>';
    }

    return '<div class="alert info" style="padding:10px 12px"><span class="ic">¥</span><div>' +
      '<strong>市场参考价 ' + C.money(m.median) + '</strong>（' +
      C.money(m.low) + '–' + C.money(m.high) + '，' + m.source + ' ' + m.n + ' 条）' +
      ' ≈ <b>' + C.usd(marketUsd) + '</b>/pc' +
      (cmp ? '<br>' + cmp : '') +
      '<br><span style="font-size:11px;color:#8a919e">淘宝/闲鱼同款零售价中位数，不是你的成本，也不是阿里挂牌价</span>' +
      '</div></div>';
  }

  function viewOppDetail(id) {
    var opp = oppById(id);
    if (!opp) return '<div class="empty">商机不存在。<a href="#/opps">返回列表</a></div>';

    prepareOpp(opp);
    var ctx = ctxFor(opp);
    var r = ctx.pricing;
    var p = ctx.product;
    var a = analyzeOpp(opp);

    /* ---- 头部 ---- */
    var head = '<section class="card"><div class="card-bd">' +
      '<div class="opp-head">' +
      '<div><div class="opp-title">' + esc(opp.buyer.name) +
      (opp.buyer.company ? ' <span style="color:#8a919e;font-weight:400;font-size:13px">· ' + esc(opp.buyer.company) + '</span>' : '') +
      '</div><div class="opp-meta">' +
      '<span>' + badge(opp.status) + '</span>' +
      '<span>' + esc(opp.buyer.country || '未知市场') + '</span>' +
      '<span>' + esc(opp.buyer.channel) + '</span>' +
      '<span>创建于 ' + C.fmtDate(opp.createdAt, true) + '</span>' +
      '</div></div>' +
      '<div class="row">' +
      '<button class="btn" data-action="gen-reply" data-lang="zh">生成中文回复</button>' +
      '<button class="btn" data-action="gen-reply" data-lang="en">生成英文回复</button>' +
      '<button class="btn" data-action="print-quote" data-id="' + safeActionId(opp.id) + '">报价单</button>' +
      '<button class="btn" data-action="open-follow" data-id="' + safeActionId(opp.id) + '">记录跟进</button>' +
      (opp.status !== 'quoted' && opp.status !== 'won'
        ? '<button class="btn primary" data-action="mark-quoted" data-id="' + safeActionId(opp.id) + '">标记已报价</button>' : '') +
      '<button class="btn" data-action="open-settle" data-id="' + safeActionId(opp.id) + '">成交</button>' +
      '<button class="btn danger" data-action="open-lose" data-id="' + safeActionId(opp.id) + '">丢单</button>' +
      '<button class="icon-btn" data-action="delete-opp" data-id="' + safeActionId(opp.id) + '" title="删除">×</button>' +
      '</div></div></div></section>';

    /* ---- 左：原文 + 解析 ---- */
    var parsedChips = [];
    parsedChips.push(chip('数量', a.parsed.qty ? a.parsed.qty.toLocaleString() : '未识别',
      a.parsed.qty ? '' : 'bad'));
    parsedChips.push(chip('目标价', a.parsed.targetPriceUsd ? C.usd(a.parsed.targetPriceUsd) : '未识别',
      a.parsed.targetPriceUsd ? '' : ''));
    parsedChips.push(chip('交期', a.parsed.leadTimeDays ? a.parsed.leadTimeDays + ' 天' : '未识别', ''));
    parsedChips.push(chip('认证', a.parsed.certs.length ? a.parsed.certs.join(' / ') : '未要求', ''));
    parsedChips.push(chip('术语', a.parsed.incoterm || '未指定', ''));
    parsedChips.push(chip('市场', a.parsed.country || '未识别', ''));

    var left = card('买家原始需求', '从询盘 / RFQ 原文自动解析',
      '<div class="row" style="gap:6px;margin-bottom:8px">' +
      '<button class="btn sm ' + (S.oppLang === 'zh' ? 'primary' : 'ghost') + '" data-action="tr-zh">中文</button>' +
      '<button class="btn sm ' + (S.oppLang !== 'zh' ? 'primary' : 'ghost') + '" data-action="tr-raw">原文</button>' +
      '<span id="tr-state" style="font-size:11.5px;color:#8a919e;align-self:center"></span>' +
      '</div>' +
      '<div class="rawtext" id="raw-block">' +
      esc(S.oppLang === 'zh' && S.oppTextZh ? S.oppTextZh : opp.rawText) + '</div>' +
      '<div class="chips" style="margin-top:12px">' + parsedChips.join('') + '</div>',
      '<button class="btn sm ghost" data-action="edit-opp" data-id="' + safeActionId(opp.id) + '">编辑原文</button>');

    /* ---- 右：定价面板 ---- */
    var right = '<section class="card" id="pricing-card">' +
      '<div class="card-hd"><div class="card-title">定价测算' +
      '<span class="card-sub">' + (p ? esc(p.sku) : '未选品') + '</span></div>' +
      '<button class="btn sm ghost" data-action="apply-recommend" data-id="' + safeActionId(opp.id) + '">用建议价</button></div>' +
      '<div class="card-bd stack">' +
      '<div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<span style="font-size:12px;color:var(--ink-3)">去别的平台比价：</span>' + searchLinks(ctx) + '</div>' +
      marketLine(p, r) +
      '<div class="form-grid">' +
      '<div class="field"><label>数量 (pcs)</label>' +
      '<input type="number" min="1" step="1" value="' + opp.quote.qty + '" data-opp="' + safeActionId(opp.id) + '" data-field="qty"></div>' +
      '<div class="field"><label>你的报价 (USD)</label>' +
      '<input type="number" min="0" step="0.01" value="' + C.round(r.unitPriceUsd, 2) + '" data-opp="' + safeActionId(opp.id) + '" data-field="unitPriceUsd"></div>' +
      '<div class="field"><label>采购成本（元/件，1688 查的）</label>' +
      '<input type="number" min="0" step="0.01" value="' + (C.num(opp.quote.costRmb) || '') + '" data-opp="' + safeActionId(opp.id) + '" data-field="costRmb"></div>' +
      '<div class="field"><label>别家卖多少（元/件）</label>' +
      '<input type="number" min="0" step="0.01" value="' + (C.num(p && p.marketPriceRmb) || '') + '" data-opp="' + safeActionId(opp.id) + '" data-field="marketPriceRmb"></div>' +
      '<div class="field"><label>国内运费（元/件）</label>' +
      '<input type="number" min="0" step="0.01" value="' + (C.num(opp.quote.shippingRmb) || 0) + '" data-opp="' + safeActionId(opp.id) + '" data-field="shippingRmb"></div>' +
      '<div class="field"><label>贸易术语</label>' +
      '<input type="text" value="' + esc(opp.quote.incoterm || '') + '" data-opp="' + safeActionId(opp.id) + '" data-field="incoterm"></div>' +
      '<div class="field"><label>交期（天，0 = 待确认）</label>' +
      '<input type="number" min="1" value="' + (opp.quote.leadTimeDays || 0) + '" data-opp="' + safeActionId(opp.id) + '" data-field="leadTimeDays"></div>' +
      '</div>' +
      '<div data-pf="split">' + rangeBarHtml(ctx) + '</div>' +
      '<div data-pf="floors">' + floorsHtml(ctx) + '</div>' +
      '<div data-pf="profit">' + profitHtml(ctx) + '</div>' +
      '<div data-pf="flags">' + flagsHtml(ctx) + '</div>' +
      '<div data-pf="versions">' + versionsHtml(opp) + '</div>' +
      '<div data-pf="nego">' + negBlock(ctx) + '</div>' +
      '</div></section>';

    /* ---- 匹配列表：只显示相关度够高的，避免一堆 0 分占地方 ---- */
    /* ---- 智能匹配（阶段二）：候选池仍来自现有 Matching，
       排序与评分换成 SmartMatch 的多维规则分（人工修正优先），
       自动选品与报价拦截仍走原有管线，不在这里改动 ---- */
    var effP = effectiveParsed(opp, a);
    var pool = a.ordered.slice(0, 10);
    if (opp.selectedProductId && !pool.some(function (x) { return x.product.id === opp.selectedProductId; })) {
      var selP = productById(opp.selectedProductId);
      if (selP) pool.push({ product: selP, match: null });
    }
    var ranked = [];
    if (window.SmartMatch && pool.length) {
      ranked = window.SmartMatch.rank(effP, opp.rawText || '', pool);
    } else {
      ranked = pool.map(function (x) {
        return { product: x.product, result: { score: x.match ? x.match.score : 0, level: '中', keyConflict: !!(x.match && x.match.hardFail), dims: {}, hits: x.match ? (x.match.reasons || []) : [], conflicts: x.match ? (x.match.gaps || []) : [], unconfirmed: [], questions: [] } };
      });
    }
    var visibleRanked = ranked.slice(0, 5);
    var hiddenRanked = ranked.length - visibleRanked.length;

    function dimChips(r) {
      var sym = { hit: '✓', part: '◐', conflict: '✗', unknown: '?', miss: '✗', na: '' };
      var cls = { hit: 'good', part: '', conflict: 'bad', unknown: '', miss: 'bad', na: '' };
      return Object.keys(r.dims || {}).map(function (k) {
        var d = r.dims[k];
        if (!d || d.status === 'na') return '';
        return '<span class="chip ' + cls[d.status] + '">' + d.label + ' ' + sym[d.status] +
          (d.max ? ' ' + d.score + '/' + d.max : '') + '</span>';
      }).join('');
    }
    function listHtml(title, items, cls, limit) {
      if (!items || !items.length) return '';
      var show = items.slice(0, limit);
      var more = items.length - show.length;
      return '<div class="sm-list ' + cls + '"><span class="sm-list-t">' + title + '</span>' +
        show.map(esc).join('；') + (more > 0 ? '；等 ' + items.length + ' 项' : '') + '</div>';
    }

    var matchHtml = visibleRanked.length
      ? visibleRanked.map(function (x) {
        var p = x.product, r = x.result;
        var sel = p.id === opp.selectedProductId;
        var cls = r.keyConflict ? 'conflict' : r.level === '高' ? 'hi' : r.level === '中' ? 'mid' : 'lo';
        var base = pool.filter(function (y) { return y.product.id === p.id; })[0];
        var tags = [];
        if (base && base.match) {
          if (base.match.hardFail) tags.push('<span class="chip bad">不可报价</span>');
          else if (base.match.quotable) tags.push('<span class="chip good">可报价</span>');
          else tags.push('<span class="chip bad">待补成本</span>');
        }
        if (sel) tags.push('<span class="chip good">已选为报价商品</span>');
        if (r.keyConflict) tags.push('<span class="chip bad">关键冲突</span>');
        return '<div class="match-item' + (sel ? ' selected' : '') + '" data-action="select-product" data-id="' +
          safeActionId(p.id) + '" data-opp="' + safeActionId(opp.id) + '" title="点击选为报价商品">' +
          '<div class="match-score ' + cls + '">' + r.score + '</div>' +
          '<div class="match-body">' +
          '<div class="match-name">' + esc(p.title) +
          ' <span class="badge ' + (r.level === '高' ? 'green' : r.level === '中' ? 'amber' : 'gray') + '">匹配' + r.level + '</span></div>' +
          '<div class="match-sku">' + esc(p.sku) + ' · ' + esc(p.category) +
          ' · ' + (p.priceFloorUsd > 0 ? C.usd(p.priceFloorUsd) + '–' + C.usd(p.priceUsd) : '橱窗价 ' + C.usd(p.priceUsd)) + ' · MOQ ' + p.moq + '</div>' +
          '<div class="chips" style="margin-top:6px">' + dimChips(r) + tags.join('') + '</div>' +
          listHtml('符合：', r.hits, 'ok', 4) +
          listHtml('不符合：', r.conflicts, 'bad', 4) +
          listHtml('未确认：', r.unconfirmed, 'mute', 3) +
          listHtml('需确认：', r.questions, 'warn', 2) +
          '</div></div>';
      }).join('') +
      (hiddenRanked > 0
        ? '<div style="padding:10px 14px;font-size:11.5px;color:var(--ink-3);border-top:1px solid #f0f1f4">' +
        '另外 ' + hiddenRanked + ' 个候选匹配度较低，已折叠</div>'
        : '')
      : '<div class="empty"><strong>没有匹配到商品</strong>可能是品类不在你的橱窗里，先到「商品库」补充。</div>';

    /* 匹配依据来源：人工修正过的字段明确标注，与原文冲突时以修正为准 */
    var srcBits = [];
    function srcBit(label, present, editKey) {
      if (present) srcBits.push(label + '（' + (effP.edited[editKey] ? '人工修正' : '自动识别') + '）');
    }
    srcBit('商品名', !!effP.productName, 'productName');
    srcBit('型号', effP.models.length > 0, 'modelsText');
    srcBit('数量', effP.qty > 0, 'qty');
    srcBit('规格', effP.specs.length > 0 || !!effP.specsText, 'specsText');
    srcBit('认证', effP.certs.length > 0, 'certsText');
    srcBit('用途', !!effP.purpose, 'purpose');
    var selRanked = ranked.filter(function (x) { return x.product.id === opp.selectedProductId; })[0];
    var selWarn = selRanked && selRanked.result.keyConflict
      ? '<div class="alert danger" style="margin:12px 14px 0"><span class="ic">!</span><div>' +
        '<strong>当前已选商品存在关键冲突：</strong>' + selRanked.result.conflicts.map(esc).join('；') +
        '。建议先看下面候选重新选择，或人工核对后再报价。</div></div>'
      : '';

    var matchCard = '<section class="card"><div class="card-hd">' +
      '<div class="card-title">智能匹配<span class="card-sub">规则匹配度，不是成交概率；点任意候选即选为报价商品</span></div>' +
      '<span class="row" style="gap:8px"><span class="badge gray">' + visibleRanked.length + ' 个候选</span>' +
      '<button class="btn sm" data-action="rematch" data-id="' + safeActionId(opp.id) + '">重新匹配</button></span></div>' +
      (srcBits.length ? '<div style="padding:10px 14px 0;font-size:11.5px;color:var(--ink-3)">匹配依据：' +
        srcBits.map(esc).join(' · ') + '；原始询盘文本作辅助依据</div>' : '') +
      selWarn +
      '<div class="card-bd tight">' + matchHtml + '</div></section>';

    /* ---- 数量阶梯 ---- */
    var extra = '<section class="card">' +
      '<div class="card-hd"><div class="card-title">数量阶梯<span class="card-sub">' +
      '同样的价，客户要多你多赚</span></div></div>' +
      '<div class="card-bd tight" data-pf="ladder">' + ladderHtml(ctx) + '</div></section>';

    /* ---- 下方：草稿 / 报价单 / 话术 ---- */
    var tabs = '<section class="card">' +
      '<div class="tabs">' +
      tabBtn('en', '英文回复', opp) + tabBtn('zh', '中文回复', opp) +
      tabBtn('nego', '议价话术', opp) + tabBtn('quote', '报价单预览', opp) +
      tabBtn('log', '操作记录', opp) +
      '</div><div class="card-bd" id="tab-body">' + tabBody(ctx) + '</div></section>';

    return '<div class="stack">' + head +
      (C.isDemoOpp(opp) ? '<div class="alert warn"><span class="ic">!</span><div><strong>演示数据</strong>：这条商机来自演示数据集，不是真实客户，不计入经营统计。在这里的编辑、跟进和报价演练都不会影响真实商机。</div></div>' : '') +
      quoteBannerHtml(opp) + '<div data-pf="verdict">' + verdictHtml(ctx) + '</div>' +
      '<div data-pf="judge">' + (window.Judge ? window.Judge.render(ctx) : '') + '</div>' +
      oppScoreCard(opp) +
      '<div class="grid grid-2 top">' + left + right + '</div>' +
      parseCard(opp, a, effP) +
      salesCard(opp, a, effP) +
      buyerCard(opp) + followCard(opp) + sandboxCard(ctx) + matchCard + extra + replyAssistantCard(opp, ctx) + tabs + '</div>';
  }

  /* 详情页第一眼：能不能报、报多少、赚多少 */
  function verdictHtml(ctx) {
    var r = ctx.pricing;
    var s = ctx.settings;
    var incoterm = (ctx.opp.quote && ctx.opp.quote.incoterm) || s.defaultIncoterm;

    if (r.flags.noCost) {
      return '<div class="verdict">' +
        '<div><div class="v-kicker">第 1 步</div>' +
        '<div class="v-price" style="font-size:22px;color:var(--ink-2)">先去查成本</div>' +
        '<div class="v-sub">1688 / 淘宝 / 闲鱼搜这个货，看多少钱一件</div></div>' +
        '<div><div class="v-kicker">要查什么</div>' +
        '<div class="v-net" style="font-size:15px">单价 + 起订量 + 有没有货</div>' +
        '<div class="v-sub">填进来立刻算保本价</div></div>' +
        '<div><div class="v-kicker">平台扣费</div>' +
        '<div class="v-net" style="font-size:17px">' + C.pct(r.feeRate) + '</div>' +
        '<div class="v-sub">保本价 = 成本 ÷ ' + (1 - r.feeRate).toFixed(2) + '</div></div>' +
        '</div>';
    }

    if (!r.qty || !r.unitPriceUsd) {
      return '<div class="verdict"><div><div class="v-kicker">结论</div>' +
        '<div class="v-price" style="font-size:22px;color:var(--ink-2)">先填数量和报价</div>' +
        '<div class="v-sub">下面的测算会实时更新</div></div><div></div><div></div></div>';
    }

    if (!r.flags.canQuote) {
      return '<div class="verdict bad">' +
        '<div><div class="v-kicker">这个价要亏</div>' +
        '<div class="v-price">' + C.usd(r.unitPriceUsd) + '</div>' +
        '<div class="v-sub">比保本价低 ' + Math.abs((r.unitPriceUsd / r.floorUsd - 1) * 100).toFixed(1) + '%</div></div>' +
        '<div><div class="v-kicker">保本价（成本 ÷ ' + (1 - r.feeRate).toFixed(2) + '）</div>' +
        '<div class="v-net">' + C.usd(r.floorUsd) + '</div>' +
        '<div class="v-sub">低于这个数就亏</div></div>' +
        '<div><div class="v-kicker">按建议价 ' + C.usd(r.recommendUsd) + ' 报，你赚</div>' +
        '<div class="v-net" style="font-size:20px;color:var(--ok)">' +
        C.money(Math.max(0, r.recommendUsd * r.qty * r.fx * (1 - r.feeRate) - r.costTotalRmb)) + '</div>' +
        '<div class="v-sub">这一单总利润</div></div></div>';
    }

    /* 统一口径判定：Pricing 自己的 canQuote 只看保本价；登记底价与关键冲突
       也必须拦在这里，否则结论横幅会和报价底线打架 */
    if (ctx.unity && !ctx.unity.quotable) {
      var u = ctx.unity;
      return '<div class="verdict bad">' +
        '<div><div class="v-kicker">暂不可报</div>' +
        '<div class="v-price">' + C.usd(u.unitUsd) + '</div>' +
        '<div class="v-sub">' + esc(u.blockReasons.join('；')) + '</div></div>' +
        '<div><div class="v-kicker">报价底线（统一口径）</div>' +
        '<div class="v-net">' + C.usd(u.quoteFloorUsd) + '</div>' +
        '<div class="v-sub">保本价 ' + C.usd(u.breakEvenUsd) + (u.businessFloorUsd > 0 ? ' · 登记底价 ' + C.usd(u.businessFloorUsd) : '') + '，取高者</div></div>' +
        '<div><div class="v-kicker">参考售价</div>' +
        '<div class="v-net" style="font-size:17px">' + C.usd(u.listUsd) + '</div>' +
        '<div class="v-sub">橱窗挂牌价，不是底线</div></div>' +
        '</div>';
    }

    var isAuto = ctx.opp.quote && ctx.opp.quote.autoPrice !== false;
    return '<div class="verdict ok">' +
      '<div><div class="v-kicker">' + (isAuto ? '建议报价' : '当前报价') + '</div>' +
      '<div class="v-price">' + C.usd(r.unitPriceUsd) + '<span>/pc</span></div>' +
      '<div class="v-sub">' + r.qty.toLocaleString() + ' pcs · ' + esc(incoterm) +
      ' · 成交额 ' + C.usd(r.gmvUsd) + '</div></div>' +
      '<div><div class="v-kicker">这一单你赚</div>' +
      '<div class="v-net">' + C.money(r.netRmb) + '</div>' +
      '<div class="v-sub">成本 ' + C.money(r.costTotalRmb) + ' · 平台扣 ' + C.money(r.feeRmb) + '</div></div>' +
      '<div><div class="v-kicker">保本价</div>' +
      '<div class="v-floor">' + C.usd(r.floorUsd) + '</div>' +
      '<div class="v-sub">低于这个数就亏</div></div>' +
      '</div>';
  }
  function chip(label, value, cls) {
    return '<span class="chip ' + (cls || '') + '">' + esc(label) + ' <b>' + esc(value) + '</b></span>';
  }

  function floorsHtml(ctx) {
    var r = ctx.pricing;
    if (r.flags.noCost) {
      return '<div class="priceline ceiling"><div class="pl-label">还没法算' +
        '<small>填上采购成本，这里会显示保本价和建议价</small></div>' +
        '<div class="pl-val">—</div></div>';
    }

    var uh = '';
    if (ctx.unity) {
      var uu = ctx.unity;
      uh = '<div class="priceline ' + (uu.quotable ? 'suggest' : 'floor') + '"><div class="pl-label">' +
        (uu.quotable ? '可报价（全站统一口径）' : '不可报价') +
        '<small>' + (uu.quotable
          ? '当前报价 ' + C.usd(uu.unitUsd) + ' ≥ 报价底线 ' + C.usd(uu.quoteFloorUsd) + ' · USD/pc · ' + uu.qty.toLocaleString() + ' pcs · 含平台佣金口径'
          : esc(uu.blockReasons.join('；'))) + '</small></div>' +
        '<div class="pl-val">' + (uu.quotable ? '可报' : '禁报') + '</div></div>' +
        '<div class="priceline floor"><div class="pl-label">报价底线（统一口径）' +
        '<small>保本价 ' + C.usd(uu.breakEvenUsd) + (uu.businessFloorUsd > 0 ? ' 与登记底价 ' + C.usd(uu.businessFloorUsd) : '') + ' 取高 · USD/pc</small></div>' +
        '<div class="pl-val">' + C.usd(uu.quoteFloorUsd) + '</div></div>' +
        (uu.businessFloorUsd > 0 ? '<div class="priceline ceiling"><div class="pl-label">商品登记底价' +
          '<small>价格区间下限 · 让价红线，低于它报价需特批</small></div>' +
          '<div class="pl-val">' + C.usd(uu.businessFloorUsd) + '</div></div>' : '') +
        (uu.negoFloorUsd ? '<div class="priceline ceiling"><div class="pl-label">谈判底线（提示线）' +
          '<small>含最低毛利' + (uu.minMarginPct != null ? ' ' + Math.round(uu.minMarginPct) + '%' : '') + '目标 · 不是保本硬线，别和报价底线混用</small></div>' +
          '<div class="pl-val">' + C.usd(uu.negoFloorUsd) + '</div></div>' : '') +
        uu.warnings.map(function (w) {
          return '<div style="font-size:12px;color:#9a6a00;background:#fdf6e0;border:1px solid #f0dfae;border-radius:8px;padding:7px 10px">' + esc(w) + '</div>';
        }).join('');
    }

    return '<div class="stack" style="gap:8px">' + uh +
      '<div class="priceline floor"><div class="pl-label">保本价（低于此价必亏）' +
      '<small>成本 ' + C.money(r.costUnitRmb) + '/件 ÷ ' + (1 - r.feeRate).toFixed(2) + ' ÷ ' + r.fx.toFixed(2) + '</small></div>' +
      '<div class="pl-val">' + C.usd(r.floorUsd) + '</div></div>' +
      '<div class="priceline suggest"><div class="pl-label">建议报价' +
      '<small>' + (function () {
        var tgt = r.fx > 0 ? (r.costUnitRmb + r.profitPerUnitRmb) / (1 - r.feeRate) / r.fx : 0;
        if (tgt > r.recommendUsd + 0.005) {
          return '想赚 ' + C.money(r.profitPerUnitRmb) + '/件 得报 ' + C.usd(tgt) +
            '，但你的挂牌价只有 ' + C.usd(r.listUsd) + '，这里只能按挂牌价封顶——先调价';
        }
        return '（成本 ' + C.money(r.costUnitRmb) + ' + 想赚 ' + C.money(r.profitPerUnitRmb) + '/件）÷ ' + (1 - r.feeRate).toFixed(2);
      })() + '</small></div>' +
      '<div class="pl-val">' + C.usd(r.recommendUsd) + '</div></div>' +
      (r.listUsd > 0
        ? '<div class="priceline ceiling"><div class="pl-label">你的挂牌价' +
        '<small>客户在阿里上看到的价格' + (r.marketUsd > 0 ? ' · 比市场' + (r.listUsd >= r.marketUsd ? '高 ' : '低 ') + Math.abs((r.listUsd / r.marketUsd - 1) * 100).toFixed(1) + '%' : '') + '</small></div>' +
        '<div class="pl-val">' + C.usd(r.listUsd) + '</div></div>'
        : '') +
      (r.marketUsd > 0
        ? '<div class="priceline' + (r.flags.aboveMarket ? ' floor' : ' suggest') + '"><div class="pl-label">别家卖多少' +
        '<small>' + C.money(r.marketPriceRmb) + '/件 · 换算成美元' +
        (r.marketGapPct !== null ? ' · 建议价比市场' + (r.marketGapPct >= 0 ? '高 ' : '低 ') + Math.abs(r.marketGapPct * 100).toFixed(1) + '%' : '') +
        '</small></div>' +
        '<div class="pl-val">' + C.usd(r.marketUsd) + '</div></div>'
        : '') +
      '</div>';
  }

  function profitHtml(ctx) {
    var r = ctx.pricing;
    if (r.flags.noCost) return '';

    var bad = r.netRmb < 0;
    return '<div class="profit-box' + (bad ? ' bad' : '') + '">' +
      '<div><div class="pb-label">这一单' + (bad ? '亏' : '赚') + '（扣完成本和平台费）</div>' +
      '<div class="pb-val">' + C.money(Math.abs(r.netRmb)) + '</div>' +
      '<div class="pb-sub">收款 ' + C.money(r.gmvRmb) + ' − 平台扣 ' + C.money(r.feeRmb) +
      ' − 成本 ' + C.money(r.costTotalRmb) + '</div></div>' +
      '<div style="text-align:right"><div class="pb-label">每件' + (bad ? '亏' : '赚') + '</div>' +
      '<div class="pb-val" style="font-size:16px">' + C.money(Math.abs(r.netRmb) / Math.max(1, r.qty)) + '</div>' +
      '<div class="pb-sub">对成本 ' + C.pct(r.marginOnCost) + '</div></div>' +
      '</div>';
  }

  /* 报价版本：只显示最近 4 版，能看清改价轨迹又不占地方。
     数据来自 core.pushQuoteVersion，缺字段的老商机就自然不显示。 */
  function versionsHtml(opp) {
    var list = (opp && opp.quoteVersions) || [];
    if (list.length < 2) return '';
    var rows = list.slice(-4).reverse().map(function (v) {
      return '<div style="display:flex;gap:8px;font-size:11.5px;color:#4a5260;padding:2px 0">' +
        '<span style="color:#8a919e;min-width:86px">' + esc(v.at ? C.fmtDate(v.at) : '') + '</span>' +
        '<span style="font-weight:600">' + C.usd(v.unitPriceUsd) + '</span>' +
        '<span style="color:#8a919e">× ' + (v.qty || 0).toLocaleString() + ' pcs</span>' +
        (v.note ? '<span style="color:#8a919e">' + esc(v.note) + '</span>' : '') +
        '</div>';
    }).join('');
    return '<div style="margin-top:8px"><div style="font-size:11.5px;color:#8a919e;margin-bottom:2px">' +
      '改价记录（共 ' + list.length + ' 版）</div>' + rows + '</div>';
  }

  /* 数量阶梯 */
  function ladderHtml(ctx) {
    var r = ctx.pricing;
    if (r.flags.noCost) return '<div class="empty">填上成本后显示</div>';

    var rows = P.ladder({
      product: ctx.product, qty: ctx.opp.quote.qty, settings: ctx.settings,
      unitCostRmb: r.unitCostRmb, shippingRmb: r.unitShipRmb
    });

    return '<div class="table-wrap"><table class="table"><thead><tr><th>数量</th><th class="num">建议单价</th>' +
      '<th class="num">成本合计</th><th class="num">这一单赚</th></tr></thead><tbody>' +
      rows.map(function (x) {
        return '<tr><td>' + x.qty.toLocaleString() + ' pcs</td>' +
          '<td class="num">' + C.usd(x.unitPriceUsd) + '</td>' +
          '<td class="num" style="color:#8a919e">' + C.money(x.costTotalRmb) + '</td>' +
          '<td class="num" style="color:' + (x.netRmb < 0 ? '#d92d20' : '#0f9d58') + '">' + C.money(x.netRmb) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function sensHtml(ctx) {
    var r = ctx.pricing;
    if (r.flags.noCost) return '<div class="empty">填上成本后显示</div>';

    var rows = P.sensitivity({
      product: ctx.product, qty: ctx.opp.quote.qty, settings: ctx.settings,
      unitCostRmb: r.unitCostRmb, shippingRmb: r.unitShipRmb,
      unitPriceUsd: ctx.opp.quote.unitPriceUsd
    });
    return '<div class="table-wrap"><table class="table"><thead><tr><th>报价变动</th><th class="num">单价</th><th class="num">这一单赚</th></tr></thead><tbody>' +
      rows.map(function (x) {
        return '<tr><td>' + (x.delta > 0 ? '+' : '') + (x.delta * 100).toFixed(0) + '%</td>' +
          '<td class="num">' + C.usd(x.unitPriceUsd) + '</td>' +
          '<td class="num" style="color:' + (x.belowCost ? '#d92d20' : '#0f9d58') + '">' + C.money(x.netRmb) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function tabBtn(key, label, opp) {
    return '<button class="tab' + (S.tab === key ? ' active' : '') + '" data-action="tab" data-tab="' + key +
      '" data-id="' + safeActionId(opp.id) + '">' + label + '</button>';
  }

  function tabBody(ctx) {
    var opp = ctx.opp;

    if (S.tab === 'en' || S.tab === 'zh') {
      var text = opp.drafts[S.tab] || '';
      if (!text) {
        return '<div class="empty"><strong>还没有草稿</strong>点上方「生成' +
          (S.tab === 'en' ? '英文' : '中文') + '回复」，系统会按当前报价和买家需求自动起草。</div>';
      }
      return '<div class="field"><label>可直接编辑后再复制到阿里后台 / 邮箱</label>' +
        '<textarea class="draft" data-draft="' + S.tab + '" data-id="' + safeActionId(opp.id) + '">' + esc(text) + '</textarea></div>' +
        '<div class="row" style="margin-top:10px">' +
        '<button class="btn sm primary" data-action="copy-draft" data-lang="' + S.tab + '" data-id="' + safeActionId(opp.id) + '">复制全文</button>' +
        '<button class="btn sm ghost" data-action="gen-reply" data-lang="' + S.tab + '" data-id="' + safeActionId(opp.id) + '">重新生成</button>' +
        '<span class="card-sub">提示：生成后改价不会自动同步，重新生成即可</span>' +
        '</div>';
    }

    if (S.tab === 'nego') {
      var items = R.negotiation(ctx);
      return items.map(function (it) {
        return '<div class="stack" style="gap:6px;margin-bottom:14px">' +
          '<div style="font-weight:650;font-size:12.5px">' + esc(it.title) + '</div>' +
          '<div class="rawtext" style="max-height:none">' + esc(it.text) + '</div></div>';
      }).join('');
    }

    if (S.tab === 'quote') {
      if (quoteBlock(opp)) {
        return '<div class="alert danger"><span class="ic">!</span><div>' +
          '<strong>报价单已拦截：</strong>所选商品与这条询盘对不上（型号/品类不符或低于起订量），' +
          '先在「橱窗匹配」里换一个对得上的商品；确认无误需要放行时，点上方「报价单」按钮按提示操作。</div></div>';
      }
      return '<div class="alert info" style="margin-bottom:12px"><span class="ic">i</span>' +
        '<div>下面是报价单预览。<strong>打印 / 存 PDF</strong> 会打开新窗口，选「另存为 PDF」即可发给客户。</div></div>' +
        '<div class="row" style="margin-bottom:12px">' +
        '<button class="btn sm primary" data-action="print-quote" data-id="' + safeActionId(opp.id) + '">打印 / 存 PDF</button>' +
        '</div>' +
        '<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;height:460px;background:#fff">' +
        '<iframe id="quote-frame" style="width:100%;height:100%;border:0" sandbox="" srcdoc="' +
        esc(R.quoteDocument(ctx)) + '"></iframe></div>';
    }

    if (S.tab === 'log') {
      if (!opp.log || !opp.log.length) return '<div class="empty">暂无记录</div>';
      return '<div class="table-wrap"><table class="table"><tbody>' + opp.log.map(function (l) {
        return '<tr><td style="width:150px;color:#8a919e">' + C.fmtDate(l.ts, true) + '</td><td>' + esc(l.text) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    }

    return '';
  }

  /* =========================================================
     视图：商品库
     ========================================================= */

  /* 关键词匹配：多个词用空格分开，全部命中才算 */
  function matchQuery(text, q) {
    if (!q) return true;
    var hay = String(text || '').toLowerCase();
    var words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      if (hay.indexOf(words[i]) < 0) return false;
    }
    return true;
  }

  function catalogRows(q, onlyEmpty) {
    var s = st();
    var fx = C.num(s.settings.fxRate, 7.1);

    var list = s.products.filter(function (p) {
      if (onlyEmpty && C.num(p.costRmb) > 0) return false;
      if (S.catType && (C.typeOfProduct(p) || '其他') !== S.catType) return false;
      return matchQuery([p.title, p.titleEn, p.sku, p.category, (p.keywords || []).join(' ')].join(' '), q);
    });

    if (!list.length) {
      return '<tr><td colspan="10"><div class="empty">没有匹配的商品</div></td></tr>';
    }

    return list.map(function (p) {
      var be = P.breakEvenOf(p, s.settings);
      var listUsd = C.num(p.priceUsd);
      var listLoss = be.hasCost && listUsd > 0 && listUsd < be.breakEvenUsd - 1e-9;
      var mref = marketRefOf(p);
      var marketRmb = C.num(p.marketPriceRmb) > 0 ? C.num(p.marketPriceRmb) : (mref ? mref.median : 0);
      var marketUsd = marketRmb > 0 ? marketRmb / fx : 0;
      var aboveMarket = marketUsd > 0 && be.hasCost && be.recommendUsd > marketUsd * 1.02;

      var verdict;
      if (!be.hasCost) verdict = '<span class="badge gray">待填成本</span>';
      else if (listLoss) verdict = '<span class="badge red">挂牌价亏</span>';
      else if (aboveMarket) verdict = '<span class="badge amber">比市场贵</span>';
      else if (marketUsd > 0) verdict = '<span class="badge green">有优势</span>';
      else verdict = '<span class="badge gray">待填市场价</span>';

      function cell(field, val, ph) {
        return '<td class="num"><input type="number" min="0" step="0.01" ' +
          'value="' + (C.num(val) > 0 ? C.num(val) : '') + '" placeholder="' + ph + '" ' +
          'data-prod="' + safeActionId(p.id) + '" data-pfield="' + field + '" ' +
          'style="width:82px;height:28px;text-align:right;font-family:var(--mono)' +
          (C.num(val) > 0 ? '' : ';border-color:#f0b429') + '"></td>';
      }

      return '<tr>' +
        '<td><span class="badge gray">' + esc(C.typeOfProduct(p) || '其他') + '</span></td>' +
        '<td style="max-width:320px"><strong style="font-size:12px">' + esc(p.title) + '</strong>' + (C.isDemoProduct(p) ? ' <span class="badge amber">演示</span>' : '') +
        (p.costSource === 'auto'
          ? ' <span class="badge amber" title="' + esc(p.costNote || '') + '">自动</span>'
          : '') +
        '<br><span style="color:#8a919e;font-size:10.5px">' + esc(p.sku) + '</span></td>' +
        '<td class="num">' + (p.priceFloorUsd > 0
          ? C.usd(p.priceFloorUsd) + ' – ' + C.usd(p.priceUsd)
          : C.usd(p.priceUsd)) +
        ((p.priceTiers && p.priceTiers.length)
          ? '<br><span style="color:#8a919e;font-size:10px">' +
          p.priceTiers.slice(0, 3).map(function (tt) {
            return tt.min + (tt.max && tt.max !== tt.min ? '-' + tt.max : '') + '件 ' + C.usd(tt.price);
          }).join(' · ') + '</span>'
          : '') + '</td>' +
        '<td class="num">' + (mref
          ? '<b>' + C.money(mref.median) + '</b><br><span style="color:#8a919e;font-size:10px">' +
          mref.low + '–' + mref.high + ' · ' + mref.source + mref.n + '条</span>'
          : '<span style="color:#c9ced6" title="淘宝/闲鱼没抓到同款，可点上方按钮手动查">—</span>') + '</td>' +
        cell('costRmb', p.costRmb, '1688价') +
        cell('marketPriceRmb', p.marketPriceRmb, '别家价') +
        '<td class="num" style="color:' + (be.hasCost ? (listLoss ? '#d92d20' : '#0f9d58') : '#8a919e') + ';font-weight:600">' +
        (be.hasCost ? C.usd(be.breakEvenUsd) : '—') + '</td>' +
        '<td class="num" style="font-weight:600">' + (be.hasCost ? C.usd(be.recommendUsd) : '—') + '</td>' +
        '<td>' + verdict +
        '<br><span style="color:#a0a6b0;font-size:10px">费率 ' + C.pct(C.feeRateFor(p, s.settings)) + '</span></td>' +
        '<td class="actions"><button class="btn sm ghost" data-action="edit-product" data-id="' + safeActionId(p.id) + '">编辑</button></td>' +
        '</tr>';
    }).join('');
  }

  function marketRefOf(p) {
    var m = window.MARKET_REF;
    if (!m || !p) return null;
    return m[String(p.sku)] || null;
  }

  function catalogTree() {
    var s = st();
    var map = {};
    s.products.forEach(function (p) {
      var t = C.typeOfProduct(p) || '其他';
      if (!map[t]) map[t] = { n: 0, withCost: 0 };
      map[t].n++;
      if (C.num(p.costRmb) > 0) map[t].withCost++;
    });

    var keys = Object.keys(map).sort(function (a, b) {
      if (a === '其他') return 1;
      if (b === '其他') return -1;
      return map[b].n - map[a].n;
    });

    function chip(label, n, withCost, active, value) {
      return '<button class="btn sm ' + (active ? 'primary' : 'ghost') + '" data-action="cat-type" data-type="' + esc(value) + '" ' +
        'style="margin:0 6px 6px 0">' + esc(label) + ' <b style="font-family:var(--mono)">' + n + '</b>' +
        (withCost !== undefined && withCost < n
          ? '<span style="color:' + (active ? '#fff' : '#a0a6b0') + ';font-size:10.5px"> · 有成本 ' + withCost + '</span>'
          : '') + '</button>';
    }

    var all = s.products.length;
    var allCost = s.products.filter(function (p) { return C.num(p.costRmb) > 0; }).length;

    return '<div style="font-size:11.5px;color:#8a919e;margin-bottom:8px">目录 · 按品类</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:0">' +
      chip('全部', all, allCost, !S.catType, '') +
      keys.map(function (k) {
        return chip(k, map[k].n, map[k].withCost, S.catType === k, k);
      }).join('') + '</div>';
  }

  function catalogCount() {
    var s = st();
    var filled = s.products.filter(function (p) { return C.num(p.costRmb) > 0; }).length;
    var shown = s.products.filter(function (p) {
      if (S.catOnlyEmpty && C.num(p.costRmb) > 0) return false;
      if (S.catType && (C.typeOfProduct(p) || '其他') !== S.catType) return false;
      return matchQuery([p.title, p.titleEn, p.sku, p.category, (p.keywords || []).join(' ')].join(' '), S.catQ);
    }).length;
    return '已填成本 ' + filled + ' / ' + s.products.length + ' · 显示 ' + shown + ' 条';
  }

  function viewCatalog() {
    var s = st();
    var fee = C.num(s.settings.platformFeeRate);
    var fx = C.num(s.settings.fxRate, 7.1);

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">商品库 · 该卖多少钱<span class="card-sub" id="cat-count">' + catalogCount() +
      '</span></div>' +
      '<div class="row">' +
      '<button class="btn sm ghost" data-action="export-catalog">导出 CSV</button>' +
      '<button class="btn sm" data-action="bulk-cost">批量填成本</button>' +
      '<button class="btn sm" data-action="import-products">粘贴导入</button>' +
      '<button class="btn sm primary" data-action="new-product">+ 新增商品</button>' +
      '</div></div>' +
      '<div class="card-bd" style="padding:12px 18px 0">' + catalogTree() + '</div>' +
      '<div class="card-bd" style="padding:12px 18px 0"><div class="row" style="gap:10px">' +
      '<input type="text" id="cat-search" value="' + esc(S.catQ) + '" placeholder="搜商品名 / 型号 / SKU，多个词用空格" ' +
      'style="width:420px;flex:none;height:34px">' +
      '<label class="row" style="gap:6px;font-size:12.5px;cursor:pointer">' +
      '<input type="checkbox" id="cat-only-empty" ' + (S.catOnlyEmpty ? 'checked' : '') + ' style="width:auto;height:auto"> 只看没填成本的</label>' +
      '</div></div>' +
      '<div class="card-bd tight" style="margin-top:10px"><div class="table-wrap">' +
      '<table class="table wide"><thead><tr><th>品类</th><th>商品</th><th class="num">阿里挂牌价</th><th class="num">市场价 ¥</th>' +
      '<th class="num">1688价 ¥</th><th class="num">别家价 ¥</th>' +
      '<th class="num">保本价 $</th><th class="num">建议售价 $</th><th>判断</th><th></th></tr></thead>' +
      '<tbody id="cat-body">' + catalogRows(S.catQ, S.catOnlyEmpty) + '</tbody></table>' +
      '</div></div></section>';
  }
  /* =========================================================
     视图：查价确认
     ========================================================= */

  function reviewFiltered(data) {
    var s = st();
    return s.products.filter(function (p) {
      var c = data[p.sku];
      var has = c && c.candidates && c.candidates.length;
      var done = C.num(p.costRmb) > 0;
      if (S.revOnlyPending && done) return false;
      if (!matchQuery([p.title, p.titleEn, p.sku].join(' '), S.revQ)) return false;
      return true;
    });
  }

  /* 候选价中位数：同名不同款、配件当整机卖，均价会被极端值带偏，中位数更稳 */
  function medianOf(c) {
    var arr = ((c && c.candidates) || []).map(function (x) { return C.num(x.price); })
      .filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    if (!arr.length) return 0;
    var m = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
  }

  function bulkFactor() {
    var f = C.num(S.bulkFactor, 1);
    if (!(f > 0)) f = 1;
    return Math.min(2, Math.max(0.1, f));
  }

  function suggestedCost(p, data) {
    var mid = medianOf(data[p.sku]);
    return mid > 0 ? C.round2(mid * bulkFactor()) : 0;
  }

  /* 当前筛选里「能补」的商品：还没成本 + 有候选价。批量只碰这些 */
  function bulkTargets(data) {
    return reviewFiltered(data).filter(function (p) {
      return !(C.num(p.costRmb) > 0) && medianOf(data[p.sku]) > 0;
    });
  }

  function costlessCount() {
    var n = 0;
    st().products.forEach(function (p) { if (!(C.num(p.costRmb) > 0)) n++; });
    return n;
  }

  /* 局部重画：搜索框有焦点，整页 render 会丢焦点，所以只刷表格和计数 */
  function paintReview() {
    var data = window.PRICE_CANDIDATES || {};
    var tb = document.getElementById('rev-body');
    if (tb) tb.innerHTML = reviewRows(data);
    var cnt = document.getElementById('rev-count');
    if (cnt) cnt.textContent = reviewCount(data);
    var bn = document.getElementById('bulk-fill-btn');
    if (bn) {
      var n = bulkTargets(data).length;
      bn.disabled = !n;
      bn.textContent = '批量填成本' + (n ? '（' + n + '）' : '');
    }
  }

  function reviewRows(data) {
    var s = st();
    var list = reviewFiltered(data);

    if (!list.length) {
      var left = costlessCount();
      return '<tr><td colspan="6"><div class="empty">' +
        (left ? '当前筛选下没有匹配的商品' : '全部 ' + s.products.length + ' 个商品都有成本价了') +
        '</div></td></tr>';
    }

    return list.map(function (p) {
      var c = data[p.sku];
      var crawled = !!c;
      var has = c && c.candidates && c.candidates.length;
      var done = C.num(p.costRmb) > 0;

      var cells = '<td style="max-width:300px"><strong style="font-size:12px">' + esc(p.title) + '</strong>' +
        '<br><span style="color:#8a919e;font-size:10.5px">' + esc(p.sku) + ' · 挂牌 ' + C.usd(p.priceUsd) + '</span></td>';

      var candHtml;
      var good = has ? c.candidates.filter(function (x) { return C.num(x.price) > 0; }) : [];
      if (!good.length) {
        candHtml = (crawled
          ? '<span style="color:#8a919e;font-size:11.5px">淘宝闲鱼都没搜到</span> '
          : '<span style="color:#8a919e;font-size:11.5px">还没抓到</span> ') + searchLinks({ product: p });
      } else {
        candHtml = '<div class="row" style="gap:6px">' + good.map(function (x) {
          var tt = String(x.title || '');
          var pr = C.num(x.price);
          return '<button class="btn sm" data-action="use-price" data-id="' + safeActionId(p.id) + '" data-price="' + pr + '" ' +
            'data-src="' + esc(x.source || '') + '" ' +
            'title="' + esc(tt || String(pr)) + '" style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            (x.source ? '<span style="color:#8a919e">' + esc(x.source) + '</span> ' : '') +
            '<b>¥' + pr + '</b>' + (tt ? ' · ' + esc(tt.slice(0, 16)) : '') + '</button>';
        }).join('') + '</div>';
      }

      var be = done ? P.breakEvenOf(p, s.settings) : null;
      var sug = done ? 0 : suggestedCost(p, data);

      return '<tr>' + cells +
        '<td>' + candHtml + '</td>' +
        '<td class="num">' + (done ? '<b>' + C.money(p.costRmb) + '</b>' : '—') + '</td>' +
        '<td class="num">' + (sug ? '<span style="color:#0f9d58">' + C.money(sug) + '</span>' : '—') + '</td>' +
        '<td class="num">' + (be && be.hasCost ? C.usd(be.breakEvenUsd) : '—') + '</td>' +
        '<td>' + (done
          ? '<span class="badge green" title="' + esc(p.costSource || '') + '">已填</span>'
          : '<span class="badge gray">待确认</span>') + '</td>' +
        '</tr>';
    }).join('');
  }

  function reviewCount(data) {
    var s = st();
    var withCand = 0, confirmed = 0;
    s.products.forEach(function (p) {
      var c = data[p.sku];
      if (c && c.candidates && c.candidates.length) withCand++;
      if (C.num(p.costRmb) > 0) confirmed++;
    });
    return '共 ' + s.products.length + ' 个 · 有成本 ' + confirmed + ' · 还缺 ' + (s.products.length - confirmed) +
      ' · 有候选 ' + withCand + ' · 显示 ' + reviewFiltered(data).length + ' 条';
  }

  function viewReview() {
    var s = st();
    var data = window.PRICE_CANDIDATES || null;

    if (!data) {
      return '<section class="card"><div class="card-bd"><div class="empty">' +
        '<strong>还没有查价数据</strong>抓取还没完成，或者数据文件没加载。</div></div></section>';
    }

    var canBulk = bulkTargets(data).length;

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">补成本<span class="card-sub" id="rev-count">' + reviewCount(data) + '</span></div>' +
      '</div>' +
      '<div class="card-bd" style="padding:12px 18px 0"><div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">' +
      '<input type="text" id="rev-search" value="' + esc(S.revQ) + '" placeholder="搜商品名 / 型号 / SKU，多个词用空格" ' +
      'style="max-width:330px;height:34px">' +
      '<label class="row" style="gap:6px;font-size:12.5px;cursor:pointer">' +
      '<input type="checkbox" id="rev-only-pending" ' + (S.revOnlyPending ? 'checked' : '') + ' style="width:auto;height:auto"> 只看还没成本的</label>' +
      '<span style="flex:1"></span>' +
      '<label class="row" style="gap:6px;font-size:12.5px" title="淘宝是零售价，采购价一般更低；1 = 直接用中位价">中位价 ×' +
      '<input type="number" id="bulk-factor" value="' + S.bulkFactor + '" min="0.1" max="2" step="0.05" style="width:74px;height:32px"></label>' +
      '<button class="btn sm" id="bulk-fill-btn" data-action="bulk-fill-cost" ' + (canBulk ? '' : 'disabled ') + '>' +
      '批量填成本' + (canBulk ? '（' + canBulk + '）' : '') + '</button>' +
      (S.bulkUndo.length ? '<button class="btn sm" data-action="undo-bulk-cost">撤销上次批量（' + S.bulkUndo.length + '）</button>' : '') +
      '</div></div>' +
      '<div class="card-bd"><div class="alert info"><span class="ic">i</span><div>' +
      '候选价是淘宝 / 闲鱼搜到的<strong>零售价，不等于你的采购价</strong>。「批量填成本」按候选价中位数 × 上面的系数估算，' +
      '填进去会标成「淘宝参考价」，报价页会当估算值提醒你。<br>' +
      '要准就逐行点候选价，或点旁边的搜索链接自己核。<strong>已有成本的商品任何批量都不会覆盖</strong>。' +
      '</div></div></div>' +
      '<div class="card-bd tight"><div class="table-wrap">' +
      '<table class="table"><thead><tr><th>商品</th><th>淘宝 / 闲鱼 候选（点一个填进去）</th>' +
      '<th class="num">成本 ¥</th><th class="num">建议 ¥</th><th class="num">保本价 $</th><th>状态</th></tr></thead>' +
      '<tbody id="rev-body">' + reviewRows(data) + '</tbody></table></div></div></section>';
  }
  /* =========================================================
     视图：复盘
     ========================================================= */

  /* ---------------- 月度统计 + 图 ---------------- */

  function monthKey(d) {
    var s = String(d || '');
    return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '未知';
  }

  function monthlyStats(orders, months) {
    var map = {};
    (orders || []).forEach(function (o) {
      var k = monthKey(o.date);
      if (!map[k]) map[k] = { month: k, count: 0, gmv: 0, profit: 0 };
      map[k].count++;
      map[k].gmv += C.num(o.amountUsd) - Math.min(C.num(o.refundUsd), C.num(o.amountUsd));
      map[k].profit += C.num(o.netRmb);
    });
    var keys = Object.keys(map).filter(function (k) { return k !== '未知'; }).sort();
    if (map['未知']) keys.push('未知');
    var list = keys.map(function (k) {
      var m = map[k];
      return { month: k, count: m.count, gmv: C.round2(m.gmv), profit: C.round2(m.profit) };
    });
    return months ? list.slice(-months) : list;
  }

  function barChart(list) {
    if (!list.length) return '<div class="empty">还没有订单，先记一笔</div>';
    var W = 560, H = 170, padL = 46, padB = 26, padT = 14;
    var innerW = W - padL - 12, innerH = H - padB - padT;
    var max = Math.max.apply(null, list.map(function (x) { return Math.max(x.profit, 0); }).concat([1]));
    var bw = Math.min(46, innerW / list.length * 0.6);

    var bars = list.map(function (x, i) {
      var cx = padL + innerW * (i + 0.5) / list.length;
      var h2 = Math.max(2, innerH * Math.max(x.profit, 0) / max);
      var y = padT + innerH - h2;
      var color = x.profit < 0 ? '#d92d20' : '#0f9d58';
      return '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + h2.toFixed(1) + '" rx="3" fill="' + color + '" opacity="0.85"></rect>' +
        '<text x="' + cx.toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="#6b7280">' +
        Math.round(x.profit) + '</text>' +
        '<text x="' + cx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#9aa1ac">' +
        x.month.slice(5) + '月</text>';
    }).join('');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;max-height:200px">' +
      '<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (W - 12) + '" y2="' + (padT + innerH) +
      '" stroke="#eef0f3"></line>' + bars + '</svg>';
  }

  /* ---------------- 汇率冲击 ---------------- */

  function fxShock(fx) {
    var s = st();
    var r = C.fxShock(s.products, s.settings, fx);
    return {
      risk: r.risk,
      total: r.total,
      rows: r.rows.slice(0, 6).map(function (x) {
        return { title: x.title, be: x.be, list: x.list, loss: x.lossPct };
      })
    };
  }

  function fxShockCard() {
    var s = st().settings;
    var cur = C.num(s.fxRate, 7.1);
    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">汇率冲击<span class="card-sub">汇率跌了，你的哪些货会变成亏本卖</span></div>' +
      '<div class="row" style="gap:8px;align-items:center">' +
      '<span style="font-size:12px;color:#8a919e">假设汇率</span>' +
      '<input type="number" id="fx-shock" value="' + cur + '" step="0.05" min="3" max="12" style="width:90px;height:30px">' +
      '</div></div>' +
      '<div class="card-bd"><div id="fx-shock-out"></div></div></section>';
  }

  function fxShockResult(fx) {
    var r = fxShock(fx);
    var cur = C.num(st().settings.fxRate, 7.1);
    var d = ((fx / cur - 1) * 100).toFixed(1);

    var head = '<div class="grid grid-3" style="gap:14px;margin-bottom:12px">' +
      '<div><div style="font-size:11px;color:#8a919e">有成本商品</div>' +
      '<div style="font-size:22px;font-weight:700">' + r.total + '</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">会亏的</div>' +
      '<div style="font-size:22px;font-weight:700;color:' + (r.risk ? '#d92d20' : '#0f9d58') + '">' +
      r.risk + ' 个</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">相对现在</div>' +
      '<div style="font-size:22px;font-weight:700">' + (d >= 0 ? '+' : '') + d + '%</div></div>' +
      '</div>';

    if (!r.rows.length) {
      return head + '<div class="alert info"><span class="ic">✓</span><div>' +
        '汇率 ' + fx.toFixed(2) + ' 时，所有商品按当前挂牌价都还有得赚。</div></div>';
    }

    var rows = r.rows.map(function (x) {
      return '<tr><td style="max-width:280px">' + esc(x.title.slice(0, 40)) + '</td>' +
        '<td class="num">' + C.usd(x.list) + '</td>' +
        '<td class="num" style="color:#d92d20">' + C.usd(x.be) + '</td>' +
        '<td class="num" style="color:#d92d20">-' + x.loss.toFixed(1) + '%</td></tr>';
    }).join('');

    return head + '<div class="table-wrap"><table class="table">' +
      '<thead><tr><th>商品</th><th class="num">挂牌价</th><th class="num">新保本价</th><th class="num">差</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div style="font-size:11px;color:#8a919e;margin-top:8px">只列最严重的 6 个。要么涨价，要么汇率回稳前别接这些单。</div>';
  }

  function monthCard(orders) {
    var list = monthlyStats(orders, 6);
    if (!list.length) return '';

    var cur = list[list.length - 1];
    var prev = list.length > 1 ? list[list.length - 2] : null;
    function delta(a, b) {
      if (!b || !b.profit) return '';
      var d = (a.profit - b.profit) / Math.abs(b.profit);
      var up = d >= 0;
      return '<span style="color:' + (up ? '#0f9d58' : '#d92d20') + ';font-size:11px">' +
        (up ? '▲' : '▼') + Math.abs(d * 100).toFixed(0) + '% 环比</span>';
    }

    var rows = list.slice().reverse().map(function (m) {
      return '<tr><td>' + esc(m.month) + '</td><td class="num">' + m.count + '</td>' +
        '<td class="num">' + C.usd(m.gmv) + '</td>' +
        '<td class="num" style="color:' + (m.profit < 0 ? '#d92d20' : '#0f9d58') + '">' + C.money(m.profit) + '</td></tr>';
    }).join('');

    return '<section class="card"><div class="card-hd">' +
      '<div class="card-title">月度对比' + (prev ? delta(cur, prev) : '') +
      '<span class="card-sub">最近 6 个月，柱高是利润</span></div></div>' +
      '<div class="card-bd">' + barChart(list) + '</div>' +
      '<div class="card-bd tight"><div class="table-wrap"><table class="table">' +
      '<thead><tr><th>月份</th><th class="num">单数</th><th class="num">成交额</th><th class="num">利润</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div></section>';
  }

  function viewAnalytics() {
    var s = st();
    var kpi = C.stats();
    var allOrders = (s.orders || []).filter(function (o) { return !C.isDemoOrder(o); }).slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    /* 订单多了以后只渲染最近 200 条，避免表格拖慢页面 */
    var orders = allOrders.slice(0, 200);

    var metrics = '<div class="grid grid-4">' +
      metric('累计成交额', C.usd(kpi.gmvUsd), kpi.orderCount + ' 单') +
      metric('累计利润', C.money(kpi.profitRmb), '扣平台费后') +
      metric('平均单笔利润', C.money(kpi.avgProfitRmb), kpi.avgMargin === null ? '—' : '利润率 ' + C.pct(kpi.avgMargin)) +
      metric('成交率', kpi.wonCount + kpi.lostCount ? C.pct(kpi.winRate, 0) : '—',
        kpi.wonCount + ' 成交 / ' + kpi.lostCount + ' 丢单') +
      '</div>';

    /* 明细表 */
    var orderRows = orders.map(function (o) {
      var profit = C.num(o.netRmb);
      return '<tr>' +
        '<td style="white-space:nowrap;color:#8a919e;font-size:11.5px">' + esc(o.date) + '</td>' +
        '<td style="max-width:280px">' + esc(o.title || '—') +
        '<br><span style="color:#8a919e;font-size:10.5px">' + esc(o.sku) +
        (o.buyer ? ' · ' + esc(o.buyer) : '') + (o.country ? ' · ' + esc(o.country) : '') + '</span></td>' +
        '<td class="num">' + o.qty + '</td>' +
        '<td class="num">' + (o.unitPriceUsd ? C.usd(o.unitPriceUsd) : '—') + '</td>' +
        '<td class="num"><b>' + C.usd(o.amountUsd) + '</b>' +
        (C.num(o.refundUsd) > 0
          ? '<br><span style="color:#d92d20;font-size:10.5px">退 ' + C.usd(o.refundUsd) + '</span>'
          : '') + '</td>' +
        '<td class="num">' + C.money(o.costRmb) + '</td>' +
        '<td class="num" style="color:' + (profit < 0 ? '#d92d20' : '#0f9d58') + '">' + C.money(profit) + '</td>' +
        '<td class="actions" style="white-space:nowrap">' +
        '<button class="btn sm ghost" data-action="refund-order" data-id="' + safeActionId(o.id) + '">退款</button> ' +
        '<button class="btn sm ghost" data-action="delete-order" data-id="' + safeActionId(o.id) + '">删</button></td>' +
        '</tr>';
    }).join('');

    var orderCard = '<section class="card"><div class="card-hd">' +
      '<div class="card-title">订单明细<span class="card-sub">所有成交都记在这里，复盘的数字就是它加出来的' +
      (allOrders.length > 200 ? ' · 只显示最近 200 条（共 ' + allOrders.length + ' 条）' : '') + '</span></div>' +
      '<div class="row"><button class="btn sm ghost" data-action="export-orders">导出 CSV</button>' +
      '<button class="btn sm primary" data-action="new-order">+ 记录一笔订单</button></div></div>' +
      '<div class="card-bd tight"><div class="table-wrap">' +
      (orderRows
        ? '<table class="table"><thead><tr><th>日期</th><th>商品</th><th class="num">数量</th>' +
        '<th class="num">单价</th><th class="num">成交额</th><th class="num">成本</th>' +
        '<th class="num">利润</th><th></th></tr></thead><tbody>' + orderRows + '</tbody></table>'
        : '<div class="empty"><strong>还没有订单</strong>点右上角「+ 记录一笔订单」，把已经成交的单子记进来。</div>') +
      '</div></div></section>';

    /* 按商品 / 按市场 */
    function groupBy(keyFn, labelFn) {
      var map = {};
      orders.forEach(function (o) {
        var k = keyFn(o) || '未填';
        if (!map[k]) map[k] = { cnt: 0, gmv: 0, profit: 0 };
        map[k].cnt++;
        map[k].gmv += C.num(o.amountUsd);
        map[k].profit += C.num(o.netRmb);
      });
      return Object.keys(map).sort(function (a, b) { return map[b].profit - map[a].profit; }).map(function (k) {
        var x = map[k];
        return '<tr><td>' + esc(labelFn(k)) + '</td><td class="num">' + x.cnt + '</td>' +
          '<td class="num">' + C.usd(x.gmv) + '</td>' +
          '<td class="num" style="color:' + (x.profit < 0 ? '#d92d20' : '#0f9d58') + '">' + C.money(x.profit) + '</td></tr>';
      }).join('');
    }

    var byProduct = groupBy(function (o) { return o.sku; }, function (k) {
      var p = s.products.find(function (x) { return x.sku === k; });
      return p ? p.title.slice(0, 34) : k;
    });
    var byCountry = groupBy(function (o) { return o.country; }, function (k) { return k; });

    var gridCards = '<div class="grid grid-2">' +
      card('按商品', '哪个货真的赚钱',
        '<div class="table-wrap"><table class="table"><thead><tr><th>商品</th><th class="num">单数</th>' +
        '<th class="num">成交额</th><th class="num">利润</th></tr></thead><tbody>' +
        (byProduct || '<tr><td colspan="4" class="empty">暂无数据</td></tr>') + '</tbody></table></div>') +
      card('按市场', '哪个国家成得多',
        '<div class="table-wrap"><table class="table"><thead><tr><th>市场</th><th class="num">单数</th>' +
        '<th class="num">成交额</th><th class="num">利润</th></tr></thead><tbody>' +
        (byCountry || '<tr><td colspan="4" class="empty">暂无数据</td></tr>') + '</tbody></table></div>') +
      '</div>';

    /* 丢单 */
    var lostRows = s.opportunities.filter(function (o) { return o.status === 'lost' && !C.isDemoOpp(o); }).map(function (o) {
      return '<tr><td>' + esc(o.buyer.name) + '</td><td>' + esc(o.buyer.country) + '</td>' +
        '<td>' + esc((o.deal && o.deal.reason) || '未记录') + '</td>' +
        '<td class="num" style="color:#8a919e">' + C.fmtDate(o.updatedAt) + '</td></tr>';
    }).join('');

    var lostCard = card('丢单记录', '每次丢单都记原因',
      '<div class="table-wrap"><table class="table"><thead><tr><th>买家</th><th>市场</th>' +
      '<th>原因</th><th class="num">时间</th></tr></thead><tbody>' +
      (lostRows || '<tr><td colspan="4" class="empty">暂无丢单记录</td></tr>') + '</tbody></table></div>');

    return '<div class="stack">' + metrics + orderCard + monthCard(orders) + fxShockCard() + gridCards + lostCard + '</div>';
  }

  /* ---------------- 记录订单 ---------------- */

  function openOrder(prefill) {
    var s = st();
    prefill = prefill || {};
    var opts = s.products.map(function (p) {
      return '<option value="' + safeActionId(p.id) + '"' + (prefill.productId === p.id ? ' selected' : '') + '>' +
        esc(p.title.slice(0, 46)) + ' · ' + esc(p.sku) + '</option>';
    }).join('');

    var html = modalHead('记录一笔订单') +
      '<div class="modal-bd">' +
      '<div class="form-grid">' +
      '<div class="field full"><label>商品</label>' +
      '<select id="ord-product"><option value="">（不指定商品）</option>' + opts + '</select></div>' +
      '<div class="field"><label>数量</label><input type="number" id="ord-qty" min="1" step="1" value="' + (prefill.qty || 1) + '"></div>' +
      '<div class="field"><label>成交单价（USD）</label><input type="number" id="ord-unit" min="0" step="0.01" value="' + (prefill.unitPriceUsd || '') + '"></div>' +
      '<div class="field"><label>成交额（USD）</label><input type="number" id="ord-amount" min="0" step="0.01" value="' + (prefill.amountUsd || '') + '"></div>' +
      '<div class="field"><label>成本合计（元）</label>' +
      '<input type="number" id="ord-cost" min="0" step="0.01" readonly value="' + (prefill.costRmb || '') + '">' +
      '<div class="hint" id="ord-cost-hint">按商品档案的 1688 成本自动带出，不能手改。</div></div>' +
      '<div class="field"><label>成交日期</label><input type="date" id="ord-date" value="' + (prefill.date || new Date().toISOString().slice(0, 10)) + '"></div>' +
      '<div class="field"><label>买家 / 客户（选填）</label><input type="text" id="ord-buyer" value="' + esc(prefill.buyer || '') + '"></div>' +
      '<div class="field"><label>市场（选填）</label><input type="text" id="ord-country" value="' + esc(prefill.country || '') + '"></div>' +
      '<div class="field full"><label>备注（选填）</label><input type="text" id="ord-note" value="' + esc(prefill.note || '') + '"></div>' +
      '</div>' +
      '<div class="alert info" style="margin-top:12px"><span class="ic">i</span><div>' +
      '成本按商品档案自动带出（只读）；成交额留空就按「单价 × 数量」算。利润 = 成交额 × 汇率 × (1 − 平台扣费) − 成本。' +
      '</div></div>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-order">保存</button>' +
      '</div>';
    openModal(html, true);
    var sel = document.getElementById('ord-product');
    if (sel) sel.addEventListener('change', function () { syncOrderCost(); });
    var qtyEl = document.getElementById('ord-qty');
    if (qtyEl) qtyEl.addEventListener('input', function () { syncOrderCost(); });
    syncOrderCost();
  }

  /* 成本只能来自商品档案：输入框是只读回显，改数量时跟着重算合计。 */
  function syncOrderCost() {
    var sel = document.getElementById('ord-product');
    var p = sel && sel.value ? productById(sel.value) : null;
    var unit = p ? C.num(p.costRmb) : 0;
    var qtyEl = document.getElementById('ord-qty');
    var qty = Math.max(1, C.num(qtyEl && qtyEl.value) || 1);
    var box = document.getElementById('ord-cost');
    if (box) box.value = unit > 0 ? Math.round(unit * qty * 100) / 100 : '';
    var hint = document.getElementById('ord-cost-hint');
    if (!hint) return;
    if (!p) hint.textContent = '选了商品才会带出成本。';
    else if (unit > 0) hint.textContent = '单价成本 ¥' + C.money(unit) + ' × ' + qty + ' 件，取商品档案，不能手改。';
    else hint.textContent = '这个商品还没有 1688 成本，先到「补成本」补上，否则这笔的利润算不出来。';
  }

  /* 退款后重算利润：
     平台费按实收金额算，成本按实收比例摊（退货能退给供应商的部分） */
  function recalcOrder(o, settings) {
    var s = settings || st().settings;
    var r = C.orderNet({
      amountUsd: o.amountUsd,
      refundUsd: o.refundUsd,
      costRmb: C.num(o.costFullRmb) > 0 ? o.costFullRmb : o.costRmb,
      fxRate: s.fxRate,
      feeRate: C.feeRateFor(productById(o.productId) || null, s)
    });
    o.feeRmb = r.feeRmb;
    o.costRmb = r.costRmb;
    o.netRmb = r.netRmb;
    return o;
  }

  /* 导 CSV（带 BOM，Excel 直接打开不乱码） */
  function downloadCsv(filename, rows) {
    var esc2 = function (v) {
      var s = String(v == null ? '' : v);
      /* Excel 会把 = + - @ 或 Tab/回车 开头的单元格当公式跑。
         买家名、商品名都是外部导入的，先加个单引号把它按文本处理。 */
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r\t]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var text = '\ufeff' + rows.map(function (r) { return r.map(esc2).join(','); }).join('\r\n');
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* 这两个 CSV 以前把 成本RMB / 最低价USD / 保本价USD 全摊在明面上：
     谁打开这个站，点一下就拿到全部报价底线，等于把底价直接给了客户。
     现在对外导出只留可公开字段；含成本与底价的完整数据只走
     「数据与安全 → 导出备份 JSON」，由老板自己在本机留档。 */
  function exportOrdersCsv() {
    var s = st();
    var rows = [['日期', '商品', 'SKU', '数量', '单价USD', '成交额USD', '退款USD', '买家', '市场']];
    (s.orders || []).forEach(function (o) {
      rows.push([o.date, o.title, o.sku, o.qty, o.unitPriceUsd, o.amountUsd,
        o.refundUsd || 0, o.buyer, o.country]);
    });
    downloadCsv('订单明细_' + new Date().toISOString().slice(0, 10) + '.csv', rows);
    C.audit('导出订单 CSV', (s.orders || []).length + ' 条');
    toast('已导出 ' + ((s.orders || []).length) + ' 条（不含成本与利润，需要请用“导出备份 JSON”）');
  }

  function exportCatalogCsv() {
    var s = st();
    var rows = [['商品', 'SKU', '挂牌价USD', 'MOQ', '交期(天)', '认证']];
    s.products.forEach(function (p) {
      rows.push([p.title, p.sku, p.priceUsd, p.moq, p.leadTimeDays || '',
        (p.certs || []).join(' ')]);
    });
    downloadCsv('商品清单_' + new Date().toISOString().slice(0, 10) + '.csv', rows);
    C.audit('导出商品 CSV', s.products.length + ' 个');
    toast('已导出 ' + s.products.length + ' 个商品（不含成本与底价）');
  }

  function saveOrder() {
    var s = st();
    var pid = document.getElementById('ord-product').value;
    var product = pid ? productById(pid) : null;

    var qty = Math.max(0, C.num(document.getElementById('ord-qty').value));
    var unit = C.num(document.getElementById('ord-unit').value);
    var amount = C.num(document.getElementById('ord-amount').value);
    /* 成本只认商品档案，不再读手填输入框：
       以前这里取 #ord-cost 的自由输入，谁都能把成本改成 1 块，利润与复盘全失真。 */
    var costUnit = product ? C.num(product.costRmb) : 0;
    var cost = costUnit > 0 ? Math.round(costUnit * Math.max(1, qty) * 100) / 100 : 0;

    if (!(amount > 0)) amount = unit * qty;
    if (!(amount > 0)) { toast('成交额必须大于 0'); return; }
    if (!(qty > 0)) qty = 1;

    var fx = C.num(s.settings.fxRate, 7.1);
    var feeRate = product ? C.feeRateFor(product, s.settings) : C.num(s.settings.platformFeeRate);
    var calc = C.orderNet({ amountUsd: amount, costRmb: cost, fxRate: fx, feeRate: feeRate });
    var feeRmb = calc.feeRmb;
    var netRmb = calc.netRmb;

    var order = C.normalizeOrder({
      productId: pid || (product ? product.id : ''),
      sku: product ? product.sku : '',
      title: product ? product.title : (document.getElementById('ord-note').value || '未指定商品'),
      qty: qty,
      unitPriceUsd: unit || (qty ? amount / qty : 0),
      amountUsd: amount,
      costRmb: cost,
      costFullRmb: cost,
      feeRmb: feeRmb,
      netRmb: netRmb,
      date: document.getElementById('ord-date').value || new Date().toISOString().slice(0, 10),
      buyer: document.getElementById('ord-buyer').value.trim(),
      country: document.getElementById('ord-country').value.trim(),
      note: document.getElementById('ord-note').value.trim(),
      source: 'manual'
    });

    s.orders.push(order);
    closeModal();
    invalidate(); C.persist(); render();
    toast('已记录，利润 ' + C.money(netRmb));
  }
  /* =========================================================
     视图：设置
     ========================================================= */

  function viewSettings() {
    var s = st().settings;
    var fee = C.num(s.platformFeeRate);

    var body = '<div class="grid grid-2">' +
      card('算价用的三个数', '决定保本价和建议售价',
        '<div class="form-grid">' +
        numField('平台扣费（手续费+提现费）', 'set-platformFeeRate', s.platformFeeRate * 100, '%', 0.1) +
        '<div class="field"><label>美元汇率（CNY）</label>' +
        '<input type="number" id="set-fxRate" value="' + C.round(s.fxRate, 2) + '" step="0.01">' +
        '<div class="hint" style="display:flex;gap:8px;align-items:center;margin-top:4px">' +
        '<span>' + fxAgeText() + '</span>' +
        '<button class="btn sm ghost" data-action="refresh-fx" type="button">立即更新</button>' +
        '</div></div>' +
        numField('每件想赚', 'set-profitRmb', s.profitRmb, '元', 5) +
        numField('还价最多让到（毛利率不低于）', 'set-minMarginPct', C.num(s.minMarginPct, 8), '%', 1) +
        numField('国内运费', 'set-domesticShippingRmb', s.domesticShippingRmb, '元/件', 1) +
        '</div>' +
        '<div class="alert info" style="margin-top:14px"><span class="ic">i</span><div>' +
        '成本 100 元的货：<br>' +
        '· 保本价 = 100 ÷ ' + (1 - fee).toFixed(2) + ' = <b>' + C.money(100 / (1 - fee)) + '</b>（再 ÷ 汇率换成美元）<br>' +
        '· 想赚 ' + C.money(s.profitRmb) + ' → 卖 <b>' + C.money((100 + C.num(s.profitRmb)) / (1 - fee)) + '</b>' +
        '<br><br>「每件想赚」填 0 就只看保本价。' +
        '</div></div>') +

      card('报价默认值', '生成报价单和回复时用',
        '<div class="form-grid">' +
        '<div class="field"><label>默认贸易术语</label><input type="text" id="set-defaultIncoterm" value="' +
        esc(s.defaultIncoterm) + '"></div>' +
        numField('默认交期', 'set-defaultLeadTimeDays', s.defaultLeadTimeDays, '天', 1) +
        numField('报价后几天提醒跟进', 'set-followUpDays', C.num(s.followUpDays, 3), '天', 1) +
        '<div class="field full"><label>付款方式（中文）</label>' +
        '<input type="text" id="set-paymentTerms" value="' + esc(s.paymentTerms) + '"></div>' +
        '<div class="field full"><label>付款方式（英文）</label>' +
        '<input type="text" id="set-paymentTermsEn" value="' + esc(s.paymentTermsEn) + '"></div>' +
        '<div class="field full"><label>公司抬头（报价单用）</label>' +
        '<input type="text" id="set-sellerName" value="' + esc(s.sellerName) + '"></div>' +
        '</div>') +
      '</div>' +

      card('数据', '所有数据只存在这台电脑的浏览器里',
        '<div class="stack" style="gap:10px">' +
        '<div class="alert warn"><span class="ic">!</span><div><strong>没有云同步。</strong>' +
        '数据存在浏览器 localStorage，换浏览器 / 清缓存会丢。养成导出备份的习惯。</div></div>' +
        '<div class="row">' +
        '<button class="btn" data-action="export-json">导出备份 JSON</button>' +
        '<button class="btn" data-action="import-json">导入备份</button>' +
        '<button class="btn danger" data-action="reset-demo">重置为演示数据</button>' +
        '<button class="btn" data-action="purge-demo">清除演示数据（保留真实数据）</button>' +
        '</div>' +
        storageBlock() +
        '<div class="card-sub">重置会清空你录入的所有商机和商品，先导出备份。</div>' +
        '</div>') +

      translateCard(s) +
      feeTypeCard(s) +
      logCard() +
      '<div class="row" style="justify-content:flex-end">' +
      '<button class="btn primary" data-action="save-settings">保存设置</button></div>';

    return '<div class="stack">' + body + '</div>';
  }
  function translateCard(s) {
    return card('翻译引擎', '优先用服务端通义千问，其次本地引擎，最后免费接口',
      '<div class="alert info"><span class="ic">i</span><div>' +
      '通义千问改为走服务端代理 <code>/api/ai</code>：<b>浏览器里不再保存 API Key</b>，' +
      '密钥只存在服务器的环境变量里。没登录或服务器没配密钥时会自动退回浏览器本地引擎（离线可用），' +
      '所以英文回复草稿在任何情况下都能生成。</div></div>' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="btn sm" data-action="test-qwen">测试服务端翻译</button>' +
      '<span id="qwen-test-out" style="font-size:12px;color:#6b7280"></span></div>' +
      '<div class="field" style="margin-top:12px"><label>自建翻译服务地址（选填）</label>' +
      '<input type="text" id="set-translateEndpoint" value="' + esc(s.translateEndpoint || '') + '" placeholder="http://127.0.0.1:5000">' +
      '<div class="hint">填了会排在本机引擎前面；自建服务挂了自动退回。' +
      '<b>只接受 https，本机/内网可用 http</b>（防止询盘原文被发到陌生地址）。</div>' +
      '<div class="row" style="margin-top:10px">' +
      '<button class="btn sm" data-action="test-translate">测试自建服务</button>' +
      '<span id="tr-test-out" style="font-size:12px;color:#6b7280"></span></div></div>');
  }

  function logCard() {
    var logs = (st().logs || []).slice(0, 40);
    var rows = logs.map(function (l) {
      return '<tr><td class="num" style="white-space:nowrap;color:#8a919e;font-size:11px">' +
        esc(C.relTime(l.at)) + '</td><td>' + esc(l.action) + '</td>' +
        '<td style="color:#6b7280;font-size:11.5px">' + esc(l.detail) + '</td></tr>';
    }).join('');

    return card('操作日志', '谁在什么时候导出了数据、改了什么',
      '<div class="alert info" style="margin-bottom:10px"><span class="ic">i</span><div>' +
      '只记操作和条数，不记具体内容。导出、删除、退款、改费率都会留痕，最多保留 500 条。</div></div>' +
      (rows
        ? '<div class="table-wrap" style="max-height:260px;overflow:auto"><table class="table">' +
        '<thead><tr><th class="num">时间</th><th>动作</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">还没有操作记录</div>') +
      (logs.length ? '<div class="row" style="margin-top:10px">' +
        '<button class="btn sm ghost" data-action="clear-logs">清空日志</button></div>' : ''));
  }

  function feeTypeCard(s) {
    var prods = st().products || [];
    var counts = {};
    prods.forEach(function (p) {
      var t = C.typeOfProduct(p);
      if (t) counts[t] = (counts[t] || 0) + 1;
    });
    var map = s.feeRateByType || {};
    var keys = C.TYPE_KEYS.filter(function (k) { return (counts[k] || 0) > 0; });

    var rows = keys.map(function (k) {
      var cur = C.num(map[k]) > 0 ? (C.num(map[k]) * 100) : '';
      return '<tr><td>' + esc(k) + '</td>' +
        '<td class="num" style="color:#8a919e">' + counts[k] + ' 个</td>' +
        '<td class="num"><input type="number" min="0" max="50" step="0.1" ' +
        'data-fee-type="' + esc(k) + '" value="' + cur + '" placeholder="' +
        C.round(C.num(s.platformFeeRate) * 100, 1) + '" ' +
        'style="width:80px;height:28px;text-align:right;font-family:var(--mono)"></td></tr>';
    }).join('');

    return card('品类费率', '不同品类阿里扣得不一样，可以单独设',
      '<div class="alert info" style="margin-bottom:12px"><span class="ic">i</span><div>' +
      '留空＝用上面的全局费率（' + C.pct(C.num(s.platformFeeRate)) + '）。' +
      '填了就以这里的为准，保本价会按该品类重算。</div></div>' +
      (rows
        ? '<div class="table-wrap"><table class="table"><thead><tr><th>品类</th>' +
        '<th class="num">商品数</th><th class="num">费率 %</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">商品里还没识别出品类</div>') +
      '<div class="row" style="margin-top:12px">' +
      '<button class="btn sm" data-action="save-fee-types">保存费率</button></div>');
  }

  function numField(label, id, value, unit, step) {
    return '<div class="field"><label>' + esc(label) + (unit ? '（' + esc(unit) + '）' : '') + '</label>' +
      '<input type="number" id="' + id + '" value="' + C.round(value, 4) + '" step="' + (step || 1) + '"></div>';
  }

  /* =========================================================
     交互：点击
     ========================================================= */

  /* Esc 关闭弹窗：在输入框/文本域里不拦截，避免编辑中误关丢内容 */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    var root = document.getElementById('modal-root');
    if (root && root.innerHTML) closeModal();
  });

  /* P1-23-R7-R2-R2 修复 C（统一守卫）：任何一次用户操作期间只要发生落盘失败，
     Core 已把内存回滚到上次落盘状态；这里统一给出失败提示并重渲染，
     避免各业务路径自己的"已保存/已合并"提示与实际持久化结果不一致。 */
  function watchPersistFailure() {
    if (!C.persistFailureCount) return;
    var before = C.persistFailureCount();
    setTimeout(function () {
      if (C.persistFailureCount() > before) {
        toast('保存失败：本次修改未能写入，已自动回滚到上次保存的状态');
        invalidate(); render();
      }
    }, 0);
  }

  document.addEventListener('click', function (e) {
    watchPersistFailure();
    if (e.target && e.target.classList && e.target.classList.contains('modal-mask')) {
      closeModal();
      return;
    }
    var btn = e.target.closest('[data-action]');
    if (!btn) return;

    var act = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    /* R4 第七项中央守卫：凡携带 data-id / data-rid 的动作入口，ID 必须通过
       严格校验才允许分发。渲染层已用 safeActionId 收口属性拼接，此处再拦
       一道，防止任何遗漏入口或 DOM 被外部篡改时把非法 ID 带入业务逻辑。
       （save-product 的空 id 表示新建商品，是合法形态，单独放行。） */
    var rid = btn.getAttribute('data-rid');
    /* sales-edit 豁免：openSalesEdit 内部已有 safeActionId 分支，非法 ID 时
       打开只读提示弹窗（R3-06 既定交互），不进入任何写操作。 */
    if (id && !safeActionId(id) && act !== 'sales-edit' && !(act === 'save-product' && id === '')) { toast('ID 异常，操作已阻止'); return; }
    if (rid && !safeActionId(rid)) { toast('ID 异常，操作已阻止'); return; }
    /* R5 5.6：data-id 属性存在但为空串，只可能来自 safeActionId 对
       不合规 ID 的收口（合法实体的按钮恒带真实 ID）。此类点击一律
       拒绝分发：save-opp 空 id 会走「新建商机」分支生成重复商机、
       edit-product 空 id 会误开新建表单、delete 类空 id 会弹无意义
       确认框。getAttribute 对「属性缺失」返回 null、对「属性存在
       但为空」返回空串，二者可区分：新建商机按钮没有 data-id
       （null，放行走新建）；save-product 的空 id 是新建商品的合法
       形态（单独放行）；sales-edit 沿用 R3-06 豁免（其内部对空 id
       打开只读提示）。data-rid 同理：存在但为空即收口结果，拒绝。 */
    if (id === '' && act !== 'save-product' && act !== 'sales-edit') { toast('ID 异常，操作已阻止'); return; }
    if (rid === '') { toast('ID 异常，操作已阻止'); return; }
    /* R6 第六项：data-opp / data-prod 纳入中央守卫。此前点击路径只有
       select-product 等 case 内部靠 oppById 查无此人兜底，守卫层不
       校验这两个属性。渲染层已全部经 safeActionId 收口（合法值恒
       有效、非法值恒为空串），故属性存在但为空串或不合规即拦截，
       与 data-id 同规则；属性缺失（null）不拦截。 */
    var oidAttr = btn.getAttribute('data-opp');
    if (oidAttr != null && !safeActionId(oidAttr)) { toast('ID 异常，操作已阻止'); return; }
    var pidAttr = btn.getAttribute('data-prod');
    if (pidAttr != null && !safeActionId(pidAttr)) { toast('ID 异常，操作已阻止'); return; }

    switch (act) {
      case 'close-modal': closeModal(); break;

      case 'open-opp':
        location.hash = '#/opp/' + id;
        break;

      case 'new-opp': openNewOpp(); break;
      case 'open-seller-app': {
        var sok = true;
        try { window.location.href = 'alisupplier://'; } catch (e) { sok = false; }
        if (!sok) {
          window.open('https://seller.alibaba.com/', '_blank', 'noopener');
          toast('没唤起电脑版，已经给你打开网页版');
          break;
        }
        toast('正在唤起「阿里卖家」…第一次会问一句，点允许');
        setTimeout(function () {
          if (document.hasFocus && document.hasFocus()) {
            toast('客户端没弹出来？点右边「网页版」一样能干活');
          }
        }, 2200);
        break;
      }
      case 'open-seller-web':
        window.open('https://seller.alibaba.com/', '_blank', 'noopener');
        toast('网页版已在新标签打开');
        break;
      case 'quick-demo': runQuickDemo(); break;
      case 'goto-opps': location.hash = '#/opps'; break;
      case 'open-help': openHelp(); break;
      case 'goto-settings': closeModal(); location.hash = '#/settings'; break;
      case 'edit-opp': openEditOpp(id); break;
      case 'edit-parsed': openEditParsed(id); break;
      case 'rematch': S.scoreCache = {}; invalidate(); render(); toast('已按当前解析结果重新匹配'); break;
      case 'save-value-note': saveValueNote(id); break;
      case 'ra-generate': raGenerate(id); break;
      case 'ra-save': raSave(id); break;
      case 'ra-copy': { var raEl = document.getElementById('ra-en'); if (raEl) copyText(raEl.value); break; }
      case 'ra-sent-open': openSentConfirm(id); break;
      case 'ra-sent-confirm': doSentConfirm(id); break;
      case 'follow-edit': openFollowEdit(id, btn.getAttribute('data-rid')); break;
      case 'follow-edit-save': saveFollowEdit(id, btn.getAttribute('data-rid')); break;
      case 'follow-del': askFollowDelete(id, btn.getAttribute('data-rid')); break;
      case 'follow-del-confirm': doFollowDelete(id, btn.getAttribute('data-rid')); break;
      case 'toggle-todo': S.oppTodoOnly = !S.oppTodoOnly; render(); break;
      case 'dataview': S.dataView = btn.getAttribute('data-view') === 'demo' ? 'demo' : 'real'; try { localStorage.setItem('ic_data_view', S.dataView); } catch (e) {} render(); break;
      case 'purge-demo': {
        if (!confirm('清除全部演示数据（演示商机 / 演示商品 / 演示订单）？真实数据不会受影响。')) break;
        var pc = C.purgeDemo(st());
        C.persist(); invalidate(); render();
        toast('已清除演示数据：商机 ' + pc.opps + ' 条、商品 ' + pc.products + ' 个、订单 ' + pc.orders + ' 笔（真实数据未动）');
        break;
      }
      case 'toggle-overdue': S.oppOverdueOnly = !S.oppOverdueOnly; render(); break;
      case 'save-parsed': saveParsed(id); break;
      case 'sales-edit': openSalesEdit(id); break;
      case 'sales-save': saveSalesEdit(id); break;
      case 'copy-questions': {
        var oq = oppById(id);
        if (oq) {
          var qs = followQuestions(effectiveParsed(oq, analyzeOpp(oq)));
          if (qs.length) {
            copyText(qs.map(function (x, i) { return (i + 1) + '. ' + x.en; }).join('\n'));
          } else {
            toast('没有需要补问的问题');
          }
        }
        break;
      }

      case 'select-product': {
        var opp = oppById(btn.getAttribute('data-opp'));
        if (!opp) return;
        opp.selectedProductId = id;
        opp.matchOverride = false;
        opp.quote.autoPrice = true;
        opp.quote.unitPriceUsd = 0;
        C.addLog(opp, '切换匹配商品为 ' + (productById(id) || {}).sku);
        invalidate(); C.persist(); render();
        break;
      }

      case 'apply-recommend': {
        var o2 = oppById(id);
        if (!o2) return;
        o2.quote.autoPrice = true;
        o2.quote.unitPriceUsd = 0;
        invalidate(); C.persist(); render();
        toast('已套用建议价');
        break;
      }

      case 'generate-reply':
      case 'gen-reply': {
        var o3 = oppById(id || (location.hash.match(/opp\/([^\/]+)/) || [])[1]);
        if (!o3) return;
        var lang = btn.getAttribute('data-lang') || 'en';
        var o3p = prepareOpp(o3);
        if (quoteBlock(o3p)) { openQuoteBlock(o3p); return; }
        var ctx = ctxFor(o3p);
        o3.drafts = o3.drafts || {};
        /* P1-FIX-02（批次二）：与全站统一护栏一致——不可报价（缺成本/
           零价/低于保本/低于登记底价等）时禁止走 replyEn/replyZh 的
           无条件价格行（曾生成 Unit price: USD 0.00），改用回复助手
           的无价谈判草稿（强制 price=null，与详情助手卡同一引擎）。
           草稿只写 o3.drafts，不触碰 o3.quote 正式报价字段。 */
        var quotable = ctx.unity ? !!ctx.unity.quotable
          : !!(ctx.pricing && ctx.pricing.flags && ctx.pricing.flags.canQuote);
        if (!quotable) {
          var genNp = replyGenFor(o3p, ctx, true);
          if (!genNp) { toast('当前不可报价，且回复助手未加载，无法生成草稿'); return; }
          o3.drafts[lang] = lang === 'en' ? genNp.en : genNp.zh;
          C.addLog(o3, '生成' + (lang === 'en' ? '英文' : '中文') + '无价谈判草稿（未通过报价护栏）');
        } else {
          o3.drafts[lang] = lang === 'en' ? R.replyEn(ctx) : R.replyZh(ctx);
          C.addLog(o3, '生成' + (lang === 'en' ? '英文' : '中文') + '回复草稿');
        }
        S.tab = lang;
        invalidate(); C.persist(); render();
        toast('草稿已生成，可编辑后复制');
        break;
      }

      case 'tab': {
        S.tab = btn.getAttribute('data-tab');
        render();
        break;
      }

      case 'copy-draft': {
        var o4 = oppById(id);
        var text = o4 && o4.drafts ? o4.drafts[btn.getAttribute('data-lang')] : '';
        copyText(text || '');
        break;
      }

      case 'print-quote': {
        var o5 = oppById(id);
        if (!o5) return;
        var o5p = prepareOpp(o5);
        if (quoteBlock(o5p)) { openQuoteBlock(o5p); return; }
        var doc = R.quoteDocument(ctxFor(o5p));
        var w = window.open('', '_blank');
        if (!w) { toast('浏览器拦截了弹窗，请允许后重试'); return; }
        try { w.opener = null; } catch (err) { /* 同源新窗口才能置空，置不了也不影响打印 */ }
        w.document.open();
        w.document.write(doc);
        w.document.close();
        setTimeout(function () { try { w.print(); } catch (err) { } }, 400);
        break;
      }

      case 'mark-quoted': {
        var o6 = oppById(id);
        if (!o6) return;
        if (quoteBlock(o6)) { openQuoteBlock(o6); return; }
        o6.status = 'quoted';
        C.pushQuoteVersion(o6, o6.quote, '标记报价');
        W.startFollow(o6, st().settings);
        C.addLog(o6, '自动排跟进：' + C.fmtDate(o6.followUpAt, true));
        invalidate(); C.persist(); render();
        toast('已标记报价，' + C.num(st().settings.followUpDays, 3) + ' 天后提醒跟进');
        break;
      }

      case 'force-quote': {
        var o7 = oppById(id);
        if (!o7) return;
        o7.matchOverride = true;
        C.addLog(o7, '人工核对后放行：所选商品与询盘硬性冲突，仍继续报价');
        closeModal();
        invalidate(); C.persist(); render();
        toast('已放行，现在可以生成回复 / 报价单了');
        break;
      }

      case 'open-follow': openFollow(id); break;
      case 'save-follow': saveFollow(id); break;
      case 'copy-follow': copyFollow(id, btn.getAttribute('data-kind'), btn.getAttribute('data-lang') || 'zh'); break;
      case 'copy-nego': copyNego(id, C.num(btn.getAttribute('data-zone'))); break;
      case 'restore-backup': doRestoreBackup(); break;
      case 'cat-only-empty': S.catOnlyEmpty = true; S.catQ = ''; location.hash = '#/catalog'; invalidate(); render(); break;

      case 'open-settle': openSettle(id); break;
      case 'confirm-settle': confirmSettle(id); break;
      case 'open-lose': openLose(id); break;
      case 'confirm-lose': confirmLose(id); break;

      case 'delete-opp': {
        if (!confirm('确定删除这条商机？')) return;
        var arr = st().opportunities;
        var idx = arr.findIndex(function (o) { return o.id === id; });
        if (idx >= 0) arr.splice(idx, 1);
        invalidate(); C.persist();
        location.hash = '#/opps';
        break;
      }

      case 'new-product': openProduct(null); break;
      case 'edit-product': openProduct(id); break;

      case 'delete-product': {
        if (!confirm('删除这个商品？')) return;
        var ps = st().products;
        var pi = ps.findIndex(function (p) { return p.id === id; });
        if (pi >= 0) {
          C.audit('删除商品', String(ps[pi].title || ps[pi].sku).slice(0, 40));
          ps.splice(pi, 1);
        }
        invalidate(); C.persist(); render();
        toast('已删除');
        break;
      }

      case 'save-product': saveProduct(id); break;
      case 'use-price': {
        var pr0 = productById(id);
        if (pr0) {
          pr0.costRmb = C.num(btn.getAttribute('data-price'));
          pr0.costSource = btn.getAttribute('data-src') || '淘宝';
          pr0.costNote = '查价页手填';
          invalidate(); C.persist(); render();
          toast('已填入 ¥' + pr0.costRmb);
        }
        break;
      }

      /* 批量补成本：只补当前筛选里没成本、且有候选价的商品 */
      case 'bulk-fill-cost': {
        var pd = window.PRICE_CANDIDATES || {};
        var targetsAll = bulkTargets(pd);
        if (!targetsAll.length) { toast('当前筛选里没有能补成本的商品'); break; }
        var fac = bulkFactor();
        if (!confirm('给 ' + targetsAll.length + ' 个商品填入成本？\n\n按候选价中位数 × ' + fac +
          '\n已有成本的不动；填完可以一键撤销。')) break;
        S.bulkUndo = targetsAll.map(function (p) {
          return { id: p.id, costRmb: p.costRmb, costSource: p.costSource, costNote: p.costNote };
        });
        var stamp = new Date().toISOString().slice(0, 10);
        targetsAll.forEach(function (p) {
          p.costRmb = suggestedCost(p, pd);
          p.costSource = '淘宝参考价';
          p.costNote = '批量估算 ' + stamp + ' × ' + fac;
        });
        invalidate(); C.persist(); render();
        toast('已补 ' + targetsAll.length + ' 个，还剩 ' + costlessCount() + ' 个没成本');
        break;
      }

      case 'undo-bulk-cost': {
        if (!S.bulkUndo.length) { toast('没有可撤销的批量操作'); break; }
        var n0 = 0;
        S.bulkUndo.forEach(function (r) {
          var p = productById(r.id);
          if (!p) return;
          p.costRmb = r.costRmb;
          p.costSource = r.costSource;
          p.costNote = r.costNote;
          n0++;
        });
        S.bulkUndo = [];
        invalidate(); C.persist(); render();
        toast('已撤销 ' + n0 + ' 个商品的成本');
        break;
      }
      case 'tr-zh': {
        var op1 = oppById(id) || oppById(S.oppId);
        if (!op1 || !window.Translate) break;
        S.oppId = op1.id;
        S.oppLang = 'zh';
        if (S.oppTextZh) { render(); break; }
        runTranslation(op1);
        render();
        setTimeout(function () { paintTr(); paintRawText(); }, 30);
        break;
      }
      case 'tr-raw': S.oppLang = 'raw'; render(); break;
      case 'clear-logs':
        if (confirm('清空全部操作日志？')) {
          st().logs = []; C.persist(); render(); toast('已清空');
        }
        break;
      case 'save-fee-types': {
        var inputs = [].slice.call(document.querySelectorAll('[data-fee-type]'));
        var mm = {};
        inputs.forEach(function (inp) {
          var v = C.num(inp.value);
          if (v > 0) mm[inp.getAttribute('data-fee-type')] = Math.min(0.5, v / 100);
        });
        C.audit('修改品类费率', Object.keys(mm).length + ' 个品类');
        st().settings.feeRateByType = mm;
        invalidate(); C.persist();
        toast('已保存 ' + Object.keys(mm).length + ' 个品类的费率');
        break;
      }
      case 'export-orders': exportOrdersCsv(); break;
      case 'export-catalog': exportCatalogCsv(); break;
      case 'cat-type':
        S.catType = btn.getAttribute('data-type') || '';
        render();
        break;
      case 'refund-order': {
        var ords2 = st().orders || [];
        var o2 = ords2.find(function (x) { return x.id === id; });
        if (!o2) break;
        var cur = C.num(o2.refundUsd);
        var v = prompt('退款金额（USD，整单金额 ' + C.usd(o2.amountUsd) + '）\n填 0 表示撤销退款', String(cur || 0));
        if (v === null) break;
        var rv = Math.max(0, Math.min(C.num(v), C.num(o2.amountUsd)));
        C.audit('记退款', o2.title + ' $' + rv);
        o2.refundUsd = C.round2(rv);
        recalcOrder(o2, st().settings);
        invalidate(); C.persist(); render();
        toast(rv > 0 ? '已记退款 ' + C.usd(rv) + '，利润重算为 ' + C.money(o2.netRmb) : '已撤销退款');
        break;
      }
      case 'new-order': openOrder(); break;
      case 'refresh-fx': refreshFx(true); break;
      case 'toggle-key': {
        var ki = document.getElementById('set-dashscopeKey');
        if (ki) {
          var show = ki.type === 'password';
          ki.type = show ? 'text' : 'password';
          if (btn) btn.textContent = show ? '隐藏' : '显示';
        }
        break;
      }
      case 'test-qwen': {
        var out1 = document.getElementById('qwen-test-out');
        if (out1) out1.textContent = '调用中…';
        /* 前端不再持有密钥：这里只探一下服务端代理通不通 */
        fetch('/api/ai', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: 'translate',
            text: 'We need 500 pcs of ES900 receiver with CE certificate.',
            to: 'zh-CN'
          })
        }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); }).then(function (res) {
          var c = res.json && res.json.text;
          var why = res.status === 401 ? '需要先登录（登录后服务器才肯出密钥）'
            : res.status === 503 ? '服务器没配 DASHSCOPE_KEY'
            : res.status === 404 ? '服务端没有 /api/ai' : '';
          if (out1) out1.innerHTML = (res.status === 200 && c)
            ? '<span style="color:#0f9d58">成功：' + esc(String(c).trim().slice(0, 60)) + '</span>'
            : '<span style="color:#d92d20">失败：' + esc(why || ('HTTP ' + res.status)) + '</span>';
        }).catch(function (e) {
          if (out1) out1.innerHTML = '<span style="color:#d92d20">失败：' + esc(String(e.message).slice(0, 60)) + '</span>';
        });
        break;
      }
      case 'test-translate': {
        var outEl = document.getElementById('tr-test-out');
        var ep = document.getElementById('set-translateEndpoint');
        var rawEp = String((ep && ep.value) || '').trim();
        var okEp = rawEp ? Core.normalizeEndpoint(rawEp) : '';
        /* 地址先过校验再存：以前直接写进去，公网 http 地址照样保存，
           测试当场失败但设置已经脏了，下次打开还报同一个错。 */
        if (rawEp && !okEp) {
          if (outEl) outEl.innerHTML = '<span style="color:#d92d20">地址不可用：只支持 https，或内网的 http / .local 地址。没有保存。</span>';
          break;
        }
        if (outEl) outEl.textContent = '测试中…';
        st().settings.translateEndpoint = okEp;
        if (ep && okEp !== rawEp) ep.value = okEp;
        if (window.Translate) window.Translate.clearCache();
        window.Translate.text('We need 500 pcs of ES900 receiver.', 'zh-CN', function (err, res) {
          if (!outEl) return;
          if (err) { outEl.innerHTML = '<span style="color:#d92d20">失败：' + esc(err.message) + '</span>'; return; }
          outEl.innerHTML = '<span style="color:#0f9d58">成功：' + esc(res.text) + '</span>';
        });
        break;
      }
      case 'save-order': saveOrder(); break;
      case 'delete-order': {
        var ords = st().orders || [];
        var oi = ords.findIndex(function (o) { return o.id === id; });
        if (oi >= 0 && confirm('删除这条订单记录？')) {
          C.audit('删除订单', ords[oi].title + ' ' + C.usd(ords[oi].amountUsd));
          ords.splice(oi, 1);
          invalidate(); C.persist(); render();
          toast('已删除');
        }
        break;
      }
      case 'bulk-cost': openBulkCost(); break;
      case 'do-bulk-cost': doBulkCost(); break;
      case 'import-products': openImportProducts(); break;
      case 'parse-import': parseImport(); break;
      case 'import-back': openImportProducts(importDraft ? importDraft.raw : ''); break;
      case 'do-import-products': doImportProducts(); break;

      case 'save-settings': saveSettings(); break;

      case 'reset-demo': {
        if (!confirm('重置为演示数据？你录入的商机和商品都会被清空。')) return;
        C.reset();
        invalidate();
        location.hash = '#/dashboard';
        render();
        toast('已重置');
        break;
      }

      case 'export-json': {
        /* P1-23-R7-R2：正式备份改为 ic-backup v2 整包（业务状态 + 身份注册表 + 校验和）。
           事务层不可用时回退旧导出并明示（旧导出不含注册表）。 */
        if (window.IdentityTxn) {
          /* R6 第七项：buildBackup 在注册表读取失败/损坏时抛错拒绝
             生成备份，此处必须接住并明示，不得让异常冒泡打断页面、
             更不得回退成一份看似完整的残缺备份。 */
          var bundle;
          try { bundle = window.IdentityTxn.buildBackup(C, window.localStorage); }
          catch (e) { toast('备份失败：身份注册表读取异常（' + String(e && e.message || e) + '），未生成备份'); break; }
          var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'inquiry-copilot-backup-v2.json';
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 400);
          C.audit('导出完整备份', 'ic-backup v2（含身份注册表）');
        } else { C.exportJson(); }
        break;
      }
      case 'import-json': document.getElementById('file-input').click(); break;
      case 'identity-recover': {
        if (!window.IdentityTxn) break;
        var rc = window.IdentityTxn.recover({ storage: window.localStorage, core: C, bizKey: C.STORE_KEY });
        if (rc.recovered) { toast('恢复完成：未完成批次已回滚并通过校验，写入阻断解除'); invalidate(); render(); }
        else toast('恢复未完成（' + rc.reason + '），写入继续保持阻断');
        break;
      }
      case 'import-merge': {
        if (!pendingImport) break;
        if (pendingImport.identityBatch === true && window.IdentityMigration) {
          /* P1-23-R7-R2：身份导入改走事务层（journal + 锁 + 读回校验）。
             事务层不可用时拒绝执行，绝不回退到无事务的旧落盘方式。 */
          if (!window.IdentityTxn) { toast('身份事务层未加载，已拒绝导入（不回退旧路径）'); break; }
          var ib = window.IdentityTxn.commitImport({ storage: window.localStorage, core: C, batch: pendingImport, opts: {
            buildEntity: function (type, content, internalId, rec) { return rec.entity || null; },
            applyContent: function (ent, content) { if (content && typeof content === 'object') Object.keys(content).forEach(function (k) { ent[k] = content[k]; }); }
          } });
          if (!ib.applied) {
            toast(ib.locked ? '存在未恢复的身份事务，已阻断导入，请先在同步与设置页处理恢复' : '身份层导入未完成' + (ib.stage ? '（阶段：' + ib.stage + '）' : '') + '，数据未标记为成功' + (ib.batchId ? '，批次 ' + ib.batchId : ''));
            break;
          }
          C.audit('身份层合并导入', JSON.stringify(ib.counts));
          pendingImport = null;
          closeModal(); invalidate(); render();
          toast('身份层导入完成：' + Object.keys(ib.counts).map(function (k) { return k + ' ' + ib.counts[k]; }).join(' · '));
          break;
        }
        var added = C.mergeAll(pendingImport);
        C.audit('合并导入', '商品 +' + added.products + ' / 商机 +' + added.opportunities + ' / 订单 +' + added.orders);
        pendingImport = null;
        closeModal(); invalidate(); render();
        toast('已合并：商品 +' + added.products + '，商机 +' + added.opportunities + '，订单 +' + added.orders);
        break;
      }
      case 'import-restore-bundle': {
        if (!pendingImport || !window.IdentityTxn) break;
        var rb = window.IdentityTxn.restoreBundle({ storage: window.localStorage, core: C, bundle: pendingImport });
        if (!rb.restored) { toast('完整备份恢复失败（' + rb.reason + '），写入保持阻断状态'); break; }
        C.audit('完整备份恢复', rb.legacyPending ? 'ic-backup v2（无注册表，已标记旧格式待迁移）' : 'ic-backup v2');
        pendingImport = null;
        closeModal(); invalidate(); render();
        toast(rb.legacyPending ? '已恢复业务数据；该备份不含身份注册表，已标记为旧格式待迁移' : '完整备份恢复完成');
        break;
      }
      case 'import-replace': {
        if (!pendingImport) break;
        if (!confirm('确定用这份备份覆盖现在的全部数据？覆盖后无法撤销。')) break;
        var snap = C.validateBackup(pendingImport);
        C.replaceAll(pendingImport);
        /* R7-R2：旧格式备份不含身份注册表，覆盖后标记待迁移（不伪造新注册表） */
        if (window.IdentityTxn) window.IdentityTxn.setLegacyPending(window.localStorage);
        C.audit('覆盖导入', '商品 ' + snap.counts.products + ' / 商机 ' + snap.counts.opportunities + ' / 订单 ' + snap.counts.orders);
        pendingImport = null;
        closeModal(); invalidate(); render();
        toast('已覆盖导入');
        break;
      }

      case 'save-opp': saveOpp(id); break;
      case 'dup-open': S.pendingCreate = null; closeModal(); location.hash = '#/opp/' + id; render(); break;
      case 'dup-create-anyway': { var pc = S.pendingCreate; S.pendingCreate = null; if (pc) doCreateOpp(pc); break; }

      default: break;
    }
  });

  /* =========================================================
     交互：输入
     ========================================================= */

  document.addEventListener('input', function (e) {
    var el = e.target;

    /* 搜索框：只换表格内容，保持输入焦点 */
    if (el.id === 'fx-shock') {
      var fxOut = document.getElementById('fx-shock-out');
      if (fxOut) fxOut.innerHTML = fxShockResult(Math.max(1, C.num(el.value, 7.1)));
      return;
    }
    if (el.id === 'sb-price' || el.id === 'sb-qty') {
      var sbOpp = oppById(el.getAttribute('data-opp'));
      if (!sbOpp) return;
      var sbPrice = C.num(document.getElementById('sb-price').value);
      var sbQty = Math.max(1, C.num(document.getElementById('sb-qty').value));
      var po = document.getElementById('sb-price-out');
      var qo = document.getElementById('sb-qty-out');
      if (po) po.textContent = C.usd(sbPrice);
      if (qo) qo.textContent = sbQty.toLocaleString();
      var res = document.getElementById('sb-result');
      if (res) res.innerHTML = sandboxResult(ctxWithQty(sbOpp, sbQty), sbPrice, sbQty);
      return;
    }
    if (el.id === 'opp-search') {
      S.oppQ = el.value;
      debounceSearch(function () {
        var ob = document.getElementById('opp-body');
        if (ob) ob.innerHTML = oppRows();
        var oc = document.getElementById('opp-count');
        if (oc) oc.textContent = '显示 ' + oppFiltered().length + ' / ' + st().opportunities.length + ' 条';
      });
      return;
    }
    if (el.id === 'cat-search') {
      S.catQ = el.value;
      debounceSearch(function () {
        var tb = document.getElementById('cat-body');
        if (tb) tb.innerHTML = catalogRows(S.catQ, S.catOnlyEmpty);
        var cnt = document.getElementById('cat-count');
        if (cnt) cnt.textContent = catalogCount();
      });
      return;
    }
    if (el.id === 'rev-search') {
      S.revQ = el.value;
      debounceSearch(paintReview);
      return;
    }
    if (el.id === 'bulk-factor') {
      S.bulkFactor = el.value;
      paintReview();
      return;
    }

    /* 商机报价字段 */
    var oppId = el.getAttribute && el.getAttribute('data-opp');
    var field = el.getAttribute && el.getAttribute('data-field');

    if (oppId && field) {
      var opp = oppById(oppId);
      if (!opp) return;
      var val = el.value;
      var prodtmp = productById(opp.selectedProductId);

      var needRecalc = false;

      if (field === 'qty') {
        if (String(val).trim() === '') return;
        opp.quote.qty = Math.max(1, C.num(val, 1));
        needRecalc = true;
      } else if (field === 'costRmb') {
        opp.quote.costRmb = C.num(val, 0);
        if (prodtmp) prodtmp.costRmb = opp.quote.costRmb;
        needRecalc = true;
      } else if (field === 'marketPriceRmb') {
        if (prodtmp) prodtmp.marketPriceRmb = C.num(val, 0);
        needRecalc = true;
      } else if (field === 'shippingRmb') {
        opp.quote.shippingRmb = C.num(val, 0);
        if (prodtmp) prodtmp.shippingRmb = opp.quote.shippingRmb;
        needRecalc = true;
      } else if (field === 'unitPriceUsd') {
        opp.quote.unitPriceUsd = C.num(val, 0);
        opp.quote.autoPrice = false;
      } else if (field === 'leadTimeDays') {
        opp.quote.leadTimeDays = Math.max(0, C.num(val, 0));
      } else {
        opp.quote[field] = val;
      }

      if (needRecalc && opp.quote.autoPrice !== false) {
        var rec = P.evaluate({
          product: productById(opp.selectedProductId),
          qty: opp.quote.qty, settings: st().settings,
          unitCostRmb: opp.quote.costRmb, shippingRmb: opp.quote.shippingRmb,
          unitPriceUsd: null
        }).recommendUsd;
        opp.quote.unitPriceUsd = rec;
        var priceInput = safeActionId(oppId) ? document.querySelector('[data-opp="' + oppId + '"][data-field="unitPriceUsd"]') : null;
        if (priceInput) priceInput.value = C.round(rec, 2);
      }
      refreshPricing(oppId);
      C.persist();
    }
  });

  document.addEventListener('change', function (e) {
    watchPersistFailure();
    var el = e.target;

    /* 改完价或数量（失焦时）记一版，便于回看这一单改过几次价 */
    var fName = el.getAttribute && el.getAttribute('data-field');
    var fOppId = el.getAttribute && el.getAttribute('data-opp');
    if (fName && fOppId && (fName === 'unitPriceUsd' || fName === 'qty')) {
      var fOpp = oppById(fOppId);
      if (fOpp) {
        C.pushQuoteVersion(fOpp, fOpp.quote, fName === 'qty' ? '改数量' : '手工改价');
        C.persist();
      }
      return;
    }

    if (el.id === 'opp-f-country') { S.oppCountry = el.value; render(); return; }
    if (el.id === 'opp-f-type') { S.oppType = el.value; render(); return; }
    if (el.id === 'opp-f-tier') { S.oppTier = el.value; render(); return; }
    if (el.id === 'opp-f-status') { S.oppStatus = el.value; render(); return; }
    if (el.id === 'opp-sort') { S.oppSort = el.value; render(); return; }
    if (el.id === 'ra-scenario') { S.replyScenario = el.value; render(); return; }
    if (el.id === 'fu-status-sel') {
      var fso = oppById(S.oppId);
      if (fso) {
        fso.followStatus = el.value || null;
        C.addLog(fso, '跟进状态改为：' + (el.value && window.FollowUp ? window.FollowUp.statusLabel(el.value) : '自动推导'));
        C.persist();
      }
      render(); return;
    }

    if (el.id === 'ord-product') {
      var pd = productById(el.value);
      if (pd) {
        var q = C.num(document.getElementById('ord-qty').value, 1) || 1;
        var tier = P.tierFor(pd, q);
        var unitEl = document.getElementById('ord-unit');
        var amtEl = document.getElementById('ord-amount');
        var costEl = document.getElementById('ord-cost');
        if (!C.num(unitEl.value)) unitEl.value = C.round(tier.price, 2);
        if (!C.num(amtEl.value)) amtEl.value = C.round(tier.price * q, 2);
        if (!C.num(costEl.value) && C.num(pd.costRmb) > 0) costEl.value = C.round(C.num(pd.costRmb) * q, 2);
      }
      return;
    }
    if (el.id === 'cat-only-empty') {
      S.catOnlyEmpty = el.checked;
      var tbA = document.getElementById('cat-body');
      if (tbA) tbA.innerHTML = catalogRows(S.catQ, S.catOnlyEmpty);
      var cntA = document.getElementById('cat-count');
      if (cntA) cntA.textContent = catalogCount();
      return;
    }
    if (el.id === 'rev-only-pending') {
      S.revOnlyPending = el.checked;
      paintReview();
      return;
    }

    /* 商品库表格里直接改成本 / 市场价 */
    var pid = el.getAttribute && el.getAttribute('data-prod');
    var pfield = el.getAttribute && el.getAttribute('data-pfield');
    if (pid && pfield) {
      var p0 = productById(pid);
      if (p0) {
        p0[pfield] = C.num(el.value, 0);
        invalidate(); C.persist(); render();
      }
      return;
    }

    /* 导入：列对应关系 */
    if (el.hasAttribute && el.hasAttribute('data-import-col')) {
      if (!importDraft) return;
      var role = el.value || null;
      var ci = parseInt(el.getAttribute('data-import-col'), 10);
      if (role) {
        for (var k = 0; k < importDraft.g.mapping.length; k++) {
          if (k !== ci && importDraft.g.mapping[k] === role) importDraft.g.mapping[k] = null;
        }
      }
      importDraft.g.mapping[ci] = role;
      renderImportPreview();
      return;
    }

    if (el.id === 'import-replace' && importDraft) { importDraft.replace = el.checked; return; }
    if (el.id === 'import-cny' && importDraft) { importDraft.convertCny = el.checked; renderImportPreview(); return; }

    if (el.id === 'file-input' && el.files && el.files[0]) {
      handleBackupFile(el.files[0]);
      el.value = '';
    }
  });

  /* =========================================================
     局部刷新（避免输入框失焦）
     ========================================================= */

  /* ---------------- 导入备份：先校验、再预览、后落盘 ---------------- */

  var MAX_BACKUP_MB = 20;

  function handleBackupFile(file) {
    if (!file) return;

    if (file.size > MAX_BACKUP_MB * 1024 * 1024) {
      toast('文件太大（' + (file.size / 1024 / 1024).toFixed(1) + 'MB），备份一般只有几 MB');
      return;
    }
    if (!/\.json$/i.test(file.name || '')) {
      toast('只认 .json 备份文件，你选的是「' + (file.name || '未知') + '」');
      return;
    }

    var reader = new FileReader();
    reader.onerror = function () { toast('文件读不出来，可能已损坏或被占用'); };
    reader.onload = function () {
      var obj;
      try {
        obj = JSON.parse(String(reader.result));
      } catch (e) {
        toast('不是有效的 JSON：' + String(e.message).slice(0, 60));
        return;
      }

      /* P1-23-R7-R2：ic-backup v2 完整备份（含身份注册表）先验校验和，再走整包恢复。 */
      if (obj && obj.format === 'ic-backup' && obj.version === 2 && window.IdentityTxn) {
        var vb = window.IdentityTxn.validateBundle(obj);
        if (!vb.ok) { toast('完整备份校验失败（' + vb.reason + '），未恢复任何数据'); return; }
        pendingImport = obj;
        openModal(modalHead('确认恢复完整备份') +
          '<div class="modal-bd"><div class="alert warn"><span class="ic">!</span><div>这份备份包含<strong>业务数据与身份注册表</strong>，恢复将整包替换当前两类数据，恢复期间写入被阻断，失败不会标记为成功。</div></div>' +
          '<div class="hint">导出于 ' + esc(String(obj.exportedAt || '')) + (obj.identityRegistry ? ' · 含身份注册表' : ' · 不含身份注册表（恢复后将标记为旧格式待迁移）') + '</div></div>' +
          '<div class="modal-ft"><button class="btn ghost" data-action="close-modal">取消</button>' +
          '<button class="btn danger" data-action="import-restore-bundle">整包恢复</button></div>', true);
        return;
      }

      /* P1-23-R7：带 identityBatch 标记的文件走身份映射层（单入口接管）。
         这类文件不是整表备份，不经 validateBackup；处理结果在预览弹窗明示，
         失败时不落盘、也绝不自动改走旧合并路径。 */
      if (obj && obj.identityBatch === true && Array.isArray(obj.records) && window.IdentityMigration) {
        pendingImport = obj;
        openModal(modalHead('确认导入（身份映射层）') +
          '<div class="modal-bd">' +
          '<div class="hint">来源系统：' + esc(String(obj.source_system || '')) + ' · 来源账号：' + esc(String(obj.source_account || '')) + ' · 记录 ' + obj.records.length + ' 条</div>' +
          '<div class="alert warn" style="margin-top:10px"><span class="ic">!</span><div>本文件将通过<strong>身份映射层</strong>合并：重复身份命中原记录不重复建档；版本不明或内容冲突的记录进入冲突待处理，不会静默覆盖。处理失败时整批不落盘，也不会改走旧合并路径。</div></div>' +
          '</div><div class="modal-ft"><button class="btn ghost" data-action="close-modal">取消</button>' +
          '<button class="btn" data-action="import-merge">通过身份层合并导入</button></div>', true);
        return;
      }

      var v = C.validateBackup(obj);
      if (!v.ok) {
        openModal(modalHead('这个文件不能导入') +
          '<div class="modal-bd"><div class="alert warn"><span class="ic">!</span><div>' +
          '<strong>问题：</strong><br>' + v.errors.map(function (e) { return '· ' + esc(e); }).join('<br>') +
          '<br><br>你的数据没有被改动。</div></div>' +
          '<div class="hint">这个文件：' + esc(file.name) + ' · ' + (file.size / 1024).toFixed(1) + ' KB</div>' +
          '</div><div class="modal-ft"><button class="btn ghost" data-action="close-modal">知道了</button></div>', true);
        return;
      }

      var c = v.counts;
      openModal(modalHead('确认导入这份备份') +
        '<div class="modal-bd">' +
        '<div class="table-wrap"><table class="table"><thead><tr><th>内容</th><th class="num">文件里</th>' +
        '<th class="num">你现在的</th></tr></thead><tbody>' +
        '<tr><td>商品</td><td class="num">' + c.products + '</td><td class="num">' + st().products.length + '</td></tr>' +
        '<tr><td>商机</td><td class="num">' + c.opportunities + '</td><td class="num">' + st().opportunities.length + '</td></tr>' +
        '<tr><td>订单</td><td class="num">' + c.orders + '</td><td class="num">' + (st().orders || []).length + '</td></tr>' +
        '</tbody></table></div>' +
        '<div class="alert warn" style="margin-top:12px"><span class="ic">!</span><div>' +
        '<strong>覆盖导入</strong>会用文件里的内容替换你现在的全部数据，无法撤销。<br>' +
        '<strong>合并导入</strong>只补充文件里有、你这里没有的条目（按 id 去重）。</div></div>' +
        '<div class="hint">文件：' + esc(file.name) + ' · ' + (file.size / 1024).toFixed(1) + ' KB' +
        (v.meta && v.meta.exportedAt ? ' · 导出于 ' + esc(String(v.meta.exportedAt).slice(0, 16).replace('T', ' ')) : '') +
        '</div></div>' +
        '<div class="modal-ft">' +
        '<button class="btn ghost" data-action="close-modal">取消</button>' +
        '<button class="btn" data-action="import-merge">合并导入</button>' +
        '<button class="btn danger" data-action="import-replace">覆盖导入</button>' +
        '</div>', true);

      pendingImport = obj;
    };
    reader.readAsText(file);
  }

  var pendingImport = null;

  function refreshPricing(oppId) {
    var opp = oppById(oppId);
    if (!opp) return;
    var ctx = ctxFor(opp);

    var verdict = document.querySelector('[data-pf="verdict"]');
    if (verdict) verdict.innerHTML = verdictHtml(ctx);

    var split = document.querySelector('[data-pf="split"]');
    if (split) split.innerHTML = rangeBarHtml(ctx);

    var floors = document.querySelector('[data-pf="floors"]');
    if (floors) floors.innerHTML = floorsHtml(ctx);

    var profit = document.querySelector('[data-pf="profit"]');
    if (profit) profit.innerHTML = profitHtml(ctx);

    var flags = document.querySelector('[data-pf="flags"]');
    if (flags) flags.innerHTML = flagsHtml(ctx);

    var ladder = document.querySelector('[data-pf="ladder"]');
    if (ladder) ladder.innerHTML = ladderHtml(ctx);

    var sens = document.querySelector('[data-pf="sens"]');
    if (sens) sens.innerHTML = sensHtml(ctx);
  }

  /* =========================================================
     弹窗：新建 / 编辑商机
     ========================================================= */

  /* 一键体验：用你自己的第一个商品生成一条示例询盘，直接跳到结论页 */
  function runQuickDemo() {
    /* 示例商机固定 id + 演示标记：重复点击只打开同一条，不再往真实商机里
       不断塞无法识别的示例；清除演示数据后它也不会残留 */
    var existing = oppById('opp_quick_demo');
    if (existing) { location.hash = '#/opp/' + existing.id; render(); return; }
    var p = st().products[0];
    if (!p) { toast('先导入商品，才能演示'); return; }

    var qty = Math.max(Number(p.moq) * 3 || 1000, 100);
    var target = Math.round(Number(p.priceUsd) * 1.10 * 100) / 100;
    var certs = (p.certs || []).join(', ');

    var text = 'Dear Sales Manager,\n\n' +
      'We are a retail chain based in Spain and we are interested in ' + (p.titleEn || p.title) + '.\n\n' +
      'Quantity: ' + qty + ' pcs\n' +
      'Target price: USD ' + target + ' per pc, FOB\n' +
      (certs ? 'Certificates: ' + certs + '\n' : '') +
      'Lead time: 30 days\n\n' +
      'Please send your best quotation and MOQ.\n\nBest regards,\nLaura';

    var parsed = M.parse(text);
    var opp = C.normalizeOpp({
      id: 'opp_quick_demo',
      demo: true,
      buyer: {
        name: 'Laura Gómez',
        company: 'Outdoor Life S.L.',
        country: parsed.country || '西班牙',
        channel: 'RFQ'
      },
      rawText: text,
      quote: {
        qty: parsed.qty || qty,
        unitPriceUsd: 0,
        incoterm: st().settings.defaultIncoterm,
        leadTimeDays: 30,
        validDays: st().settings.quoteValidDays
      }
    });
    C.addLog(opp, '一键体验：自动生成的示例商机');

    st().opportunities.unshift(opp);
    invalidate();
    C.persist();
    location.hash = '#/opp/' + opp.id;
    render();
    toast('这是示例商机，下面就是结论');
  }

  function openNewOpp() {
    var html = modalHead('新建商机') +
      '<div class="modal-bd">' +
      '<div class="alert info" style="margin-bottom:14px"><span class="ic">i</span><div>' +
      '把买家发来的询盘 / RFQ 原文整个粘进来，系统会自动识别数量、目标价、交期、认证和市场。</div></div>' +
      '<div class="form-grid">' +
      '<div class="field"><label>买家称呼</label><input type="text" id="opp-name" placeholder="如 Michael Braun"></div>' +
      '<div class="field"><label>公司</label><input type="text" id="opp-company" placeholder="选填"></div>' +
      '<div class="field"><label>市场 / 国家</label><input type="text" id="opp-country" placeholder="如 德国"></div>' +
      '<div class="field"><label>来源渠道</label><select id="opp-channel">' +
      '<option>询盘</option><option>RFQ</option><option>旺旺</option><option>访客</option><option>其他</option>' +
      '</select></div>' +
      '<div class="field full"><label>询盘 / RFQ 原文</label>' +
      '<textarea id="opp-raw" style="min-height:200px" placeholder="Dear Sales Manager, ...&#10;&#10;Quantity: 2000 pcs&#10;Target price: USD 3.20 / pc FOB&#10;Certificates: FDA, LFGB&#10;Delivery: 30 days"></textarea></div>' +
      '</div></div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-opp">解析并创建</button>' +
      '</div>';
    openModal(html, true);
  }

  function openEditOpp(id) {
    var opp = oppById(id);
    if (!opp) return;
    var html = modalHead('编辑商机') +
      '<div class="modal-bd">' +
      '<input type="hidden" id="opp-id" value="' + safeActionId(opp.id) + '">' +
      '<div class="form-grid">' +
      '<div class="field"><label>买家称呼</label><input type="text" id="opp-name" value="' + esc(opp.buyer.name) + '"></div>' +
      '<div class="field"><label>公司</label><input type="text" id="opp-company" value="' + esc(opp.buyer.company) + '"></div>' +
      '<div class="field"><label>市场 / 国家</label><input type="text" id="opp-country" value="' + esc(opp.buyer.country) + '"></div>' +
      '<div class="field"><label>来源渠道</label><select id="opp-channel">' +
      ['询盘', 'RFQ', '旺旺', '访客', '其他'].map(function (c) {
        return '<option' + (c === opp.buyer.channel ? ' selected' : '') + '>' + c + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field full"><label>询盘 / RFQ 原文</label>' +
      '<textarea id="opp-raw" style="min-height:200px">' + esc(opp.rawText) + '</textarea></div>' +
      '</div></div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-opp" data-id="' + safeActionId(opp.id) + '">保存并重新解析</button>' +
      '</div>';
    openModal(html, true);
  }

  function saveOpp(id) {
    var name = document.getElementById('opp-name').value.trim() || '未知买家';
    var company = document.getElementById('opp-company').value.trim();
    var country = document.getElementById('opp-country').value.trim();
    var channel = document.getElementById('opp-channel').value;
    var raw = document.getElementById('opp-raw').value;

    if (!raw.trim()) { toast('请先粘贴询盘原文'); return; }

    var parsed = M.parse(raw);

    if (id) {
      var opp = oppById(id);
      if (!opp) return;
      opp.buyer.name = name;
      opp.buyer.company = company;
      opp.buyer.country = country || parsed.country || opp.buyer.country;
      opp.buyer.channel = channel;
      opp.rawText = raw;
      opp.quote.qty = parsed.qty || opp.quote.qty;
      opp.quote.autoPrice = true;
      opp.quote.unitPriceUsd = 0;
      opp.drafts = {};
      C.addLog(opp, '更新商机原文并重新解析');
      closeModal();
      invalidate(); C.persist(); render();
      toast('已更新并重新解析');
      return;
    }

    /* P1-2 批次 2：建档查重闸——命中疑似重复时先让用户裁决，
       查重只是提醒：不自动合并、不自动拒绝、不改写旧商机；
       查重本身异常时按无命中处理，绝不阻断正常建档。 */
    var payload = { name: name, company: company, country: country, channel: channel, raw: raw, parsed: parsed };
    var dups = [];
    try { dups = C.findDuplicateOpps ? C.findDuplicateOpps(st(), S.dataView, { name: name, company: company }, raw) : []; } catch (e) { dups = []; }
    if (dups.length) { S.pendingCreate = payload; openDupModal(dups); return; }
    doCreateOpp(payload);
  }

  function doCreateOpp(p) {
    var fresh = C.normalizeOpp({
      buyer: {
        name: p.name, company: p.company,
        country: p.country || p.parsed.country || '',
        channel: p.channel
      },
      rawText: p.raw,
      quote: {
        qty: p.parsed.qty || 100,
        unitPriceUsd: 0,
        incoterm: p.parsed.incoterm ? (p.parsed.incoterm + ' ' + (st().settings.defaultIncoterm.split(' ')[1] || '')) : st().settings.defaultIncoterm,
        leadTimeDays: p.parsed.leadTimeDays || st().settings.defaultLeadTimeDays,
        validDays: st().settings.quoteValidDays
      }
    });
    C.addLog(fresh, '商机创建（' + p.channel + '渠道）');
    st().opportunities.unshift(fresh);

    closeModal();
    invalidate(); C.persist();
    location.hash = '#/opp/' + fresh.id;
    render();
    toast('已创建并完成匹配');
  }

  /* 疑似重复提示弹窗：逐条列出全部候选（日期/状态/买家/原文摘要），
     每条可单独打开；或明确选择仍要新建。措辞一律「疑似」，不冒充确定。 */
  function openDupModal(dups) {
    var rows = dups.map(function (d) {
      var stLabel = (STATUS[d.status] || {}).label || d.status;
      return '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee">' +
        '<div style="min-width:0"><div><b>' + esc(d.buyerName || '未知买家') + '</b>' +
        (d.company ? ' <span class="mute">' + esc(d.company) + '</span>' : '') +
        ' <span class="badge">' + esc(stLabel) + '</span> <span class="mute">' + esc(String(d.createdAt || '').slice(0, 10)) + '</span></div>' +
        '<div class="mute" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:460px">' + esc(d.snippet) + '</div></div>' +
        '<button class="btn sm" data-action="dup-open" data-id="' + safeActionId(d.id) + '">打开已有商机</button></div>';
    }).join('');
    var html = modalHead('疑似重复询盘') +
      '<div class="modal-bd">' +
      '<div class="alert" style="margin-bottom:8px"><span class="ic">i</span><div>发现 <b>' + dups.length + '</b> 条与本次粘贴内容相同、且买家相同的已有商机。这只是<b>疑似重复</b>提醒，系统不会自动合并或拒绝。你可以打开已有商机继续处理，或确认这是一条新询盘、仍要新建。</div></div>' +
      rows +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="dup-create-anyway">仍要新建</button>' +
      '</div>';
    openModal(html, true);
  }

  /* =========================================================
     弹窗：成交 / 丢单
     ========================================================= */

  function openSettle(id) {
    var opp = oppById(id);
    if (!opp) return;
    prepareOpp(opp);
    var ctx = ctxFor(opp);
    var defAmount = C.round(ctx.pricing.gmvUsd || (opp.quote.qty * opp.quote.unitPriceUsd), 2);

    var html = modalHead('标记成交') +
      '<div class="modal-bd">' +
      '<div class="field"><label>实际成交额（USD，含全部货款）</label>' +
      '<input type="number" id="settle-amount" value="' + defAmount + '" step="0.01"></div>' +
      '<div class="alert info" style="margin-top:12px"><span class="ic">i</span><div>' +
      '系统会按「成交额 − 平台扣费 − 成本」算出真实利润，记进复盘。</div></div>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="confirm-settle" data-id="' + safeActionId(id) + '">确认成交</button>' +
      '</div>';
    openModal(html);
  }

  function confirmSettle(id) {
    var opp = oppById(id);
    if (!opp) return;
    var amount = C.num(document.getElementById('settle-amount').value);
    if (amount <= 0) { toast('成交额必须大于 0'); return; }

    var prod = productById(opp.selectedProductId);
    /* 成本口径必须和报价页一致：进货价 + 运费，缺一项就从商品库补，
       否则成交利润会凭空多出「运费 × 件数」，亏单还可能记成赚。 */
    var unitCost = (opp.quote.costRmb === null || opp.quote.costRmb === undefined || opp.quote.costRmb === '')
      ? C.num(prod && prod.costRmb) : C.num(opp.quote.costRmb);
    var unitShip = (opp.quote.shippingRmb === null || opp.quote.shippingRmb === undefined || opp.quote.shippingRmb === '')
      ? C.num(prod && prod.shippingRmb) : C.num(opp.quote.shippingRmb);
    var d = P.settleDeal({
      amountUsd: amount,
      qty: opp.quote.qty,
      costRmb: (unitCost + unitShip) * C.num(opp.quote.qty),
      product: prod,
      settings: st().settings
    });
    opp.status = 'won';
    opp.deal = {
      finalAmountUsd: d.amountUsd,
      netRmb: d.netRmb,
      closedAt: C.nowIso()
    };
    /* 同时写进订单明细，复盘统一从订单汇总 */
    st().orders.push(C.normalizeOrder({
      productId: opp.selectedProductId,
      sku: (productById(opp.selectedProductId) || {}).sku || '',
      title: (productById(opp.selectedProductId) || {}).title || '',
      qty: opp.quote.qty,
      unitPriceUsd: opp.quote.qty ? d.amountUsd / opp.quote.qty : 0,
      amountUsd: d.amountUsd,
      costRmb: d.costRmb,
      feeRmb: d.feeRmb,
      netRmb: d.netRmb,
      date: new Date().toISOString().slice(0, 10),
      buyer: opp.buyer.name,
      country: opp.buyer.country,
      source: 'opp'
    }));

    C.addLog(opp, '成交，金额 ' + C.usd(d.amountUsd) + '，利润 ' + C.money(d.netRmb));
    closeModal();
    invalidate(); C.persist(); render();
    toast('已记录成交，利润 ' + C.money(d.netRmb));
  }

  function openLose(id) {
    var html = modalHead('标记丢单') +
      '<div class="modal-bd">' +
      '<div class="field"><label>丢单原因</label><select id="lose-reason">' +
      '<option>价格不匹配</option><option>交期太长</option><option>认证缺失</option>' +
      '<option>买家无回复</option><option>规格不符</option><option>起订量谈不拢</option><option>其他</option>' +
      '</select></div>' +
      '<div class="alert info" style="margin-top:12px"><span class="ic">i</span><div>' +
      '记原因比记结果有用。三个月后你会想知道：是价格问题多，还是产品问题多。</div></div>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn danger" data-action="confirm-lose" data-id="' + safeActionId(id) + '">确认丢单</button>' +
      '</div>';
    openModal(html);
  }

  function confirmLose(id) {
    var opp = oppById(id);
    if (!opp) return;
    var reason = document.getElementById('lose-reason').value;
    opp.status = 'lost';
    opp.deal = Object.assign({}, opp.deal || {}, { reason: reason, closedAt: C.nowIso() });
    C.addLog(opp, '丢单：' + reason);
    closeModal();
    invalidate(); C.persist(); render();
    toast('已记录丢单原因');
  }

  /* =========================================================
     弹窗：商品
     ========================================================= */

  function openProduct(id) {
    var p = id ? productById(id) : null;
    var v = function (k, d) { return p ? (p[k] === undefined ? d : p[k]) : d; };

    var html = modalHead(p ? '编辑商品' : '新增商品') +
      '<div class="modal-bd">' +
      '<div class="form-grid">' +
      '<div class="field"><label>SKU</label><input type="text" id="f-sku" value="' + esc(v('sku', '')) + '"></div>' +
      '<div class="field"><label>类目</label><input type="text" id="f-category" value="' + esc(v('category', '')) + '"></div>' +
      '<div class="field full"><label>中文名称</label><input type="text" id="f-title" value="' + esc(v('title', '')) + '"></div>' +
      '<div class="field full"><label>英文名称</label><input type="text" id="f-titleEn" value="' + esc(v('titleEn', '')) + '"></div>' +
      '<div class="field full"><label>关键词（逗号分隔，越全匹配越准）</label>' +
      '<input type="text" id="f-keywords" value="' + esc((v('keywords', []) || []).join(', ')) + '"></div>' +
      '<div class="field full"><label>规格描述（中文）</label><input type="text" id="f-specs" value="' + esc(v('specs', '')) + '"></div>' +
      '<div class="field full"><label>规格描述（英文，写进英文回复和报价单）</label><input type="text" id="f-specsEn" value="' + esc(v('specsEn', '')) + '"></div>' +
      '<div class="field"><label>橱窗价（USD，按 MOQ 数量）</label><input type="number" id="f-priceUsd" step="0.01" value="' + v('priceUsd', 0) + '"></div>' +
      '<div class="field"><label>价格区间下限 / 商品登记底价（可选，低于它报价需特批）</label><input type="number" id="f-priceFloorUsd" step="0.01" value="' + v('priceFloorUsd', 0) + '"></div>' +
      '<div class="field"><label>采购成本（元/件，1688 查的）</label><input type="number" id="f-costRmb" step="0.01" value="' + v('costRmb', 0) + '"></div>' +
      '<div class="field"><label>别家卖多少（元/件）</label><input type="number" id="f-marketPriceRmb" step="0.01" value="' + v('marketPriceRmb', 0) + '"></div>' +
      
      '<div class="field"><label>MOQ</label><input type="number" id="f-moq" step="1" value="' + v('moq', 100) + '"></div>' +
      '<div class="field"><label>交期（天）</label><input type="number" id="f-leadTimeDays" step="1" value="' + v('leadTimeDays', 15) + '"></div>' +
      '<div class="field"><label>认证（逗号分隔）</label><input type="text" id="f-certs" value="' + esc((v('certs', []) || []).join(', ')) + '"></div>' +
      '<div class="field"><label>HS 编码</label><input type="text" id="f-hsCode" value="' + esc(v('hsCode', '')) + '"></div>' +
      '<div class="field"><label>库存状态</label><input type="text" id="f-stock" value="' + esc(v('stock', '备货')) + '"></div>' +
      '<div class="field full"><label>备注</label><input type="text" id="f-note" value="' + esc(v('note', '')) + '"></div>' +
      '</div></div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-product" data-id="' + safeActionId(id || '') + '">保存</button>' +
      '</div>';
    openModal(html, true);
  }

  function saveProduct(id) {
    var data = {
      sku: document.getElementById('f-sku').value.trim(),
      category: document.getElementById('f-category').value.trim(),
      title: document.getElementById('f-title').value.trim(),
      titleEn: document.getElementById('f-titleEn').value.trim(),
      keywords: C.splitList(document.getElementById('f-keywords').value),
      specs: document.getElementById('f-specs').value.trim(),
      specsEn: document.getElementById('f-specsEn').value.trim(),
      priceUsd: C.num(document.getElementById('f-priceUsd').value),
      priceFloorUsd: C.num(document.getElementById('f-priceFloorUsd').value),
      costRmb: C.num(document.getElementById('f-costRmb').value),
      marketPriceRmb: C.num(document.getElementById('f-marketPriceRmb').value),

      moq: Math.max(1, C.num(document.getElementById('f-moq').value, 1)),
      leadTimeDays: Math.max(1, C.num(document.getElementById('f-leadTimeDays').value, 15)),
      certs: C.splitList(document.getElementById('f-certs').value).map(function (x) { return x.toUpperCase(); }),
      hsCode: document.getElementById('f-hsCode').value.trim(),
      stock: document.getElementById('f-stock').value.trim(),
      note: document.getElementById('f-note').value.trim()
    };

    if (!data.title) { toast('商品名称必填'); return; }
    if (!(data.priceUsd > 0)) { toast('橱窗价必须大于 0'); return; }

    if (id) {
      var p = productById(id);
      Object.assign(p, data);
      p.id = id;
    } else {
      st().products.push(C.normalizeProduct(data));
      st().demoMode = false;
    }

    closeModal();
    invalidate(); C.persist(); render();
    toast('已保存');
  }

  /* =========================================================
     弹窗：智能导入商品
     流程：粘贴 → 自动识别列 → 预览+改列 → 导入
     ========================================================= */

  var importDraft = null;

  function openBulkCost() {
    var s = st();
    var unset = s.products.filter(function (p) { return !(C.num(p.costRmb) > 0); }).length;

    var html = modalHead('批量填成本') +
      '<div class="modal-bd">' +
      '<div class="alert info" style="margin-bottom:14px"><span class="ic">i</span><div>' +
      '一共 ' + s.products.length + ' 个商品，其中 <strong>' + unset + '</strong> 个还没填成本。' +
      '成本不一样的商品，之后在商品库表格里直接改就行。</div></div>' +
      '<div class="field"><label>采购成本（元/件）</label>' +
      '<input type="number" id="bulk-cost" step="0.01" min="0" value="' + '"></div>' +
      '<label class="row" style="gap:8px;margin-top:14px;font-size:12.5px;cursor:pointer">' +
      '<input type="checkbox" id="bulk-only-empty" checked style="width:auto;height:auto"> 只填充还没填成本的商品</label>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="do-bulk-cost">应用</button>' +
      '</div>';
    openModal(html);
  }

  function doBulkCost() {
    var val = C.num(document.getElementById('bulk-cost').value);
    var onlyEmptyEl = document.getElementById('bulk-only-empty');
    var onlyEmpty = onlyEmptyEl ? onlyEmptyEl.checked : true;
    if (!(val > 0)) { toast('填一个大于 0 的数'); return; }

    var n = 0;
    st().products.forEach(function (p) {
      if (onlyEmpty && C.num(p.costRmb) > 0) return;
      p.costRmb = val;
      n++;
    });

    st().opportunities.forEach(function (o) { o.quote.costRmb = null; });

    closeModal();
    invalidate(); C.persist(); render();
    toast('已给 ' + n + ' 个商品填成本 ' + C.money(val) + ' / 件');
  }
  function openImportProducts(prefill) {
    importDraft = null;
    var html = modalHead('导入商品') +
      '<div class="modal-bd">' +
      '<div class="alert info" style="margin-bottom:14px"><span class="ic">i</span><div>' +
      '<strong>从阿里后台复制：</strong>商品管理 → 勾选商品（或整页 Ctrl+A）→ <strong>Ctrl+C</strong> → 粘到下面。' +
      '从 Excel 复制也行。列的顺序不用管，下一步会自动识别。</div></div>' +
      '<div class="field"><label>粘贴区域</label>' +
      '<textarea id="import-text" style="min-height:240px;font-family:var(--mono);font-size:12px" ' +
      'placeholder="把从阿里后台或 Excel 复制的内容粘在这里…&#10;&#10;例如：&#10;产品名称&#9;价格&#9;MOQ&#9;交期&#10;304不锈钢保温杯 500ml&#9;$3.20&#9;100&#9;15">' +
      esc(prefill || '') + '</textarea></div>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="parse-import">下一步：识别列</button>' +
      '</div>';
    openModal(html, true);
  }

  function parseImport() {
    var el = document.getElementById('import-text');
    var text = el ? el.value : '';
    if (!text.trim()) { toast('请先粘贴内容'); return; }

    var g = window.Importer.guess(text);
    if (!g.rows.length) { toast('没识别到内容'); return; }

    var mapped = g.mapping.filter(Boolean);
    if (mapped.indexOf('priceUsd') < 0 || (mapped.indexOf('title') < 0 && mapped.indexOf('titleEn') < 0)) {
      // 猜不出来也别卡住，让用户在预览里手动指
    }

    importDraft = {
      raw: text,
      g: g,
      convertCny: window.Importer.detectCny(g.rows, g.mapping),
      replace: !!st().demoMode
    };
    renderImportPreview();
  }

  function roleOptions(selected) {
    var out = '<option value="">（忽略这列）</option>';
    window.Importer.ROLES.forEach(function (r) {
      out += '<option value="' + r.key + '"' + (selected === r.key ? ' selected' : '') + '>' +
        esc(r.label) + '</option>';
    });
    return out;
  }

  function renderImportPreview() {
    if (!importDraft) return;
    var g = importDraft.g;

    var products = window.Importer.toProducts(g.rows, g.mapping, {
      header: g.header,
      fxRate: st().settings.fxRate,
      convertCny: importDraft.convertCny
    });

    var head = '<tr><th style="width:38px">#</th>';
    for (var c = 0; c < g.cols; c++) {
      var caption = g.header ? String(g.rows[0][c] || '').trim() : '';
      if (caption.length > 12) caption = caption.slice(0, 12) + '…';
      head += '<th style="padding:6px;vertical-align:top">' +
        '<div style="font-size:10.5px;color:var(--ink-3);font-weight:500;margin-bottom:4px;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:118px" title="' +
        esc(caption) + '">' + (caption ? esc(caption) : '第 ' + (c + 1) + ' 列') + '</div>' +
        '<select data-import-col="' + c + '" ' +
        'style="height:28px;font-size:11.5px;min-width:118px;border-color:' +
        (g.mapping[c] ? 'var(--brand)' : 'var(--line-strong)') + ';color:' +
        (g.mapping[c] ? 'var(--ink)' : 'var(--ink-3)') + '">' +
        roleOptions(g.mapping[c]) + '</select></th>';
    }
    head += '</tr>';

    var bodyStart = g.header ? 1 : 0;
    var preview = g.rows.slice(bodyStart, bodyStart + 5).map(function (r, i) {
      var tds = r.map(function (cell) {
        var s = String(cell || '');
        if (s.length > 38) s = s.slice(0, 38) + '…';
        return '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s) + '</td>';
      }).join('');
      return '<tr><td style="color:#8a919e">' + (i + 1) + '</td>' + tds + '</tr>';
    }).join('');

    var missing = [];
    if (g.mapping.indexOf('priceUsd') < 0) missing.push('价格');
    if (g.mapping.indexOf('title') < 0 && g.mapping.indexOf('titleEn') < 0) missing.push('商品名');

    var html = modalHead('确认列对应关系') +
      '<div class="modal-bd">' +
      (missing.length
        ? '<div class="alert danger" style="margin-bottom:12px"><span class="ic">✕</span><div>' +
        '还没认出<strong>' + missing.join('、') + '</strong>是哪一列。请在上方每一列的下拉框里手动指定一下。</div></div>'
        : '<div class="alert ok" style="margin-bottom:12px"><span class="ic">✓</span><div>' +
        '识别完成：共 ' + g.cols + ' 列' + (g.header ? '（第一行是表头，已跳过）' : '') +
        '，将导入 <strong>' + products.length + '</strong> 条商品。识别错了就改上面的下拉框。</div></div>') +
      '<div class="table-wrap" style="max-height:320px;overflow:auto;border:1px solid var(--line);border-radius:8px">' +
      '<table class="table" style="font-size:11.5px"><thead>' + head + '</thead><tbody>' + preview + '</tbody></table>' +
      '</div>' +
      '<div class="row" style="margin-top:14px;gap:18px">' +
      '<label class="row" style="gap:6px;font-size:12.5px;cursor:pointer">' +
      '<input type="checkbox" id="import-replace" ' + (importDraft.replace ? 'checked' : '') + ' style="width:auto;height:auto">' +
      '先清空现有商品</label>' +
      (true
        ? '<label class="row" style="gap:6px;font-size:12.5px;cursor:pointer">' +
        '<input type="checkbox" id="import-cny" ' + (importDraft.convertCny ? 'checked' : '') + ' style="width:auto;height:auto">' +
        '这些是人民币价，按 ' + st().settings.fxRate + ' 折成美元' +
        (importDraft.convertCny ? '' : '（没检测到 ¥/元，勾上就按人民币算）') + '</label>'
        : '') +
      '</div>' +
      '</div>' +
      '<div class="modal-ft">' +
      '<button class="btn ghost" data-action="import-back">返回重贴</button>' +
      '<button class="btn primary" data-action="do-import-products">导入 ' + products.length + ' 条</button>' +
      '</div>';

    document.getElementById('modal-root').innerHTML =
      '<div class="modal-mask"><div class="modal wide" role="dialog" aria-modal="true">' + html + '</div></div>';
  }

  function doImportProducts() {
    if (!importDraft) return;
    var g = importDraft.g;
    var replaceEl = document.getElementById('import-replace');
    var cnyEl = document.getElementById('import-cny');
    var replace = replaceEl ? replaceEl.checked : false;
    var convertCny = cnyEl ? cnyEl.checked : false;

    var products = window.Importer.toProducts(g.rows, g.mapping, {
      header: g.header,
      fxRate: st().settings.fxRate,
      convertCny: convertCny
    });

    if (!products.length) { toast('没有解析到有效商品，检查一下列对应关系'); return; }

    var list = products.map(function (p) { return C.normalizeProduct(p); });
    if (replace) st().products = list;
    else st().products = st().products.concat(list);

    st().demoMode = false;
    closeModal();
    importDraft = null;
    invalidate(); C.persist(); render();
    toast('已导入 ' + list.length + ' 条商品');
  }

  /* =========================================================
     设置保存
     ========================================================= */

  function saveSettings() {
    var s = st().settings;
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };

    s.platformFeeRate = C.num(g('set-platformFeeRate')) / 100;
    s.fxRate = C.num(g('set-fxRate'), 7.1);
    s.profitRmb = C.num(g('set-profitRmb'));
    s.minMarginPct = C.num(g('set-minMarginPct'), 8);
    s.followUpDays = Math.max(1, C.num(g('set-followUpDays'), 3));
    s.domesticShippingRmb = C.num(g('set-domesticShippingRmb'));

    s.defaultIncoterm = g('set-defaultIncoterm');
    s.defaultLeadTimeDays = C.num(g('set-defaultLeadTimeDays'), 15);
    s.paymentTerms = g('set-paymentTerms');
    s.paymentTermsEn = g('set-paymentTermsEn');
    s.sellerName = g('set-sellerName');
    s.translateEndpoint = String(g('set-translateEndpoint') || '').trim();
    /* API Key 已移到服务端环境变量，前端不再保存（老值在 core.js 载入时丢弃）。 */

    /* 统一过一遍白名单/区间：手输 700 的汇率、0 的扣费率不能直接落盘 */
    var rawEndpoint = s.translateEndpoint;
    var before = { fx: s.fxRate, fee: s.platformFeeRate, margin: s.minMarginPct, profit: s.profitRmb };
    st().settings = C.normalizeSettings(s);
    var endpointDropped = !!(rawEndpoint && !st().settings.translateEndpoint);

    /* 报价里存过的手填价，跟着设置变（只重算「自动定价」的那些） */
    st().opportunities.forEach(function (o) {
      if (o.quote.autoPrice) o.quote.unitPriceUsd = 0;
    });

    invalidate(); C.persist(); render();

    if (endpointDropped) {
      toast('翻译地址没保存：只接受 https（本机/内网可用 http）');
      return;
    }
    var fixed = [];
    if (st().settings.fxRate !== before.fx) fixed.push('汇率 ' + before.fx + '→' + st().settings.fxRate);
    if (st().settings.platformFeeRate !== before.fee) fixed.push('扣费率 ' + (before.fee * 100).toFixed(1) + '%→' + (st().settings.platformFeeRate * 100).toFixed(1) + '%');
    if (st().settings.minMarginPct !== before.margin) fixed.push('最低毛利 ' + before.margin + '%→' + st().settings.minMarginPct + '%');
    if (fixed.length) {
      toast('设置已保存（已纠正不合理数值：' + fixed.join('，') + '），报价已重算');
      return;
    }
    toast('设置已保存，报价已重算');
  }
  /* =========================================================
     弹窗：怎么用
     ========================================================= */

  function helpStep(n, title, body, action, btn) {
    return '<div class="row" style="align-items:flex-start;gap:14px">' +
      '<div style="flex:none;width:26px;height:26px;border-radius:50%;background:var(--brand);color:#fff;' +
      'display:grid;place-items:center;font-size:12px;font-weight:700">' + n + '</div>' +
      '<div style="flex:1;min-width:0">' +
      '<div style="font-weight:650;font-size:13.5px">' + title + '</div>' +
      '<div style="color:var(--ink-2);font-size:12.5px;margin-top:3px;line-height:1.7">' + body + '</div>' +
      (action ? '<button class="btn sm" style="margin-top:8px" data-action="' + action + '">' + btn + '</button>' : '') +
      '</div></div>';
  }

  function openHelp() {
    var body = '<div class="stack" style="gap:18px">' +
      helpStep(1, '把你的橱窗商品导进来（只做一次）',
        '工作台点「导入商品」→ 打开阿里后台的商品管理页，勾选商品或直接 Ctrl+A → <b>Ctrl+C</b> → ' +
        '回到这里 <b>Ctrl+V</b> → 点「识别列」。' +
        '<br>列的顺序不用管，它会自己认出哪列是商品名、哪列是价格、哪列是 MOQ。认错了在预览里改下拉框就行。' +
        '<br><span style="color:var(--ink-3)">如果你是从后台导出 Excel，就打开那个 Excel，全选复制，一样能粘。</span>',
        'import-products', '去导入商品') +
      helpStep(2, '把买家原文粘进来',
        '点「粘贴一条新询盘」，把邮件 / RFQ / 旺旺对话整段粘进去，不用整理格式。' +
        '<br>它会自动认出：数量、目标价、交期、认证要求、发往哪个国家。',
        'new-opp', '粘贴一条') +
      helpStep(3, '看第一眼的结论',
        '打开任意一条商机，最上面那一条就是答案：<b>报多少、你能净赚多少、低于多少不能报</b>。' +
        '<br>要发出去的内容在页面最下面的四个标签里：英文回复、中文回复、议价话术、报价单。',
        'quick-demo', '先看一个例子') +
      '<div style="border-top:1px solid var(--line);padding-top:16px">' +
      '<div style="font-weight:650;font-size:13.5px;margin-bottom:8px">算价就两步</div>' +
      '<div class="rawtext" style="max-height:none;font-size:13px">' +
      '保本价 = 成本 ÷ 0.97 ÷ 汇率' + "\n" + '建议售价 = (成本 + 想赚的) ÷ 0.97 ÷ 汇率</div>' +
      '<div style="font-size:12.5px;color:var(--ink-2);line-height:1.9;margin-top:10px">' +
      '0.97 就是扣掉平台 3% 后你实际拿到手的比例。<br>' +
      '成本 100 元的东西，卖 103.09 元才刚好不亏。<br>' +
      '再去查一下别家卖多少，就知道你建议的价能不能卖动。' +
      '</div>' +
      '<button class="btn sm" style="margin-top:10px" data-action="goto-settings">去设汇率和想赚的利润</button>' +
      '</div>' +
      '<div class="alert info"><span class="ic">i</span><div>' +
      '<b>为什么不能直接帮你登录阿里后台？</b><br>' +
      '登录要你的账号密码和短信验证码，而且用脚本操作账号违反平台规则、有封号风险。' +
      '所以这里走「复制粘贴」：你手动复制，它自动整理。30 秒的事，账号零风险。' +
      '</div></div>' +
      '</div>';

    var html = modalHead('怎么用（30 秒看完）') +
      '<div class="modal-bd">' + body + '</div>' +
      '<div class="modal-ft"><button class="btn primary" data-action="close-modal">知道了</button></div>';
    openModal(html, true);
  }

  /* =========================================================
     启动
     ========================================================= */

  function boot() {
    /* P1-PERF-FIX-01 附带修正（fail-closed，与 defer 性能变更无关）：
       身份事务模块缺失（脚本加载失败）时绝不静默跳过恢复门禁——
       抛出启动错误由 boot-error 横幅明示，并中止 boot（不 render、
       不启动任何后台流程）。此前是可选守卫，缺失即无门禁启动。
       守卫必须位于 hashchange 监听注册之前：否则 boot 中止后监听
       仍存活，后续 hash 变化会绕过未完成的 boot 直接触发 render
       （第二阶段独立审查已复现该绕过，见 REVIEW-phase2b）。 */
    if (!window.IdentityTxn) {
      throw new Error('启动失败：身份事务模块（identity-txn.js）未能加载，恢复门禁无法执行，已中止启动。请检查网络后刷新页面。');
    }
    window.addEventListener('hashchange', render);
    /* P1-23-R7-R2：启动时先检查身份事务状态，未完成批次立即进入恢复阻断并明示 */
    if (window.IdentityTxn) {
      window.IdentityTxn.init(window.localStorage);
      var txnChk = window.IdentityTxn.checkOnLoad(window.localStorage, C);
      if (txnChk.locked) setTimeout(function () { toast('检测到未完成的身份导入事务，写入已阻断。请到「同步与设置」执行恢复后再继续使用。'); }, 600);
      /* 多标签页仅做检测（不支持协调）：其他标签页改动事务键时立即内存阻断本页写入 */
      window.addEventListener('storage', function (ev) {
        if (ev.key === window.IdentityTxn.JOURNAL_KEY || ev.key === window.IdentityTxn.LOCK_KEY || ev.key === 'ic_identity_registry_v1') {
          window.IdentityTxn.noteExternalChange();
          toast('检测到其他标签页修改了身份数据，本页写入已阻断。请只保留一个标签页并刷新。');
        }
      });
    }
    if (!location.hash) location.hash = '#/dashboard';
    render();

    startBridge();
    setTimeout(detectLocalTranslate, 600);

    /* 汇率超过 6 小时就自动更新一次 */
    try {
      var lastAt = st().settings.fxUpdatedAt ? new Date(st().settings.fxUpdatedAt).getTime() : 0;
      if (typeof fetch === 'function' && location && location.href && (!lastAt || Date.now() - lastAt > 6 * 3600 * 1000)) {
        setTimeout(function () { refreshFx(false); }, 1200);
      }
    } catch (e) { }

    /* 本地数据读坏过就说清楚，别让老板以为商品自己没了 */
    try {
      var issue = C.loadIssue && C.loadIssue();
      if (issue) {
        setTimeout(function () { toast(issue); }, 800);
        if (C.clearLoadIssue) C.clearLoadIssue();
      }
    } catch (e) { }

    /* 第一次打开自动弹「怎么用」 */
    try {
      var seen = localStorage.getItem('ali_copilot_seen_help');
      if (!seen) {
        localStorage.setItem('ali_copilot_seen_help', '1');
        openHelp();
      }
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  /* =========================================================
     今日待办 / 老板看的那几个数 / 还价底线 / 跟进
     ========================================================= */

  /* 详情页：这条跟到哪一步了，下一步干什么 */
  /* 跟进时间线：结构化记录（阶段五）与旧记录（只有 note）兼容展示，倒序 */
  function followTimelineHtml(opp, editable) {
    if (!window.FollowUp) return '';
    var list = window.FollowUp.recordsDesc(opp);
    if (!list.length) return '<div style="font-size:12px;color:var(--ink-3)">还没有跟进记录。</div>';
    return '<div style="max-height:340px;overflow:auto">' + list.map(function (x) {
      var head = '<span style="color:#a0a6b0">' + esc(C.fmtDate(x.at, true)) + '</span> ';
      if (x.id) {
        return '<div style="font-size:12px;color:#4b5563;padding:7px 0;border-bottom:1px dashed #f0f1f4">' + head +
          '<span class="badge gray">' + esc(window.FollowUp.typeLabel(x.type)) + '</span> ' +
          (x.source === 'draft' ? '<span class="badge gray">由回复草稿确认生成</span> ' : '') +
          '<span>' + esc(x.summary) + '</span>' +
          (x.feedback ? '<div style="margin-top:2px">客户反馈：' + esc(x.feedback) + '</div>' : '') +
          (x.nextAction ? '<div style="margin-top:2px">下一步：' + esc(x.nextAction) + '</div>' : '') +
          (x.plannedAt ? '<div style="margin-top:2px;color:#8a919e">计划跟进：' + esc(C.fmtDate(x.plannedAt)) + '</div>' : '') +
          (editable ? '<div style="margin-top:3px"><button class="btn sm ghost" data-action="follow-edit" data-id="' + safeActionId(opp.id) + '" data-rid="' + safeActionId(x.id) + '">编辑</button> ' +
            '<button class="btn sm ghost" data-action="follow-del" data-id="' + safeActionId(opp.id) + '" data-rid="' + safeActionId(x.id) + '">删除</button></div>' : '') +
          '</div>';
      }
      return '<div style="font-size:11.5px;color:#6b7280;padding:4px 0;border-bottom:1px dashed #f0f1f4">' + head +
        esc(x.note || x.summary || '（无备注）') + '</div>';
    }).join('') + '</div>';
  }

  function followCard(opp) {
    var closed = opp.status === 'won' || opp.status === 'lost';
    var n = C.num(opp.followCount, 0);
    /* 已关闭：停止提醒，但历史跟进记录只读保留 */
    if (closed) {
      return '<section class="card"><div class="card-hd"><div class="card-title">跟进记录' +
        '<span class="card-sub">商机已' + (opp.status === 'won' ? '成交' : '丢单') + '，已停止跟进提醒，历史记录保留</span></div>' +
        '<span class="badge gray">已完成</span></div>' +
        '<div class="card-bd">' + followTimelineHtml(opp, false) + '</div></section>';
    }
    var f = W.followState(opp, st().settings) || {};
    var when = f.none ? '没排跟进' : f.label;
    var cls = f.overdue ? 'red' : f.today ? 'amber' : 'gray';
    var last = opp.lastContactAt ? C.relTime(opp.lastContactAt) : '—';
    var fuStatus = window.FollowUp ? window.FollowUp.deriveStatus(opp) : 'todo';
    var statusSel = window.FollowUp
      ? '<div class="row" style="gap:8px;align-items:center"><span style="font-size:12px;color:#6b7280">跟进状态</span>' +
        '<select id="fu-status-sel" style="width:auto;height:30px">' +
        '<option value="">自动（当前：' + window.FollowUp.statusLabel(fuStatus) + '）</option>' +
        window.FollowUp.STATUSES.map(function (s) {
          return '<option value="' + s.key + '"' + (opp.followStatus === s.key ? ' selected' : '') + '>' + s.label + '</option>';
        }).join('') + '</select></div>'
      : '';

    return '<section class="card"><div class="card-hd"><div class="card-title">跟进' +
      '<span class="card-sub">' + (n ? '已跟 ' + n + ' 次' : '一次都还没跟') + '</span></div>' +
      '<span class="badge ' + cls + '">' + esc(when) + '</span></div>' +
      '<div class="card-bd stack" style="gap:8px">' +
      '<div class="row" style="gap:16px;font-size:12px;color:#6b7280;flex-wrap:wrap">' +
      '<span>上次联系 ' + esc(last) + '</span>' +
      (f.at ? '<span>下次跟进 ' + C.fmtDate(f.at) + '</span>' : '') + statusSel + '</div>' +
      '<div class="row" style="gap:6px;flex-wrap:wrap">' +
      '<button class="btn sm primary" data-action="open-follow" data-id="' + safeActionId(opp.id) + '">记录这次跟进</button>' +
      '<button class="btn sm ghost" data-action="copy-follow" data-kind="nudge" data-lang="zh" data-id="' + safeActionId(opp.id) + '">催单（中）</button>' +
      '<button class="btn sm ghost" data-action="copy-follow" data-kind="nudge" data-lang="en" data-id="' + safeActionId(opp.id) + '">催单（EN）</button>' +
      '<button class="btn sm ghost" data-action="copy-follow" data-kind="counter" data-lang="zh" data-id="' + safeActionId(opp.id) + '">还价（中）</button>' +
      '<button class="btn sm ghost" data-action="copy-follow" data-kind="sample" data-lang="zh" data-id="' + safeActionId(opp.id) + '">要样品（中）</button>' +
      '<button class="btn sm ghost" data-action="copy-follow" data-kind="close" data-lang="zh" data-id="' + safeActionId(opp.id) + '">逼成交（中）</button>' +
      '</div>' + followTimelineHtml(opp, true) + '</div></section>';
  }

  /* 首页第一块：今天必须做的事，按要紧程度排 */
  function todoCard() {    var list = W.todos(st());
    if (!list.length) {
      return '<section class="card"><div class="card-hd"><div class="card-title">今天要做的事' +
        '<span class="card-sub">没有欠账</span></div></div>' +
        '<div class="card-bd"><div class="alert info"><span class="ic">✓</span><div>' +
        '商机都回完了、该跟的都跟了、成本都填了。有新询盘直接粘进来。' +
        '</div></div></div></section>';
    }

    var rows = list.map(function (t) {
      var btn;
      if (t.action === 'refresh-fx') {
        btn = '<button class="btn sm" data-action="refresh-fx">现在更新</button>';
      } else if (t.action === 'only-empty') {
        btn = '<button class="btn sm" data-action="cat-only-empty">只看没成本的</button>';
      } else {
        btn = '<a class="btn sm" href="' + esc(t.hash || '#/opps') + '">去处理</a>';
      }
      return '<div class="row" style="gap:12px;padding:11px 0;border-bottom:1px solid #f0f1f4;align-items:center">' +
        '<span class="badge ' + (t.severity === 'high' ? 'red' : 'amber') + '" style="min-width:34px;justify-content:center">' +
        esc(String(t.count)) + '</span>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600;font-size:13.5px">' + esc(t.label) + '</div>' +
        '<div style="color:#8a919e;font-size:11.5px;margin-top:2px">' + esc(t.desc) + '</div></div>' +
        btn + '</div>';
    }).join('');

    return '<section class="card"><div class="card-hd"><div class="card-title">今天要做的事' +
      '<span class="card-sub">系统自己排的，从上往下做</span></div>' +
      '<button class="btn sm primary" data-action="new-opp">+ 粘一条新询盘</button></div>' +
      '<div class="card-bd" style="padding-top:4px;padding-bottom:8px">' + rows + '</div></section>';
  }

  /* 老板只关心四个数：进来多少、报了多少、成了几个、赚了多少 */
  function bossStrip() {
    var s = st();
    var w = W.weekSummary(s);
    var win = w.winRate === null || w.winRate === undefined ? '—' : Math.round(w.winRate * 100) + '%';
    return '<section class="card"><div class="card-hd"><div class="card-title">本周（近 7 天）' +
      '<span class="card-sub">不用去后台导表</span></div>' +
      '<a href="#/analytics" style="font-size:12px;color:#8a919e">看全部 →</a></div>' +
      '<div class="card-bd"><div class="grid grid-4">' +
      metric('新询盘', String(w.weekIn), '近 7 天进店') +
      metric('发出去的报价', String(w.quoted), '近 7 天，含后续成交/丢单') +
      metric('成交率', win, '近 7 天 ' + w.won + ' 成 / ' + w.lost + ' 丢') +
      metric('成了的单均毛利', w.avgNet === null ? '—' : C.money(w.avgNet),
        '近 7 天合计 ' + C.money(w.netRmb), w.netRmb < 0 ? 'bad' : 'ok') +
      '</div></div></section>';
  }

  /* 列表里的跟进小标 */
  function followChip(o) {
    if (!o || o.status === 'won' || o.status === 'lost') return '';
    var f = W.followState(o, st().settings);
    if (!f || f.none) return '';
    var txt = f.overdue ? '逾期' + f.days + '天' : f.today ? '今天跟' : f.days + '天后跟';
    return ' <span class="badge ' + (f.cls === 'red' ? 'red' : f.cls === 'amber' ? 'amber' : 'gray') +
      '" title="' + esc(f.label) + '">' + esc(txt) + '</span>';
  }

  /* 还价底线：客服不用问老板就知道能让到哪 */
  function negBlock(ctx) {
    var opp = ctx.opp;
    var a = analyzeOpp(opp);
    var target = a.parsed.targetPriceUsd || 0;
    var ng = W.negotiation({
      product: ctx.product, qty: opp.quote.qty, settings: ctx.settings,
      unitPriceUsd: opp.quote.unitPriceUsd, buyerTargetUsd: target
    });

    var box = 'border:1px solid #eceef2;border-radius:8px;padding:12px;margin-top:6px;background:#fafbfc';

    if (!ng.ok) {
      return '<div style="' + box + '"><div style="font-weight:650;font-size:12.5px;margin-bottom:8px">还价底线</div>' +
        '<div class="alert warn" style="margin:0"><span class="ic">!</span><div>' +
        esc(W.negoHeadline(ng)) + '</div></div></div>';
    }

    var head = '<div style="font-weight:650;font-size:12.5px;margin-bottom:8px">还价底线' +
      '<span style="color:#8a919e;font-weight:400;font-size:11.5px"> · 低于底线不如不接</span></div>';
    if (ctx.unity && ctx.unity.negoFloorUsd) {
      head += '<div style="font-size:11.5px;color:#8a919e;margin:-2px 0 8px">口径提醒：这里的「到底」指谈判底线（含最低毛利目标）；保本价 ' +
        C.usd(ctx.unity.breakEvenUsd) + '、报价底线 ' + C.usd(ctx.unity.quoteFloorUsd) + ' 以定价卡的统一口径为准</div>';
    }

    var line = '<div class="alert ' + (ng.roomUsd > 0 ? 'info' : 'warn') + '" style="margin:0">' +
      '<span class="ic">' + (ng.roomUsd > 0 ? 'i' : '!') + '</span><div>' + esc(W.negoHeadline(ng)) +
      (target ? '<br>' + esc(W.targetText(ng)) : '') + '</div></div>';

    var facts = '<div class="grid grid-3" style="gap:10px;margin-top:10px">' +
      '<div><div style="font-size:11px;color:#8a919e">报到客户</div>' +
      '<div style="font-family:var(--mono);font-size:16px;font-weight:600">' + C.usd(ng.askUsd) + '</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">底线（低于不接）</div>' +
      '<div style="font-family:var(--mono);font-size:16px;font-weight:600;color:#d92d20">' + C.usd(ng.floorUsd) + '</div></div>' +
      '<div><div style="font-size:11px;color:#8a919e">每让 $' + C.round(ng.stepUsd, 2) + '</div>' +
      '<div style="font-family:var(--mono);font-size:16px;font-weight:600">-' + C.money(ng.perStepRmb) + '</div></div>' +
      '</div>';

    var rows = ng.zones.map(function (z, i) {
      var neg = z.marginOnCost <= 0;
      return '<tr><td><strong>' + esc(z.label) + '</strong>' +
        (z.bottom ? ' <span class="badge red">不能再低</span>' : '') + '</td>' +
        '<td class="num" style="font-family:var(--mono);font-weight:600">' + C.usd(z.priceUsd) + '</td>' +
        '<td class="num">' + (z.dropUsd > 0 ? '-' + C.usd(z.dropUsd) : '—') + '</td>' +
        '<td class="num" style="color:' + (neg ? '#d92d20' : '#0f9d58') + '">' +
        (z.netRmb ? C.money(z.netRmb) : '—') + '<br>' +
        '<span style="font-size:10.5px;color:#8a919e">毛利 ' + C.pct(z.marginOnCost) + '</span></td>' +
        '<td class="actions"><button class="btn sm ghost" data-action="copy-nego" data-id="' + safeActionId(opp.id) +
        '" data-zone="' + i + '">复制话术</button></td></tr>';
    }).join('');

    var table = '<div class="table-wrap" style="margin-top:10px"><table class="table">' +
      '<thead><tr><th>让到第几口</th><th class="num">报价</th><th class="num">比首报少</th>' +
      '<th class="num">这单赚</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div style="font-size:11px;color:#8a919e;margin-top:8px">底线按「毛利率不低于 ' +
      C.pct(ng.minMarginPct) + '」算，在设置里改。点「复制话术」直接发客户。</div>';

    return '<div style="' + box + '">' + head + line + facts + table + '</div>';
  }

  /* 设置页：本地存储健康 + 一键回滚 */
  function storageBlock() {
    var h = C.storageHealth();
    var size = h.bytes > 0 ? (h.bytes / 1024).toFixed(0) + ' KB' : '0 KB';
    var bk = h.backupAt ? '上次自动快照：' + C.relTime(h.backupAt) : '还没有自动快照（改动满 10 分钟才存一份）';
    return '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f1f4">' +
      (h.ok ? '' : '<div class="alert warn" style="margin-bottom:8px"><span class="ic">!</span><div>' +
        '<strong>本地保存失败：' + esc(h.error) + '</strong><br>刚改的内容可能没存进去。' +
        '先「导出备份 JSON」，再清掉不用的浏览器数据。</div></div>') +
      '<div style="font-size:12px;color:#8a919e;margin-bottom:6px">当前数据 ' + size + ' · ' + esc(bk) + '</div>' +
      '<button class="btn sm ghost" data-action="restore-backup">回滚到上一个快照</button>' +
      '</div>';
  }

  /* ---------------- 跟进 ---------------- */

  function openFollow(id) {
    var o = oppById(id);
    if (!o) return;
    var s = st().settings;
    var f = W.followState(o, s) || {};
    var days = Math.max(1, C.num(s.followUpDays, 3));
    var last = o.lastContactAt ? '上次联系：' + C.relTime(o.lastContactAt) : '还没记录过联系';
    var when = f.overdue ? '已经逾期 ' + f.days + ' 天' : f.today ? '今天该跟'
      : (f.at ? '计划 ' + C.fmtDate(f.at) : '还没排跟进');

    var html = modalHead('记录这次跟进') +
      '<div class="card-bd stack">' +
      '<div class="alert ' + (f.overdue ? 'warn' : 'info') + '"><span class="ic">' +
      (f.overdue ? '!' : 'i') + '</span><div>' + esc(last) + ' · ' + esc(when) + '</div></div>' +
      '<div class="field"><label>跟进类型</label><select id="fu-type">' +
      (window.FollowUp ? window.FollowUp.TYPES.map(function (t) {
        return '<option value="' + t.key + '">' + t.label + '</option>';
      }).join('') : '<option value="other">其他</option>') + '</select></div>' +
      '<div class="field"><label>沟通摘要（你做了什么）</label>' +
      '<textarea id="fu-note" rows="3" placeholder="例：把报价单和规格表发过去了"></textarea></div>' +
      '<div class="field"><label>客户反馈（买家原话或大意，没有就留空，不要编）</label>' +
      '<input type="text" id="fu-feedback" placeholder="例：嫌贵 5%，问 500 件能不能 4.6"></div>' +
      '<div class="field"><label>下一步行动（文字）</label>' +
      '<input type="text" id="fu-action" placeholder="例：等回复后寄样"></div>' +
      '<div class="field"><label>流程走向</label><select id="fu-next">' +
      '<option value="wait">他还在考虑，' + days + ' 天后再跟</option>' +
      '<option value="counter">他要还价，我去看底线</option>' +
      '<option value="sample">要样品 / 要资料</option>' +
      '<option value="won">谈成了，记成交</option>' +
      '<option value="lost">不做了，记丢单</option>' +
      '</select></div>' +
      '<div class="field"><label>记录后跟进状态</label><select id="fu-fstatus">' +
      '<option value="">不修改（按系统推导）</option>' +
      '<option value="waiting">等待客户回复</option>' +
      '<option value="internal">需要内部确认</option>' +
      '<option value="planned">计划再次联系</option>' +
      '<option value="todo">待联系</option>' +
      '</select></div>' +
      '<div class="field"><label>下次跟进日期（留空按设置自动算）</label>' +
      '<input type="date" id="fu-date"></div>' +
      '</div>' +
      '<div class="modal-ft"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="save-follow" data-id="' + safeActionId(o.id) + '">保存</button></div>';
    openModal(html);
  }

  function saveFollow(id) {
    var o = oppById(id);
    if (!o) return;
    var g = function (i) { var el = document.getElementById(i); return el ? el.value : ''; };
    var note = String(g('fu-note') || '').trim();
    var next = g('fu-next') || 'wait';
    var date = String(g('fu-date') || '').trim();
    var s = st().settings;

    if (next === 'won') { closeModal(); openSettle(id); return; }
    if (next === 'lost') { closeModal(); openLose(id); return; }

    o.lastContactAt = C.nowIso();
    o.followCount = C.num(o.followCount, 0) + 1;

    var d = date ? new Date(date + 'T09:00:00') : null;
    var plannedIso = (d && !isNaN(d.getTime()))
      ? d.toISOString()
      : new Date(Date.now() + Math.max(1, C.num(s.followUpDays, 3)) * 86400000).toISOString();

    /* 阶段五：写结构化记录（兼容旧 followLog 存储）；摘要为空时用类型兜底，不编内容 */
    var fuType = g('fu-type') || 'other';
    var summary = note || ('记录了一次跟进（' + (window.FollowUp ? window.FollowUp.typeLabel(fuType) : '其他') + '）');
    var rec = window.FollowUp
      ? window.FollowUp.addRecord(o, {
        type: fuType, summary: summary,
        feedback: String(g('fu-feedback') || '').trim(),
        nextAction: String(g('fu-action') || '').trim(),
        plannedAt: plannedIso
      }, o.lastContactAt, C.uid('fu'))
      : null;
    if (!rec) {
      o.followLog = (o.followLog || []).concat([{ at: o.lastContactAt, note: note, next: next }]).slice(-100);
      o.followUpAt = plannedIso;
    }
    var fst = g('fu-fstatus');
    if (fst && window.FollowUp && window.FollowUp.validStatus(fst)) o.followStatus = fst;
    if (note) C.addLog(o, '跟进：' + note);

    if (next === 'counter') S.tab = 'nego';
    if (o.status === 'new') o.status = 'matched';

    invalidate(); C.persist(); closeModal(); render();
    toast('已记录，下次跟进 ' + C.fmtDate(o.followUpAt));
  }

  /* 阶段五：结构化记录的编辑 / 删除（旧记录无 id，不可改，保持历史原样） */
  function openFollowEdit(oppId, rid) {
    var o = oppById(oppId);
    if (!o || !window.FollowUp) return;
    var rec = (o.followLog || []).filter(function (x) { return x && x.id === rid; })[0];
    if (!rec) return;
    var dateVal = rec.plannedAt ? String(rec.plannedAt).slice(0, 10) : '';
    var html = modalHead('编辑跟进记录') +
      '<div class="card-bd stack">' +
      '<div class="field"><label>跟进类型</label><select id="fe-type">' +
      window.FollowUp.TYPES.map(function (t) {
        return '<option value="' + t.key + '"' + (rec.type === t.key ? ' selected' : '') + '>' + t.label + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>沟通摘要</label>' +
      '<textarea id="fe-summary" rows="3">' + esc(rec.summary || '') + '</textarea></div>' +
      '<div class="field"><label>客户反馈</label>' +
      '<input type="text" id="fe-feedback" value="' + esc(rec.feedback || '') + '"></div>' +
      '<div class="field"><label>下一步行动</label>' +
      '<input type="text" id="fe-next" value="' + esc(rec.nextAction || '') + '"></div>' +
      '<div class="field"><label>计划跟进日期</label>' +
      '<input type="date" id="fe-date" value="' + dateVal + '"></div>' +
      '</div>' +
      '<div class="modal-ft"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn" data-action="follow-del" data-id="' + safeActionId(o.id) + '" data-rid="' + safeActionId(rid) + '">删除此记录</button>' +
      '<button class="btn primary" data-action="follow-edit-save" data-id="' + safeActionId(o.id) + '" data-rid="' + safeActionId(rid) + '">保存</button></div>';
    openModal(html);
  }

  function saveFollowEdit(oppId, rid) {
    var o = oppById(oppId);
    if (!o || !window.FollowUp) return;
    var g = function (i) { var el = document.getElementById(i); return el ? el.value : ''; };
    var date = String(g('fe-date') || '').trim();
    var d = date ? new Date(date + 'T09:00:00') : null;
    var okEdit = window.FollowUp.editRecord(o, rid, {
      type: g('fe-type'),
      summary: String(g('fe-summary') || '').trim(),
      feedback: String(g('fe-feedback') || '').trim(),
      nextAction: String(g('fe-next') || '').trim(),
      plannedAt: (d && !isNaN(d.getTime())) ? d.toISOString() : null
    });
    if (!okEdit) { toast('保存失败：摘要不能为空'); return; }
    C.addLog(o, '编辑了跟进记录');
    invalidate(); C.persist(); closeModal(); render();
    toast('跟进记录已更新');
  }

  function askFollowDelete(oppId, rid) {
    var html = modalHead('删除跟进记录') +
      '<div class="card-bd"><p style="font-size:13px;line-height:1.7">确定要删除这条跟进记录吗？删除后无法恢复（商机本身和其它记录不受影响）。</p></div>' +
      '<div class="modal-ft"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn danger" data-action="follow-del-confirm" data-id="' + safeActionId(oppId) + '" data-rid="' + safeActionId(rid) + '">确认删除</button></div>';
    openModal(html);
  }

  function doFollowDelete(oppId, rid) {
    var o = oppById(oppId);
    if (!o || !window.FollowUp) return;
    if (window.FollowUp.removeRecord(o, rid)) {
      C.addLog(o, '删除了一条跟进记录');
      invalidate(); C.persist();
    }
    closeModal(); render();
    toast('跟进记录已删除');
  }

  /* 本地日历日期工具（P1-2 批次 3）：一律用设备本地年月日运算，
     setDate 做日历加减——跨月、跨年、夏令时都不会偏移一天；
     禁止用 UTC 时间戳加 72 小时推日期。 */
  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function localTodayPlusStr(days) {
    var t = new Date();
    t.setDate(t.getDate() + days);
    return localDateStr(t);
  }
  function isRealLocalDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    var p = s.split('-');
    var y = +p[0], m = +p[1], d = +p[2];
    var dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  /* 阶段四草稿 → 跟进记录：必须人工勾选确认「已实际发送」，复制/生成不算发送。
     P1-2 批次 3：确认同屏必须选定下一次动作日期（默认本地日期 +3 天），
     日期写入跟进记录 plannedAt，并同步商机 nextActionAt / followUpAt。 */
  function openSentConfirm(id) {
    var o = oppById(id);
    if (!o) return;
    var ctx = analyzeOpp(o);
    var gen = replyGenFor(o, ctx);
    if (!gen) return;
    var saved = (o.replyDrafts || {})[gen.scenario];
    if (!saved) { toast('先生成并保存草稿，再记录发送'); return; }
    var html = modalHead('记录已发送的回复') +
      '<div class="card-bd stack">' +
      '<div class="alert warn"><span class="ic">!</span><div>只有当你<b>已经在阿里后台把这份回复实际发给买家</b>之后，才能记为已发送。生成或复制草稿都不算发送。</div></div>' +
      '<div style="font-size:12.5px">场景：' + esc(gen.scenarioLabel) + ' · 草稿保存于 ' + esc(C.fmtDate(saved.at, true)) + (saved.edited ? ' · 已人工编辑' : '') + '</div>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.6">' +
      '<input type="checkbox" id="ms-confirm" style="margin-top:3px">我确认这份回复已经实际发送给买家</label>' +
      '<div class="field"><label>下次跟进日期（必选，默认 +3 天，可改）</label><input type="date" id="ms-date" value="' + localTodayPlusStr(3) + '"></div>' +
      '</div>' +
      '<div class="modal-ft"><button class="btn ghost" data-action="close-modal">取消</button>' +
      '<button class="btn primary" data-action="ra-sent-confirm" data-id="' + safeActionId(o.id) + '">确认并记录</button></div>';
    openModal(html);
  }

  function doSentConfirm(id) {
    var o = oppById(id);
    if (!o || !window.FollowUp) return;
    var chk = document.getElementById('ms-confirm');
    if (!chk || !chk.checked) { toast('请先勾选确认：这份回复已经实际发送'); return; }
    var ctx = analyzeOpp(o);
    var gen = replyGenFor(o, ctx);
    if (!gen) return;
    var saved = (o.replyDrafts || {})[gen.scenario];
    if (!saved) { toast('先生成并保存草稿，再记录发送'); return; }
    /* 防重复确认：同一份已保存草稿（saved.at 未变）已生成过发送记录时，
       再次确认视为重复操作，不再生成第二条记录。 */
    var already = (o.followLog || []).some(function (r) {
      return r && r.source === 'draft' && r.summary && r.summary.indexOf('（' + gen.scenarioLabel + '）') >= 0 &&
        (!saved.at || !r.at || String(r.at) >= String(saved.at));
    });
    if (already) { toast('这份草稿已经记录为已发送，无需重复确认'); closeModal(); return; }
    var dateEl = document.getElementById('ms-date');
    var date = dateEl ? String(dateEl.value || '').trim() : '';
    if (!date) { toast('请选择下次跟进日期（必选）'); return; }
    if (!isRealLocalDateStr(date)) { toast('下次跟进日期不正确，请重新选择'); return; }
    if (date < localDateStr(new Date())) { toast('下次跟进日期不能早于今天'); return; }
    var plannedIso = new Date(date + 'T09:00:00').toISOString();
    var fields = window.FollowUp.draftRecordFields(gen.scenario, gen.scenarioLabel);
    fields.plannedAt = plannedIso;
    var rec = window.FollowUp.addRecord(o, fields, C.nowIso(), C.uid('fu'));
    if (!rec) { toast('记录失败'); return; }
    o.lastContactAt = C.nowIso();
    o.lastTouchAt = o.lastContactAt;
    o.followCount = C.num(o.followCount, 0) + 1;
    o.followStatus = 'waiting';
    /* 跟进记录 plannedAt、followUpAt（addRecord 已同步）与 nextActionAt
       必须一致——工作台到期区读 followUpAt/nextActionAt，缺一不可 */
    o.nextActionAt = plannedIso;
    C.addLog(o, '确认已发送回复（' + gen.scenarioLabel + '），已生成跟进记录');
    invalidate();
    if (!C.persist()) { toast('保存失败：本地写入被阻断，本次记录未保存，请重试'); return; }
    closeModal(); render();
    toast('已记录为已发送，下次跟进 ' + C.fmtDate(plannedIso));
  }

  function copyFollow(id, kind, lang) {
    var o = oppById(id);
    if (!o) return;
    var text = W.followDraft(o, kind || 'nudge', lang || 'zh');
    if (!text) { toast('这条还没有报价，先生成报价'); return; }
    copyText(text);
  }

  function copyNego(id, zone) {
    var o = oppById(id);
    if (!o) return;
    var ctx = ctxFor(o);
    var a = analyzeOpp(o);
    var ng = W.negotiation({
      product: ctx.product, qty: o.quote.qty, settings: st().settings,
      unitPriceUsd: o.quote.unitPriceUsd, buyerTargetUsd: a.parsed.targetPriceUsd
    });
    if (!ng.ok) { toast('这条商品还没填成本，算不出底线'); return; }
    var z = ng.zones[zone] || ng.zones[ng.zones.length - 1];
    var qty = C.num(o.quote.qty);
    var term = o.quote.incoterm || st().settings.defaultIncoterm || 'FOB';
    copyText('您好 ' + (o.buyer.name || '') + '，价格我们又核算了一遍：' +
      (qty ? qty.toLocaleString() + ' 件，' : '') + C.usd(z.priceUsd) + '/件 ' + term +
      '，这已经贴着我们的成本了，再低就做不下来。' +
      (qty ? '如果数量能加到 ' + (qty * 2).toLocaleString() + ' 件，我再去申请一下。' : '') +
      '您看这个价格能不能确认？');
  }

  function doRestoreBackup() {
    if (!confirm('用上一个自动快照覆盖当前数据？当前改动会丢。')) return;
    var r = C.restoreBackup();
    if (!r.ok) { toast(r.reason || '回滚失败'); return; }
    invalidate(); render();
    toast('已回滚到 ' + C.fmtDate(r.at, true));
  }

  /* 调试钩子：仅在 URL 带 ?debug=1 时暴露，供截图/自动化用 */
  if (String((location && location.search) || '').indexOf('debug=1') >= 0) {
    window.__dbg = {
      openImport: openImportProducts,
      openHelp: openHelp,
      parseImport: parseImport,
      getDraft: function () { return importDraft; }
    };
  }
  /* P1-PERF-FIX-01（B1）：脚本已全部改为 defer（boot-error 除外）。
     启动时机按 readyState 区分：'loading' 是经典解析期、'interactive'
     是 defer 执行期——这两种状态下 DOMContentLoaded 都尚未触发，
     注册监听可保证 boot 在全部 defer 脚本按序执行完后才启动（这正是
     本次修正的关键：旧代码在 'interactive' 下会立即 boot，此时排在
     app.js 之后的 p0-ui 尚未执行）；其余状态（'complete' 或无此属性
     的嵌入环境）文档已就绪，直接启动。 */
  if (document.readyState === 'loading' || document.readyState === 'interactive') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
