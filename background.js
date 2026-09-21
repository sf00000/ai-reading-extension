// AI 翻译助手 - 后台服务线程
// 职责：设置存取、缓存管理、大模型/谷歌翻译 API 调用、右键菜单、快捷键

const DEFAULT_SUMMARY_PROMPT = `请使用{{lang}}总结以下内容。要求：
1. 先用一两句话概括核心主题；
2. 列出 3~6 个要点，尽量保留关键数据、名词与结论；
3. 如有行动建议或风险提示，单独列出。
直接输出总结，不要复述原文。

{{text}}`;

const DEFAULTS = {
  targetLang: '简体中文',
  provider: 'llm', // llm | google
  llm: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat'
  },
  summary: {
    lang: '', // 空 = 跟随目标语言
    prompt: DEFAULT_SUMMARY_PROMPT
  },
  presets: [] // 用户自定义 API 预设（公司中转站等）：[{name, baseUrl, model}]
};

const LANG_CODE = {
  '简体中文': 'zh-CN',
  '繁體中文': 'zh-TW',
  'English': 'en',
  '日本語': 'ja',
  '한국어': 'ko',
  'Français': 'fr',
  'Deutsch': 'de',
  'Español': 'es',
  'Русский': 'ru'
};

// ---------- 工具 ----------

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

async function getSettings() {
  const { aitr_settings } = await chrome.storage.local.get('aitr_settings');
  const s = structuredClone(DEFAULTS);
  const saved = aitr_settings || {};
  Object.assign(s, saved, {
    llm: Object.assign({}, DEFAULTS.llm, saved.llm || {}),
    summary: Object.assign({}, DEFAULTS.summary, saved.summary || {})
  });
  return s;
}

// ---------- 缓存 ----------
// 键：aitr_cache:<provider>:<lang>:<mode>:<promptHash>:<textHash>_<len>
// 同一链接/同一段落文字 + 同一目标语言 + 同一服务 → 直接命中，不再调大模型

function cacheKey(provider, lang, mode, text, promptHash) {
  return `aitr_cache:${provider}:${lang}:${mode}:${promptHash || 'x'}:${hashStr(text)}_${text.length}`;
}

async function cacheGet(key) {
  const o = await chrome.storage.local.get(key);
  return o[key] || null;
}

async function cacheSet(key, val) {
  await chrome.storage.local.set({ [key]: val });
}

// ---------- API 调用 ----------

async function llmChat(s, messages, maxTokens) {
  const base = (s.llm.baseUrl || '').replace(/\/+$/, '');
  if (!base || !s.llm.apiKey) throw new Error('未配置大模型 API，请到插件设置页填写 API 地址与 Key');
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.llm.apiKey
      },
      body: JSON.stringify({
        model: s.llm.model,
        messages,
        temperature: 0.3,
        max_tokens: maxTokens || 4096
      })
    });
  } catch (e) {
    throw new Error('无法连接 API（可能未授权该域名）：' + e.message);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`API 错误 ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// 批量翻译：一次请求翻译一组段落（JSON 数组进出），省 token 且保持顺序
async function llmTranslateBatch(s, texts, lang) {
  const sys = `You are a professional translation engine. Translate each string in the user's JSON array into ${lang}. Rules: return exactly the same number of items in the same order; preserve formatting, code, URLs, numbers and technical terms; keep proper nouns. Respond with ONLY a JSON array of translated strings, no markdown fences, no explanation.`;
  const raw = await llmChat(s, [
    { role: 'system', content: sys },
    { role: 'user', content: JSON.stringify(texts) }
  ]);
  let cleaned = raw.trim().replace(/^```(json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('模型未返回 JSON 数组');
  const arr = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('翻译条数与原文不一致');
  return arr.map(x => String(x ?? ''));
}

async function llmTranslateOne(s, text, lang) {
  const r = await llmChat(s, [
    { role: 'system', content: `Translate the user's text into ${lang}. Output ONLY the translation, nothing else.` },
    { role: 'user', content: text }
  ], 4096);
  return r.trim();
}

// 谷歌翻译（免费网页端接口，无需 Key）
// 主端点用 Chrome 内置翻译同款的 dict-chrome-ex，风控更宽松；
// 失败时降级回 gtx 端点，仍被限流则给出明确提示
const GOOGLE_RATE_LIMIT_MSG = '谷歌翻译接口被限流或拦截（免费接口的常见风控）。请稍等几分钟重试，或到「设置 → 翻译服务」切换为大模型翻译。';

function parseGoogleT(data) {
  // dict-chrome-ex 端点可能返回 ["译文"]、[["译文","源语言"]]、[[["译文"]]] 等多种形态
  if (!Array.isArray(data) || !data.length) return null;
  if (typeof data[0] === 'string') return data.join('');
  if (Array.isArray(data[0])) {
    const parts = data.map(x => {
      if (typeof x === 'string') return x;
      if (Array.isArray(x)) {
        if (typeof x[0] === 'string') return x[0];
        if (Array.isArray(x[0])) return (x[0][0] || '') + '';
      }
      return '';
    });
    const joined = parts.join('');
    return joined || null;
  }
  return null;
}

