/* ===========================================================
   core.js — 存储层 / 工具函数 / 种子数据
   全局暴露：window.Core
   =========================================================== */
(function () {
  'use strict';

  var STORE_KEY = 'ali_commission_copilot_v1';
  var STORE_BAK = STORE_KEY + '_bak';
  var SCHEMA_VERSION = 1;

  /* ---------------- 默认设置 ----------------
     保本价 = 采购成本 ÷ (1 − 平台扣费率) ÷ 汇率
     建议售价 = (采购成本 + 想赚的) ÷ (1 − 平台扣费率) ÷ 汇率
  ------------------------------------------- */
  var DEFAULT_SETTINGS = {
    sellerName: '深圳市示例贸易有限公司',

    /* 平台扣费：手续费 + 提现费，合计 3%，也就是那个 0.97 */
    platformFeeRate: 0.03,

    /* 按品类覆盖费率，如 { '接收机': 0.05 }；留空用上面的全局值 */
    feeRateByType: {},

    /* 自建翻译地址，如 http://127.0.0.1:5000；留空用在线免费接口 */
    translateEndpoint: '',

    /* 阿里云百炼 API Key 已移到服务端环境变量；早先版本把这个字段存在
       localStorage 里，白名单不再包含它，老值在下次载入时自然丢弃。 */
    dashscopeKey: '',

    /* 汇率：1688 用人民币采购，阿里用美元报价 */
    fxRate: 7.10,

    /* 每件想赚多少钱（人民币）。填 0 就只看保本价 */
    profitRmb: 20,

    /* 国内运费（元/件） */
    domesticShippingRmb: 0,

    /* 最低毛利（占成本的比例）。还价时最多让到这个线，再低就不接 */
    minMarginPct: 8,
    /* 报价后几天没回就提醒跟进 */
    followUpDays: 3,

    quoteStepUsd: 0.10,
    quoteValidDays: 30,
    defaultLeadTimeDays: 15,
    defaultIncoterm: 'FOB Ningbo',
    paymentTerms: '30% T/T 定金，余款见提单副本',
    paymentTermsEn: '30% T/T deposit, balance against copy of B/L'
  };

  /* 设置项白名单：导入/恢复时只认这些字段，别的一律丢掉。
     min/max 同时兜住手改 localStorage 造成的越界值。 */
  var SETTINGS_NUM = {
    platformFeeRate: [0, 0.5],
    fxRate: [1, 30],
    profitRmb: [0, 1000000],
    domesticShippingRmb: [0, 1000000],
    minMarginPct: [0, 90],
    followUpDays: [1, 365],
    quoteStepUsd: [0.01, 100],
    quoteValidDays: [1, 3650],
    defaultLeadTimeDays: [1, 365]
  };
  var SETTINGS_TEXT = ['defaultIncoterm', 'paymentTerms',
    'paymentTermsEn', 'sellerName'];

  /* 自建翻译地址只认 https；本机/内网允许 http。
     否则导入一份别人给的备份，就能让「翻译」把询盘原文明文发到他的服务器。 */
  function normalizeEndpoint(raw) {
    var v = String(raw === undefined || raw === null ? '' : raw).trim().slice(0, 500);
    if (!v) return '';
    var m = /^(https?):\/\/([^\/?#\s:@]+)/i.exec(v);
    if (!m) return '';
    var scheme = m[1].toLowerCase();
    var host = m[2].toLowerCase().replace(/^\[|\]$/g, '');
    if (scheme === 'https') return v;
    var local = host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /\.local$/.test(host);
    return local ? v : '';
  }

  function normalizeSettings(raw) {
    var src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    var out = Object.assign({}, DEFAULT_SETTINGS);
    Object.keys(SETTINGS_NUM).forEach(function (k) {
      var range = SETTINGS_NUM[k];
      var v = num(src[k], DEFAULT_SETTINGS[k]);
      out[k] = clamp(v, range[0], range[1]);
    });
    SETTINGS_TEXT.forEach(function (k) {
      out[k] = String(src[k] === undefined || src[k] === null ? DEFAULT_SETTINGS[k] : src[k]).slice(0, 500);
    });
    out.translateEndpoint = normalizeEndpoint(src.translateEndpoint);
    var byType = {};
    var fb = (src.feeRateByType && typeof src.feeRateByType === 'object' && !Array.isArray(src.feeRateByType))
      ? src.feeRateByType : {};
    Object.keys(fb).forEach(function (k) {
      var rate = num(fb[k], NaN);
      if (!isFinite(rate) || rate < 0 || rate > 0.5) return;
      byType[String(k).slice(0, 40)] = rate;
    });
    out.feeRateByType = byType;
    return out;
  }
  /* ---------------- 工具 ---------------- */

  function uid(prefix) {
    return (prefix || 'id') + '_' +
      Math.random().toString(36).slice(2, 8) +
      Date.now().toString(36).slice(-4);
  }

  function nowIso() { return new Date().toISOString(); }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function round(n, d) {
    var p = Math.pow(10, d === undefined ? 2 : d);
    return Math.round((n + Number.EPSILON) * p) / p;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function sum(arr, pick) {
    return arr.reduce(function (a, x) { return a + (pick ? pick(x) : x); }, 0);
  }

  function num(v, fallback) {
    /* Number('') === 0，会把「输入框清空」当成「填了 0」。
       汇率清空 → 0 → 归一化夹成 1，全站按 ¥1=$1 记账，刷新也回不去。 */
    if (v === '' || v === null || v === undefined) return fallback === undefined ? 0 : fallback;
    var n = Number(v);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function money(n, symbol) {
    var s = Number(n) || 0;
    return (symbol === undefined ? '¥' : symbol) + s.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function usd(n) { return money(n, '$'); }

  function pct(n, d) {
    return (Number(n) * 100).toFixed(d === undefined ? 1 : d) + '%';
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var s = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (withTime) s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return s;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function relTime(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return fmtDate(iso);
  }

  /* 导入的 JSON 里 id 可能是任意字符串，直接拼进 HTML 属性会注入。
     只允许字母数字下划线短横，其余一律剥掉；空的就重新生成。 */
  /* 品类（不是阿里的类目树）：从标题自动识别，用来套不同费率 */
  var TYPE_CN = {
    rx: '接收机', camera: '摄像头', fc: '飞控', esc: '电调', vtx: '图传',
    gps: 'GPS', ant: '天线', goggle: '眼镜', batt: '电池', motor: '电机',
    frame: '机架', charger: '充电器', servo: '舵机', tx: '遥控器'
  };
  var TYPE_KEYS = ['接收机', '摄像头', '飞控', '电调', '图传', 'GPS', '天线', '眼镜', '电池', '电机', '机架', '充电器', '舵机', '遥控器'];

  /* 品类识别要跑 14 条正则，238 行 × 每次输入都算太浪费，缓存住 */
  var typeCache = new WeakMap();

  function typeOfProduct(p) {
    if (!p) return '';
    if (typeCache.has(p)) return typeCache.get(p);
    var M = window.Matching;
    if (!M || !M.typesOf) return '';
    var kw = Array.isArray(p.keywords) ? p.keywords.join(' ') : String(p.keywords || '');
    var text = (p.title || '') + ' ' + (p.titleEn || '') + ' ' + kw + ' ' + (p.category || '');
    var t = M.typesOf(text);
    var out = t.length ? (TYPE_CN[t[0]] || '') : '';
    typeCache.set(p, out);
    return out;
  }

  /* 费率优先级：单品覆盖 > 品类费率 > 全局费率 */
  function feeRateFor(p, settings) {
    var s = settings || get().settings;
    if (p && num(p.feeRate) > 0) return num(p.feeRate);
    var t = typeOfProduct(p);
    var map = s.feeRateByType || {};
    if (t && num(map[t]) > 0) return num(map[t]);
    return num(s.platformFeeRate);
  }

  /* 操作日志：只记「谁在什么时候干了什么」，不记内容本身 */
  function audit(action, detail) {
    var s = get();
    s.logs = s.logs || [];
    s.logs.unshift({ at: nowIso(), action: String(action || ''), detail: String(detail || '').slice(0, 200) });
    if (s.logs.length > 500) s.logs.length = 500;
    persist();
  }

  /**
   * 一笔订单的净利（含退款按比例摊成本）。
   * 纯函数，界面和测试用同一份逻辑。
   */
  function orderNet(opts) {
    var amount = num(opts.amountUsd);
    var refund = Math.min(num(opts.refundUsd), amount);
    var effective = Math.max(0, amount - refund);
    var ratio = amount > 0 ? effective / amount : 0;
    var fx = num(opts.fxRate, 7.1);
    var fee = num(opts.feeRate);
    var cost = num(opts.costRmb) * ratio;
    return {
      feeRmb: round2(effective * fx * fee),
      costRmb: round2(cost),
      netRmb: round2(effective * fx * (1 - fee) - cost)
    };
  }

  /**
   * 汇率冲击：给定假设汇率，算出多少商品会变成亏本卖。
   */
  function fxShock(products, settings, fx) {
    var list = [];
    var risk = 0, total = 0;
    (products || []).forEach(function (p) {
      var cost = num(p.costRmb);
      if (!(cost > 0)) return;
      total++;
      var rate = feeRateFor(p, settings);
      var be = cost / (1 - Math.min(0.5, rate)) / fx;
      var floorPrice = num(p.priceFloorUsd) > 0 ? num(p.priceFloorUsd) : num(p.priceUsd);
      if (!(floorPrice > 0)) return;
      if (be > floorPrice - 1e-9) {
        risk++;
        list.push({ id: p.id, title: p.title, be: round2(be), list: round2(floorPrice), lossPct: (be - floorPrice) / be * 100 });
      }
    });
    list.sort(function (a, b) { return b.lossPct - a.lossPct; });
    return { risk: risk, total: total, rows: list };
  }

  function safeId(v, prefix) {
    var s = String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
    if (!s) return uid(prefix || 'id');
    return s.slice(0, 48);
  }

  /* 金额一律保留两位，避免浮点累加误差 */
  function round2(n) {
    var v = Number(n);
    if (!isFinite(v)) return 0;
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function roundUpTo(value, step) {
    if (!step || step <= 0) return round(value, 2);
    return round(Math.ceil(value / step - 1e-9) * step, 2);
  }

  /* ---------------- 种子数据：商品库（橱窗） ----------------
     priceUsd = 橱窗价 = 你向供应商/店铺结算的底价（FOB USD）
     ！！这是演示数据，实际请导入你自己的橱窗商品！！
  --------------------------------------------------------- */

  function seedProducts() {
    return [
      {
        id: 'p_tws_001',
        sku: 'TWS-PRO-01',
        title: 'TWS 蓝牙耳机 入耳式 带充电仓',
        titleEn: 'TWS Bluetooth Earbuds with Charging Case, In-Ear',
        category: '消费电子',
        keywords: ['tws', 'bluetooth', 'earbuds', 'wireless', 'headphone', 'earphone', '蓝牙耳机', '无线耳机', '充电仓', '入耳式'],
        specs: '蓝牙 5.3；续航 5h+18h；IPX5 防水；黑白双色；支持定制 LOGO',
        specsEn: 'Bluetooth 5.3; 5h + 18h playtime; IPX5 waterproof; black & white; custom logo available',
        priceUsd: 6.80,
        moq: 500,
        leadTimeDays: 25,
        certs: ['CE', 'RoHS', 'FCC'],
        hsCode: '8518.30',
        stock: '备货',
        note: '主推款，德国/美国客户反馈好'
      },
      {
        id: 'p_cup_500',
        sku: 'CUP-304-500',
        title: '304 不锈钢真空保温杯 500ml',
        titleEn: '304 Stainless Steel Vacuum Insulated Tumbler 500ml',
        category: '日用家居',
        keywords: ['vacuum', 'insulated', 'tumbler', 'bottle', 'stainless', '保温杯', '不锈钢', '水杯', '真空'],
        specs: '304 内胆；容量 500ml；24h 保温；可定制印刷；单层纸盒包装',
        specsEn: '304 inner wall; 500ml; 24h insulation; custom printing; single-layer paper box',
        priceUsd: 3.20,
        moq: 100,
        leadTimeDays: 15,
        certs: ['FDA', 'LFGB'],
        hsCode: '9617.00',
        stock: '现货',
        note: '起订量低，适合小 B 客户试单'
      },
      {
        id: 'p_glass_350',
        sku: 'GLS-DW-350',
        title: '双层玻璃杯 350ml 隔热',
        titleEn: 'Double Wall Glass Cup 350ml Heat Resistant',
        category: '日用家居',
        keywords: ['glass', 'cup', 'double wall', 'mug', '玻璃杯', '双层', '隔热'],
        specs: '高硼硅玻璃；350ml；耐 -20~120℃；可印刷',
        specsEn: 'Borosilicate glass; 350ml; -20 to 120°C; printable',
        priceUsd: 1.85,
        moq: 200,
        leadTimeDays: 20,
        certs: ['FDA'],
        hsCode: '7013.37',
        stock: '备货',
        note: ''
      },
      {
        id: 'p_juicer_380',
        sku: 'JCR-USB-380',
        title: '便携榨汁杯 380ml USB 充电',
        titleEn: 'Portable Blender Juicer Cup 380ml USB Rechargeable',
        category: '小家电',
        keywords: ['blender', 'juicer', 'portable', 'usb', '榨汁杯', '便携', '果汁机', '料理机'],
        specs: '380ml；6 叶刀头；USB-C；IPX6；可定制颜色',
        specsEn: '380ml; 6-blade; USB-C; IPX6; custom colors',
        priceUsd: 4.50,
        moq: 300,
        leadTimeDays: 20,
        certs: ['CE', 'RoHS', 'FDA'],
        hsCode: '8509.40',
        stock: '备货',
        note: ''
      },
      {
        id: 'p_bottle_750',
        sku: 'BTL-SIL-750',
        title: '硅胶折叠水壶 750ml 户外',
        titleEn: 'Collapsible Silicone Water Bottle 750ml Outdoor',
        category: '户外运动',
        keywords: ['silicone', 'collapsible', 'foldable', 'water bottle', 'outdoor', '硅胶', '折叠', '水壶', '户外'],
        specs: '食品级硅胶；750ml；折叠后 5cm；BPA Free；可定制色',
        specsEn: 'Food-grade silicone; 750ml; folds to 5cm; BPA free; custom colors',
        priceUsd: 2.40,
        moq: 500,
        leadTimeDays: 18,
        certs: ['FDA', 'LFGB'],
        hsCode: '3924.10',
        stock: '备货',
        note: '欧洲客户复购率高'
      },
      {
        id: 'p_french_350',
        sku: 'FP-304-350',
        title: '不锈钢法压壶 350ml 咖啡壶',
        titleEn: 'Stainless Steel French Press Coffee Maker 350ml',
        category: '日用家居',
        keywords: ['french press', 'coffee', 'maker', 'stainless', '法压壶', '咖啡壶', '手冲'],
        specs: '304 不锈钢；350ml；双层滤网；可定制包装',
        specsEn: '304 stainless steel; 350ml; double mesh filter; custom packaging',
        priceUsd: 5.60,
        moq: 100,
        leadTimeDays: 22,
        certs: ['FDA'],
        hsCode: '7323.93',
        stock: '备货',
        note: ''
      }
    ];
  }

  /* ---------------- 种子数据：商机 ---------------- */

  function seedOpportunities() {
    return [
      {
        id: 'opp_demo_1',
        createdAt: '2026-10-17T01:20:00.000Z',
        updatedAt: '2026-10-17T01:20:00.000Z',
        buyer: {
          name: 'Michael Braun',
          company: 'Braun Retail GmbH',
          country: '德国',
          channel: '询盘'
        },
        rawText: 'Dear Sales Manager,\n\nWe are a consumer electronics distributor based in Hamburg, Germany. We are looking for TWS bluetooth earbuds with charging case, in-ear type, for our retail chain (about 40 stores).\n\nQuantity: 1,200 pcs for the first order\nTarget price: around USD 6.50 per piece, FOB\nRequirement: CE, RoHS and FCC certificates, white and black colors\nLead time: within 30 days\n\nPlease send your best quotation and MOQ.\n\nBest regards,\nMichael Braun',
        status: 'new',
        matches: [],
        selectedProductId: null,
        quote: { qty: 1200, unitPriceUsd: 0, incoterm: 'FOB Ningbo', leadTimeDays: 30, validDays: 30 },
        drafts: {},
        deal: null,
        log: [{ ts: '2026-10-17T01:20:00.000Z', text: '商机创建（询盘渠道）' }]
      },
      {
        id: 'opp_demo_2',
        createdAt: '2026-10-17T08:05:00.000Z',
        updatedAt: '2026-10-17T08:05:00.000Z',
        buyer: {
          name: '张先生',
          company: '（RFQ 匿名买家）',
          country: '美国',
          channel: 'RFQ'
        },
        rawText: '采购需求：不锈钢保温杯 500ml，304 内胆，数量 3000 个，交货期 25 天，需要 FDA 认证，目标价 3.00 美元 FOB 宁波，发往美国洛杉矶。\n\n如质量 OK 后续有返单，请报阶梯价（3000 / 5000 / 10000）。',
        status: 'new',
        matches: [],
        selectedProductId: null,
        quote: { qty: 3000, unitPriceUsd: 0, incoterm: 'FOB Ningbo', leadTimeDays: 25, validDays: 30 },
        drafts: {},
        deal: null,
        log: [{ ts: '2026-10-17T08:05:00.000Z', text: '商机创建（RFQ 渠道）' }]
      },
      {
        id: 'opp_demo_3',
        createdAt: '2026-10-18T00:40:00.000Z',
        updatedAt: '2026-10-18T00:40:00.000Z',
        buyer: {
          name: 'Laura Gómez',
          company: 'Outdoor Life S.L.',
          country: '西班牙',
          channel: 'RFQ'
        },
        rawText: 'Hola, we need collapsible silicone water bottles for our outdoor retail chain in Spain.\n\nQuantity: 2,000 pcs\nSize: 750 ml\nMaterial: food grade silicone, BPA free\nCertificates: FDA and LFGB required\nTarget price: USD 3.20 / pc FOB\nDelivery: 30 days\n\nPlease confirm if you can supply and send the price for 2000 / 5000 pcs.',
        status: 'new',
        matches: [],
        selectedProductId: null,
        quote: { qty: 2000, unitPriceUsd: 0, incoterm: 'FOB Ningbo', leadTimeDays: 30, validDays: 30 },
        drafts: {},
        deal: null,
        log: [{ ts: '2026-10-18T00:40:00.000Z', text: '商机创建（RFQ 渠道）' }]
      }
    ];
  }

  /* ---------------- 演示数据隔离（阶段六） ----------------
     演示实体一律带 demo:true 标记。旧版本地数据没有这个字段，
     靠种子数据的固定 id 识别并在规范化时自动补标（迁移兼容）。
     真实业务统计与真实商机列表只认 demo !== true 的记录；
     演示数据的增删改只作用于演示集合，不触碰真实数据。 */
  var DEMO_OPP_IDS = { opp_demo_1: true, opp_demo_2: true, opp_demo_3: true, opp_quick_demo: true };
  var DEMO_PRODUCT_IDS = { p_tws_001: true, p_cup_500: true, p_glass_350: true, p_juicer_380: true, p_bottle_750: true, p_french_350: true };

  function isDemoOpp(o) { return !!o && (o.demo === true || !!DEMO_OPP_IDS[o.id]); }
  function isDemoProduct(p) { return !!p && (p.demo === true || !!DEMO_PRODUCT_IDS[p.id]); }
  function isDemoOrder(o) { return !!o && o.demo === true; }

  /* 按视图取商机：view='demo' 只看演示，其余（默认）只看真实。
     损坏条目（null/非对象）直接跳过，不影响另一类数据。 */
  function visibleOpps(state, view) {
    var list = (state && Array.isArray(state.opportunities)) ? state.opportunities : [];
    return list.filter(function (o) {
      if (!o || typeof o !== 'object') return false;
      return view === 'demo' ? isDemoOpp(o) : !isDemoOpp(o);
    });
  }

  /* P1-2 批次 2：建档查重（只提示、不裁决）。
     buyerKeyOf 与 app 层客户聚合的 buyerKey 完全同规（company 优先、
     其次 name，去空白转小写），不得另立口径。 */
  function buyerKeyOf(buyer) {
    var b = buyer || {};
    return String(b.company || b.name || '').trim().toLowerCase();
  }

  /* 询盘原文规范化指纹：统一换行、折叠一切空白、转小写后做 FNV-1a
     并附规范化后长度。只消除排版差异，数字、单位、规格、型号、日期
     等业务字符一字不动；指纹相等才算疑似重复，不做模糊相似判定，
     避免把数量/规格不同的新需求误伤为重复。 */
  function inquiryFingerprint(text) {
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8) + ':' + s.length;
  }

  /* 在指定数据视图内按 buyerKey + 指纹找疑似重复商机，只返回展示
     所需字段。任何异常都返回空数组——查重失败不得阻断正常建档。 */
  function findDuplicateOpps(state, view, buyer, rawText) {
    try {
      var fp = inquiryFingerprint(rawText);
      var key = buyerKeyOf(buyer);
      if (!fp || !key) return [];
      return visibleOpps(state, view).filter(function (o) {
        return buyerKeyOf(o.buyer) === key && inquiryFingerprint(o.rawText) === fp;
      }).map(function (o) {
        return {
          id: o.id,
          createdAt: o.createdAt || '',
          status: o.status || 'new',
          buyerName: (o.buyer && o.buyer.name) || '',
          company: (o.buyer && o.buyer.company) || '',
          snippet: String(o.rawText || '').replace(/\s+/g, ' ').slice(0, 80)
        };
      }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    } catch (e) { return []; }
  }

  /* 只清除演示数据（商机/订单/商品），真实数据一律不动。 */
  function purgeDemo(state) {
    var counts = { opps: 0, products: 0, orders: 0 };
    if (!state || typeof state !== 'object') return counts;
    if (Array.isArray(state.opportunities)) {
      var b1 = state.opportunities.length;
      state.opportunities = state.opportunities.filter(function (o) { return !isDemoOpp(o); });
      counts.opps = b1 - state.opportunities.length;
    }
    if (Array.isArray(state.products)) {
      var b2 = state.products.length;
      state.products = state.products.filter(function (p) { return !isDemoProduct(p); });
      counts.products = b2 - state.products.length;
    }
    if (Array.isArray(state.orders)) {
      var b3 = state.orders.length;
      state.orders = state.orders.filter(function (o) { return !isDemoOrder(o); });
      counts.orders = b3 - state.orders.length;
    }
    return counts;
  }

  /* ---------------- 状态管理 ---------------- */

  function freshState(opts) {
    var s = {
      version: SCHEMA_VERSION,
      settings: clone(DEFAULT_SETTINGS),
      products: [],
      opportunities: [],
      orders: [],
      logs: [],
      demoMode: true,
      createdAt: nowIso()
    };
    if (!opts || opts.empty !== true) {
      /* 有新生成的 seed-state.js 就用它（换电脑打开也能看到真实商品），否则用演示数据 */
      var seed = (typeof window !== 'undefined' && window.SEED_STATE) || null;
      if (seed && Array.isArray(seed.products) && seed.products.length) {
        s.products = seed.products.map(normalizeProduct);
        s.demoMode = false;
      } else {
        s.products = seedProducts().map(function (p) { p.demo = true; return p; });
        s.opportunities = seedOpportunities().map(function (o) { o.demo = true; return o; });
      }
    }
    return s;
  }

  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return freshState();
    var s = {};
    s.version = SCHEMA_VERSION;
    s.createdAt = raw.createdAt || nowIso();
    s.demoMode = raw.demoMode === true;
    s.settings = normalizeSettings(raw.settings);
    s.products = Array.isArray(raw.products) ? raw.products.map(normalizeProduct) : [];
    s.opportunities = Array.isArray(raw.opportunities) ? raw.opportunities.map(normalizeOpp) : [];
    s.orders = Array.isArray(raw.orders) ? raw.orders.map(normalizeOrder) : [];
    s.logs = Array.isArray(raw.logs) ? raw.logs.filter(function (l) { return l && l.at; }).slice(0, 500) : [];
    return s;
  }

  function normalizeProduct(p) {
    return {
      id: safeId(p.id, 'p'),
      demo: p.demo === true || !!DEMO_PRODUCT_IDS[p.id],
      sku: String(p.sku || '').trim(),
      title: String(p.title || '').trim(),
      titleEn: String(p.titleEn || '').trim(),
      category: String(p.category || '').trim(),
      keywords: Array.isArray(p.keywords) ? p.keywords.filter(Boolean) : splitList(p.keywords),
      specs: String(p.specs || ''),
      specsEn: String(p.specsEn || ''),
      priceUsd: num(p.priceUsd, 0),
      shippingRmb: num(p.shippingRmb, 0),
      priceFloorUsd: num(p.priceFloorUsd, 0),
      /* 阶梯价：[{min:1,max:1,price:15.43},{min:2,max:9,price:14.9},...] */
      priceTiers: Array.isArray(p.priceTiers) ? p.priceTiers.filter(function (x) {
        return x && num(x.price, 0) > 0;
      }).map(function (x) {
        return { min: num(x.min, 1), max: num(x.max, 0), price: num(x.price, 0) };
      }) : [],
      costRmb: num(p.costRmb, 0),
      costSource: String(p.costSource || ''),
      costNote: String(p.costNote || ''),
      /* 上次改成本的时间：补成本页与询盘卡片用它判断“这个成本是不是过期了” */
      costUpdatedAt: p.costUpdatedAt || '',
      shippingRmb: num(p.shippingRmb, 0),
      marketPriceRmb: num(p.marketPriceRmb, 0),
      moq: num(p.moq, 1),
      leadTimeDays: num(p.leadTimeDays, 15),
      certs: Array.isArray(p.certs) ? p.certs.filter(Boolean) : splitList(p.certs),
      hsCode: String(p.hsCode || ''),
      stock: String(p.stock || '备货'),
      note: String(p.note || '')
    };
  }

  /* 商机里的报价：只留认识的字段，数字一律转成有限数，防止手改文件写进字符串
     或 __proto__ 之类的怪键，让后面的计算出现 NaN / 隐式类型转换 */
  function normalizeQuote(q) {
    q = (q && typeof q === 'object' && !Array.isArray(q)) ? q : {};
    return {
      qty: Math.max(0, num(q.qty, 0)),
      unitPriceUsd: Math.max(0, num(q.unitPriceUsd, 0)),
      targetPriceUsd: Math.max(0, num(q.targetPriceUsd, 0)),
      /* null = 没填（要按商品库的成本带出来）；0 = 真的不收成本。
         以前两者都写 0，导致新商机成本永远是 0，保本价 / 建议价全成 0。 */
      costRmb: (q.costRmb === undefined || q.costRmb === null || q.costRmb === '')
        ? null : Math.max(0, num(q.costRmb, 0)),
      shippingRmb: (q.shippingRmb === undefined || q.shippingRmb === null || q.shippingRmb === '')
        ? null : Math.max(0, num(q.shippingRmb, 0)),
      leadTimeDays: Math.max(0, num(q.leadTimeDays, 0)),
      validDays: Math.max(0, num(q.validDays, 30)),
      incoterm: String(q.incoterm || '').slice(0, 60),
      autoPrice: q.autoPrice === true
    };
  }

  /* 报价版本：同一个商机每改一次价就留一条，回看“为什么从 15.4 降到 14.8”。
     只留最近 20 条；价格与数量完全相同的不重复记（防输入框连打留一串同价）。 */
  function normalizeQuoteVersion(v) {
    v = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return {
      at: v.at || null,
      unitPriceUsd: Math.max(0, num(v.unitPriceUsd, 0)),
      qty: Math.max(0, num(v.qty, 0)),
      incoterm: String(v.incoterm || '').slice(0, 60),
      leadTimeDays: Math.max(0, num(v.leadTimeDays, 0)),
      marginPct: (v.marginPct === undefined || v.marginPct === null || v.marginPct === '')
        ? null : num(v.marginPct, 0),
      netRmb: (v.netRmb === undefined || v.netRmb === null || v.netRmb === '')
        ? null : num(v.netRmb, 0),
      productId: v.productId ? String(v.productId).slice(0, 60) : null,
      note: String(v.note || '').slice(0, 120)
    };
  }

  function pushQuoteVersion(opp, q, note) {
    if (!opp || typeof opp !== 'object') return opp;
    var quote = normalizeQuote(q || opp.quote);
    if (!(quote.unitPriceUsd > 0)) return opp;   /* 没价不记版本 */
    var list = Array.isArray(opp.quoteVersions) ? opp.quoteVersions.slice() : [];
    var last = list[list.length - 1];
    if (last && last.unitPriceUsd === quote.unitPriceUsd && last.qty === quote.qty) return opp;
    list.push(normalizeQuoteVersion({
      at: nowIso(), unitPriceUsd: quote.unitPriceUsd, qty: quote.qty,
      incoterm: quote.incoterm, leadTimeDays: quote.leadTimeDays,
      marginPct: q && q.marginPct, netRmb: q && q.netRmb,
      productId: q && q.productId, note: note || ''
    }));
    opp.quoteVersions = list.slice(-20);
    return opp;
  }

  /* 解析结果的人工修正：只收白名单字段、限长限值，脏数据进不来。
     修正只影响解析展示与待确认问题；有真实落点的字段（数量/市场/交期/术语）
     由保存动作同步写回 quote/buyer，不在这里处理。 */
  var REPLY_SCENARIOS = ['first', 'prequote', 'spec', 'moq', 'negotiation', 'sample', 'closing', 'clarify'];
  /* P1-7：时间线清洗——结构不对、方向非法、空文本整条丢弃；单条文本
     截断 2000 字，chg 截断 120 字，总量保留最近 100 条（追加顺序即
     对话顺序，不按 at 重排，避免本机时钟误差打乱次序）。 */
  function sanitizeMessages(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (m) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.dir !== 'buyer' && m.dir !== 'seller') return;
      var text = String(m.text || '').trim().slice(0, 2000);
      if (!text) return;
      var at = (typeof m.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(m.at)) ? m.at : nowIso();
      var e = { at: at, dir: m.dir, text: text };
      if (typeof m.chg === 'string' && m.chg.trim()) e.chg = m.chg.trim().slice(0, 120);
      out.push(e);
    });
    return out.slice(-100);
  }

  function msgNorm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  /* 最新一条买家消息原文；没有买家消息时回落第一封询盘 rawText——
     意向判定与发送稿语言只认这个来源，卖家消息永不参与。 */
  function latestBuyerText(opp) {
    var ms = (opp && opp.messages) || [];
    for (var i = ms.length - 1; i >= 0; i--) {
      if (ms[i] && ms[i].dir === 'buyer' && ms[i].text) return ms[i].text;
    }
    return String((opp && opp.rawText) || '');
  }

  /* 追加买家消息（幂等）：与 rawText 相同（第一封询盘本身）或与最新
     一条买家消息规范化后相同，都不重复入线。chg 为关键字段变更注记。 */
  function appendBuyerMessage(opp, text, chg) {
    if (!opp) return { added: false, reason: 'no-opp' };
    var t = String(text || '').trim().slice(0, 2000);
    if (!t) return { added: false, reason: 'empty' };
    if (msgNorm(t) === msgNorm(opp.rawText)) return { added: false, reason: 'seed' };
    var ms = Array.isArray(opp.messages) ? opp.messages : (opp.messages = []);
    for (var i = ms.length - 1; i >= 0; i--) {
      if (ms[i] && ms[i].dir === 'buyer') {
        if (msgNorm(ms[i].text) === msgNorm(t)) return { added: false, reason: 'dup' };
        break;
      }
    }
    var e = { at: nowIso(), dir: 'buyer', text: t };
    if (typeof chg === 'string' && chg.trim()) e.chg = chg.trim().slice(0, 120);
    ms.push(e);
    if (ms.length > 100) opp.messages = ms.slice(-100);
    opp.updatedAt = nowIso();
    return { added: true, entry: e };
  }

  /* 追加卖家消息：唯一调用方是 app 的「确认已发送」成功路径（该路径
     已有同一草稿防重复确认闸），此处只负责落盘与容量。 */
  function appendSellerMessage(opp, text) {
    if (!opp) return { added: false, reason: 'no-opp' };
    var t = String(text || '').trim().slice(0, 2000);
    if (!t) return { added: false, reason: 'empty' };
    var ms = Array.isArray(opp.messages) ? opp.messages : (opp.messages = []);
    var e = { at: nowIso(), dir: 'seller', text: t };
    ms.push(e);
    if (ms.length > 100) opp.messages = ms.slice(-100);
    opp.updatedAt = nowIso();
    return { added: true, entry: e };
  }

  /* 商机当前有效字段快照（原始询盘解析 + parseEdits 覆盖），只取多轮
     变更注记关心的四项：数量、目的地、贸易术语、目标价。parseEdits 的
     语义是「买家最新提及」，不代表双方已确认。 */
  function effSnapshotOf(opp) {
    var snap = { qty: null, destination: '', incoterm: '', targetPriceUsd: null };
    if (!opp) return snap;
    try {
      var P = window.P0Parse;
      if (P && P.extract) {
        /* extract 返回 {fields:{...}}；歧义金额在 parse 层就不会写进
           targetPriceUsd（恒为 0），快照直接读 fields 即可。 */
        var res = P.extract(String(opp.rawText || '')) || {};
        var f = res.fields || {};
        if (f.qty > 0) snap.qty = Math.round(f.qty);
        if (f.destination) snap.destination = String(f.destination);
        if (f.incoterm) snap.incoterm = String(f.incoterm);
        if (f.targetPriceUsd > 0) snap.targetPriceUsd = Math.round(f.targetPriceUsd * 100) / 100;
      }
    } catch (e) {}
    var pe = opp.parseEdits || {};
    if (num(pe.qty, 0) > 0) snap.qty = Math.round(num(pe.qty, 0));
    if (pe.destination) snap.destination = String(pe.destination);
    if (pe.incoterm) snap.incoterm = String(pe.incoterm);
    if (num(pe.targetPriceUsd, 0) > 0) snap.targetPriceUsd = Math.round(num(pe.targetPriceUsd, 0) * 100) / 100;
    return snap;
  }

  /* 变更注记：只记「旧值与新值都明确且不同」的字段；首次补充不算变更；
     新目标价带解析歧义（afterAmbiguous）时不生成确定变更。 */
  function chgNote(before, after, afterAmbiguous) {
    if (!before || !after) return '';
    var parts = [];
    if (before.qty != null && after.qty != null && before.qty !== after.qty)
      parts.push('数量 ' + before.qty + ' → ' + after.qty);
    if (before.destination && after.destination && before.destination !== after.destination)
      parts.push('目的地 ' + before.destination + ' → ' + after.destination);
    if (before.incoterm && after.incoterm && before.incoterm !== after.incoterm)
      parts.push('贸易术语 ' + before.incoterm + ' → ' + after.incoterm);
    if (!afterAmbiguous && before.targetPriceUsd != null && after.targetPriceUsd != null && before.targetPriceUsd !== after.targetPriceUsd)
      parts.push('目标价 $' + before.targetPriceUsd.toFixed(2) + ' → $' + after.targetPriceUsd.toFixed(2));
    return parts.join('；').slice(0, 120);
  }

  /* P1-7-FIX：多轮字段合并的唯一规则——两侧先过 sanitizeParseEdits
     白名单清洗，再逐键合并：新值非空则新值胜，新值缺失或为空则保留
     旧值（决策台字段框留空 = 本轮未提供新值）。显式清空不走这里：
     详情页解析修正编辑器直接写 parseEdits（留空 = 恢复自动识别），
     其结果就是下一次合并读取的「旧值」，被清掉的字段不会复活。 */
  function mergeParseEdits(oldEdits, newEdits) {
    var o = sanitizeParseEdits(oldEdits);
    var n = sanitizeParseEdits(newEdits);
    var out = {};
    Object.keys(o).forEach(function (k) { out[k] = o[k]; });
    Object.keys(n).forEach(function (k) { out[k] = n[k]; });
    return out;
  }

  function sanitizeReplyDrafts(rd) {
    if (!rd || typeof rd !== 'object' || Array.isArray(rd)) return {};
    var out = {};
    REPLY_SCENARIOS.forEach(function (k) {
      var d = rd[k];
      if (d && typeof d === 'object' && typeof d.en === 'string') {
        out[k] = {
          en: d.en.slice(0, 6000),
          zh: typeof d.zh === 'string' ? d.zh.slice(0, 6000) : '',
          edited: !!d.edited,
          at: d.at || null
        };
      }
    });
    return out;
  }

  function sanitizeParseEdits(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return {};
    var out = {};
    ['productName', 'purpose', 'country', 'destination', 'incoterm', 'certsText', 'modelsText', 'specsText'].forEach(function (k) {
      if (typeof e[k] === 'string' && e[k].trim()) out[k] = e[k].trim().slice(0, 160);
    });
    if (num(e.qty, 0) > 0) out.qty = Math.round(num(e.qty, 0));
    if (num(e.targetPriceUsd, 0) > 0) out.targetPriceUsd = Math.round(num(e.targetPriceUsd, 0) * 100) / 100;
    if (num(e.leadTimeDays, 0) > 0) out.leadTimeDays = Math.round(num(e.leadTimeDays, 0));
    return out;
  }

  /* P1-22 员工销售判断修正层：只保留白名单结构，脏数据整层丢弃返回 null，
     保证人工修正能过 normalizeOpp/migrate/mergeAll 而不丢失、也不带毒 */
  function sanitizeSalesReview(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    var NEED_KEYS = ['product', 'specs', 'qty', 'purpose', 'certs', 'delivery', 'destination', 'targetPrice'];
    var STAGES = ['初步了解', '明确需求', '商品比较', '供应商筛选', '价格谈判', '样品或订单推进', '暂时无法判断'];
    var TOPICS = ['价格', '认证', '交货时间', '产品质量', 'MOQ', '售后', '供应商可靠性', '定制能力'];
    var out = {};
    if (r.needFix && typeof r.needFix === 'object' && !Array.isArray(r.needFix)) {
      var nf = {};
      NEED_KEYS.forEach(function (k) {
        var v = r.needFix[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.value === 'string' && v.value.trim()) {
          nf[k] = { value: v.value.trim().slice(0, 200), at: typeof v.at === 'string' ? v.at.slice(0, 20) : null };
        }
      });
      if (Object.keys(nf).length) out.needFix = nf;
    }
    if (typeof r.stageFix === 'string' && STAGES.indexOf(r.stageFix) >= 0) out.stageFix = r.stageFix;
    if (r.concernFix && typeof r.concernFix === 'object' && !Array.isArray(r.concernFix)) {
      var cf = {};
      TOPICS.forEach(function (t) {
        if (r.concernFix[t] === 'confirmed' || r.concernFix[t] === 'dismissed') cf[t] = r.concernFix[t];
      });
      if (Object.keys(cf).length) out.concernFix = cf;
    }
    if (Array.isArray(r.flagged)) {
      var fl = [];
      r.flagged.forEach(function (f) {
        if (typeof f !== 'string') return;
        if (f === 'stage' || (f.indexOf('need:') === 0 && NEED_KEYS.indexOf(f.slice(5)) >= 0)) {
          if (fl.indexOf(f) < 0 && fl.length < 16) fl.push(f);
        }
      });
      if (fl.length) out.flagged = fl;
    }
    if (!Object.keys(out).length) return null;
    out.at = typeof r.at === 'string' ? r.at.slice(0, 20) : null;
    return out;
  }

  function normalizeOpp(o) {
    o = o || {};
    var buyer = o.buyer || {};
    var drafts = (o.drafts && typeof o.drafts === 'object' && !Array.isArray(o.drafts)) ? o.drafts : {};
    var deal = (o.deal && typeof o.deal === 'object' && !Array.isArray(o.deal)) ? o.deal : null;
    return {
      id: safeId(o.id, 'opp'),
      demo: o.demo === true || !!DEMO_OPP_IDS[o.id],
      createdAt: o.createdAt || nowIso(),
      updatedAt: o.updatedAt || o.createdAt || nowIso(),
      buyer: {
        name: String(buyer.name || '未知买家'),
        company: String(buyer.company || ''),
        country: String(buyer.country || ''),
        channel: String(buyer.channel || '询盘')
      },
      rawText: String(o.rawText || ''),
      status: o.status || 'new',
      matches: Array.isArray(o.matches) ? o.matches.filter(function (m) {
        return m && typeof m === 'object' && !Array.isArray(m);
      }).slice(0, 20).map(function (m) {
        return {
          productId: String(m.productId || m.id || '').slice(0, 60),
          score: num(m.score, 0),
          reason: String(m.reason || '').slice(0, 200)
        };
      }) : [],
      selectedProductId: o.selectedProductId ? String(o.selectedProductId).slice(0, 60) : null,
      /* 型号不符拦截的人工放行标记：销售核对后显式放行才为 true，换商品时重置 */
      matchOverride: !!o.matchOverride,
      /* P1-3B-2 决策台选品来源：只认 auto/manual 两值，其余一律归 null 防污染；
         selectionAt 只接受 ISO 日期时间字符串，其余归 null */
      selectionSource: o.selectionSource === 'manual' ? 'manual' : (o.selectionSource === 'auto' ? 'auto' : null),
      selectionAt: (typeof o.selectionAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(o.selectionAt)) ? o.selectionAt : null,
      parseEdits: sanitizeParseEdits(o.parseEdits),
      /* P1-22 员工销售判断修正：与 AI 分析分开保存，白名单清洗后保留 */
      salesReview: sanitizeSalesReview(o.salesReview),
      /* 阶段四回复草稿：按场景存中英正文，只认白名单场景键，防脏数据膨胀 */
      replyDrafts: sanitizeReplyDrafts(o.replyDrafts),
      /* 人工价值判断记录：卖家自己的结论（重点/正常/搁置）+ 备注，只认白名单值 */
      valueNote: (o.valueNote && typeof o.valueNote === 'object' && !Array.isArray(o.valueNote) &&
        ['focus', 'normal', 'defer'].indexOf(o.valueNote.verdict) >= 0)
        ? { verdict: o.valueNote.verdict, note: String(o.valueNote.note || '').slice(0, 200), at: o.valueNote.at || null }
        : null,
      quote: normalizeQuote(o.quote),
      quoteVersions: Array.isArray(o.quoteVersions) ? o.quoteVersions.filter(function (v) {
        return v && typeof v === 'object' && !Array.isArray(v);
      }).slice(-20).map(normalizeQuoteVersion) : [],
      drafts: {
        en: String(drafts.en || ''),
        zh: String(drafts.zh || '')
      },
      deal: deal ? {
        finalAmountUsd: num(deal.finalAmountUsd, 0),
        netRmb: num(deal.netRmb, 0),
        reason: String(deal.reason || '').slice(0, 500),
        closedAt: deal.closedAt || null
      } : null,
      followUpAt: o.followUpAt || null,
      lastContactAt: o.lastContactAt || null,
      /* 首次回复 / 最近一次实际接触 / 下次该动手的时间：跟进完成率全靠这三个时间 */
      firstResponseAt: o.firstResponseAt || null,
      lastTouchAt: o.lastTouchAt || o.lastContactAt || null,
      nextActionAt: o.nextActionAt || o.followUpAt || null,
      priority: String(o.priority || '').slice(0, 20),
      followCount: num(o.followCount, 0),
      /* 阶段五跟进状态（人工设置）：只认白名单键，其余一律清空走推导 */
      followStatus: ['todo', 'waiting', 'internal', 'planned', 'done'].indexOf(o.followStatus) >= 0 ? o.followStatus : null,
      followLog: Array.isArray(o.followLog) ? o.followLog.filter(function (x) {
        return x && typeof x === 'object' && !Array.isArray(x);
      }).slice(-100) : [],
      /* P1-7 多轮消息时间线：[{at, dir, text, chg?}]——dir 只认 buyer/seller，
         旧商机无此字段时为空数组，详情页以 rawText 充当第一条买家消息展示，
         绝不把 rawText 重复写进时间线。卖家消息只来自「确认已发送」动作。 */
      messages: sanitizeMessages(o.messages),
      log: Array.isArray(o.log) ? o.log.filter(function (x) {
        return x && typeof x === 'object' && !Array.isArray(x);
      }).slice(0, 200).map(function (x) {
        return { ts: String(x.ts || ''), text: String(x.text || '').slice(0, 500) };
      }) : []
    };
  }

  function normalizeOrder(o) {
    o = o || {};
    return {
      id: safeId(o.id, 'ord'),
      demo: o.demo === true,
      date: o.date || (new Date().toISOString().slice(0, 10)),
      productId: o.productId || '',
      sku: String(o.sku || ''),
      title: String(o.title || ''),
      qty: num(o.qty, 0),
      unitPriceUsd: num(o.unitPriceUsd, 0),
      amountUsd: num(o.amountUsd, 0),
      refundUsd: num(o.refundUsd, 0),
      costRmb: num(o.costRmb, 0),
      /* 原始成本，退款时不覆盖它，否则撤销退款就回不去了 */
      costFullRmb: num(o.costFullRmb, num(o.costRmb, 0)),
      feeRmb: num(o.feeRmb, 0),
      netRmb: num(o.netRmb, 0),
      buyer: String(o.buyer || ''),
      country: String(o.country || ''),
      note: String(o.note || ''),
      source: String(o.source || 'manual'),
      createdAt: o.createdAt || nowIso()
    };
  }

  function splitList(v) {
    if (!v) return [];
    return String(v).split(/[,，;；\/|\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  var state = null;

  var BROKEN_KEY = STORE_KEY + '_broken';
  var loadIssue = '';

  function load() {
    if (state) return state;
    var raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch (e) {
      console.warn('localStorage 不可用，将使用内存态', e);
    }
    if (!raw) {
      state = freshState();
      /* R3-02：首次空存储也要建立内存回滚基准（只在内存中序列化，
         不为建基准而写磁盘）；否则第一次落盘失败时无处可回滚。 */
      establishBaseline();
      return state;
    }
    try {
      state = migrate(JSON.parse(raw));
      lastGoodRaw = raw;
    } catch (e) {
      /* 以前这里直接换演示数据，下一次 persist 就把用户几个月的商品和商机全覆盖了。
         先试图从自动备份恢复；恢复不了，也把坏数据原样留一份在 _broken 里。 */
      console.warn('状态解析失败', e);
      var restored = null;
      try {
        var bak = localStorage.getItem(STORE_BAK);
        if (bak) {
          var bj = JSON.parse(bak);
          restored = migrate(bj && bj.data ? bj.data : bj);
        }
      } catch (e2) { restored = null; }
      var kept = false;
      try {
        localStorage.setItem(BROKEN_KEY, raw);
        kept = true;
      } catch (e3) { kept = false; }
      if (restored) {
        state = restored;
        loadIssue = '原数据损坏，已从自动备份恢复' + (kept ? '（坏数据另存了一份）' : '');
      } else {
        state = freshState();
        loadIssue = '原数据损坏、无法读取，已换成演示数据' +
          (kept ? '。坏数据存在浏览器里（键名 ' + BROKEN_KEY + '），别再导入新数据覆盖之前先找我们' : '');
      }
      /* R3-02：损坏 fallback 的回滚基准是"经 migrate 验证后的恢复/初始状态"
         本身，绝不使用未经验证的损坏原文（上方 lastGoodRaw=raw 只适用于解析成功路径）。 */
      establishBaseline();
    }
    return state;
  }

  /* 上一次成功写入的快照，存满或其他原因丢数据时能回滚一步 */
  var lastSnapAt = 0;
  var storageError = '';

  var lastPersistOk = true;
  var lastGoodRaw = null;      /* 最近一次确认落盘成功（或加载时）的状态原文 */
  var persistFailureCount = 0; /* 累计落盘失败次数，供上层统一守卫判断本次操作是否失败 */
  /* P1-23-R7-R2-R2：落盘失败时把内存状态回滚到最近一次已落盘状态，
     避免界面继续显示未保存的修改（等价于一次重新加载的语义）。 */
  function rollbackMemoryToLastGood() {
    if (!lastGoodRaw) return false;
    try { state = migrate(JSON.parse(lastGoodRaw)); return true; } catch (e) { return false; }
  }
  /* R3-02：把当前内存状态序列化为回滚基准（不写磁盘）。
     用于 load 的空存储/损坏 fallback 路径——这些路径没有"上次落盘原文"，
     但状态本身已经过 freshState/migrate 验证，可以作为失败回滚目标。 */
  function establishBaseline() {
    try { lastGoodRaw = JSON.stringify(state); } catch (e) { lastGoodRaw = null; }
  }
  /* 落盘失败的统一收尾：回滚内存；回滚本身失败必须显式体现在 storageError 中
     （fail-closed：不假装已回滚），上层据 persistOk()=false 与失败计数感知。 */
  function rollbackOrNote() {
    if (!rollbackMemoryToLastGood()) storageError = (storageError || '保存失败') + '；内存回滚失败，请刷新页面';
  }
  function persist() {
    if (!state) { lastPersistOk = false; return false; }
    /* P1-23-R7-R2 写入屏障：身份事务处于待恢复锁定状态时，拒绝一切业务落盘。
       persist 是业务状态的唯一落盘漏斗，故在此一处设防即覆盖全部写入入口；
       恢复通道由 IdentityTxn 置内部旁路标记后放行。返回值 true/false 为附加语义，
       旧调用者忽略返回值、行为不变；新调用者必须检查返回值或 persistOk()。 */
    if (typeof window !== 'undefined' && window.IdentityTxn && window.IdentityTxn.isLocked && window.IdentityTxn.isLocked() && !window.IdentityTxn._bypass) {
      storageError = '身份数据待恢复，写入已阻断';
      lastPersistOk = false;
      persistFailureCount++;
      rollbackOrNote();
      return false;
    }
    var raw;
    try {
      raw = JSON.stringify(state);
    } catch (e) {
      lastPersistOk = false;
      persistFailureCount++;
      storageError = '数据序列化失败';
      console.warn('保存失败', e);
      rollbackOrNote();
      return false;
    }
    try {
      var prev = null;
      try { prev = localStorage.getItem(STORE_KEY); } catch (e2) { prev = null; }
      if (prev && Date.now() - lastSnapAt > 10 * 60 * 1000 && prev.length > 200) {
        try {
          localStorage.setItem(STORE_BAK, JSON.stringify({ at: nowIso(), data: JSON.parse(prev) }));
          lastSnapAt = Date.now();
        } catch (e3) { /* 快照写不进就算了，不能拖累主保存 */ }
      }
      localStorage.setItem(STORE_KEY, raw);
      /* 写后读回校验：setItem 不抛错不等于写成功（R7-R2 成功判定标准） */
      var readBack = null;
      try { readBack = localStorage.getItem(STORE_KEY); } catch (e4) { readBack = null; }
      if (readBack !== raw) { lastPersistOk = false; persistFailureCount++; storageError = '保存后校验失败'; rollbackOrNote(); return false; }
      storageError = '';
      lastPersistOk = true;
      lastGoodRaw = raw;
      return true;
    } catch (e) {
      var full = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
      storageError = full ? '浏览器存储满了' : '浏览器拒绝了本地保存';
      console.warn('保存失败', e);
      lastPersistOk = false;
      persistFailureCount++;
      rollbackOrNote();
      return false;
    }
  }

  function persistOk() { return lastPersistOk; }
  function getPersistFailureCount() { return persistFailureCount; }
  /* 与 replaceAll 相同，但向调用者报告落盘是否成功（供事务通道使用） */
  function replaceAllChecked(obj) { replaceAll(obj); return lastPersistOk; }

  /* 事务回滚专用：把恢复前快照原样写回（不经 migrate/规范化）。
     与 replaceAll 的区别：replaceAll 面向外部备份导入，必须规范化并
     处理本机设置；本入口只供身份事务回滚写回本机自己的恢复前快照
     （快照来自事务日志保存的磁盘原文解析对象）。任何规范化改写都会
     让回滚后的整包哈希与恢复前不一致、令 abortRestore 的核验永远
     失败（C9 缺陷），故此处只做深拷贝置换后走 persist()——persist
     本身不做规范化，锁屏障、写后读回校验与 _bak 轮换语义与其它
     写入口完全一致。禁止把未经验证的外部备份直接传入本入口。 */
  function replaceAllRaw(obj) {
    state = clone(obj);
    persist();
    return lastPersistOk;
  }

  /* 设置页用：存储健康 + 能不能回滚 */
  function storageHealth() {
    var out = { ok: !storageError, error: storageError, bytes: 0, backupAt: null, backupBytes: 0 };
    try {
      var raw = localStorage.getItem(STORE_KEY);
      out.bytes = raw ? raw.length : 0;
    } catch (e) { out.ok = false; out.error = out.error || '读不了本地存储'; }
    try {
      var b = localStorage.getItem(STORE_BAK);
      if (b) {
        var o = JSON.parse(b);
        out.backupAt = o && o.at || null;
        out.backupBytes = b.length;
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /* 回滚到上一次快照 */
  function restoreBackup() {
    var b;
    try { b = localStorage.getItem(STORE_BAK); } catch (e) { return { ok: false, reason: '读不了备份' }; }
    if (!b) return { ok: false, reason: '还没有备份（改动超过 10 分钟才会存一份）' };
    var o;
    try { o = JSON.parse(b); } catch (e) { return { ok: false, reason: '备份已损坏' }; }
    if (!o || !o.data || !Array.isArray(o.data.products)) return { ok: false, reason: '备份格式不对' };
    state = migrate(o.data);
    persist();
    return { ok: true, at: o.at };
  }

  function get() { return load(); }

  function reset(opts) {
    state = freshState(opts);
    persist();
    return state;
  }

  var BACKUP_VERSION = 2;
  var MAX_ITEMS = 5000;

  /**
   * 校验备份内容。不碰现有数据，只判断能不能导入。
   * @returns {{ok:boolean, errors:string[], counts:object}}
   */
  function validateBackup(obj) {
    var errors = [];
    var counts = { products: 0, opportunities: 0, orders: 0, logs: 0 };

    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { ok: false, errors: ['文件里不是 JSON 对象，可能不是本工具的备份'], counts: counts };
    }

    var hasAny = ('products' in obj) || ('opportunities' in obj) || ('orders' in obj);
    if (!hasAny) {
      errors.push('找不到 products / opportunities / orders 任何字段');
    }

    [['products', '商品'], ['opportunities', '商机'], ['orders', '订单'], ['logs', '日志']].forEach(function (pair) {
      var k = pair[0], label = pair[1];
      if (!(k in obj) || obj[k] === undefined || obj[k] === null) return;
      if (!Array.isArray(obj[k])) {
        errors.push(label + '（' + k + '）不是数组，格式不对');
        return;
      }
      if (obj[k].length > MAX_ITEMS) {
        errors.push(label + '有 ' + obj[k].length + ' 条，超过上限 ' + MAX_ITEMS + '，为防止卡死已拒绝');
      }
      counts[k] = obj[k].length;
    });

    /* 抽头 / 中 / 尾三条看形状，防止「前几条是对的、后面混进垃圾」 */
    function probe(arr, label, need) {
      if (!Array.isArray(arr) || !arr.length) return;
      var idx = [0, Math.floor(arr.length / 2), arr.length - 1];
      var seen = {};
      for (var i = 0; i < idx.length; i++) {
        var n = idx[i];
        if (seen[n]) continue;
        seen[n] = 1;
        var x = arr[n];
        if (!x || typeof x !== 'object' || Array.isArray(x)) {
          errors.push(label + '第 ' + (n + 1) + ' 条不是对象，文件可能被改坏了');
          return;
        }
        var hit = false;
        for (var j = 0; j < need.length; j++) if (x[need[j]]) { hit = true; break; }
        if (!hit) {
          errors.push(label + '里没有 ' + need.join(' / ') + '，可能不是' + label + '数据');
          return;
        }
      }
    }
    probe(obj.products, '商品', ['title', 'sku', 'titleEn']);
    probe(obj.opportunities, '商机', ['buyer', 'rawText']);

    var meta = obj._backup || null;
    if (meta && meta.app && meta.app !== '询盘副驾驶') {
      errors.push('这个备份来自「' + String(meta.app).slice(0, 40) + '」，不是本工具的文件');
    }

    return { ok: errors.length === 0, errors: errors, counts: counts, meta: meta };
  }

  function mergeAll(obj) {
    var s = get();
    var added = { products: 0, opportunities: 0, orders: 0 };
    /* 合并前也过一遍校验：导入入口已经验过一次，这里防的是别处直接调这个函数 */
    if (!validateBackup(obj).ok) return added;

    if (Array.isArray(obj.products)) {
      var pIds = {};
      s.products.forEach(function (p) { pIds[p.id] = 1; });
      obj.products.map(normalizeProduct).forEach(function (p) {
        if (pIds[p.id]) return;
        pIds[p.id] = 1;
        s.products.push(p);
        added.products++;
      });
    }
    if (Array.isArray(obj.opportunities)) {
      var oIds = {};
      s.opportunities.forEach(function (o) { oIds[o.id] = 1; });
      obj.opportunities.map(normalizeOpp).forEach(function (o) {
        if (oIds[o.id]) return;
        oIds[o.id] = 1;
        s.opportunities.push(o);
        added.opportunities++;
      });
    }
    if (Array.isArray(obj.orders)) {
      var rIds = {};
      s.orders.forEach(function (o) { rIds[o.id] = 1; });
      obj.orders.map(normalizeOrder).forEach(function (o) {
        if (rIds[o.id]) return;
        rIds[o.id] = 1;
        s.orders.push(o);
        added.orders++;
      });
    }
    persist();
    return added;
  }

  function replaceAll(obj) {
    var prev = get();
    state = migrate(obj);
    /* Key 和自建翻译地址是「这台机器」的配置，不跟着别人的备份走：
       否则导入一份备份就等于把询盘内容转给备份作者的服务器。 */
    state.settings.dashscopeKey = '';
    state.settings.translateEndpoint = prev.settings.translateEndpoint;
    persist();
    return state;
  }

  function addLog(opp, text) {
    if (!opp.log) opp.log = [];
    opp.log.unshift({ ts: nowIso(), text: text });
    opp.updatedAt = nowIso();
  }

  /* ---------------- 统计 ---------------- */

  function stats() {
    var s = get();
    /* 经营统计只算真实业务：演示商机/演示订单一律排除，另行给出演示计数 */
    var oppsAll = Array.isArray(s.opportunities) ? s.opportunities : [];
    var ordersAll = Array.isArray(s.orders) ? s.orders : [];
    var opps = oppsAll.filter(function (o) { return !isDemoOpp(o); });
    var orders = ordersAll.filter(function (o) { return !isDemoOrder(o); });

    var won = opps.filter(function (o) { return o.status === 'won'; });
    var lost = opps.filter(function (o) { return o.status === 'lost'; });
    var open = opps.filter(function (o) { return o.status === 'new' || o.status === 'matched'; });
    var closed = won.length + lost.length;

    /* 退款要从成交额里扣掉，别把退掉的钱算成业绩 */
    var gmvUsd = round2(sum(orders, function (o) {
      return num(o.amountUsd) - Math.min(num(o.refundUsd), num(o.amountUsd));
    }));
    var profitRmb = round2(sum(orders, function (o) { return num(o.netRmb); }));
    var costRmb = round2(sum(orders, function (o) { return num(o.costRmb); }));

    return {
      demoOppCount: oppsAll.filter(isDemoOpp).length,
      demoOrderCount: ordersAll.filter(isDemoOrder).length,
      totalOpps: opps.length,
      openCount: open.length,
      wonCount: won.length,
      lostCount: lost.length,
      winRate: closed ? won.length / closed : 0,

      orderCount: orders.length,
      gmvUsd: gmvUsd,
      profitRmb: profitRmb,
      costRmb: costRmb,
      avgProfitRmb: orders.length ? profitRmb / orders.length : 0,
      avgMargin: costRmb > 0 ? profitRmb / costRmb : null,
      products: (s.products || []).length
    };
  }
  /* ---------------- 导出 / 导入 ---------------- */

  function exportJson() {
    var s = get();
    var payload = JSON.parse(JSON.stringify(s));
    /* 备份会被转发、丢网盘、发给同事，不能把阿里云 Key 一起带走。
       导入时（replaceAll）本机 Key / 自建翻译地址会原样保留，所以剔掉不影响自己恢复。 */
    if (payload.settings) {
      payload.settings.dashscopeKey = '';
      payload.settings.translateEndpoint = '';
    }
    payload._backup = {
      app: '询盘副驾驶', version: BACKUP_VERSION, exportedAt: nowIso(), secretsStripped: true
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    a.href = url;
    a.download = '询盘副驾驶-备份-' +
      d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.Core = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    STORE_KEY: STORE_KEY,
    // 工具
    uid: uid, nowIso: nowIso, clone: clone, round: round, clamp: clamp,
    sum: sum, num: num, money: money, usd: usd, pct: pct, esc: esc,
    safeId: safeId, round2: round2, typeOfProduct: typeOfProduct, feeRateFor: feeRateFor, audit: audit,
    orderNet: orderNet, fxShock: fxShock,
    TYPE_KEYS: TYPE_KEYS,
    fmtDate: fmtDate, relTime: relTime, roundUpTo: roundUpTo, splitList: splitList,
    // 状态
    get: get, persist: persist, persistOk: persistOk, persistFailureCount: getPersistFailureCount, reset: reset, replaceAll: replaceAll, replaceAllChecked: replaceAllChecked, replaceAllRaw: replaceAllRaw, STORE_KEY: STORE_KEY,
    storageHealth: storageHealth, restoreBackup: restoreBackup,
    validateBackup: validateBackup, mergeAll: mergeAll, BACKUP_VERSION: BACKUP_VERSION,
    addLog: addLog, stats: stats,
    isDemoOpp: isDemoOpp, isDemoProduct: isDemoProduct, isDemoOrder: isDemoOrder,
    visibleOpps: visibleOpps, purgeDemo: purgeDemo,
    buyerKeyOf: buyerKeyOf, inquiryFingerprint: inquiryFingerprint, findDuplicateOpps: findDuplicateOpps,
    sanitizeMessages: sanitizeMessages, latestBuyerText: latestBuyerText, mergeParseEdits: mergeParseEdits,
    appendBuyerMessage: appendBuyerMessage, appendSellerMessage: appendSellerMessage,
    effSnapshotOf: effSnapshotOf, chgNote: chgNote,
    // 规范化
    normalizeProduct: normalizeProduct, normalizeOpp: normalizeOpp, normalizeOrder: normalizeOrder,
    normalizeSettings: normalizeSettings, normalizeQuote: normalizeQuote, normalizeEndpoint: normalizeEndpoint,
    normalizeQuoteVersion: normalizeQuoteVersion, pushQuoteVersion: pushQuoteVersion,
    loadIssue: function () { return loadIssue; },
    clearLoadIssue: function () { loadIssue = ''; },
    // 种子
    seedProducts: seedProducts, seedOpportunities: seedOpportunities,
    // 导出
    exportJson: exportJson
  };
})();
