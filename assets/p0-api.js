/* ===========================================================
   p0-api.js — 前端访问受保护数据的唯一通道（模块 E）
   作用：把"成本/底价"这类数据钉死在服务端，前端只通过会话接口取。
   规则：
     1. 只调用 /api/*，绝不从 localStorage / seed-state 兜底成本；
     2. 401 / 503 一律抛 auth_required，由 UI 引导登录，不做任何降级；
     3. 所有请求 credentials:'same-origin'，走 __Host-copilot cookie；
     4. 不把响应内容拼进 innerHTML，也不写进 URL。
   全局暴露：window.P0Api
   =========================================================== */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var BASE = '/api';
  var impl = null;

  function fetchImpl() {
    if (impl) return impl;
    if (typeof root.fetch === 'function') return root.fetch.bind(root);
    throw err('network', 0, '浏览器不支持 fetch，无法访问服务端数据。');
  }

  function configure(opts) {
    if (opts && typeof opts.fetch === 'function') impl = opts.fetch;
    if (opts && typeof opts.base === 'string' && opts.base) BASE = opts.base.replace(/\/+$/, '');
    return api;
  }

  function err(code, status, message) {
    var e = new Error(message || code);
    e.code = code;
    e.status = status || 0;
    return e;
  }

  function authError(status) {
    return status === 503
      ? err('auth_required', status, '服务端未配置登录密钥（SESSION_SECRET / AUTH_PASSWORD_HASH），成本数据接口暂不可用。')
      : err('auth_required', status, '需要老板登录才能查看成本与底价。');
  }

  function request(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' }
    };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var f = fetchImpl();
    return Promise.resolve(f(BASE + path, init)).then(function (res) {
      var status = res && res.status ? res.status : 0;
      if (status === 401 || status === 503) throw authError(status);
      if (!res || !res.ok) {
        if (status === 404) throw err('not_found', status, '接口不存在。');
        if (status === 409) throw err('version_conflict', status, '数据已被别处修改，请刷新后重试。');
        if (status === 400) throw err('bad_request', status, '请求被服务端拒绝，请检查字段。');
        throw err('http_error', status, '服务端返回 ' + status + '。');
      }
      return res.json().catch(function () {
        throw err('bad_response', status, '服务端返回的不是合法 JSON。');
      });
    }, function (e) {
      throw err('network', 0, '网络请求失败：' + (e && e.message ? e.message : '未知原因'));
    });
  }

  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  /* 公开目录：不需要登录，只含白名单字段 */
  function catalog(opts) {
    opts = opts || {};
    return request('/catalog' + qs({ q: opts.q, offset: opts.offset, limit: opts.limit })).then(function (d) {
      return {
        ok: true,
        count: d.count,
        total: d.total,
        offset: d.offset,
        updatedAt: d.updatedAt,
        products: d.products || []
      };
    });
  }

  /* 登录后才可读：含成本、底价 */
  function products() {
    return request('/products').then(function (d) {
      return {
        ok: true,
        count: d.count,
        total: d.total,
        updatedAt: d.updatedAt,
        products: d.products || []
      };
    });
  }

  /* 改成本/底价：必须带 version，服务端做并发保护并写审计 */
  function patchProduct(sku, patch, version) {
    if (!sku) return Promise.reject(err('bad_request', 0, '缺少 sku。'));
    var body = { sku: String(sku), patch: patch || {} };
    if (version !== undefined && version !== null) body.version = version;
    return request('/products', { method: 'PATCH', body: body }).then(function (d) {
      return { ok: true, product: d.product, version: d.product && d.product.version };
    });
  }

  /* UI 用：把异常翻译成一句人话 + 是否需要登录 */
  function describe(e) {
    var code = (e && e.code) || 'unknown';
    if (code === 'auth_required') return { code: code, needLogin: true, text: (e && e.message) || '需要登录' };
    return { code: code, needLogin: false, text: (e && e.message) || '请求失败' };
  }

  var api = {
    VERSION: VERSION,
    configure: configure,
    catalog: catalog,
    products: products,
    patchProduct: patchProduct,
    describe: describe
  };

  root.P0Api = api;
})(typeof window !== 'undefined' ? window : this);