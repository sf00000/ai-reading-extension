// AI 翻译助手 - 设置页逻辑

const LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];
const DEFAULT_PROMPT = `请使用{{lang}}总结以下内容。要求：
1. 先用一两句话概括核心主题；
2. 列出 3~6 个要点，尽量保留关键数据、名词与结论；
3. 如有行动建议或风险提示，单独列出。
直接输出总结，不要复述原文。

{{text}}`;

const $ = (id) => document.getElementById(id);

function fillLangSelect(sel, withFollow) {
  sel.innerHTML = '';
  if (withFollow) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '跟随目标语言';
    sel.appendChild(o);
  }
  LANGS.forEach(l => {
    const o = document.createElement('option');
    o.value = l; o.textContent = l;
    sel.appendChild(o);
  });
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = resp.settings;
  fillLangSelect($('targetLang'), false);
  fillLangSelect($('sumLang'), true);
  $('targetLang').value = s.targetLang;
  $('provider').value = s.provider;
  $('baseUrl').value = s.llm.baseUrl;
  $('apiKey').value = s.llm.apiKey;
  $('model').value = s.llm.model;
  $('sumLang').value = s.summary.lang || '';
  $('sumPrompt').value = s.summary.prompt || DEFAULT_PROMPT;
  refreshCacheInfo();
}

async function refreshCacheInfo() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TR_CACHE_INFO' });
    $('cacheInfo').textContent = `当前缓存 ${r.count} 条，约 ${r.sizeKB} KB`;
  } catch (e) {
    $('cacheInfo').textContent = '缓存统计失败';
  }
}

// 请求 API 域名访问授权（MV3 下后台 fetch 需要 host permission）
async function ensureOriginPermission(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin + '/*';
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

async function collectSettings() {
  return {
    targetLang: $('targetLang').value,
    provider: $('provider').value,
    llm: {
      baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim()
    },
    summary: {
      lang: $('sumLang').value,
      prompt: $('sumPrompt').value
    }
  };
}

$('saveBtn').addEventListener('click', async () => {
  const s = await collectSettings();
  if (s.llm.apiKey && s.llm.baseUrl) {
    const granted = await ensureOriginPermission(s.llm.baseUrl);
    if (!granted) {
      setStatus($('saveStatus'), '⚠️ 未授权 API 域名，调用可能被浏览器拦截', false);
    }
  }
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: s });
  setStatus($('saveStatus'), '✓ 已保存', true);
  setTimeout(() => { $('saveStatus').textContent = ''; }, 2500);
});

$('testBtn').addEventListener('click', async () => {
  setStatus($('testStatus'), '测试中…', true);
  const s = await collectSettings();
  // 先保存再测试，保证后台用的是最新配置
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: s });
  if (s.llm.baseUrl && s.llm.apiKey) {
    const granted = await ensureOriginPermission(s.llm.baseUrl);
    if (!granted) {
      setStatus($('testStatus'), '❌ 未授权 API 域名访问', false);
      return;
    }
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TR_TEST' });
    if (r && r.ok) setStatus($('testStatus'), '✓ 连接成功：' + (r.result || '').slice(0, 40), true);
    else setStatus($('testStatus'), '❌ ' + (r && r.error || '失败'), false);
  } catch (e) {
    setStatus($('testStatus'), '❌ ' + e.message, false);
  }
});

document.querySelectorAll('.preset button').forEach(btn => {
  btn.addEventListener('click', () => {
    $('baseUrl').value = btn.dataset.base;
    $('model').value = btn.dataset.model;
  });
});

$('resetPrompt').addEventListener('click', () => {
  $('sumPrompt').value = DEFAULT_PROMPT;
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TR_CLEAR_CACHE' });
  refreshCacheInfo();
});

loadSettings();
