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
  customPresets = Array.isArray(s.presets) ? s.presets : [];
  renderPresets();
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

// ---------- 自定义预设（公司中转站等） ----------

const BUILTIN_PRESETS = Array.from(document.querySelectorAll('#presetList button[data-base]'))
  .map(b => ({ name: b.textContent, baseUrl: b.dataset.base, model: b.dataset.model }));

let customPresets = []; // 从设置里加载

function renderPresets() {
  const list = $('presetList');
  // 移除旧的自定义按钮，保留内置按钮和"＋ 自定义"
  list.querySelectorAll('span.custom-preset').forEach(b => b.remove());
  const addBtn = $('addPresetBtn');
  customPresets.forEach((p, idx) => {
    const wrap = document.createElement('span');
    wrap.className = 'custom-preset';
    wrap.style.cssText = 'display:inline-flex;align-items:center;border:1px dashed #d0d4da;border-radius:999px;overflow:hidden;';
    const btn = document.createElement('button');
    btn.textContent = p.name;
    btn.style.cssText = 'border:none;background:transparent;padding:3px 4px 3px 12px;font-size:12px;cursor:pointer;color:#57606a;font-family:inherit;';
    btn.title = p.baseUrl + ' · ' + p.model;
    btn.addEventListener('click', () => {
      $('baseUrl').value = p.baseUrl;
      $('model').value = p.model;
    });
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除该预设';
    del.style.cssText = 'border:none;background:transparent;padding:3px 10px 3px 4px;font-size:13px;cursor:pointer;color:#c62828;font-family:inherit;';
    del.addEventListener('click', async () => {
      customPresets.splice(idx, 1);
      await savePresets();
      renderPresets();
    });
    wrap.appendChild(btn);
    wrap.appendChild(del);
    list.insertBefore(wrap, addBtn);
  });
}

async function savePresets() {
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { presets: customPresets } });
}

$('addPresetBtn').addEventListener('click', () => {
  const form = $('presetForm');
  form.style.display = form.style.display === 'none' ? '' : 'none';
  $('pName').value = '';
  $('pBase').value = '';
  $('pModel').value = '';
});

$('pCancel').addEventListener('click', () => { $('presetForm').style.display = 'none'; });

$('pSave').addEventListener('click', async () => {
  const name = $('pName').value.trim();
  const baseUrl = $('pBase').value.trim().replace(/\/+$/, '');
  const models = $('pModel').value.split(',').map(m => m.trim()).filter(Boolean);
  if (!baseUrl || !models.length) {
    setStatus($('saveStatus'), '❌ 请至少填写 API 地址和模型名称', false);
    setTimeout(() => { $('saveStatus').textContent = ''; }, 3000);
    return;
  }
  const displayName = name || ('自定义 ' + (customPresets.length + 1));
  models.forEach((m, i) => {
    customPresets.push({
      name: models.length > 1 ? `${displayName}·${m}` : displayName,
      baseUrl,
      model: m
    });
  });
  await savePresets();
  renderPresets();
  $('presetForm').style.display = 'none';
  setStatus($('saveStatus'), '✓ 预设已保存，点击预设标签即可填入', true);
  setTimeout(() => { $('saveStatus').textContent = ''; }, 3000);
});

document.querySelectorAll('.preset button[data-base]').forEach(btn => {
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
