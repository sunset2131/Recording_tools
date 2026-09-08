/**
 * custom-recorder.js - 自定义录制器
 * 打开浏览器，监听用户操作，自动记录每个元素的完整定位信息（id/class/css/xpath）
 * 用法: node custom-recorder.js [url] [output.json]
 */
const fs = require('fs');
const path = require('path');

const TOOL_DIR = __dirname;
const PLAYWRIGHT_PATH = path.join(TOOL_DIR, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright');
const BROWSER_CHANNEL = process.env.RECORDER_BROWSER_CHANNEL || 'chrome';

// 注入到页面的事件监听脚本
const INJECT_SCRIPT = `
(function() {
  if (window.__recorderInjected) return;
  window.__recorderInjected = true;

  var inputTimers = new WeakMap();

  function getXPath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    if (el === document.body) return '/html/body';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var idx = 1;
      var sib = cur.previousSibling;
      while (sib) { if (sib.nodeType === 1 && sib.tagName === cur.tagName) idx++; sib = sib.previousSibling; }
      parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  function getCss(el) {
    if (el.id) return '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      var cls = el.className.trim().split(/\\s+/)[0];
      if (cls) return el.tagName.toLowerCase() + '.' + cls;
    }
    return el.tagName.toLowerCase();
  }

  function getAria(el) {
    var role = el.getAttribute('role') || '';
    var name = el.getAttribute('aria-label') || el.title || el.textContent.trim().slice(0, 30);
    if (role) return 'getByRole(' + role + ', {name: \\'' + name + '\\'})';
    if (el.tagName === 'A') return 'getByRole(link, {name: \\'' + name + '\\'})';
    if (el.tagName === 'BUTTON') return 'getByRole(button, {name: \\'' + name + '\\'})';
    if (el.tagName === 'INPUT') return 'getByRole(' + (el.type || 'textbox') + ', {name: \\'' + (el.placeholder || el.name || name) + '\\'})';
    return 'getByText(\\'' + name.slice(0, 20) + '\\')';
  }

  function buildInfo(el, action) {
    return {
      action: action,
      tag: el.tagName,
      id: el.id || '',
      className: (typeof el.className === 'string' ? el.className : '') || '',
      css: getCss(el),
      xpath: getXPath(el),
      aria: getAria(el),
      text: (el.textContent || '').trim().slice(0, 50),
      value: el.value || '',
      placeholder: el.placeholder || '',
      name: el.name || '',
      type: el.type || '',
      href: el.href || '',
      title: el.title || '',
      role: el.getAttribute('role') || '',
      checked: el.checked || false,
      selectedText: el.tagName === 'SELECT' ? (el.options[el.selectedIndex] || {}).text || '' : '',
      url: location.href,
      pageTitle: document.title,
      timestamp: Date.now(),
    };
  }

  document.addEventListener('click', function(e) {
    var el = e.target;
    if (el === document.documentElement || el === document.body) return;
    window.__recordAction(buildInfo(el, 'click'));
  }, true);

  document.addEventListener('dblclick', function(e) {
    var el = e.target;
    window.__recordAction(buildInfo(el, 'dblclick'));
  }, true);

  document.addEventListener('input', function(e) {
    var el = e.target;
    if (inputTimers.has(el)) clearTimeout(inputTimers.get(el));
    inputTimers.set(el, setTimeout(function() {
      window.__recordAction(buildInfo(el, 'fill'));
    }, 800));
  }, true);

  document.addEventListener('change', function(e) {
    var el = e.target;
    if (el.tagName === 'SELECT') {
      window.__recordAction(buildInfo(el, 'select'));
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      window.__recordAction(buildInfo(el, el.checked ? 'check' : 'uncheck'));
    }
  }, true);

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      window.__recordAction(buildInfo(e.target, 'press_Enter'));
    }
  }, true);
})();
`;

async function record(targetUrl, outputFile) {
  const playwright = require(PLAYWRIGHT_PATH);
  const browser = await playwright.chromium.launch({
    channel: BROWSER_CHANNEL,
    headless: false,
    args: ['--start-maximized'],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  const actions = [];
  const startTime = new Date();
  // context 级别暴露函数（所有标签页通用）
  await context.exposeFunction('__recordAction', (data) => {
    actions.push(data);
    var loc = data.css || data.id || data.text;
    console.log(`  [${actions.length}] ${data.action} → ${data.tag} ${loc}`);
  });

  // context 级别注入脚本（所有标签页通用，包括新标签页）
  await context.addInitScript(INJECT_SCRIPT);

  // 监听新标签页
  context.on('page', async (newPage) => {
    console.log(`  [新标签页] ${newPage.url()}`);
  });

  // 导航
  if (targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  } else {
    await page.goto('about:blank');
  }

  console.log('');
  console.log('  录制已启动，请在浏览器中操作...');
  console.log('  支持多标签页操作，新标签页自动录制');
  console.log('  关闭浏览器窗口 或 按 Ctrl+C 结束录制');
  console.log('');

  // 仅在整个浏览器关闭后结束。服务端通过 IPC 请求关闭，可确保先写出 JSON。
  await new Promise((resolve) => {
    let settled = false;
    let closing = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const closeBrowser = async (reason) => {
      if (closing) return;
      closing = true;
      console.log(`  正在结束录制: ${reason}`);
      try {
        await browser.close();
      } catch (error) {
        console.error(`  关闭浏览器失败: ${error.message}`);
      }
      finish();
    };

    browser.on('disconnected', finish);
    process.on('message', (message) => {
      if (message && message.type === 'stop') closeBrowser('收到保存请求');
    });
    process.once('SIGINT', () => closeBrowser('Ctrl+C'));
    process.once('SIGTERM', () => closeBrowser('终止信号'));
  });

  // 延迟确保所有事件都已记录
  await new Promise(r => setTimeout(r, 500));

  const endTime = new Date();
  const duration = Math.round((endTime - startTime) / 1000);

  const output = {
    metadata: {
      url: targetUrl || '(手动导航)',
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration_seconds: duration,
      actionCount: actions.length,
    },
    actions: actions,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`  录制完成: ${actions.length} 个操作，耗时 ${duration}秒`);
  console.log(`  已保存: ${outputFile}`);
  if (process.connected) process.disconnect();
}

// 命令行入口
const targetUrl = process.argv[2] || '';
const outputFile = process.argv[3] || path.join(TOOL_DIR, 'output', `recording_${new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)}.json`);

// 确保输出目录存在
const outDir = path.dirname(outputFile);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

record(targetUrl, outputFile).catch(err => {
  console.error('录制失败:', err.message);
  process.exit(1);
});
