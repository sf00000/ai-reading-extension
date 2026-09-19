// AI 翻译助手 - 内容脚本
// 悬浮窗（可拖动）、划词翻译/总结、整页段落级双语翻译

(() => {
  if (window.__aitrInjected) return;
  window.__aitrInjected = true;

  const LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];

  // ---------- 悬浮窗 ----------

  let panelHost = null;
  let panelState = { mode: 'translate', text: '', lang: '', running: false };

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .wrap {
      width: 400px; max-width: 92vw;
      background: #ffffff; color: #24292f;
      border-radius: 12px; overflow: hidden;
      box-shadow: 0 8px 32px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.06);
      font-size: 14px;
    }
    .hdr {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 12px; background: #4f5ce5; color: #fff;
      cursor: move; user-select: none;
    }
    .hdr .ttl { font-weight: 600; font-size: 13px; }
    .hdr .spacer { flex: 1; }
    .hdr select {
      font-size: 12px; padding: 2px 4px; border-radius: 6px;
      border: none; background: rgba(255,255,255,.22); color: #fff; cursor: pointer;
    }
    .hdr select option { color: #24292f; background: #fff; }
    .hdr button {
      border: none; background: rgba(255,255,255,.22); color: #fff;
      width: 22px; height: 22px; border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1;
    }
    .hdr button:hover { background: rgba(255,255,255,.36); }
    .tabs { display: flex; border-bottom: 1px solid #e6e8ec; background: #f7f8fa; }
    .tabs button {
      flex: 1; border: none; background: transparent; padding: 8px 0;
      font-size: 13px; color: #57606a; cursor: pointer; border-bottom: 2px solid transparent;
    }
    .tabs button.active { color: #4f5ce5; border-bottom-color: #4f5ce5; font-weight: 600; }
    .body { max-height: 46vh; overflow: auto; padding: 12px 14px; }
    .content { font-size: 14px; line-height: 1.7; word-break: break-word; white-space: pre-wrap; }
    .content code { background: #f0f1f3; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
    .loading { color: #57606a; display: flex; align-items: center; gap: 8px; }
    .spin {
      width: 14px; height: 14px; border: 2px solid #d0d4da; border-top-color: #4f5ce5;
      border-radius: 50%; animation: r 0.8s linear infinite;
    }
    @keyframes r { to { transform: rotate(360deg); } }
    .error { color: #c62828; }
    .ftr {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-top: 1px solid #e6e8ec; background: #f7f8fa;
    }
    .ftr .meta { font-size: 12px; color: #8b949e; }
    .ftr .spacer { flex: 1; }
    .ftr button {
      border: 1px solid #d0d4da; background: #fff; color: #24292f;
      border-radius: 6px; padding: 3px 12px; font-size: 12px; cursor: pointer;
    }
    .ftr button:hover { border-color: #4f5ce5; color: #4f5ce5; }
  `;

  function ensurePanel() {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'aitr-panel-host';
    panelHost.style.cssText = 'position:fixed; z-index:2147483647; top:90px; right:48px;';
    const sh = panelHost.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="wrap">
        <div class="hdr">
          <span class="ttl">🤖 AI 翻译助手</span>
          <span class="spacer"></span>
          <select class="lang" title="目标语言（切换后自动重新执行）"></select>
          <button class="close" title="关闭">×</button>
        </div>
        <div class="tabs">
          <button class="tab" data-mode="translate">翻译</button>
          <button class="tab" data-mode="summary">总结</button>
        </div>
        <div class="body"><div class="content"></div></div>
        <div class="ftr">
          <span class="meta"></span>
          <span class="spacer"></span>
          <button class="copy">复制</button>
          <button class="rerun">重新执行</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panelHost);

    // 语言下拉
    const sel = sh.querySelector('.lang');
    LANGS.forEach(l => {
      const o = document.createElement('option');
      o.value = l; o.textContent = l;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      panelState.lang = sel.value;
      panelState.langTouched = true; // 用户手动选过语言，之后不再被设置页覆盖
      if (panelState.text) runPanel();
    });

    sh.querySelector('.close').addEventListener('click', () => { panelHost.style.display = 'none'; });

    sh.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        sh.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panelState.mode = btn.dataset.mode;
        runPanel();
      });
    });

    sh.querySelector('.rerun').addEventListener('click', () => { if (panelState.text) runPanel(); });
    sh.querySelector('.copy').addEventListener('click', async () => {
      const txt = panelState.result || '';
      if (!txt) return;
      try { await navigator.clipboard.writeText(txt); setMeta('已复制'); }
      catch (e) { setMeta('复制失败，请手动选择文本'); }
    });

    // 拖动
    const wrap = sh.querySelector('.wrap');
    const hdr = sh.querySelector('.hdr');
    let dragging = null;
    hdr.addEventListener('pointerdown', (e) => {
      if (e.target.closest('select,button')) return;
      const rect = panelHost.getBoundingClientRect();
      dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      hdr.setPointerCapture(e.pointerId);
    });
    hdr.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - dragging.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - dragging.dy));
      panelHost.style.left = x + 'px';
      panelHost.style.top = y + 'px';
      panelHost.style.right = 'auto';
    });
    hdr.addEventListener('pointerup', () => { dragging = null; });
  }

  function setContent(html) {
    panelHost.shadowRoot.querySelector('.content').innerHTML = html;
    panelHost.shadowRoot.querySelector('.body').scrollTop = 0;
  }
  function setMeta(t) { panelHost.shadowRoot.querySelector('.meta').textContent = t; }
  function setActiveTab(mode) {
    panelHost.shadowRoot.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  }

  function renderResult(t) {
    const esc = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  async function runPanel() {
    const { mode, text, lang } = panelState;
    if (!text || panelState.running) return;
    panelState.running = true;
    setActiveTab(mode);
    setContent(`<div class="loading"><span class="spin"></span>${mode === 'summary' ? '正在总结…' : '正在翻译…'}</div>`);
    setMeta('');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'TR_TEXT', mode, text, lang, url: location.href });
      if (!resp || !resp.ok) throw new Error(resp && resp.error || '请求失败');
      panelState.result = resp.result;
      setContent(renderResult(resp.result));
      setMeta((resp.cached ? '来自缓存 ⚡ · ' : '') + new Date().toLocaleTimeString());
    } catch (e) {
      panelState.result = '';
      setContent(`<div class="error">❌ ${String(e.message || e)}</div>`);
      setMeta('');
    } finally {
      panelState.running = false;
    }
  }

  async function showPanel(text, mode) {
    ensurePanel();
    panelHost.style.display = '';
    panelState.text = text;
    panelState.result = '';
    panelState.mode = mode || 'translate';
    if (!panelState.langTouched || !panelState.lang) {
      // 未手动选过语言时，每次打开都按模式从设置取最新值
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        const s = resp?.settings;
        if (s) {
          panelState.lang = (mode === 'summary')
            ? (s.summary?.lang || s.targetLang)
            : (s.targetLang || '简体中文');
        }
      } catch (e) { /* 保底 */ }
      panelState.lang = panelState.lang || '简体中文';
    }
    panelHost.shadowRoot.querySelector('.lang').value = panelState.lang;
    runPanel();
  }

  // ---------- 划词 ----------

  function getSelectionText() {
    return (window.getSelection ? String(window.getSelection()) : '').trim();
  }

  // ---------- 整页翻译 ----------

  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th,caption,summary';
  const INS_STYLE = 'display:block;margin:4px 0 12px;padding:4px 10px;border-left:3px solid rgba(99,102,241,.8);background:rgba(99,102,241,.07);border-radius:0 6px 6px 0;font-size:.95em;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:inherit;';

  function shouldSkip(text, lang) {
    if (text.length < 2) return true;
    const hasKana = /[\u3040-\u30ff\u31f0-\u31ff]/.test(text);          // 日文假名
    const hasHangul = /[\uac00-\ud7af\u1100-\u11ff]/.test(text);        // 韩文谚文
    const hanCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;     // 中日共通汉字
    // 纯 ASCII 才视为英文（法语/德语等带重音符号的文字不算，避免被误判跳过）
    const asciiOnly = /^[\x20-\x7E\s\u00A0]*$/.test(text);

    switch (lang) {
      case '简体中文':
      case '繁體中文':
        // 已是中文：汉字为主，且不含假名/谚文（否则日文、韩文页面会被误跳过）
        if (hanCount / text.length > 0.3 && !hasKana && !hasHangul) return true;
        break;
      case '日本語':
        // 已含假名，视为日文原文
        if (hasKana) return true;
        break;
      case '한국어':
        if (hasHangul) return true;
        break;
      case 'English':
        // 仅纯 ASCII（且无汉字/假名/谚文）视为英文原文
        if (asciiOnly && !hasKana && !hasHangul && hanCount === 0) return true;
        break;
    }
    return false;
  }

  function collectCandidates(lang) {
    const out = [];
    const seenText = new Set();
    document.querySelectorAll(BLOCK_SEL).forEach(el => {
      if (el.closest('[data-aitr-ins]') || el.closest('#aitr-panel-host')) return;
      if (el.closest('pre, code, noscript, script, style, textarea, button, a[href^="javascript"]')) return;
      // 含块级子元素的是容器，交给子元素翻译
      if (el.querySelector('p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,div,section,article')) return;
      const cls = (typeof el.className === 'string' ? el.className : '');
      if (/(code|highlight|snippet|comment|reply)/i.test(cls)) return;
      const text = (el.innerText || '').trim();
      if (text.length < 2 || text.length > 5000) return;
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return;
      if (shouldSkip(text, lang)) return;
      if (seenText.has(text)) return;
      seenText.add(text);
      out.push({ el, text });
    });
    return out.slice(0, 400);
  }

  function insertTranslation(el, dst) {
    const n = document.createElement('div');
    n.setAttribute('data-aitr-ins', '1');
    n.setAttribute('style', INS_STYLE);
    n.textContent = dst;
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      el.appendChild(n); // 表格单元格里追加，避免撑坏表格结构
    } else {
      el.after(n);
    }
  }

  // 进度胶囊
  function showPill(text, withRestore) {
    if (!showPill.el || !showPill.el.isConnected) {
      const el = document.createElement('div');
      el.id = 'aitr-pill';
      el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:rgba(30,32,40,.92);color:#fff;font-size:13px;font-family:-apple-system,"PingFang SC",sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);';
      const span = document.createElement('span');
      el.appendChild(span);
      const btn = document.createElement('button');
      btn.textContent = '恢复原文';
      btn.style.cssText = 'border:none;border-radius:999px;padding:2px 10px;font-size:12px;background:#6366f1;color:#fff;cursor:pointer;display:none;';
      btn.addEventListener('click', restorePage);
      el.appendChild(btn);
      document.documentElement.appendChild(el);
      showPill.el = el;
      showPill.span = span;
      showPill.btn = btn;
    }
    showPill.span.textContent = text;
    showPill.btn.style.display = withRestore ? '' : 'none';
    showPill.el.style.display = '';
  }
  function hidePill() {
    if (showPill.el) showPill.el.style.display = 'none';
  }

  let pageState = 'idle';

  async function translatePage() {
    if (pageState === 'running') return;
    if (pageState === 'done' && document.querySelector('[data-aitr-ins]')) { restorePage(); return; }

    let lang = '简体中文';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      lang = resp?.settings?.targetLang || lang;
    } catch (e) {}

    const cands = collectCandidates(lang);
    if (!cands.length) {
      showPill('未找到需要翻译的内容');
      setTimeout(hidePill, 2500);
      return;
    }

    pageState = 'running';
    showPill(`AI 翻译中 0/${cands.length}`);
    const CHUNK = 8;
    for (let i = 0; i < cands.length; i += CHUNK) {
      const slice = cands.slice(i, i + CHUNK);
      showPill(`AI 翻译中 ${i}/${cands.length}`);
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'TR_PAGE_BATCH',
          items: slice.map(c => c.text),
          lang,
          url: location.href
        });
        if (!resp || !resp.ok) throw new Error(resp && resp.error || '请求失败');
        slice.forEach((c, j) => {
          const r = resp.results && resp.results[j];
          if (r) insertTranslation(c.el, r);
        });
      } catch (e) {
        showPill('翻译失败：' + String(e.message || e), true);
        pageState = 'done';
        return;
      }
    }
    pageState = 'done';
    const n = document.querySelectorAll('[data-aitr-ins]').length;
    showPill(`✓ 已翻译 ${n} 段（再次触发可恢复原文）`, true);
  }

  function restorePage() {
    document.querySelectorAll('[data-aitr-ins]').forEach(n => n.remove());
    hidePill();
    pageState = 'idle';
  }

  async function summarizePage() {
    const text = (document.body.innerText || '')
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 12000);
    if (!text.trim()) return;
    await showPanel(text, 'summary');
  }

  // ---------- 消息入口 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'TR_PING':
        sendResponse({ ok: true });
        break;
      case 'TR_SELECTION': {
        const sel = getSelectionText();
        if (!sel) {
          showPanel('', msg.mode || 'translate');
          setContent('<div class="error">请先选中网页上的文字再试。</div>');
        } else {
          showPanel(sel, msg.mode || 'translate');
        }
        sendResponse({ ok: true });
        break;
      }
      case 'TR_PAGE':
        translatePage();
        sendResponse({ ok: true });
        break;
      case 'TR_RESTORE':
        restorePage();
        sendResponse({ ok: true });
        break;
      case 'TR_PAGE_SUMMARY':
        summarizePage();
        sendResponse({ ok: true });
        break;
      case 'TR_STATE':
        sendResponse({ ok: true, state: pageState, count: document.querySelectorAll('[data-aitr-ins]').length });
        break;
      default:
        sendResponse({ ok: false });
    }
    return false;
  });
})();
