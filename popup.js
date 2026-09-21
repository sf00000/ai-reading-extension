// AI 翻译助手 - 弹窗逻辑

const LANGS = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'];

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isNormalPage(tab) {
  return tab && /^https?:/i.test(tab.url || '');
}

async function ensureInjected(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'TR_PING' });
    if (r && r.ok) return;
  } catch (e) { /* 未注入 */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
}

function updateMeta(s, active) {
  const hasModel = !!(active && active.baseUrl && active.apiKey);
  $('meta').textContent = s.provider === 'google'
    ? `当前翻译服务：谷歌翻译｜总结模型：${hasModel ? (active.name || active.model) : '未配置 ⚠'}`
    : `当前模型：${hasModel ? (active.name || active.model) + ' · ' + active.model : '未配置 ⚠ 请到设置添加模型'}`;
}

async function loadState() {
  // 语言下拉
  const sel = $('lang');
  LANGS.forEach(l => {
    const o = document.createElement('option');
    o.value = l; o.textContent = l;
    sel.appendChild(o);
  });

  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = resp.settings;
  sel.value = s.targetLang;

  // 模型下拉：列出所有已配置模型，可直接切换默认模型
  const msel = $('model');
  const models = Array.isArray(s.models) ? s.models : [];
  if (models.length) {
    models.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = (m.name || m.model) + (m.key ? '' : ' ⚠无Key');
      msel.appendChild(o);
    });
    msel.value = s.activeModelId || models[0].id;
  } else {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '未配置，请到设置添加';
    msel.appendChild(o);
  }

  updateMeta(s, resp.activeLlm);

  const tab = await activeTab();
  if (!isNormalPage(tab)) {
    $('meta').textContent = '⚠️ 当前页面不是普通网页（如浏览器内部页面），无法翻译';
    $('btnTranslate').disabled = true;
    $('btnSummary').disabled = true;
    return;
  }
  try {
    await ensureInjected(tab.id);
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'TR_STATE' });
    if (st && st.count > 0) $('btnTranslate').textContent = '↩️ 恢复原文';
  } catch (e) { /* 忽略 */ }
}

$('btnTranslate').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!isNormalPage(tab)) return;
  await ensureInjected(tab.id);
  const st = await chrome.tabs.sendMessage(tab.id, { type: 'TR_STATE' });
  if (st && st.count > 0) {
    await chrome.tabs.sendMessage(tab.id, { type: 'TR_RESTORE' });
    $('btnTranslate').textContent = '🌐 翻译本页 / 恢复原文';
  } else {
    await chrome.tabs.sendMessage(tab.id, { type: 'TR_PAGE' });
    window.close();
  }
});

$('btnSummary').addEventListener('click', async () => {
  const tab = await activeTab();
  if (!isNormalPage(tab)) return;
  await ensureInjected(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: 'TR_PAGE_SUMMARY' });
  window.close();
});

$('lang').addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { targetLang: $('lang').value } });
  $('meta').textContent = '✓ 已切换目标语言，重新翻译本页即可生效';
});

// 弹窗内直接切换默认模型（翻译/总结立即用新模型）
$('model').addEventListener('change', async () => {
  const id = $('model').value;
  if (!id) return;
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { activeModelId: id } });
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  updateMeta(resp.settings, resp.activeLlm);
  const m = (resp.settings.models || []).find(x => x.id === id);
  $('meta').textContent = '✓ 已切换模型：' + (m ? (m.name || m.model) : id);
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

loadState();
