/* ===========================================================
   tr-panel.js — 右下角「随时翻译」悬浮面板
   独立文件，不依赖 app.js，任何页面都能用。
   =========================================================== */
(function () {
  'use strict';

  var fab = document.getElementById('tr-fab');
  var panel = document.getElementById('tr-panel');
  var input = document.getElementById('tr-input');
  var output = document.getElementById('tr-output');
  var stateEl = document.getElementById('tr-panel-state');
  var engineEl = document.getElementById('tr-engine');
  if (!fab || !panel || !input) return;

  var timer = null;
  var lastText = '';

  /* 浏览器本地引擎首次使用要下载模型，这里显示进度 */
  if (window.Translate) {
    window.Translate.onDownload = function (loaded, total) {
      if (!total) { setState('正在准备本地引擎…', '#b7791f'); return; }
      var pct = Math.min(99, Math.round(loaded / total * 100));
      setState('正在下载本地引擎 ' + pct + '%（只需一次）', '#b7791f');
    };
  }

  function setState(text, color) {
    if (!stateEl) return;
    stateEl.textContent = text;
    stateEl.style.color = color || '#8a919e';
  }

  function open() {
    panel.hidden = false;
    fab.classList.add('active');
    setTimeout(function () { input.focus(); }, 50);
  }

  function close() {
    panel.hidden = true;
    fab.classList.remove('active');
  }

  function translate(text) {
    if (!text || !window.Translate) return;

    var lang = window.Translate.detect(text);
    if (!window.Translate.needsTranslation(text, 'zh-CN')) {
      output.textContent = text;
      setState('已经是中文', '#8a919e');
      return;
    }

    setState('翻译中…', '#b7791f');
    output.textContent = '';

    window.Translate.text(text, 'zh-CN', function (err, res) {
      if (err) {
        setState('失败：' + err.message, '#d92d20');
        output.textContent = '';
        return;
      }
      output.textContent = res.text;
      setState('译好了（' + lang + ' → 中文）', '#0f9d58');
    }, function (done, total, partial) {
      if (partial) output.textContent = partial;
      setState('翻译中 ' + done + '/' + total, '#b7791f');
    });
  }

  fab.addEventListener('click', function () {
    if (panel.hidden) open(); else close();
  });

  document.getElementById('tr-panel-close').addEventListener('click', close);

  input.addEventListener('input', function () {
    var text = input.value.trim();
    if (text === lastText) return;
    lastText = text;
    if (timer) clearTimeout(timer);
    if (!text) { output.textContent = ''; setState('粘贴外文，自动译成中文'); return; }
    timer = setTimeout(function () { translate(text); }, 500);
  });

  /* 粘贴后立刻翻，不等 */
  input.addEventListener('paste', function () {
    setTimeout(function () {
      lastText = input.value.trim();
      if (lastText) translate(lastText);
    }, 60);
  });

  document.getElementById('tr-copy').addEventListener('click', function () {
    var t = output.textContent || '';
    if (!t) return;
    var btn = this;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(t).then(function () {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制译文'; }, 1500);
      });
    }
  });

  document.getElementById('tr-clear').addEventListener('click', function () {
    input.value = '';
    output.textContent = '';
    lastText = '';
    setState('粘贴外文，自动译成中文');
    input.focus();
  });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
      e.preventDefault();
      if (panel.hidden) open(); else close();
    }
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  /* 离线引擎：必须由用户点击才允许下载 */
  function renderEngine() {
    if (!engineEl) return;
    var T = window.Translate;
    if (!T) return;

    if (T.qwenReady && T.qwenReady()) {
      engineEl.innerHTML = '<span style="color:#0f9d58">通义千问 · 已接入</span>';
      return;
    }
    if (T.builtinReady && T.builtinReady()) {
      engineEl.innerHTML = '<span style="color:#0f9d58">本地引擎 · 离线可用 · 不限量</span>';
      return;
    }
    if (T.builtinSupported && T.builtinSupported()) {
      engineEl.innerHTML = '<button id="tr-enable-offline" class="btn sm" type="button" ' +
        'style="padding:3px 8px;font-size:11px">启用离线翻译</button>';
      var btn = document.getElementById('tr-enable-offline');
      if (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = '准备中…';
          T.prepareBuiltin('en', 'zh-CN', function (loaded, total) {
            var pct = total ? Math.min(99, Math.round(loaded / total * 100)) : 0;
            btn.textContent = total ? ('下载 ' + pct + '%') : '准备中…';
          }).then(function () {
            btn.textContent = '已启用';
            renderEngine();
            setState('本地引擎已就绪，可以离线翻译', '#0f9d58');
          }).catch(function (e) {
            btn.disabled = false;
            btn.textContent = '启用离线翻译';
            setState('本地引擎不可用：' + (e.message || '').slice(0, 40), '#d92d20');
          });
        });
      }
      return;
    }
    engineEl.textContent = '免费接口 · 每天约 1000 字';
    engineEl.style.color = '#8a919e';
  }

  renderEngine();
})();

/* 注册 Service Worker：第二次打开即使断网也能用 */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { });
  });
}