async function googleTranslate(text, tl) {
  const endpoints = [
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' + encodeURIComponent(tl),
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) + '&dt=t'
  ];
  let lastErr = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'q=' + encodeURIComponent(text)
      });
      if (res.redirected && /\/sorry\//.test(res.url)) throw new Error('RATE_LIMITED');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('json') && !ct.includes('javascript')) throw new Error('RATE_LIMITED'); // 验证码页是 HTML
      const data = await res.json();
      let out = null;
      if (url.includes('dict-chrome-ex')) {
        out = parseGoogleT(data);
      } else {
        if (Array.isArray(data) && Array.isArray(data[0])) {
          out = data[0].map(seg => (seg && seg[0]) || '').join('') || null;
        }
      }
      if (out) return out;
      throw new Error('返回格式异常');
    } catch (e) {
      if (e instanceof TypeError || /Failed to fetch/i.test(e.message || '')) {
        // 重定向到验证码页且该域名无授权时，浏览器以 CORS 错误抛出
        lastErr = new Error('RATE_LIMITED');
      } else {
        lastErr = e;
      }
      if (lastErr.message === 'RATE_LIMITED' && url === endpoints[endpoints.length - 1]) break;
    }
  }
  if (lastErr && lastErr.message === 'RATE_LIMITED') throw new Error(GOOGLE_RATE_LIMIT_MSG);
  throw new Error('谷歌翻译失败：' + ((lastErr && lastErr.message) || lastErr));
}

// ---------- 消息处理 ----------

