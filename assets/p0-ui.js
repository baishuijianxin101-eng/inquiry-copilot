/* ===========================================================
   p0-ui.js — 把 P0 引擎接进现有页面（模块 F）
   只在已有页面上"加一段真实可用的流程"，不新增导航、不重写界面：
     · 商机页顶部：今日销售行动中心 + 询盘录入 → 匹配 → 报价 → 英文回复 → 保存
     · 补成本页顶部：成本体检结论（几款不能报价、几款亏损）
   规则：
     1. 每个按钮都走真实引擎/真实存储，没有假成功提示；
     2. 成本只能来自登录后的 /api/products，或用户本机已录入的数据，绝不写进公开页面；
     3. 报价数字一律由 P0Quote 计算，界面不做任何加减乘除；
     4. 渲染后不动 app.js 的既有 DOM，只在自己插入的卡片里工作。
   全局暴露：window.P0Ui
   =========================================================== */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var MARK_OPP = 'p0-opp-card';
  var MARK_REVIEW = 'p0-review-card';
  var S = {
    text: '',
    parsed: null,
    match: null,
    selectedSku: '',
    qty: 0,
    priceUsd: 0,
    result: null,
    reply: '',
    notice: '',
    server: { state: 'idle', count: 0, message: '' }
  };
  var serverProducts = null;
  var mounted = false;
  var timer = 0;

  /* ---------------- 基础设施 ---------------- */

  function C() { return root.Core; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function state() {
    var core = C();
    return core && core.get ? core.get() : { products: [], opportunities: [], orders: [], settings: {} };
  }
  function productList() {
    if (serverProducts && serverProducts.length) return serverProducts;
    var list = state().products || [];
    return list.map(function (p) {
      return C().normalizeProduct(p);
    });
  }
  function findProduct(sku) {
    var list = productList();
    for (var i = 0; i < list.length; i++) if (list[i].sku === sku) return list[i];
    return null;
  }
  function toast(msg) {
    var el = root.document && root.document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2800);
  }
  function copyText(text) {
    if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
      return root.navigator.clipboard.writeText(text);
    }
    var doc = root.document;
    var ta = doc.createElement('textarea');
    ta.value = text;
    doc.body.appendChild(ta);
    ta.select();
    try { doc.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }
  function rerender() {
    root.location.hash = '#/opps';
    try {
      root.dispatchEvent(new root.Event('hashchange'));
    } catch (e) {
      /* 老浏览器没有 Event 构造器，退回手动点击导航 */
      var a = root.document.querySelector('.nav-item[href="#/opps"]');
      if (a) a.click();
    }
  }

  /* ---------------- 纯逻辑（可测） ---------------- */

  /** 登录后把服务端成本合并进内存副本；不写 localStorage，避免成本落盘。 */
  function mergeServerProducts(local, remote) {
    var base = (local || []).map(function (p) { return C().normalizeProduct(p); });
    var idx = {};
    base.forEach(function (p, i) { idx[p.sku] = i; });
    var merged = 0;
    (remote || []).forEach(function (r) {
      if (!r || !r.sku) return;
      var i = idx[r.sku];
      if (i == null) return;
      ['costRmb', 'priceFloorUsd', 'costUpdatedAt', 'costSource', 'shippingRmb'].forEach(function (k) {
        if (r[k] !== undefined && r[k] !== null && r[k] !== '') base[i][k] = r[k];
      });
      merged++;
    });
    return { products: base, merged: merged };
  }

  function preview(text, products, opts) {
    var P = root.P0Parse;
    var M = root.P0Match;
    if (!P || !M) throw new Error('P0 解析/匹配模块未加载');
    var parsed = P.extract(text || '', opts || {});
    var match = M.search({ raw: text || '', fields: parsed.fields }, products || [], { limit: 5 });
    return { parsed: parsed, match: match };
  }

  function quoteFor(product, qty, opts) {
    var Q = root.P0Quote;
    if (!Q) throw new Error('P0 报价模块未加载');
    return Q.price({
      product: product,
      qty: qty,
      settings: (state().settings || {}),
      unitPriceUsd: opts && opts.unitPriceUsd,
      targetPriceUsd: opts && opts.targetPriceUsd,
      exception: opts && opts.exception,
      now: opts && opts.now
    });
  }

  function replyFor(product, quote, parsed, opts) {
    var R = root.Reply;
    if (!R || !quote || !quote.ok) return '';
    var q = quote.quote;
    var g = quote.guard;
    var gmvRmb = q.amountUsd * q.fx;
    var pricing = {
      qty: q.qty,
      unitPriceUsd: q.unitPriceUsd,
      fx: q.fx,
      feeRate: g.feeRate,
      costTotalRmb: g.costTotalRmb,
      netRmb: q.netRmb,
      gmvRmb: gmvRmb,
      feeRmb: gmvRmb * g.feeRate,
      marginPct: q.marginPct
    };
    var s = state().settings || {};
    var opp = {
      id: 'draft',
      buyer: { name: (opts && opts.buyerName) || (parsed && parsed.fields && parsed.fields.buyerName) || '', country: (parsed && parsed.fields && parsed.fields.country) || '' },
      quote: { validDays: q.validDays, leadTimeDays: product.leadTimeDays, incoterm: q.incoterm },
      rawText: (parsed && parsed.raw) || ''
    };
    return R.replyEn({ opp: opp, product: product, pricing: pricing, settings: s, parsed: parsed });
  }

  function makeOpp(payload) {
    var core = C();
    var p = payload || {};
    return core.normalizeOpp({
      id: p.id || core.uid('opp'),
      buyer: p.buyer || { name: '', country: '', company: '' },
      rawText: p.rawText || '',
      status: p.status || 'quoted',
      matches: p.matches || [],
      selectedProductId: p.selectedProductId || '',
      quote: p.quote || {},
      drafts: p.drafts || { en: '', zh: '' },
      followUpAt: p.followUpAt || '',
      lastContactAt: p.lastContactAt || core.nowIso(),
      followCount: p.followCount == null ? 0 : p.followCount,
      followLog: p.followLog || [],
      log: p.log || [{ ts: core.nowIso(), text: '由询盘副驾驶生成' }]
    });
  }

  /** 只有客户可见字段，供预览区/复制用 */
  function publicQuote(quote) {
    if (!quote || !quote.ok) return null;
    var q = quote.quote;
    return {
      sku: q.sku,
      title: q.title,
      qty: q.qty,
      unitPriceUsd: q.unitPriceUsd,
      amountUsd: q.amountUsd,
      incoterm: q.incoterm,
      validDays: q.validDays,
      leadTimeDays: q.leadTimeDays
    };
  }

  function actionHtml(actions, opps) {
    var list = (actions && actions.today) || [];
    var head;
    if (!list.length) {
      head = '<div class="p0-empty">今天没有到期跟进。可以录一条新询盘，或去补成本。</div>';
    } else {
      head = '<div class="p0-actions">' + list.map(function (x) {
        var cls = x.level === 'urgent' ? 'p0-lv-urgent' : (x.level === 'today' ? 'p0-lv-today' : 'p0-lv-watch');
        return '<a class="p0-act ' + cls + '" href="#/opp/' + esc(x.oppId) + '">' +
          '<span class="p0-act-dot"></span>' +
          '<span class="p0-act-main"><b>' + esc(x.buyer || '未命名买家') + '</b>' +
          '<span class="p0-act-why">' + esc((x.reasons || []).join('；')) + '</span>' +
          '<span class="p0-act-ask">下一步：' + esc(x.nextAction || '') + '</span></span>' +
          '<span class="p0-act-score">' + (x.score || 0) + '</span></a>';
      }).join('') + '</div>';
    }
    /* 今天之外的那一批：老板关心的不是“今天有没有事”，
       而是“接下来三天谁要跟”，所以把未来最近的几条排在行动列表下面。 */
    var now = Date.now();
    var soon = (opps || []).filter(function (o) {
      if (!o || !o.followUpAt) return false;
      if (o.status === 'won' || o.status === 'lost') return false;
      var t = Date.parse(o.followUpAt);
      return isFinite(t) && t > now + 60 * 1000;
    }).sort(function (a, b) {
      return Date.parse(a.followUpAt) - Date.parse(b.followUpAt);
    }).slice(0, 3);
    if (soon.length) {
      head += '<div class="p0-soon">接下来：' + soon.map(function (o) {
        var d = String(o.followUpAt).slice(0, 10).slice(5);
        return '<a class="p0-soon-i" href="#/opp/' + esc(o.id) + '">' + esc(d) +
          ' ' + esc((o.buyer && o.buyer.name) || '未命名买家') + '</a>';
      }).join('') + '</div>';
    }
    return head;
  }

  /* ---------------- 渲染：商机页 ---------------- */

  function cardShell(inner) {
    return '<section class="card p0-card" id="' + MARK_OPP + '">' +
      '<div class="card-hd"><div class="card-title">询盘副驾驶' +
      '<span class="card-sub">粘原文 → 匹配 → 算价 → 英文回复 → 存档</span></div>' +
      '<span class="p0-srv">' + serverBadge() + '</span></div>' +
      '<div class="card-bd">' + inner + '</div></section>';
  }

  function serverBadge() {
    var s = S.server;
    if (s.state === 'ok') return '<span class="p0-ok">成本已从服务端加载 ' + s.count + ' 条</span>';
    if (s.state === 'auth') return '<span class="p0-warn">成本未加载：需登录后读取</span>';
    if (s.state === 'loading') return '<span class="p0-mute">正在读取成本…</span>';
    if (s.state === 'static') return '<span class="p0-mute">纯静态版：未接服务端，成本取自本机记录</span>';
    if (s.state === 'error') return '<span class="p0-warn">' + esc(s.message) + '</span>';
    return '<span class="p0-mute">成本使用本机已录入数据</span>';
  }

  function renderFlow() {
    var h = '';
    if (S.notice) h += '<div class="p0-notice">' + esc(S.notice) + '</div>';

    h += '<div class="p0-input"><textarea id="p0-text" rows="4" placeholder="把阿里国际站买家询盘原文整段粘进来，例如：Hi, we need 500 pcs of XXX, target price USD 12, FOB, CE…">' + esc(S.text) + '</textarea>' +
      '<div class="row" style="gap:8px;align-items:center;margin-top:8px">' +
      '<button class="btn primary" data-p0="analyze">解析并匹配商品</button>' +
      '<span class="p0-hint">不会替你发消息、也不会自动报价，全部需要你点确认</span></div></div>';

    if (S.parsed) {
      var f = S.parsed.fields || {};
      h += '<div class="p0-fields">' +
        chip('数量', f.qty ? f.qty + ' ' + (f.qtyUnit || 'pcs') : '未识别') +
        chip('型号', (f.models && f.models[0]) || '未识别') +
        chip('交期', f.deadlineDays ? f.deadlineDays + ' 天' : '未识别') +
        chip('贸易术语', f.incoterm || '未识别') +
        chip('目的地', f.destination || '未识别') +
        chip('证书', (f.certs || []).join('/') || '未识别') +
        '</div>';
      if (S.parsed.needsReview && S.parsed.needsReview.length) {
        h += '<div class="p0-review">需人工确认：' + S.parsed.needsReview.map(function (x) {
          return esc(x.field + '（' + x.why + '）');
        }).join('、') + '</div>';
      }
    }

    if (S.match) {
      var ms = S.match.matches || [];
      h += '<div class="p0-sec-title">候选商品 <span class="p0-mute">从 ' + S.match.counts.total + ' 条里筛出 ' + ms.length + ' 条，按匹配度排序</span></div>';
      if (!ms.length) {
        h += '<div class="p0-empty">没找到靠谱匹配。改一下型号/关键词再试，或去商品库新建商品。</div>';
      } else {
        h += '<div class="p0-cands">' + ms.map(function (m) {
          var on = m.sku === S.selectedSku;
          return '<label class="p0-cand' + (on ? ' on' : '') + '">' +
            '<input type="radio" name="p0-sku" value="' + esc(m.sku) + '" data-p0="pick"' + (on ? ' checked' : '') + '>' +
            '<span class="p0-cand-main"><b>' + esc(m.title || m.sku) + '</b>' +
            '<span class="p0-mute">' + esc(m.sku) + ' · 匹配 ' + m.score + ' 分 · ' + (m.grade === 'direct' ? '型号命中' : (m.grade === 'review' ? '需核对' : '弱相关')) + '</span>' +
            '<span class="p0-why">依据：' + esc((m.why || []).join('；')) + '</span>' +
            (m.gaps && m.gaps.length ? '<span class="p0-gap">缺口：' + esc(m.gaps.join('；')) + '</span>' : '') +
            '</span>' +
            '<span class="p0-cand-side">' + (m.quotable ? '<span class="p0-ok">有成本</span>' : '<span class="p0-warn">缺成本</span>') +
            '<span class="p0-mute">' + (m.priceUsd ? '挂牌 $' + m.priceUsd : '') + '</span></span></label>';
        }).join('') + '</div>';

        var sel = S.selectedSku ? findProduct(S.selectedSku) : null;
        h += '<div class="p0-quote-box"><div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end">' +
          '<label class="p0-lab">数量<input type="number" id="p0-qty" min="1" step="1" value="' + (S.qty || (sel && sel.moq) || 100) + '"></label>' +
          '<label class="p0-lab">指定单价 USD<input type="number" id="p0-price" min="0" step="0.01" value="' + (S.priceUsd || '') + '" placeholder="留空=自动守住底价"></label>' +
          '<button class="btn primary" data-p0="quote">算价并写英文回复</button>' +
          (S.result && !S.result.ok ? '<span class="p0-warn">' + esc(S.result.message || '') + '</span>' : '') +
          '</div>';

        if (S.result && S.result.ok) {
          var q = S.result.quote;
          h += '<div class="p0-quote-out">' +
            '<div class="p0-q-main"><b>USD ' + q.unitPriceUsd.toFixed(2) + '</b> / ' + q.qty + ' ' + (q.qtyUnit || 'pcs') +
            '<span class="p0-mute">总价 USD ' + q.amountUsd.toFixed(2) + ' · ' + esc(q.incoterm) + ' · 有效期 ' + q.validDays + ' 天</span></div>' +
            '<div class="p0-q-side"><span>毛利 ' + q.marginPct + '%</span><span>底线校验通过</span></div></div>';
          if (S.result.warnings && S.result.warnings.length) {
            h += '<div class="p0-review">' + S.result.warnings.map(esc).join('；') + '</div>';
          }
          h += '<div class="p0-sec-title">英文回复草稿 <span class="p0-mute">逐句可改，发之前自己再读一遍</span></div>' +
            '<textarea id="p0-reply" rows="9">' + esc(S.reply) + '</textarea>' +
            '<div class="row" style="gap:8px;margin-top:8px">' +
            '<button class="btn primary" data-p0="save">保存处理记录</button>' +
            '<button class="btn" data-p0="copy">复制英文回复</button>' +
            '<span class="p0-hint">保存后出现在商机列表和今日行动里</span></div>';
        }
        h += '</div>';
      }
    }

    if (S.match && S.match.notes && S.match.notes.length) {
      h += '<div class="p0-hint" style="margin-top:8px">匹配说明：' + S.match.notes.map(esc).join('；') + '</div>';
    }
    return h;
  }

  function chip(k, v) {
    return '<span class="p0-chip"><i>' + esc(k) + '</i>' + esc(v) + '</span>';
  }

  function renderOppPage() {
    var actions = null;
    var oppsList = state().opportunities || [];
    var actions = null;
    try {
      actions = root.P0Cockpit && root.P0Cockpit.actions
        ? root.P0Cockpit.actions(oppsList)
        : null;
    } catch (e) { actions = null; }
    var inner = '<div class="p0-sec-title">今日销售行动 <span class="p0-mute">按逾期、报价到期、久未联系自动排序</span></div>' +
      (actions ? actionHtml(actions, oppsList) : '<div class="p0-empty">行动中心未加载</div>') +
      '<div class="p0-sec-title" style="margin-top:18px">新询盘处理</div>' +
      renderFlow();
    return cardShell(inner);
  }

  /* ---------------- 渲染：补成本页 ---------------- */

  function renderReviewCard() {
    if (!root.P0Cost || !root.P0Cost.audit) return '';
    var products = productList();
    var audit = root.P0Cost.audit(products, { settings: state().settings || {} });
    var s = audit.summary;
    return '<section class="card p0-card" id="' + MARK_REVIEW + '"><div class="card-hd">' +
      '<div class="card-title">成本体检<span class="card-sub">' + audit.total + ' 款商品</span></div>' +
      '<a class="btn sm ghost" href="#/catalog">去商品库补</a></div>' +
      '<div class="card-bd"><div class="p0-metrics">' +
      '<div class="p0-metric bad"><b>' + s.block + '</b><span>不能直接报价</span></div>' +
      '<div class="p0-metric warn"><b>' + s.warn + '</b><span>需要复核</span></div>' +
      '<div class="p0-metric ok"><b>' + s.ok + '</b><span>正常</span></div>' +
      '<div class="p0-metric"><b>' + s.missingCost + '</b><span>没录成本</span></div>' +
      '<div class="p0-metric"><b>' + s.loss + '</b><span>按挂牌价会亏</span></div>' +
      '</div><div class="p0-hint">' + esc(s.text) + ' 成本数据只在本机/登录后可见，不进公开页面。</div>' +
      '</div></section>';
  }

  /* ---------------- 事件 ---------------- */

  function readInputs() {
    var doc = root.document;
    var t = doc.getElementById('p0-text');
    if (t) S.text = t.value;
    var q = doc.getElementById('p0-qty');
    if (q) S.qty = Math.max(1, Math.round(Number(q.value) || 0));
    var p = doc.getElementById('p0-price');
    if (p) S.priceUsd = Number(p.value) > 0 ? Number(p.value) : 0;
    var r = doc.getElementById('p0-reply');
    if (r) S.reply = r.value;
  }

  function onAction(name) {
    readInputs();
    if (name === 'analyze') {
      if (S.text.trim().length < 10) { S.notice = '先把买家询盘原文粘进来（至少 10 个字）。'; paint(); return; }
      try {
        var out = preview(S.text, productList());
        S.parsed = out.parsed;
        S.match = out.match;
        S.selectedSku = out.match.matches.length ? out.match.matches[0].sku : '';
        S.qty = out.parsed.fields.qty || (S.selectedSku && findProduct(S.selectedSku) ? findProduct(S.selectedSku).moq : 100);
        S.result = null; S.reply = ''; S.notice = '';
      } catch (e) {
        S.notice = '解析失败：' + (e && e.message ? e.message : e);
      }
      paint(); return;
    }
    if (name === 'pick') {
      var el = root.document.activeElement;
      S.selectedSku = el && el.value ? el.value : S.selectedSku;
      S.result = null; S.reply = '';
      paint(); return;
    }
    if (name === 'quote') {
      var prod = findProduct(S.selectedSku);
      if (!prod) { S.notice = '先选一个候选商品。'; paint(); return; }
      /* 与商机详情同一条拦截线：所选商品与询盘硬性冲突（型号/品类对不上、
         或数量低于起订量，即 Matching 的 hardFail）时不许生成报价回复，
         避免把错货报给客户；换一个候选商品即可继续。 */
      var MM = root.Matching;
      if (MM && S.text) {
        var mRank = MM.rank({ rawText: S.text }, [prod]);
        if (mRank.matches && mRank.matches[0] && mRank.matches[0].hardFail) {
          S.notice = '已拦截：所选商品与询盘对不上（型号/品类不符或低于起订量），换一个候选商品再报价。';
          S.reply = '';
          paint(); return;
        }
      }
      var qty = S.qty || prod.moq || 100;
      try {
        var r = quoteFor(prod, qty, { unitPriceUsd: S.priceUsd });
        S.result = r;
        if (r.ok) {
          S.reply = replyFor(prod, r, S.parsed, {});
          S.notice = '';
        } else {
          S.notice = r.message || '这个价格不能报';
          S.reply = '';
        }
      } catch (e) {
        S.notice = '算价失败：' + (e && e.message ? e.message : e);
      }
      paint(); return;
    }
    if (name === 'copy') {
      if (!S.reply) { S.notice = '还没有回复草稿。'; paint(); return; }
      try {
        copyText(S.reply).then(function () { toast('英文回复已复制'); }, function () { toast('复制失败，请手动选中文本'); });
      } catch (e) { toast('复制失败，请手动选中文本'); }
      return;
    }
    if (name === 'save') {
      if (!S.result || !S.result.ok) { S.notice = '还没有通过护栏的报价，不能保存。'; paint(); return; }
      var p2 = findProduct(S.selectedSku);
      if (!p2) { S.notice = '商品已不存在，请重新匹配。'; paint(); return; }
      var core = C();
      var opp = makeOpp({
        buyer: { name: '', country: (S.parsed && S.parsed.fields && S.parsed.fields.destination) || '', company: '' },
        rawText: S.text,
        status: 'quoted',
        matches: (S.match.matches || []).map(function (m) {
          return { productId: m.productId, sku: m.sku, score: m.score, reason: (m.why || [])[0] || '' };
        }),
        selectedProductId: p2.id,
        quote: {
          qty: S.result.quote.qty,
          unitPriceUsd: S.result.quote.unitPriceUsd,
          amountUsd: S.result.quote.amountUsd,
          incoterm: S.result.quote.incoterm,
          validDays: S.result.quote.validDays,
          sentAt: ''
        },
        drafts: { en: S.reply, zh: '' },
        followUpAt: new Date(Date.now() + 3 * 86400000).toISOString(),
        lastContactAt: core.nowIso(),
        followCount: 1,
        followLog: [{ at: core.nowIso(), text: '已生成报价与英文回复，待发送' }]
      });
      core.pushQuoteVersion(opp, {
        qty: opp.quote.qty, unitPriceUsd: opp.quote.unitPriceUsd,
        incoterm: opp.quote.incoterm, leadTimeDays: opp.quote.leadTimeDays,
        marginPct: S.result.quote.marginPct, netRmb: S.result.quote.netRmb,
        productId: p2.id, note: 'AI 报价保存'
      });
      var st = core.get();
      st.opportunities = (st.opportunities || []).concat([opp]);
      core.persist();
      S.notice = '';
      S.text = ''; S.parsed = null; S.match = null; S.selectedSku = ''; S.result = null; S.reply = ''; S.qty = 0; S.priceUsd = 0;
      toast('已保存为商机，可在今日行动里跟进');
      rerender();
      return;
    }
  }

  function onClick(e) {
    var t = e.target;
    while (t && t !== root.document) {
      if (t.getAttribute && t.getAttribute('data-p0')) {
        var name = t.getAttribute('data-p0');
        if (name === 'pick') return; /* radio 由 change 处理 */
        e.preventDefault();
        onAction(name);
        return;
      }
      t = t.parentNode;
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'p0-text') S.text = t.value;
    else if (t.id === 'p0-qty') S.qty = Math.max(1, Math.round(Number(t.value) || 0));
    else if (t.id === 'p0-price') S.priceUsd = Number(t.value) > 0 ? Number(t.value) : 0;
    else if (t.id === 'p0-reply') S.reply = t.value;
  }

  function onChange(e) {
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('data-p0') === 'pick') {
      S.selectedSku = t.value;
      S.result = null; S.reply = '';
      paint();
    }
  }

  function paint() {
    var doc = root.document;
    if (!doc) return;
    var view = doc.getElementById('view');
    if (!view) return;
    var page = (root.location.hash || '#/dashboard').replace(/^#\/?/, '').split('/')[0];
    if (page === 'opps') {
      var old = doc.getElementById(MARK_OPP);
      if (old) old.parentNode.removeChild(old);
      var holder = doc.createElement('div');
      holder.innerHTML = renderOppPage();
      var node = holder.firstChild;
      if (node) view.insertBefore(node, view.firstChild);
    } else if (page === 'review') {
      var old2 = doc.getElementById(MARK_REVIEW);
      if (old2) old2.parentNode.removeChild(old2);
      var html = renderReviewCard();
      if (html) {
        var holder2 = doc.createElement('div');
        holder2.innerHTML = html;
        var node2 = holder2.firstChild;
        if (node2) view.insertBefore(node2, view.firstChild);
      }
    }
  }

  /* 登录后 cookie 才落地：首屏可能早于它跑完，这里补两次重试，
     否则老板登完进来看到的是“成本未加载”，得手动刷新才有数。 */
  var serverTries = 0;
  function loadServer() {
    if (!root.P0Api) return;
    S.server = { state: 'loading', count: 0, message: '' };
    paint();
    root.P0Api.products().then(function (d) {
      var merged = mergeServerProducts(state().products || [], d.products || []);
      serverProducts = merged.products;
      S.server = { state: 'ok', count: merged.merged, message: '' };
      serverTries = 0;
      if (root.document.getElementById(MARK_OPP)) paint();
    }, function (e) {
      var auth = e && e.code === 'auth_required';
      var noApi = e && (e.code === 'not_found' || e.code === 'network' || e.code === 'bad_response');
      S.server = { state: auth ? 'auth' : (noApi ? 'static' : 'error'), count: 0,
        message: auth ? '需登录' : (noApi ? '纯静态版' : '读取失败：' + (e && e.message ? e.message : e)) };
      if (root.document.getElementById(MARK_OPP)) paint();
      if (auth && serverTries < 2 && root.setTimeout) {
        serverTries++;
        root.setTimeout(loadServer, 1500);
      }
    });
  }

  function enhance() {
    if (!root.document || !root.document.getElementById) return;
    paint();
    loadServer();
  }

  function mount() {
    if (mounted || !root.document) return;
    mounted = true;
    root.document.addEventListener('click', onClick, true);
    root.document.addEventListener('change', onChange, true);
    root.document.addEventListener('input', onInput, true);
    root.addEventListener('hashchange', function () { setTimeout(paint, 0); });
    /* app.js 的 render 可能在筛选/弹窗后重建 DOM，观察一下再补回卡片 */
    if (root.MutationObserver) {
      var obs = new root.MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          var page = (root.location.hash || '#/dashboard').replace(/^#\/?/, '').split('/')[0];
          var mark = page === 'opps' ? MARK_OPP : (page === 'review' ? MARK_REVIEW : '');
          if (mark && !root.document.getElementById(mark)) paint();
        }, 30);
      });
      var view = root.document.getElementById('view');
      if (view) obs.observe(view, { childList: true });
    }
    enhance();
  }

  root.P0Ui = {
    VERSION: VERSION,
    mount: mount,
    enhance: enhance,
    mergeServerProducts: mergeServerProducts,
    preview: preview,
    quoteFor: quoteFor,
    replyFor: replyFor,
    makeOpp: makeOpp,
    publicQuote: publicQuote,
    actionHtml: actionHtml
  };

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', function () { setTimeout(mount, 0); });
    } else {
      setTimeout(mount, 0);
    }
  }
})(typeof window !== 'undefined' ? window : this);