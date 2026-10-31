/* ===========================================================
   translate.js — 询盘翻译（任意语种 → 中文）
   数据源：MyMemory 公共接口（免费、支持跨域、上限 500 字符/次）
   要点：
   - 超过 500 字符自动切段，长句按词硬切
   - 严格校验返回，接口报错（限额/超长）不会当成译文显示
   - 结果本地缓存，同一段只翻一次
   - 失败重试 1 次；额度用完当天不再请求
   全局暴露：window.Translate
   =========================================================== */
(function () {
  'use strict';

  var CACHE_KEY = 'ali_tr_cache_v2';
  var QUOTA_KEY = 'ali_tr_quota_day';
  var MAX_CHARS = 480;          /* 接口上限 500，留点余量 */
  var RETRY = 1;

  /* ---------------- 缓存 ---------------- */

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveCache(c) {
    try {
      var keys = Object.keys(c);
      if (keys.length > 1000) keys.slice(0, 400).forEach(function (k) { delete c[k]; });
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (e) { }
  }

  /* 简单哈希，做缓存 key（避免长文本当 key） */
  function hash(s) {
    var h = 5381, i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  function quotaExhausted() {
    return localStorage.getItem(QUOTA_KEY) === today();
  }
  function markQuota() {
    try { localStorage.setItem(QUOTA_KEY, today()); } catch (e) { }
  }

  /* ---------------- 语种判断 ---------------- */

  function detect(text) {
    var s = String(text || '');
    if (/[\u0400-\u04FF]/.test(s)) return 'ru';
    if (/[\u0600-\u06FF]/.test(s)) return 'ar';
    if (/[\uAC00-\uD7AF]/.test(s)) return 'ko';
    if (/[\u3040-\u30FF]/.test(s)) return 'ja';
    if (/[\u0590-\u05FF]/.test(s)) return 'he';
    if (/[\u0E00-\u0E7F]/.test(s)) return 'th';
    if (/[\u0900-\u097F]/.test(s)) return 'hi';
    return 'en';
  }

  /* 中英混排时，只要英文占比够高就还值得译 */
  function needsTranslation(text, to) {
    var s = String(text || '');
    if (to !== 'zh-CN') return detect(s) !== to;
    var cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    var latin = (s.match(/[A-Za-z]/g) || []).length;
    if (latin === 0) return false;
    if (cjk === 0) return true;
    return latin / (latin + cjk * 2) > 0.35;
  }

  /* ---------------- 切段 ---------------- */

  function hardWrap(s) {
    var out = [], cur = '';
    String(s).split(/(\s+)/).forEach(function (piece) {
      /* 单个「词」本身就超长（比如一串没有空格的型号），按字符硬切 */
      if (piece.length > MAX_CHARS) {
        if (cur.trim()) { out.push(cur.trim()); cur = ''; }
        for (var i = 0; i < piece.length; i += MAX_CHARS) {
          out.push(piece.slice(i, i + MAX_CHARS));
        }
        return;
      }
      if ((cur + piece).length > MAX_CHARS) {
        if (cur.trim()) out.push(cur.trim());
        cur = piece;
      } else {
        cur += piece;
      }
    });
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function splitChunks(text) {
    var s = String(text || '').trim();
    if (!s) return [];
    if (s.length <= MAX_CHARS) return [s];

    var parts = s.split(/(?<=[.!?。！？;；\n])\s*/);
    var out = [], buf = '';

    parts.forEach(function (p) {
      if (p.length > MAX_CHARS) {
        if (buf.trim()) { out.push(buf.trim()); buf = ''; }
        hardWrap(p).forEach(function (x) { out.push(x); });
        return;
      }
      if ((buf + ' ' + p).trim().length > MAX_CHARS) {
        if (buf.trim()) out.push(buf.trim());
        buf = p;
      } else {
        buf = (buf + ' ' + p).trim();
      }
    });
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  /* ---------------- 请求 ---------------- */

  /* 自建 LibreTranslate（可选）：设置里填了地址就优先用它，不限量、不走外网 */
  function endpoint() {
    try {
      var s = window.Core && window.Core.get().settings;
      var set = (s && String(s.translateEndpoint || '').trim()) || '';
      if (set) return set;
    } catch (e) { }
    /* 部署包里的默认地址（本机翻译服务的公网隧道） */
    if (typeof window !== 'undefined' && window.TR_ENDPOINT) {
      return String(window.TR_ENDPOINT).trim();
    }
    return '';
  }

  function requestLibre(base, text, from, to) {
    var url = base.replace(/\/+$/, '') + '/translate';
    var target = to === 'zh-CN' ? 'zh' : to;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: from.split('-')[0], target: target, format: 'text' })
    }).then(function (r) {
      if (!r.ok) throw new Error('自建翻译返回 ' + r.status);
      return r.json();
    }).then(function (j) {
      var t = j && j.translatedText;
      if (!t) throw new Error('自建翻译没有返回译文');
      return String(t).trim();
    });
  }

  /* ---------------- 通义千问（服务端代理） ---------------- */

  /* 以前这里从 localStorage 取 sk-...，带 Authorization 头直接请求 dashscope：
     页面源码、导出备份、随便一个 XSS 就能拿到密钥，等于公开公司的 AI 账号。
     现在密钥只在服务器环境变量 DASHSCOPE_KEY 里，前端只调 /api/ai（要登录）。 */
  var aiBroken = false;

  function qwenReady() { return !aiBroken; }

  /* prompt 必须跟着目标语言走。以前写死「译成简体中文」，
     中译英时千问照样回中文，界面标着英文，一键复制就把中文发给了外国客户。 */
  function qwenPrompt(to) {
    var t = String(to || 'zh-CN');
    var rule = '要求：型号、数字、单位、贸易术语（FOB/CIF/EXW/MOQ/T/T/L/C/CE/RoHS/FCC）保持原样不译；' +
      '语气保持商务口语；只输出译文，不要解释。';
    if (t === 'zh' || t === 'zh-CN' || t === 'zh-Hans') {
      return '你是外贸业务员的翻译助手。把用户给的原文译成简体中文。' + rule;
    }
    var name = t === 'en' || t === 'en-US' || t === 'en-GB' ? 'English' : t;
    return 'You are a translation assistant for a foreign-trade sales rep. Translate the user text into ' +
      name + '. Keep model numbers, quantities, units and Incoterms unchanged. ' +
      'Business tone. Output only the translation, no explanation.';
  }

  function requestQwen(text, from, to) {
    to = to || 'zh-CN';
    return fetch('/api/ai', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'translate', text: text, to: to })
    }).then(function (r) {
      /* 401/503/404 说明这条路走不通（没登录 / 服务器没配密钥 / 没这个函数），
         本页不再重试，直接退回本地引擎，不让每次翻译都多等一个失败请求。 */
      if (r.status === 401 || r.status === 503 || r.status === 404) aiBroken = true;
      if (!r.ok) throw new Error('ai ' + r.status);
      return r.json();
    }).then(function (j) {
      var t = j && j.text;
      if (!t) throw new Error('ai empty');
      return String(t).trim();
    });
  }

  /* ---------------- 浏览器自带翻译引擎（离线、不限量） ---------------- */

  var builtin = { map: {}, failed: false };

  function builtinSupported() {
    return typeof self !== 'undefined' && self.Translator && typeof self.Translator.create === 'function';
  }

  function builtinGet(from, to, onProgress) {
    var key = from.split('-')[0] + '>' + to.split('-')[0];
    if (builtin.map[key]) return Promise.resolve(builtin.map[key]);
    if (builtin.failed) return Promise.reject(new Error('builtin unavailable'));

    return self.Translator.create({
      sourceLanguage: from.split('-')[0],
      targetLanguage: to.split('-')[0],
      monitor: function (m) {
        if (m && m.addEventListener) {
          m.addEventListener('downloadprogress', function (e) {
            if (onProgress) onProgress(e.loaded || 0, e.total || 0);
          });
        }
      }
    }).then(function (t) {
      builtin.map[key] = t;
      return t;
    }).catch(function (e) {
      builtin.failed = true;
      throw e;
    });
  }

  /* 部署在 Netlify 上时，走同源的 /api/tr 函数代理（不限量、自动缓存） */
  var fnBroken = false;

  function canUseFn() {
    if (fnBroken) return false;
    if (typeof location === 'undefined') return false;
    return /^https?:$/.test(location.protocol);
  }

  function requestFn(text, from, to) {
    var url = '/api/tr?q=' + encodeURIComponent(text) +
      '&from=' + encodeURIComponent(from.split('-')[0]) +
      '&to=' + encodeURIComponent(to === 'zh-CN' ? 'zh' : to);
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('proxy ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.text) throw new Error('proxy empty');
      return String(j.text).trim();
    });
  }

  function requestAny(text, from, to) {
    /* 0) 服务端通义千问：质量最好；没登录/没配密钥会自动降级 */
    if (qwenReady()) {
      return requestQwen(text, from, to).catch(function () { return fallbackChain(text, from, to); });
    }
    return fallbackChain(text, from, to);
  }

  function fallbackChain(text, from, to) {
    /* 1) 浏览器自带引擎：本机算，离线可用，不限量 */
    if (builtinSupported()) {
      return builtinGet(from, to, function (loaded, total) {
        if (window.Translate && window.Translate.onDownload) {
          window.Translate.onDownload(loaded, total);
        }
      }).then(function (t) { return t.translate(text); })
        .catch(function () { return afterBuiltin(text, from, to); });
    }
    return afterBuiltin(text, from, to);
  }

  function afterBuiltin(text, from, to) {
    /* 2) 自建/隧道服务  3) 免费接口 */
    if (!canUseFn()) return requestMyMemory(text, from, to);
    return requestFn(text, from, to).catch(function () {
      fnBroken = true;
      return requestMyMemory(text, from, to);
    });
  }

  function request(text, from, to) {
    var base = endpoint();
    if (base) {
      /* 自建服务挂了就退回代理/免费接口，不让翻译彻底失效 */
      return requestLibre(base, text, from, to).catch(function () {
        return requestAny(text, from, to);
      });
    }
    return requestAny(text, from, to);
  }

  function requestMyMemory(text, from, to) {
    var url = 'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(text) + '&langpair=' + encodeURIComponent(from + '|' + to);

    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, json: j }; });
    }).then(function (res) {
      var j = res.json || {};
      var details = String(j.responseDetails || '');
      var status = String(j.responseStatus);

      if (/ALL AVAILABLE FREE TRANSLATIONS|USED ALL/i.test(details)) {
        markQuota();
        throw new Error('今日免费翻译额度已用完，明天再试');
      }
      if (/QUERY LENGTH LIMIT/i.test(details) || /QUERY LENGTH LIMIT/i.test(String(j.responseData && j.responseData.translatedText))) {
        throw new Error('这段太长，超过翻译接口上限');
      }
      if (status !== '200' && res.status !== 200) {
        throw new Error('翻译接口返回 ' + (res.status || status));
      }

      var t = j.responseData && j.responseData.translatedText;
      if (!t) throw new Error('接口没有返回译文');
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(t)) {
        throw new Error(t.slice(0, 60));
      }
      return String(t).trim();
    });
  }

  function requestWithRetry(text, from, to, attempt) {
    attempt = attempt || 0;
    return request(text, from, to).catch(function (err) {
      if (attempt >= RETRY) throw err;
      if (/额度|上限|INVALID/i.test(err.message)) throw err;
      return new Promise(function (r) { setTimeout(r, 500); })
        .then(function () { return requestWithRetry(text, from, to, attempt + 1); });
    });
  }

  /**
   * 翻译整段。
   * @param input 原文
   * @param to    目标语，默认 zh-CN
   * @param onDone (err, {text, from, to, cached, partial})
   * @param onProgress (doneChunks, totalChunks, partialText)
   */
  function text(input, to, onDone, onProgress) {
    to = to || 'zh-CN';
    var src = String(input || '').trim();
    if (!src) { onDone(null, { text: '', from: '', to: to }); return; }

    var from = detect(src);
    if (!needsTranslation(src, to)) {
      onDone(null, { text: src, from: from, to: to, same: true });
      return;
    }

    if (quotaExhausted()) {
      onDone(new Error('今日免费翻译额度已用完，明天再试'), { text: '', from: from, to: to });
      return;
    }

    var cache = loadCache();
    var key = from + '>' + to + ':' + hash(src) + ':' + src.length;
    if (cache[key]) {
      onDone(null, { text: cache[key], from: from, to: to, cached: true });
      return;
    }

    var chunks = splitChunks(src);
    var results = [];
    var i = 0;

    function next() {
      if (i >= chunks.length) {
        var joined = results.join(' ').replace(/\s+([，。；！？])/g, '$1');
        cache[key] = joined;
        saveCache(cache);
        onDone(null, { text: joined, from: from, to: to });
        return;
      }
      requestWithRetry(chunks[i], from, to)
        .then(function (t) {
          results.push(t);
          i++;
          if (onProgress) onProgress(i, chunks.length, results.join(' '));
          setTimeout(next, 150);
        })
        .catch(function (err) {
          onDone(err, { text: '', from: from, to: to, partial: results.join(' ') });
        });
    }
    next();
  }

  window.Translate = {
    endpoint: endpoint,
    qwenReady: function () { return qwenReady(); },
    builtinSupported: builtinSupported,
    prepareBuiltin: function (from, to, onProgress) { return builtinGet(from || 'en', to || 'zh-CN', onProgress); },
    builtinReady: function () { return Object.keys(builtin.map).length > 0; },
    detect: detect,
    needsTranslation: needsTranslation,
    splitChunks: splitChunks,
    text: text,
    quotaExhausted: quotaExhausted,
    clearCache: function () {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(QUOTA_KEY);
    }
  };
})();