async function handleMsg(msg) {
  switch (msg.type) {
    case 'TR_PING':
      return { ok: true };

    case 'GET_SETTINGS':
      return { ok: true, settings: await getSettings() };

    case 'SAVE_SETTINGS': {
      const cur = await getSettings();
      const next = Object.assign({}, cur, msg.settings, {
        llm: Object.assign({}, cur.llm, (msg.settings || {}).llm || {}),
        summary: Object.assign({}, cur.summary, (msg.settings || {}).summary || {})
      });
      await chrome.storage.local.set({ aitr_settings: next });
      return { ok: true, settings: next };
    }

    case 'TR_TEST': {
      const s = await getSettings();
      if (msg.provider === 'google') {
        const r = await googleTranslate('Hello, world!', 'zh-CN');
        return { ok: true, result: r };
      }
      const r = await llmChat(s, [{ role: 'user', content: '请只回复两个字：成功' }], 20);
      return { ok: true, result: r.trim() };
    }

    // 单文本：划词翻译 / 总结（含缓存）
    case 'TR_TEXT': {
      const s = await getSettings();
      const lang = msg.lang || s.targetLang;

      if (msg.mode === 'summary') {
        const sumLang = msg.lang || s.summary.lang || s.targetLang;
        const tpl = (s.summary.prompt || DEFAULT_SUMMARY_PROMPT);
        const prompt = tpl.replaceAll('{{lang}}', sumLang).replaceAll('{{text}}', msg.text);
        const key = cacheKey('llm', sumLang, 'summary', msg.text, hashStr(tpl));
        const hit = await cacheGet(key);
        if (hit) return { ok: true, result: hit.r, cached: true };
        const r = await llmChat(s, [
          // 系统级强约束：无论用户 prompt 里是否写了 {{lang}}，输出语言都强制生效
          { role: 'system', content: `You MUST write your entire response in ${sumLang}. This requirement overrides everything else, including the language of the provided text. Never explain this instruction.` },
          { role: 'user', content: prompt }
        ], 4096);
        await cacheSet(key, { r, ts: Date.now(), u: msg.url || '' });
        return { ok: true, result: r, cached: false };
      }

      // 翻译
      const provider = msg.provider || s.provider;
      const key = cacheKey(provider, lang, 'translate', msg.text, 'x');
      const hit = await cacheGet(key);
      if (hit) return { ok: true, result: hit.r, cached: true, provider };

      let r;
      let usedProvider = provider;
      if (provider === 'google') {
        try {
          r = await googleTranslate(msg.text, LANG_CODE[lang] || 'zh-CN');
        } catch (e) {
          // 谷歌被限流时，若配置了大模型则自动降级，保证可用性
          if (s.llm.apiKey && /限流/.test(String(e && e.message || e))) {
            r = await llmTranslateOne(s, msg.text, lang);
            usedProvider = 'llm(谷歌限流自动降级)';
          } else {
            throw e;
          }
        }
      } else {
        r = await llmTranslateOne(s, msg.text, lang);
      }
      await cacheSet(key, { r, ts: Date.now(), u: msg.url || '' });
      return { ok: true, result: r, cached: false, provider: usedProvider };
    }

    // 整页批量：内容脚本按 8 条一组发来，未命中的再合并成一次 LLM 请求
    case 'TR_PAGE_BATCH': {
      const s = await getSettings();
      const lang = msg.lang || s.targetLang;
      const provider = s.provider;
      const items = msg.items || [];
      const results = new Array(items.length).fill(null);
      const need = [];

      for (let i = 0; i < items.length; i++) {
        const hit = await cacheGet(cacheKey(provider, lang, 'translate', items[i], 'x'));
        if (hit) results[i] = hit.r;
        else need.push({ i, text: items[i] });
      }

      if (need.length) {
        let firstErr = null; // 记录第一个失败原因，全部失败时透传给页面

        // LLM 批量处理（按条数 ≤8 且字符 ≤3500 分组，批量失败逐条兜底）
        const processWithLlm = async (remaining, cacheProv) => {
          const groups = [];
          let g = [];
          let chars = 0;
          for (const n of remaining) {
            if (g.length >= 8 || chars + n.text.length > 3500) { if (g.length) groups.push(g); g = []; chars = 0; }
            g.push(n); chars += n.text.length;
          }
          if (g.length) groups.push(g);

          for (const grp of groups) {
            let done = false;
            try {
              const arr = await llmTranslateBatch(s, grp.map(n => n.text), lang);
              grp.forEach((n, j) => { results[n.i] = arr[j]; });
              done = true;
            } catch (e) { firstErr = firstErr || String(e && e.message || e); }
            if (!done) {
              for (const n of grp) {
                try { results[n.i] = await llmTranslateOne(s, n.text, lang); } catch (e) { firstErr = firstErr || String(e && e.message || e); }
              }
            }
            for (const n of grp) {
              if (results[n.i]) await cacheSet(cacheKey(cacheProv, lang, 'translate', n.text, 'x'), { r: results[n.i], ts: Date.now(), u: msg.url || '' });
            }
          }
        };

        if (provider === 'google') {
          const CONC = 2; // 低并发，降低触发谷歌风控的概率
          for (let k = 0; k < need.length; k += CONC) {
            await Promise.all(need.slice(k, k + CONC).map(async n => {
              try {
                const r = await googleTranslate(n.text, LANG_CODE[lang] || 'zh-CN');
                results[n.i] = r;
                await cacheSet(cacheKey(provider, lang, 'translate', n.text, 'x'), { r, ts: Date.now(), u: msg.url || '' });
              } catch (e) { firstErr = firstErr || String(e && e.message || e); }
            }));
          }
          // 谷歌被限流时，配置了大模型的部分自动降级补齐
          const stillNeed = need.filter(n => !results[n.i]);
          if (stillNeed.length && s.llm.apiKey && /限流/.test(firstErr || '')) {
            await processWithLlm(stillNeed, 'llm');
          }
        } else {
          await processWithLlm(need, provider);
        }
        // 全部失败时明确报错，而不是静默返回空结果
        if (results.every(r => r === null || r === undefined)) {
          return { ok: false, error: firstErr || '翻译请求全部失败' };
        }
      }
      return { ok: true, results, provider };
    }

    case 'TR_CACHE_INFO': {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(k => k.startsWith('aitr_cache:'));
      let size = 0;
      keys.forEach(k => { size += JSON.stringify(all[k]).length; });
      return { ok: true, count: keys.length, sizeKB: Math.round(size / 1024) };
    }

    case 'TR_CLEAR_CACHE': {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter(k => k.startsWith('aitr_cache:'));
      await chrome.storage.local.remove(keys);
      return { ok: true, removed: keys.length };
    }

    default:
      return { ok: false, error: '未知消息类型: ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMsg(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true; // 异步响应
});

// ---------- 右键菜单 ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'aitr-parent', title: 'AI 翻译助手', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'tr-sel', parentId: 'aitr-parent', title: '🔍 翻译选中内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'sum-sel', parentId: 'aitr-parent', title: '📝 总结选中内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'tr-page', parentId: 'aitr-parent', title: '🌐 翻译本页', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'sum-page', parentId: 'aitr-parent', title: '📄 总结本页', contexts: ['page'] });
  });
});

// ---------- 内容脚本按需注入 ----------

async function ensureInjected(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'TR_PING' });
    if (r && r.ok) return;
  } catch (e) { /* 未注入 */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
}

async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) return;
  await fn(tab.id);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) return;
  await ensureInjected(tab.id);
  const map = {
    'tr-sel': { type: 'TR_SELECTION', mode: 'translate' },
    'sum-sel': { type: 'TR_SELECTION', mode: 'summary' },
    'tr-page': { type: 'TR_PAGE' },
    'sum-page': { type: 'TR_PAGE_SUMMARY' }
  };
  const msg = map[info.menuItemId];
  if (msg) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-page') return;
  await withActiveTab(async (tabId) => {
    await ensureInjected(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'TR_PAGE' }).catch(() => {});
  });
});
