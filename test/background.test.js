// background.js 回归测试：node --test test/background.test.js
// 覆盖：整页批量缓存读写一致 / 同名模型不同网关不共用缓存 / 谷歌限流自动降级
// 方式：以 chrome.* 桩 + fetch 桩在 Node 中加载 background.js（不依赖任何框架）

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ---------- chrome.* 桩（内存版 storage.local） ----------

function makeChrome() {
  const mem = new Map();
  return {
    _mem: mem,
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return Object.fromEntries(mem);
          if (typeof keys === 'string') return mem.has(keys) ? { [keys]: mem.get(keys) } : {};
          const o = {};
          (Array.isArray(keys) ? keys : Object.keys(keys)).forEach(k => { if (mem.has(k)) o[k] = mem.get(k); });
          return o;
        },
        async set(obj) { Object.entries(obj).forEach(([k, v]) => mem.set(k, structuredClone(v))); },
        async remove(ks) { (Array.isArray(ks) ? ks : [ks]).forEach(k => mem.delete(k)); }
      }
    },
    runtime: { id: 'test', onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    contextMenus: { create() {}, removeAll(cb) { cb && cb(); }, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    scripting: { executeScript: async () => {} }
  };
}

// fetch 桩：chat/completions 返回固定译文（批量请求自动按条数补齐 JSON 数组）；
// 谷歌端点一律抛 TypeError，即 googleTranslate 眼中的限流/CORS 失败
function makeFetch(llmText) {
  const calls = { llm: 0, google: 0 };
  const fn = async (url, opts) => {
    if (String(url).includes('chat/completions')) {
      calls.llm++;
      const body = JSON.parse(opts.body);
      const user = body.messages[body.messages.length - 1].content;
      let arr = null;
      try {
        const p = JSON.parse(user);
        if (Array.isArray(p)) arr = Array.from({ length: p.length }, () => llmText);
      } catch (e) { /* 单文本翻译，非 JSON 数组 */ }
      return { ok: true, json: async () => ({ choices: [{ message: { content: arr ? JSON.stringify(arr) : llmText } }] }) };
    }
    calls.google++;
    throw new TypeError('Failed to fetch');
  };
  fn.calls = calls;
  return fn;
}

// ---------- 加载被测模块 ----------

function loadBackground(chrome, fetchImpl) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const factory = new Function('chrome', 'fetch', 'structuredClone',
    src + '\n;return { cacheKey, llmCacheProv, handleMsg, getSettings };');
  return factory(chrome, fetchImpl, structuredClone);
}

const GATEWAY_A_SETTINGS = {
  targetLang: '简体中文',
  provider: 'llm',
  llmMigrated: true,
  summaryMigrated: true,
  models: [{ id: 'm1', name: '网关A', baseUrl: 'https://gw-a.example', model: 'gpt-4o-mini', key: 'k1' }],
  activeModelId: 'm1'
};

// ---------- 用例 ----------

test('整页批量：LLM 缓存读写同键，命中后不再请求模型', async () => {
  const chrome = makeChrome();
  await chrome.storage.local.set({ aitr_settings: GATEWAY_A_SETTINGS });
  const fetchImpl = makeFetch('世界');
  const api = loadBackground(chrome, fetchImpl);

  // 预置缓存：与 TR_PAGE_BATCH 读取使用同一身份，必须命中
  const s = await api.getSettings();
  const key = api.cacheKey(api.llmCacheProv(s), '简体中文', 'translate', 'Hello', 'x');
  await chrome.storage.local.set({ [key]: { r: 'CACHED', ts: 1, u: '' } });

  const r1 = await api.handleMsg({ type: 'TR_PAGE_BATCH', items: ['Hello'], lang: '简体中文', url: 'u' });
  assert.equal(r1.ok, true);
  assert.equal(r1.results[0], 'CACHED');
  assert.equal(fetchImpl.calls.llm, 0, '缓存命中不应请求模型');

  // 未命中的文本走模型，并按 llm:<model>@<网关> 身份落缓存
  const r2 = await api.handleMsg({ type: 'TR_PAGE_BATCH', items: ['World'], lang: '简体中文', url: 'u' });
  assert.equal(r2.results[0], '世界');
  assert.equal(fetchImpl.calls.llm, 1);

  const r3 = await api.handleMsg({ type: 'TR_PAGE_BATCH', items: ['World'], lang: '简体中文', url: 'u' });
  assert.equal(r3.results[0], '世界');
  assert.equal(fetchImpl.calls.llm, 1, '第二次应命中刚写入的缓存');
});

test('同名模型、不同网关：缓存身份不同，不串用结果', async () => {
  const chrome = makeChrome();
  await chrome.storage.local.set({ aitr_settings: GATEWAY_A_SETTINGS });
  const fetchA = makeFetch('A网结果');
  const apiA = loadBackground(chrome, fetchA);

  const rA = await apiA.handleMsg({ type: 'TR_TEXT', mode: 'translate', text: 'Hi', lang: '简体中文', url: 'u' });
  assert.equal(rA.result, 'A网结果');
  assert.equal(fetchA.calls.llm, 1);

  // 切到网关 B（模型名相同：gpt-4o-mini）
  await chrome.storage.local.set({
    aitr_settings: Object.assign({}, GATEWAY_A_SETTINGS, {
      models: [{ id: 'm1', name: '网关B', baseUrl: 'https://gw-b.example', model: 'gpt-4o-mini', key: 'k2' }]
    })
  });
  const fetchB = makeFetch('B网结果');
  const apiB = loadBackground(chrome, fetchB);

  // 网关 B 的请求不得命中 A 网刚写入的缓存
  const rB = await apiB.handleMsg({ type: 'TR_TEXT', mode: 'translate', text: 'Hi', lang: '简体中文', url: 'u' });
  assert.equal(rB.result, 'B网结果', '同名模型换网关后应重新请求');
  assert.equal(fetchB.calls.llm, 1);

  // 两个身份确实不同（同 model、不同 baseUrl → llmCacheProv 必不相同）
  const bSettings = await apiB.getSettings();
  const provA = llmProvOf(apiB, GATEWAY_A_SETTINGS.models[0]);
  const provB = llmProvOf(apiB, bSettings.models[0]);
  assert.notEqual(provA, provB);
});

