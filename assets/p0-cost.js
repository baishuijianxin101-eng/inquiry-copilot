/* P0 成本与利润控制中心：找出"缺失 / 过期 / 异常"的成本，按能不能卖分级。
 * 只做只读体检，绝不改商品数据；任何修补都由人在成本中心里确认后写回。
 * 输出分两层：
 *   rows / issues —— 内部视图，含成本与毛利数字，只能在受保护的数据区渲染；
 *   summary / counts —— 可以安全投影到看板上的计数与结论，不含任何金额。
 * 依赖：pricing.js（可选）；没有 Pricing 时用同一套公式本地兜底。
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : this;
  var C = root.Core || null;
  var Pricing = root.Pricing || null;

  var VERSION = '1.0.0';
  var DAY = 86400000;

  var DEFAULTS = {
    fxRate: 7.1,
    platformFeeRate: 0.05,
    minMarginPct: 8,
    staleDays: 180
  };

  function num(v, d) {
    if (v === '' || v === null || v === undefined) return d === undefined ? 0 : d;
    var n = Number(v);
    return isFinite(n) ? n : (d === undefined ? 0 : d);
  }

  function round(n, d) {
    var p = Math.pow(10, d === undefined ? 2 : d);
    return Math.round((num(n) + Number.EPSILON) * p) / p;
  }

  function settingsOf(raw) {
    var src = (raw && typeof raw === 'object') ? raw : {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = src[k] === undefined || src[k] === null ? DEFAULTS[k] : src[k];
    });
    out.fxRate = num(out.fxRate, DEFAULTS.fxRate) || DEFAULTS.fxRate;
    out.platformFeeRate = Math.min(0.5, Math.max(0, num(out.platformFeeRate, DEFAULTS.platformFeeRate)));
    out.minMarginPct = Math.max(0, num(out.minMarginPct, DEFAULTS.minMarginPct));
    out.staleDays = Math.max(1, num(out.staleDays, DEFAULTS.staleDays));
    return out;
  }

  function nowOf(out) {
    if (out && typeof out === 'string') return out;
    return new Date().toISOString();
  }

  function ageDaysOf(iso, now) {
    if (!iso) return null;
    var t = Date.parse(String(iso));
    if (!isFinite(t)) return null;
    var n = Date.parse(now);
    if (!isFinite(n)) return null;
    var d = (n - t) / DAY;
    return d < 0 ? 0 : Math.round(d);
  }

  /* 最低能让到的挂牌价：有阶梯取最低一档，客户量大时就是按这档成交 */
  function lowestListUsd(p) {
    var list = num(p && p.priceUsd, 0);
    var tiers = (p && p.priceTiers) || [];
    var low = list;
    tiers.forEach(function (t) {
      var v = num(t && t.price, 0);
      if (v > 0 && (low <= 0 || v < low)) low = v;
    });
    return round(low, 2);
  }

  /* 一件卖掉的净利：优先用 Pricing，保证与报价护栏同一套公式 */
  function economicsOf(p, settings, unitUsd) {
    var s = settingsOf(settings);
    if (Pricing && typeof Pricing.evaluate === 'function') {
      var r = Pricing.evaluate({ product: p, qty: 1, settings: s, unitPriceUsd: unitUsd });
      return {
        netRmb: round(r.netRmb, 2),
        marginPct: round(num(r.marginOnCost, 0) * 100, 2),
        breakEvenUsd: round(num(r.floorUsd, 0), 2),
        costUnitRmb: round(num(r.costUnitRmb, 0), 2),
        noCost: !!r.flags.noCost,
        belowCost: !!r.flags.belowCost
      };
    }
    var fx = num(s.fxRate, 7.1) || 7.1;
    var fee = Math.min(0.5, Math.max(0, num(p && p.feeRate, s.platformFeeRate)));
    var keep = 1 - fee;
    var costUnit = num(p && p.costRmb, 0) + num(p && p.shippingRmb, 0);
    var net = unitUsd * fx * keep - costUnit;
    return {
      netRmb: round(net, 2),
      marginPct: costUnit > 0 ? round((net / costUnit) * 100, 2) : 0,
      breakEvenUsd: costUnit > 0 ? round(costUnit / keep / fx, 2) : 0,
      costUnitRmb: round(costUnit, 2),
      noCost: costUnit <= 0,
      belowCost: costUnit > 0 && net < 0
    };
  }

  var LEVEL_RANK = { block: 0, warn: 1, info: 2, ok: 3 };

  function item(code, level, text, ask) {
    return { code: code, level: level, text: text, ask: ask || '' };
  }

  /**
   * 单条体检。
   * @param {object} p 商品
   * @param {object} settings
   * @param {object} opts {now, staleDays}
   * @returns {object} {sku, level, codes[], items[], marginPct, netRmb, dataAgeDays, costUnitRmb, listUsd}
   */
  function checkOne(p, settings, opts) {
    opts = opts || {};
    var s = settingsOf(settings);
    var now = nowOf(opts.now);
    var staleDays = Math.max(1, num(opts.staleDays, s.staleDays));
    var items = [];

    var listUsd = lowestListUsd(p);
    var floorUsd = round(num(p && p.priceFloorUsd, 0), 2);
    var wallUsd = round(num(p && p.priceUsd, 0), 2);
    var e = economicsOf(p, s, listUsd > 0 ? listUsd : 0);
    var age = ageDaysOf(p && p.costUpdatedAt, now);

    if (e.costUnitRmb <= 0) {
      items.push(item('missing_cost', 'block',
        '没有采购成本，报价只能靠猜，利润无法计算。',
        '到成本中心补齐该 SKU 的采购价与国内运费。'));
    } else {
      if (age === null) {
        items.push(item('age_unknown', 'info',
          '成本没有登记更新日期，无法判断是否过期。',
          '补一次成本并记录更新日期，后续系统会自动提醒复审。'));
      } else if (age > staleDays) {
        items.push(item('stale', 'warn',
          '成本已 ' + age + ' 天未复审（阈值 ' + staleDays + ' 天），汇率与采购价都可能变了。',
          '找一次采购确认最新价格，更新成本与日期。'));
      }

      if (listUsd <= 0) {
        items.push(item('missing_price', 'block',
          '没有挂牌价，客户看不到价格。',
          '补齐挂牌价与阶梯价。'));
      } else if (e.netRmb < -0.005) {
        items.push(item('loss', 'block',
          '按最低挂牌价卖仍是亏的：每件净亏 ¥' + round(-e.netRmb, 2) + '。',
          '先调价或压成本，再对外报价；这一条不修好不能接单。'));
      } else if (e.marginPct < s.minMarginPct) {
        items.push(item('thin', 'warn',
          '毛利率 ' + e.marginPct + '% 低于底线 ' + s.minMarginPct + '%，一涨价或汇率一动就亏。',
          '与采购确认成本，或把挂牌价上调到留出安全垫。'));
      }

      if (e.marginPct > 300) {
        items.push(item('cost_suspect', 'warn',
          '毛利率 ' + e.marginPct + '%，高得不像真实数据，成本可能少填了运费或配件。',
          '核对成本是否含包装、国内运费与配件。'));
      }
    }

    if (floorUsd > 0 && wallUsd > 0 && floorUsd > wallUsd + 0.005) {
      items.push(item('floor_above_list', 'warn',
        '底价 $' + floorUsd + ' 高于挂牌价 $' + wallUsd + '，数据自相矛盾。',
        '把底价改到不高于挂牌价，否则报价护栏会把挂牌价当上限。'));
    } else if (!(floorUsd > 0) && e.costUnitRmb > 0) {
      items.push(item('no_floor', 'warn',
        '没有登记底价，销售只能凭保本价守线。',
        '在商品资料里补一个最低可接受价。'));
    }

    var level = items.some(function (x) { return x.level === 'block' }) ? 'block'
      : (items.some(function (x) { return x.level === 'warn' }) ? 'warn' : 'ok');

    return {
      productId: p && p.id ? p.id : '',
      sku: p && p.sku ? String(p.sku) : '',
      title: p ? String(p.title || p.titleEn || '') : '',
      level: level,
      codes: items.map(function (x) { return x.code; }),
      items: items,
      reasons: items.filter(function (x) { return x.level !== 'info' }).map(function (x) { return x.text; }),
      action: (items.filter(function (x) { return x.level === 'block' })[0]
        || items.filter(function (x) { return x.level === 'warn' })[0]
        || items[0] || {}).ask || '',
      marginPct: e.marginPct,
      netRmb: e.netRmb,
      breakEvenUsd: e.breakEvenUsd,
      costUnitRmb: e.costUnitRmb,
      listUsd: listUsd,
      floorUsd: floorUsd,
      listPriceUsd: wallUsd,
      dataAgeDays: age,
      /* 这一行含成本与毛利，只能给受保护的数据区用 */
      private: true
    };
  }

  var COUNT_KEYS = ['ok', 'warn', 'block', 'missing_cost', 'missing_price', 'stale',
    'thin', 'loss', 'cost_suspect', 'no_floor', 'floor_above_list', 'age_unknown'];

  /**
   * 全库体检。
   * @param {array} products
   * @param {object} opts {settings, now, staleDays, limit}
   */
  function audit(products, opts) {
    opts = opts || {};
    var s = settingsOf(opts.settings);
    var now = nowOf(opts.now);
    var rows = (products || []).map(function (p) {
      return checkOne(p, s, { now: now, staleDays: opts.staleDays });
    });

    var counts = {};
    COUNT_KEYS.forEach(function (k) { counts[k] = 0; });
    rows.forEach(function (r) {
      counts[r.level] = (counts[r.level] || 0) + 1;
      r.codes.forEach(function (c) { if (counts[c] !== undefined) counts[c]++; });
    });

    var issues = rows.filter(function (r) { return r.level !== 'ok'; })
      .sort(function (a, b) {
        var d = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
        if (d) return d;
        return a.marginPct - b.marginPct;
      });

    var limit = Math.max(1, num(opts.limit, 50));
    var blockIssues = issues.filter(function (r) { return r.level === 'block'; });
    var topActions = [];
    var seen = {};
    blockIssues.concat(issues.filter(function (r) { return r.level === 'warn' })).forEach(function (r) {
      var first = r.items.filter(function (x) { return x.level === r.level; })[0];
      if (!first || seen[first.code]) return;
      seen[first.code] = true;
      topActions.push({ code: first.code, level: first.level, text: first.text, ask: first.ask, sku: r.sku });
    });

    var summary = {
      total: rows.length,
      block: counts.block,
      warn: counts.warn,
      ok: counts.ok,
      missingCost: counts.missing_cost,
      loss: counts.loss,
      thin: counts.thin,
      stale: counts.stale,
      suspect: counts.cost_suspect,
      text: counts.block + ' 个 SKU 不能直接报价，' + counts.warn + ' 个需要复核，' + counts.ok + ' 个正常。'
    };

    /* 不含任何金额，可安全投影到看板 */
    return {
      ok: true,
      at: now,
      total: rows.length,
      counts: counts,
      summary: summary,
      rows: rows,
      issues: issues.slice(0, limit),
      topActions: topActions.slice(0, 8),
      needsReview: issues.filter(function (r) {
        return r.codes.indexOf('missing_cost') >= 0 || r.codes.indexOf('age_unknown') >= 0;
      }).map(function (r) {
        return { sku: r.sku, code: r.codes[0], ask: r.action };
      }).slice(0, 200),
      note: 'rows/issues 含成本与毛利，只允许在受保护的数据区展示；summary 可安全用于看板。'
    };
  }

  /* 成本中心的分组清单：按"先修哪个"排好序，直接渲染成动作列表 */
  function queue(products, opts) {
    var r = audit(products, opts);
    var groups = [
      { key: 'missing_cost', title: '缺成本（不能报价）', rows: [] },
      { key: 'loss', title: '卖就亏（必须调价或压成本）', rows: [] },
      { key: 'thin', title: '毛利偏薄（需复核）', rows: [] },
      { key: 'stale', title: '成本过期（需复审）', rows: [] },
      { key: 'cost_suspect', title: '成本异常偏低（需核对）', rows: [] },
      { key: 'data', title: '价格/底价数据矛盾', rows: [] }
    ];
    r.issues.forEach(function (row) {
      var hit = null;
      if (row.codes.indexOf('missing_cost') >= 0) hit = 'missing_cost';
      else if (row.codes.indexOf('loss') >= 0) hit = 'loss';
      else if (row.codes.indexOf('thin') >= 0) hit = 'thin';
      else if (row.codes.indexOf('stale') >= 0) hit = 'stale';
      else if (row.codes.indexOf('cost_suspect') >= 0) hit = 'cost_suspect';
      else hit = 'data';
      groups.filter(function (g) { return g.key === hit; })[0].rows.push(row);
    });
    return {
      ok: true,
      at: r.at,
      summary: r.summary,
      counts: r.counts,
      groups: groups.filter(function (g) { return g.rows.length > 0 }),
      note: r.note
    };
  }

  root.P0Cost = {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    audit: audit,
    checkOne: checkOne,
    queue: queue,
    economicsOf: economicsOf,
    lowestListUsd: lowestListUsd,
    ageDaysOf: ageDaysOf
  };
})();