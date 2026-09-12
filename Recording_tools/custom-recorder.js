'use strict';

/* Evidence-first Playwright recorder. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { loadConfig } = require('./recording-config');

const TOOL_DIR = __dirname;
const PLAYWRIGHT_PATH = path.join(TOOL_DIR, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright');
const BROWSER_CHANNEL = process.env.RECORDER_BROWSER_CHANNEL || 'chrome';

const INJECT_SCRIPT = `
(function() {
  if (window.__recorderInjected) return;
  window.__recorderInjected = true;
  var inputTimers = new WeakMap();
  function xpath(el) {
    if (el.id) return '//*[@id="' + el.id.replace(/"/g, '&quot;') + '"]';
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1) {
      var index = 1, sib = cur.previousSibling;
      while (sib) { if (sib.nodeType === 1 && sib.tagName === cur.tagName) index++; sib = sib.previousSibling; }
      parts.unshift(cur.tagName.toLowerCase() + '[' + index + ']'); cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }
  function css(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/)[0] : '';
    return el.tagName.toLowerCase() + (cls ? '.' + CSS.escape(cls) : '');
  }
  function info(target, action, rawType) {
    var el = target && target.closest ? (target.closest('button,a,input,textarea,select,[role],label') || target) : target;
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    return { action: action, rawType: rawType || action, tag: el.tagName, id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '', css: css(el), xpath: xpath(el),
      text: text.slice(0, 200), value: 'value' in el ? String(el.value || '') : '', placeholder: el.placeholder || '',
      name: el.name || '', type: el.type || '', href: el.href || '', title: el.title || '',
      role: el.getAttribute('role') || '', ariaLabel: el.getAttribute('aria-label') || '',
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
      checked: !!el.checked, selectedText: el.tagName === 'SELECT' && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '',
      url: location.href, pageTitle: document.title, timestamp: Date.now() };
  }
  function send(data) { try { window.__recordAction(data); } catch (_) {} }
  document.addEventListener('click', function(e) { if (e.target !== document.documentElement && e.target !== document.body) send(info(e.target, 'click', 'click')); }, true);
  document.addEventListener('dblclick', function(e) { send(info(e.target, 'dblclick', 'dblclick')); }, true);
  document.addEventListener('input', function(e) {
    var el = e.target; if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(function() { send(info(el, 'fill', 'input')); inputTimers.delete(el); }, 800));
  }, true);
  document.addEventListener('change', function(e) {
    var el = e.target;
    if (el.tagName === 'SELECT') send(info(el, 'select', 'change'));
    else if (el.type === 'checkbox' || el.type === 'radio') send(info(el, el.checked ? 'check' : 'uncheck', 'change'));
  }, true);
  document.addEventListener('keydown', function(e) { if (e.key === 'Enter' && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) send(info(e.target, 'press_Enter', 'keydown')); }, true);
  ['pushState', 'replaceState'].forEach(function(name) { var original = history[name]; history[name] = function() { var result = original.apply(this, arguments); send({ action: name, rawType: name, url: location.href, pageTitle: document.title, timestamp: Date.now() }); return result; }; });
  addEventListener('popstate', function() { send({ action: 'popstate', rawType: 'popstate', url: location.href, pageTitle: document.title, timestamp: Date.now() }); });
  window.__recorderFlushInputs = function() { document.querySelectorAll('input,textarea').forEach(function(el) { if (inputTimers.has(el)) { clearTimeout(inputTimers.get(el)); inputTimers.delete(el); send(info(el, 'fill', 'input-flush')); } }); };
})();`;

const SENSITIVE_HEADERS = /^(cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token)$/i;
const TEXT_TYPES = /^(application\/json|application\/.*\+json|text\/|application\/xml|application\/javascript)/i;

function iso(date) { return new Date(date).toISOString(); }
function nowClock(start) { return { timestamp: iso(Date.now()), elapsedMs: Number(process.hrtime.bigint() - start) / 1e6 }; }
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function appendJsonl(file, value) { fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }
function safeFileName(value) { return String(value || 'response').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80); }
function headerObject(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) if (!SENSITIVE_HEADERS.test(key)) output[key] = value;
  return output;
}
function kindFor(request) {
  const resource = request.resourceType();
  if (resource === 'document') return 'document';
  if (resource === 'xhr') return 'xhr';
  if (resource === 'fetch') return 'fetch';
  if (resource === 'websocket') return 'websocket';
  return 'static';
}

class RecordingSession {
  constructor(targetUrl, outputDir) {
    this.targetUrl = targetUrl || '';
    this.outDir = outputDir;
    this.pagesDir = path.join(this.outDir, 'pages');
    this.responsesDir = path.join(this.outDir, 'responses');
    this.downloadsDir = path.join(this.outDir, 'downloads');
    this.startDate = new Date();
    this.clock = process.hrtime.bigint();
    this.config = loadConfig();
    this.actions = [];
    this.steps = [];
    this.states = [];
    this.network = [];
    this.consoleEvents = [];
    this.warnings = [];
    this.errors = [];
    this.pages = new Map();
    this.frames = new Map();
    this.requests = new Map();
    this.stepWindows = [];
    this.next = { action: 1, step: 1, state: 1, page: 1, frame: 1, request: 1, console: 1, response: 1, download: 1 };
    this.queue = Promise.resolve();
    this.stopping = false;
    this.browser = null;
    this.context = null;
    this.tracePath = path.join(this.outDir, 'trace.zip');
    this.traceStopped = false;
    fs.mkdirSync(this.outDir, { recursive: true });
    fs.mkdirSync(this.pagesDir, { recursive: true });
    fs.mkdirSync(this.responsesDir, { recursive: true });
    fs.mkdirSync(this.downloadsDir, { recursive: true });
    this.networkFile = path.join(this.outDir, 'network.jsonl');
    this.consoleFile = path.join(this.outDir, 'console.jsonl');
    fs.writeFileSync(this.networkFile, ''); fs.writeFileSync(this.consoleFile, '');
  }
  id(type) { const n = this.next[type]++; return `${type}-${String(n).padStart(4, '0')}`; }
  clockNow() { return nowClock(this.clock); }
  pageId(page) { if (!this.pages.has(page)) this.pages.set(page, this.id('page')); return this.pages.get(page); }
  frameId(frame) { if (!this.frames.has(frame)) this.frames.set(frame, this.id('frame')); return this.frames.get(frame); }
  findFrame(url) {
    for (const frame of this.frames.keys()) if (frame.url() === url) return frame;
    for (const page of this.pages.keys()) for (const frame of page.frames()) if (frame.url() === url) { this.frameId(frame); return frame; }
    return null;
  }
  async init() {
    const playwright = require(PLAYWRIGHT_PATH);
    this.browser = await playwright.chromium.launch({ channel: BROWSER_CHANNEL, headless: false, args: ['--start-maximized'] });
    this.context = await this.browser.newContext({ viewport: null, acceptDownloads: true });
    if (this.config.trace) await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await this.context.exposeFunction('__recordAction', data => { this.queue = this.queue.then(() => this.handleAction(data)).catch(error => this.warn('action', error)); });
    await this.context.addInitScript({ content: INJECT_SCRIPT });
    this.context.on('page', page => this.attachPage(page));
    this.context.on('request', request => this.onRequest(request));
    this.context.on('requestfinished', request => this.onRequestFinished(request));
    this.context.on('requestfailed', request => this.onRequestFailed(request));
    const page = await this.context.newPage(); this.attachPage(page);
    if (this.targetUrl) await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(error => this.warn('goto', error));
    else await page.goto('about:blank');
    await this.captureState(page, page.mainFrame(), null, 'initial');
    return page;
  }
  attachPage(page) {
    if (this.pages.has(page)) return;
    this.pageId(page);
    page.on('console', message => this.onConsole(page, message));
    page.on('pageerror', error => this.onConsole(page, null, error));
    page.on('download', download => this.onDownload(page, download));
    page.on('frameattached', frame => this.frameId(frame));
    page.on('framedetached', frame => this.frames.delete(frame));
    if (this.pages.size > 1) page.once('domcontentloaded', () => this.captureState(page, page.mainFrame(), null, 'page_open').catch(error => this.warn('page_open_state', error)));
  }
  onConsole(page, message, error) {
    const clock = this.clockNow();
    const event = { consoleId: this.id('console'), ...clock, pageId: this.pageId(page), type: error ? 'pageerror' : message.type(), text: error ? error.message : message.text(), args: error ? [] : message.args().map(arg => arg.toString()).slice(0, 20) };
    this.consoleEvents.push(event); appendJsonl(this.consoleFile, event);
  }
  onDownload(page, download) {
    const downloadId = this.id('download');
    const fileName = `${downloadId}_${safeFileName(download.suggestedFilename())}`;
    const target = path.join(this.downloadsDir, fileName);
    download.saveAs(target).catch(error => this.warn('download', error));
    this.actions.push({ actionId: this.id('action'), action: 'download', downloadId, file: `downloads/${fileName}`, pageId: this.pageId(page), ...this.clockNow() });
  }
  onRequest(request) {
    const clock = this.clockNow();
    const requestId = this.id('request');
    let frame = null; try { frame = request.frame(); } catch (_) {}
    const record = { requestId, ...clock, url: request.url(), method: request.method(), resourceType: request.resourceType(), kind: kindFor(request), pageId: frame ? this.pageId(frame.page()) : null, frameId: frame ? this.frameId(frame) : null, headers: {}, postData: request.postData() || null, status: null, failed: false, failure: null, responseBody: null, stepIds: [] };
    if (!this.config.network.includeStatic && record.kind === 'static') return;
    if (!this.config.network.includeThirdParty && this.targetUrl) {
      try { if (new URL(record.url).origin !== new URL(this.targetUrl).origin) return; } catch (_) {}
    }
    Object.defineProperty(record, '_written', { value: false, writable: true, enumerable: false });
    this.requests.set(request, record); this.network.push(record);
  }
  async onRequestFinished(request) {
    const record = this.requests.get(request); if (!record) return;
    record.endElapsedMs = this.clockNow().elapsedMs;
    record.headers = headerObject(await request.allHeaders().catch(() => ({})));
    const response = await request.response().catch(() => null);
    if (!response) return;
    record.status = response.status(); record.responseHeaders = headerObject(await response.allHeaders().catch(() => ({})));
    const contentType = record.responseHeaders['content-type'] || '';
    const length = Number(record.responseHeaders['content-length'] || 0);
    if (this.config.captureResponseBodies && TEXT_TYPES.test(contentType) && (!length || length <= this.config.responseBodyMaxBytes)) {
      try {
        const body = await response.body();
        if (body.length <= this.config.responseBodyMaxBytes) {
          const ext = /json/i.test(contentType) ? '.json' : /html/i.test(contentType) ? '.html' : '.txt';
          const file = `responses/${record.requestId}${ext}`;
          fs.writeFileSync(path.join(this.outDir, file), body);
          record.responseBody = { file, bytes: body.length, contentType };
        } else record.responseBodySkipped = { reason: 'size_limit', bytes: body.length, limit: this.config.responseBodyMaxBytes };
      } catch (error) { record.responseBodySkipped = { reason: 'read_failed', error: error.message }; }
    } else record.responseBodySkipped = { reason: !this.config.captureResponseBodies ? 'disabled' : 'content_type_or_size' };
    if (!record._written) { appendJsonl(this.networkFile, record); record._written = true; }
  }
  onRequestFailed(request) {
    const record = this.requests.get(request); if (!record) return;
    record.endElapsedMs = this.clockNow().elapsedMs; record.failed = true; record.failure = request.failure(); if (!record._written) { appendJsonl(this.networkFile, record); record._written = true; }
  }
  warn(scope, error) { this.warnings.push({ scope, message: error && error.message ? error.message : String(error), ...this.clockNow() }); }
  async settle(page) {
    const started = this.clockNow(); let reason = 'network_idle';
    try { await page.waitForLoadState('networkidle', { timeout: 2000 }); }
    catch (_) { reason = 'timeout'; }
    return { reason, elapsedMs: this.clockNow().elapsedMs - started.elapsedMs };
  }
  async handleAction(data) {
    const page = [...this.pages.keys()].find(candidate => candidate.url() === data.url) || [...this.pages.keys()][0];
    if (!page) return;
    const frame = this.findFrame(data.url) || page.mainFrame();
    const actionId = this.id('action'); const stepId = this.id('step'); const start = this.clockNow();
    const action = { actionId, stepId, ...data, pageId: this.pageId(page), frameId: this.frameId(frame), ...start };
    const before = await this.captureState(page, frame, data, 'before');
    this.actions.push(action);
    const settle = await this.settle(page);
    const after = await this.captureState(page, frame, data, 'after');
    after.settle = settle;
    const end = this.clockNow();
    this.stepWindows.push({ stepId, startElapsedMs: start.elapsedMs, endElapsedMs: end.elapsedMs });
    const step = { stepId, action: data.action, rawEventIds: [actionId], pageId: this.pageId(page), frameId: this.frameId(frame), timestamp: start.timestamp, elapsedMs: start.elapsedMs, target: data, locators: await this.locators(frame, data), before, after, networkRequestIds: [], consoleEventIds: [] };
    this.steps.push(step);
  }
  async locators(frame, data) {
    const candidates = [];
    const add = (type, value, score) => { if (value) candidates.push({ type, value, score }); };
    if (data.testId) add('testId', `getByTestId(${JSON.stringify(data.testId)})`, 100);
    const name = data.ariaLabel || data.text || data.placeholder || data.name;
    if (data.role && name) add('role', `getByRole(${JSON.stringify(data.role)}, { name: ${JSON.stringify(name.slice(0, 80))} })`, 95);
    if (data.tag === 'LABEL' || data.placeholder) add('label', `getByLabel(${JSON.stringify(data.placeholder || data.text)})`, 90);
    if (data.placeholder) add('placeholder', `getByPlaceholder(${JSON.stringify(data.placeholder)})`, 85);
    add('css', data.css, 55); add('xpath', data.xpath, 35);
    for (const candidate of candidates) {
      try {
        let locator = null;
        if (candidate.type === 'css') locator = frame.locator(candidate.value);
        else if (candidate.type === 'xpath') locator = frame.locator(`xpath=${candidate.value}`);
        else if (candidate.type === 'testId') locator = frame.getByTestId(data.testId);
        else if (candidate.type === 'role') locator = frame.getByRole(data.role, { name: name || undefined });
        else if (candidate.type === 'label') locator = frame.getByLabel(data.placeholder || data.text);
        else if (candidate.type === 'placeholder') locator = frame.getByPlaceholder(data.placeholder);
        candidate.unique = locator ? await locator.count() === 1 : null;
        if (candidate.unique) candidate.score += 5;
      } catch (_) { candidate.unique = false; }
      candidate.stability = candidate.type === 'testId' || candidate.type === 'role' || candidate.type === 'label' ? 'high' : candidate.type === 'css' ? 'medium' : 'low';
    }
    return candidates.sort((a, b) => b.score - a.score);
  }
  async captureState(page, frame, target, phase) {
    const stateId = this.id('state'); const clock = this.clockNow();
    let sameOrigin = true;
    try { sameOrigin = new URL(frame.url() || page.url()).origin === new URL(page.url()).origin; } catch (_) {}
    const base = { stateId, phase, ...clock, pageId: this.pageId(page), frameId: this.frameId(frame), url: page.url(), frameUrl: frame.url(), sameOrigin, title: await page.title().catch(() => ''), viewport: null, screenshot: null, dom: null, settle: null };
    try { base.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })); } catch (_) {}
    const stem = `pages/${stateId}`;
    if (!sameOrigin) {
      base.dom = { file: null, unavailable: true, reason: 'cross_origin_frame_boundary' };
      this.states.push(base); return base;
    }
    try {
      const png = path.join(this.pagesDir, `${stateId}.png`); await page.screenshot({ path: png, fullPage: false }); base.screenshot = `${stem}.png`;
    } catch (error) { this.warn('screenshot', error); }
    try {
      const result = await frame.evaluate(() => ({ html: document.documentElement ? document.documentElement.outerHTML : '', visibleText: document.body ? (document.body.innerText || '').slice(0, 10000) : '', viewport: { width: innerWidth, height: innerHeight } }));
      const originalSizeBytes = Buffer.byteLength(result.html, 'utf8'); const limit = this.config.domSnapshotMaxBytes;
      let html = result.html; const dom = { file: `${stem}.html`, originalSizeBytes, truncated: originalSizeBytes > limit, visibleTextSummary: result.visibleText };
      if (dom.truncated) { html = Buffer.from(result.html, 'utf8').subarray(0, 1024 * 1024).toString('utf8'); dom.truncatedBytes = originalSizeBytes - Buffer.byteLength(html, 'utf8'); dom.truncationReason = 'domSnapshotMaxBytes'; dom.targetAncestorChain = target ? [target.tag, target.id, target.css, target.xpath].filter(Boolean) : []; }
      atomicWrite(path.join(this.pagesDir, `${stateId}.html`), html); base.dom = dom;
    } catch (error) { base.dom = { file: null, unavailable: true, reason: error.message }; this.warn('dom', error); }
    this.states.push(base); return base;
  }
  assignLinks() {
    for (const request of this.network) request.stepIds = this.stepWindows.filter(window => request.elapsedMs <= window.endElapsedMs && (request.endElapsedMs == null || request.endElapsedMs >= window.startElapsedMs)).map(window => window.stepId);
    for (const step of this.steps) {
      step.networkRequestIds = this.network.filter(item => item.stepIds.includes(step.stepId)).map(item => item.requestId);
      step.consoleEventIds = this.consoleEvents.filter(item => item.elapsedMs >= step.elapsedMs && item.elapsedMs <= (this.stepWindows.find(w => w.stepId === step.stepId) || {}).endElapsedMs).map(item => item.consoleId);
    }
  }
  async finalize(forceError) {
    await this.queue.catch(error => this.warn('action_queue', error));
    for (const record of this.network) if (!record._written) { appendJsonl(this.networkFile, record); record._written = true; }
    if (this.context && this.config.trace && !this.traceStopped) { try { await this.context.tracing.stop({ path: this.tracePath }); this.traceStopped = true; } catch (error) { this.warn('trace', error); } }
    this.assignLinks();
    const endDate = new Date();
    const referenced = ['evidence.json', 'actions.json', 'network.jsonl', 'console.jsonl'];
    if (this.config.trace && fs.existsSync(this.tracePath)) referenced.push('trace.zip');
    const evidence = { schemaVersion: '1.0', recorderVersion: '2.0.0', metadata: { flowName: path.basename(this.outDir), url: this.targetUrl || '(手动导航)', startTime: this.startDate.toISOString(), endTime: endDate.toISOString(), durationSeconds: Math.round((endDate - this.startDate) / 1000), browser: BROWSER_CHANNEL, platform: process.platform }, complete: !forceError && this.errors.length === 0, config: this.config, files: { evidence: 'evidence.json', actions: 'actions.json', network: 'network.jsonl', console: 'console.jsonl', pages: 'pages/', responses: 'responses/', downloads: 'downloads/', trace: fs.existsSync(this.tracePath) ? 'trace.zip' : null, archive: this.config.zip ? 'evidence.zip' : null }, missingFiles: [], warnings: this.warnings, errors: this.errors, states: this.states, steps: this.steps };
    try { atomicWrite(path.join(this.outDir, 'actions.json'), JSON.stringify({ metadata: evidence.metadata, actions: this.actions }, null, 2)); } catch (error) { evidence.complete = false; evidence.errors.push({ scope: 'actions_write', message: error.message }); }
    for (const file of referenced) if (file !== 'evidence.json' && !fs.existsSync(path.join(this.outDir, file))) evidence.missingFiles.push(file);
    if (evidence.missingFiles.length) evidence.complete = false;
    atomicWrite(path.join(this.outDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    if (this.config.zip) this.createZip().catch(error => { this.warnings.push({ scope: 'zip', message: error.message }); try { atomicWrite(path.join(this.outDir, 'evidence.json'), JSON.stringify({ ...evidence, warnings: this.warnings }, null, 2)); } catch (_) {} });
  }
  createZip() {
    return new Promise((resolve, reject) => {
      const args = ['-a', '-c', '-f', path.join(this.outDir, 'evidence.zip'), '--exclude=./evidence.zip', '-C', this.outDir, '.'];
      execFile('tar', args, error => error ? reject(error) : resolve());
    });
  }
  async stop(reason) {
    if (this.stopping) return;
    this.stopping = true; console.log(`正在结束录制: ${reason}`);
    for (const page of this.pages.keys()) await page.evaluate(() => window.__recorderFlushInputs && window.__recorderFlushInputs()).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this.context && this.config.trace && !this.traceStopped) { try { await this.context.tracing.stop({ path: this.tracePath }); this.traceStopped = true; } catch (error) { this.warn('trace', error); } }
    try { if (this.browser) await this.browser.close(); } catch (error) { this.warn('browser_close', error); }
    await this.finalize(false);
  }
}

async function main() {
  const targetUrl = process.argv[2] || ''; const outputDir = process.argv[3] || path.join(TOOL_DIR, 'output', `recording_${Date.now()}`);
  let session;
  try {
    session = new RecordingSession(targetUrl, outputDir); await session.init();
    console.log('录制已启动，请在浏览器中操作；通过控制台的“完成并保存”结束。');
    const finish = reason => session.stop(reason).then(() => { if (process.connected) process.disconnect(); }).catch(error => { session.errors.push({ scope: 'finalize', message: error.message }); session.finalize(true).finally(() => process.exitCode = 1); });
    process.on('message', message => { if (message && message.type === 'stop') finish('收到保存请求'); });
    process.once('SIGINT', () => finish('Ctrl+C')); process.once('SIGTERM', () => finish('终止信号'));
    session.browser.on('disconnected', () => { if (!session.stopping) finish('浏览器关闭'); });
  } catch (error) {
    if (session) { session.errors.push({ scope: 'startup', message: error.message }); await session.finalize(true).catch(() => {}); }
    console.error(`录制失败: ${error.message}`); process.exitCode = 1;
  }
}

main();
