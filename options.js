// AI 翻译助手 - 设置页逻辑（模型列表管理版）

const LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];
const DEFAULT_PROMPT = `请使用{{lang}}总结以下内容。要求：
1. 先用一两句话概括核心主题；
2. 列出 3~6 个要点，尽量保留关键数据、名词与结论；
3. 如有行动建议或风险提示，单独列出。
直接输出总结，不要复述原文。

{{text}}`;

const $ = (id) => document.getElementById(id);

let models = [];        // [{id, name, baseUrl, model, key}]
let activeModelId = ''; // 默认模型 id
let editingId = null;   // 正在编辑的模型 id（null = 新增）

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function uid() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = 'status ' + (ok ? 'ok' : 'err');
}

function flash(el, text) {
  setStatus(el, text, true);
  setTimeout(() => { el.textContent = ''; }, 2500);
}

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

// ---------- 模型列表 ----------

function activeModel() {
  return models.find(m => m.id === activeModelId) || models[0] || null;
}

async function persistModels() {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: { models, activeModelId, llmMigrated: true }
  });
}

function renderModels() {
  const list = $('modelList');
  list.innerHTML = '';
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'tip';
    empty.textContent = '还没有添加模型，点下方「快速添加」或「＋ 自定义模型」开始。';
    list.appendChild(empty);
    return;
  }
  models.forEach(m => {
    const row = document.createElement('div');
    row.className = 'model-row' + (m.id === activeModelId ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'minfo';
    info.innerHTML = `
      <div class="mname">${esc(m.name || m.model)}<span class="mmodel">${esc(m.model)}</span>${m.id === activeModelId ? '<span class="badge">默认</span>' : ''}</div>
      <div class="murl">${esc(m.baseUrl)}</div>
      <div class="mkey${m.key ? '' : ' warn'}">${m.key ? '✓ Key 已配置' : '⚠ 未配置 Key'}</div>`;
    row.appendChild(info);

    if (m.id !== activeModelId) {
      const bUse = document.createElement('button');
      bUse.textContent = '设为默认';
      bUse.addEventListener('click', async () => {
        activeModelId = m.id;
        await persistModels();
        renderModels();
        flash($('saveStatus'), `✓ 已将「${m.name || m.model}」设为默认模型`);
      });
      row.appendChild(bUse);
    }

    const bEdit = document.createElement('button');
    bEdit.textContent = '编辑';
    bEdit.addEventListener('click', () => openForm(m));
    row.appendChild(bEdit);

    const bDel = document.createElement('button');
    bDel.className = 'del';
    bDel.textContent = '删除';
    bDel.addEventListener('click', async () => {
      if (!confirm(`删除「${m.name || m.model}」？`)) return;
      models = models.filter(x => x.id !== m.id);
      if (activeModelId === m.id) activeModelId = models[0] ? models[0].id : '';
      await persistModels();
      renderModels();
    });
    row.appendChild(bDel);

    list.appendChild(row);
  });
}

function openForm(m) {
  editingId = m && m.id ? m.id : null;
  $('mName').value = m ? (m.name || '') : '';
  $('mBase').value = m ? (m.baseUrl || '') : '';
  $('mModel').value = m ? (m.model || '') : '';
  $('mKey').value = m ? (m.key || '') : '';
  $('mDefault').checked = !editingId; // 新增默认勾选设为默认
  $('modelForm').style.display = '';
  $('mName').focus();
}

function closeForm() {
  $('modelForm').style.display = 'none';
  editingId = null;
}

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

async function saveModelFromForm() {
  const name = $('mName').value.trim();
  const baseUrl = $('mBase').value.trim().replace(/\/+$/, '');
  const model = $('mModel').value.trim();
  const key = $('mKey').value.trim();
  if (!baseUrl || !model) {
    setStatus($('testStatus'), '❌ 请至少填写 API 地址和模型名称', false);
    return;
  }
  const entry = { id: editingId || uid(), name: name || model, baseUrl, model, key };
  const idx = models.findIndex(m => m.id === entry.id);
  if (idx >= 0) models[idx] = entry; else models.push(entry);
  if ($('mDefault').checked || models.length === 1) activeModelId = entry.id;

  await ensureOriginPermission(baseUrl);
  await persistModels();
  renderModels();
  closeForm();
  flash($('saveStatus'), `✓ 已保存「${entry.name}」${activeModelId === entry.id ? '（默认模型）' : ''}`);
}

// ---------- 加载 / 保存 ----------

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = resp.settings;
  fillLangSelect($('targetLang'), false);
  fillLangSelect($('sumLang'), true);
  $('targetLang').value = s.targetLang;
  $('provider').value = s.provider;
  models = Array.isArray(s.models) ? s.models : [];
  activeModelId = s.activeModelId || (models[0] ? models[0].id : '');
  $('sumLang').value = s.summary.lang || '';
  $('sumPrompt').value = s.summary.prompt || DEFAULT_PROMPT;
  renderModels();
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

async function collectSettings() {
  return {
    targetLang: $('targetLang').value,
    provider: $('provider').value,
    models,
    activeModelId,
    llmMigrated: true,
    summary: {
      lang: $('sumLang').value,
      prompt: $('sumPrompt').value
    }
  };
}

$('saveBtn').addEventListener('click', async () => {
  const s = await collectSettings();
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: s });
  flash($('saveStatus'), '✓ 已保存');
});

$('testBtn').addEventListener('click', async () => {
  setStatus($('testStatus'), '测试中…', true);
  const s = await collectSettings();
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: s });
  const active = activeModel();
  if (active && active.baseUrl && active.key) {
    const granted = await ensureOriginPermission(active.baseUrl);
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

// 快速添加：预填表单
document.querySelectorAll('.preset button[data-base]').forEach(btn => {
  btn.addEventListener('click', () => {
    openForm({
      name: btn.dataset.name,
      baseUrl: btn.dataset.base,
      model: btn.dataset.model,
      key: ''
    });
  });
});

$('addModelBtn').addEventListener('click', () => openForm(null));
$('mSave').addEventListener('click', saveModelFromForm);
$('mCancel').addEventListener('click', closeForm);
$('resetPrompt').addEventListener('click', () => { $('sumPrompt').value = DEFAULT_PROMPT; });

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TR_CLEAR_CACHE' });
  refreshCacheInfo();
});

loadSettings();
