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
let templates = [];     // 总结模板 [{id, name, prompt}]
let activeTplId = '';   // 当前选中的总结模板 id

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
      <div class="mkey${m.key ? '' : ' warn'}">${m.key ? '✓ Key 已配置' : '⚠ 未配置 Key'}</div>
      <div class="mtest status" style="margin-top:2px;"></div>`;
    row.appendChild(info);

    const bTest = document.createElement('button');
    bTest.textContent = '测试';
    bTest.addEventListener('click', () => {
      const st = row.querySelector('.mtest');
      st.textContent = '';
      testModel({ baseUrl: m.baseUrl, model: m.model, key: m.key }, bTest,
        (text, ok) => { st.textContent = text; st.className = 'mtest status ' + (ok ? 'ok' : 'err'); });
    });
    row.appendChild(bTest);

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
  refreshGenModelSelect();
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

// 测试指定的模型配置：cfg = {baseUrl, model, key}
// statusEl 可省略；按钮在测试期间禁用并显示进行中状态
async function testModel(cfg, btn, showResult) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  const finish = () => { if (btn) { btn.disabled = false; btn.textContent = label; } };
  if (!cfg.baseUrl || !cfg.model) {
    finish();
    showResult ? showResult('❌ 请先填写 API 地址和模型名称', false) : null;
    return { ok: false, error: '请先填写 API 地址和模型名称' };
  }
  if (!cfg.key) {
    finish();
    showResult ? showResult('❌ 请先填写 API Key', false) : null;
    return { ok: false, error: '请先填写 API Key' };
  }
  const granted = await ensureOriginPermission(cfg.baseUrl);
  if (!granted) {
    finish();
    showResult ? showResult('❌ 未授权 API 域名访问', false) : null;
    return { ok: false, error: '未授权 API 域名访问' };
  }
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'TR_TEST',
      llm: { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.key }
    });
    finish();
    if (r && r.ok) {
      showResult ? showResult('✓ 连接成功：' + (r.result || '').slice(0, 40), true) : null;
      return { ok: true };
    }
    showResult ? showResult('❌ ' + (r && r.error || '失败'), false) : null;
    return { ok: false, error: r && r.error || '失败' };
  } catch (e) {
    finish();
    showResult ? showResult('❌ ' + e.message, false) : null;
    return { ok: false, error: e.message };
  }
}

async function saveModelFromForm() {
  const name = $('mName').value.trim();
  const baseUrl = $('mBase').value.trim().replace(/\/+$/, '');
  const model = $('mModel').value.trim();
  const key = $('mKey').value.trim();
  if (!baseUrl || !model) {
    setStatus($('mTestStatus'), '❌ 请至少填写 API 地址和模型名称', false);
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

// ---------- 总结模板事件 ----------

$('tplSelect').addEventListener('change', () => {
  activeTplId = $('tplSelect').value;
  fillTplEditor(activeTpl());
});

$('tplNew').addEventListener('click', () => {
  const t = { id: uid(), name: '新模板', prompt: DEFAULT_PROMPT };
  templates.push(t);
  activeTplId = t.id;
  persistTemplates();
  renderTplSelect();
  $('tplName').focus();
  flash($('ioStatus') || $('saveStatus'), '✓ 已新建模板，编辑后点「保存」');
});

$('tplSave').addEventListener('click', async () => {
  const t = activeTpl();
  if (!t) { flash($('saveStatus'), '❌ 没有可保存的模板'); return; }
  const name = $('tplName').value.trim();
  const prompt = $('sumPrompt').value;
  if (!prompt.trim()) { setStatus($('saveStatus'), '❌ 模板内容不能为空', false); return; }
  t.name = name || '未命名模板';
  t.prompt = prompt;
  await persistTemplates();
  renderTplSelect();
  flash($('saveStatus'), `✓ 模板「${t.name}」已保存并生效`);
});

$('tplDel').addEventListener('click', async () => {
  if (templates.length <= 1) { flash($('saveStatus'), '至少保留一个模板'); return; }
  const t = activeTpl();
  if (!t || !confirm(`删除模板「${t.name || '未命名'}」？`)) return;
  templates = templates.filter(x => x.id !== t.id);
  activeTplId = templates[0] ? templates[0].id : '';
  await persistTemplates();
  renderTplSelect();
  flash($('saveStatus'), '✓ 已删除');
});

// AI 生成模板：用选定模型生成，生成后自动创建为新模板，用户可继续修改后保存
$('genBtn').addEventListener('click', async () => {
  const need = $('genNeed').value.trim();
  if (!need) { setStatus($('genStatus'), '❌ 请先描述总结需求', false); return; }
  const m = models.find(x => x.id === $('genModel').value) || models[0];
  if (!m) { setStatus($('genStatus'), '❌ 请先在上方添加模型', false); return; }
  setStatus($('genStatus'), '生成中…（使用 ' + (m.name || m.model) + '）', true);
  const granted = await ensureOriginPermission(m.baseUrl);
  if (!granted) { setStatus($('genStatus'), '❌ 未授权 API 域名访问', false); return; }
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'GEN_TEMPLATE',
      need,
      llm: { baseUrl: m.baseUrl, model: m.model, apiKey: m.key }
    });
    if (!r || !r.ok) { setStatus($('genStatus'), '❌ ' + (r && r.error || '生成失败'), false); return; }
    const prompt = String(r.result || '').trim();
    if (!prompt) { setStatus($('genStatus'), '❌ 模型返回为空，请重试或换模型', false); return; }
    const t = { id: uid(), name: 'AI生成-' + need.slice(0, 10), prompt };
    templates.push(t);
    activeTplId = t.id;
    await persistTemplates();
    renderTplSelect();
    $('tplName').focus();
    $('tplName').select();
    setStatus($('genStatus'), '✓ 已生成并创建为新模板，可修改后点「💾 保存」', true);
  } catch (e) {
    setStatus($('genStatus'), '❌ ' + e.message, false);
  }
});

// ---------- 加载 / 保存 ----------

// ---------- 总结模板 ----------

async function persistTemplates() {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: { summaryTemplates: templates, activeSummaryId: activeTplId, summaryMigrated: true }
  });
}

function activeTpl() {
  return templates.find(t => t.id === activeTplId) || templates[0] || null;
}

function fillTplEditor(t) {
  $('tplName').value = t ? (t.name || '') : '';
  $('sumPrompt').value = t ? (t.prompt || '') : '';
}

function renderTplSelect() {
  const sel = $('tplSelect');
  sel.innerHTML = '';
  templates.forEach(t => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name || '(未命名)';
    sel.appendChild(o);
  });
  const cur = activeTpl();
  if (cur) sel.value = cur.id;
  fillTplEditor(cur);
}

// 生成模型下拉：跟随模型列表变化，保留当前选择
function refreshGenModelSelect() {
  const sel = $('genModel');
  const prev = sel.value;
  sel.innerHTML = '';
  models.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = (m.name || m.model) + '（' + m.model + '）';
    sel.appendChild(o);
  });
  if (prev && models.some(m => m.id === prev)) sel.value = prev;
  else if (models.some(m => m.id === activeModelId)) sel.value = activeModelId;
  else if (models.length) sel.value = models[0].id;
}

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = resp.settings;
  fillLangSelect($('targetLang'), false);
  fillLangSelect($('sumLang'), true);
  $('targetLang').value = s.targetLang;
  $('provider').value = s.provider;
  models = Array.isArray(s.models) ? s.models : [];
  activeModelId = s.activeModelId || (models[0] ? models[0].id : '');
  templates = Array.isArray(s.summaryTemplates) ? s.summaryTemplates : [];
  activeTplId = s.activeSummaryId || (templates[0] ? templates[0].id : '');
  $('sumLang').value = s.summary.lang || '';
  renderModels();
  renderTplSelect();
  refreshGenModelSelect();
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
    summaryTemplates: templates,
    activeSummaryId: activeTplId,
    summaryMigrated: true,
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

// ---------- 导出 / 导入（API Key 混淆存储，非明文） ----------

// 混淆：与固定盐做 XOR 再 Base64。防止导出文件被直接读取/搜索到 Key，
// 属于防君子不防小人的混淆（文件本身仍在导出者手里，可逆）。
const EXPORT_SALT = 'aitr::v1::key-obf::7f3a';

function xorString(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    out.push(String.fromCharCode(str.charCodeAt(i) ^ EXPORT_SALT.charCodeAt(i % EXPORT_SALT.length)));
  }
  return out.join('');
}
function encodeKey(k) { return btoa(unescape(encodeURIComponent(xorString(k)))); }
function decodeKey(s) { return xorString(decodeURIComponent(escape(atob(s)))); }

$('exportBtn').addEventListener('click', async () => {
  if (!models.length) { flash($('ioStatus'), '❌ 还没有可导出的模型'); return; }
  const payload = {
    app: 'ai-translate-extension',
    format: 1,
    exportedAt: new Date().toISOString(),
    models: models.map(m => ({
      name: m.name || '',
      baseUrl: m.baseUrl || '',
      model: m.model || '',
      key: m.key ? encodeKey(m.key) : ''
    }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      // saveAs: true 弹出系统保存对话框，由用户选择导出目录
      filename: 'ai-translate-models-' + new Date().toISOString().slice(0, 10) + '.json',
      saveAs: true,
      conflictAction: 'uniquify'
    });
    flash($('ioStatus'), '✓ 已导出 ' + models.length + ' 个模型配置');
  } catch (e) {
    setStatus($('ioStatus'), '❌ 导出失败：' + e.message, false);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch (err) {
    setStatus($('ioStatus'), '❌ 不是有效的配置文件', false);
    return;
  }
  if (!data || data.app !== 'ai-translate-extension' || !Array.isArray(data.models)) {
    setStatus($('ioStatus'), '❌ 文件格式不匹配（应为 AI 翻译助手导出的配置）', false);
    return;
  }
  let added = 0, updated = 0;
  for (const m of data.models) {
    if (!m.baseUrl || !m.model) continue;
    const entry = {
      id: uid(),
      name: m.name || m.model,
      baseUrl: String(m.baseUrl).replace(/\/+$/, ''),
      model: String(m.model),
      key: m.key ? decodeKey(m.key) : ''
    };
    // 相同「网关+模型」视为同一条：覆盖名称与 Key
    const idx = models.findIndex(x => x.baseUrl === entry.baseUrl && x.model === entry.model);
    if (idx >= 0) {
      entry.id = models[idx].id;
      models[idx] = entry;
      updated++;
    } else {
      models.push(entry);
      added++;
    }
  }
  // 没有默认模型时，取第一个导入项作为默认，导入即可用
  if (!activeModel() && models.length) activeModelId = models[0].id;
  await persistModels();
  renderModels();
  flash($('ioStatus'), `✓ 导入完成：新增 ${added} 个，更新 ${updated} 个`);
});

$('addModelBtn').addEventListener('click', () => openForm(null));
$('mSave').addEventListener('click', saveModelFromForm);
$('mCancel').addEventListener('click', closeForm);
// 表单内测试：直接测当前填写的值，无需先保存
$('mTest').addEventListener('click', () => {
  $('mTestStatus').textContent = '';
  testModel({
    baseUrl: $('mBase').value.trim().replace(/\/+$/, ''),
    model: $('mModel').value.trim(),
    key: $('mKey').value.trim()
  }, $('mTest'),
  (text, ok) => setStatus($('mTestStatus'), text, ok));
});
// 将当前模板内容恢复为默认（需再点「保存」才生效）
$('resetPrompt').addEventListener('click', () => {
  $('sumPrompt').value = DEFAULT_PROMPT;
  flash($('saveStatus'), '已填入默认模板内容，点「💾 保存」生效');
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TR_CLEAR_CACHE' });
  refreshCacheInfo();
});

loadSettings();