// 用指定模型配置计算缓存身份
function llmProvOf(api, modelConf) {
  return api.llmCacheProv({ models: [modelConf], activeModelId: modelConf.id, llm: {} });
}

test('谷歌限流自动降级：按 LLM 身份入缓存，之后不再重复调模型', async () => {
  const chrome = makeChrome();
  await chrome.storage.local.set({ aitr_settings: Object.assign({}, GATEWAY_A_SETTINGS, { provider: 'google' }) });
  const fetchImpl = makeFetch('降级译文');
  const api = loadBackground(chrome, fetchImpl);

  const r1 = await api.handleMsg({ type: 'TR_TEXT', mode: 'translate', text: 'Hello', lang: '简体中文', url: 'u', provider: 'google' });
  assert.equal(r1.ok, true);
  assert.match(r1.provider, /降级/);
  assert.equal(r1.result, '降级译文');
  assert.equal(fetchImpl.calls.google, 2, '谷歌两个端点都被限流');
  assert.equal(fetchImpl.calls.llm, 1);

  // 降级结果必须落在 LLM 缓存键，谷歌键保持干净
  const s = await api.getSettings();
  const gKey = api.cacheKey('google', '简体中文', 'translate', 'Hello', 'x');
  const lKey = api.cacheKey(api.llmCacheProv(s), '简体中文', 'translate', 'Hello', 'x');
  assert.ok((await chrome.storage.local.get(lKey))[lKey], '降级结果应写入 LLM 缓存键');
  assert.ok(!(await chrome.storage.local.get(gKey))[gKey], '谷歌缓存键不应混入降级结果');

  // 再次请求（仍选谷歌）：谷歌会再试一次（正常，需先确认仍被限流），但不再调模型
  const r2 = await api.handleMsg({ type: 'TR_TEXT', mode: 'translate', text: 'Hello', lang: '简体中文', url: 'u', provider: 'google' });
  assert.equal(r2.result, '降级译文');
  assert.equal(r2.cached, true);
  assert.equal(fetchImpl.calls.llm, 1, '降级复用 LLM 缓存，不应重复调模型');
});

test('整页批量：谷歌限流降级也复用 LLM 缓存', async () => {
  const chrome = makeChrome();
  await chrome.storage.local.set({ aitr_settings: Object.assign({}, GATEWAY_A_SETTINGS, { provider: 'google' }) });
  const fetchImpl = makeFetch('批量降级');
  const api = loadBackground(chrome, fetchImpl);
  const msg = { type: 'TR_PAGE_BATCH', items: ['A1'], lang: '简体中文', url: 'u' };

  const r1 = await api.handleMsg(msg);
  assert.equal(r1.results[0], '批量降级');
  assert.equal(fetchImpl.calls.llm, 1);

  const r2 = await api.handleMsg(msg);
  assert.equal(r2.results[0], '批量降级');
  assert.equal(fetchImpl.calls.llm, 1, '第二次降级应复用 LLM 缓存');
});

test('整页批量：首个错误非限流、后续限流时仍应触发降级', async () => {
  const chrome = makeChrome();
  await chrome.storage.local.set({ aitr_settings: Object.assign({}, GATEWAY_A_SETTINGS, { provider: 'google' }) });
  const calls = { llm: 0, google: 0 };
  // 按请求正文区分：段落 A 两个端点都返回普通 HTTP 500，段落 B 走限流路径
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('chat/completions')) {
      calls.llm++;
      const body = JSON.parse(opts.body);
      const user = body.messages[body.messages.length - 1].content;
      let arr = null;
      try {
        const p = JSON.parse(user);
        if (Array.isArray(p)) arr = Array.from({ length: p.length }, () => 'LLM兜底');
      } catch (e) { /* 单文本翻译，非 JSON 数组 */ }
      return { ok: true, json: async () => ({ choices: [{ message: { content: arr ? JSON.stringify(arr) : 'LLM兜底' } }] }) };
    }
    calls.google++;
    const text = decodeURIComponent(String(opts.body || '').replace(/^q=/, ''));
    if (text === 'A') return { ok: false, status: 500, text: async () => 'server error' };
    throw new TypeError('Failed to fetch');
  };
  fetchImpl.calls = calls;
  const api = loadBackground(chrome, fetchImpl);

  const r = await api.handleMsg({ type: 'TR_PAGE_BATCH', items: ['A', 'B'], lang: '简体中文', url: 'u' });
  assert.equal(r.ok, true);
  assert.equal(r.results[0], 'LLM兜底', '普通失败的段落也应被 LLM 降级补齐');
  assert.equal(r.results[1], 'LLM兜底');
  assert.equal(calls.llm, 1, '批次中出现限流即应触发降级，不能只看首个错误');
});
