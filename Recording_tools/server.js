/**
 * server.js - 录制工具 Web 服务器
 * 用 Node.js 内置模块实现，零外部依赖（exceljs 仅用于 enrich）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const PORT = 19832;
const TOOL_DIR = __dirname;
const NODE_EXE = process.execPath;  // 使用启动 server.js 的 node，不硬编码路径
const PLAYWRIGHT_CLI = path.join(TOOL_DIR, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright', 'cli.js');
const CONFIG_FILE = path.join(TOOL_DIR, 'config.txt');
const OUTPUT_DIR = path.join(TOOL_DIR, 'output');
const CUSTOM_RECORDER = path.join(TOOL_DIR, 'custom-recorder.js');
const { loadConfig } = require('./recording-config');

// 浏览器检测
let BROWSER_CHANNEL = 'chrome';
try {
  const { execSync } = require('child_process');
  execSync('reg query "HKLM\\SOFTWARE\\Google\\Chrome\\BLBeacon" /v version', { stdio: 'pipe' });
} catch {
  try {
    const { execSync } = require('child_process');
    execSync('reg query "HKCU\\SOFTWARE\\Google\\Chrome\\BLBeacon" /v version', { stdio: 'pipe' });
  } catch {
    BROWSER_CHANNEL = 'msedge';
  }
}

// 当前录制进程
let currentRecord = null;

// 日志系统
const logs = [];
const MAX_LOGS = 500;
function addLog(msg, level = 'info') {
  const entry = { time: new Date().toLocaleTimeString(), level, msg };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  console.log(`[${level}] ${msg}`);
}

// ========== 路由 ==========

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // 静态文件
    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(TOOL_DIR, 'public', 'index.html'), 'text/html');
    }

    // API
    if (pathname === '/api/config') return handleGetConfig(res);
    if (pathname === '/api/record/start' && req.method === 'POST') return handleStartRecord(req, res);
    if (pathname === '/api/record/status') return handleRecordStatus(res);
    if (pathname === '/api/record/stop' && req.method === 'POST') return handleStopRecord(res);
    if (pathname === '/api/files') return handleListFiles(res);
    if (pathname === '/api/delete' && req.method === 'POST') return handleDelete(req, res);
    if (pathname === '/api/open') return handleOpenInExplorer(url, res);
    if (pathname === '/api/logs') return handleGetLogs(res);
    if (pathname === '/api/channel') return handleGetChannel(res);

    res.writeHead(404); res.end('Not Found');
  } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

// ========== API 处理 ==========

function handleGetConfig(res) {
  const lines = [];
  if (fs.existsSync(CONFIG_FILE)) {
    const content = fs.readFileSync(CONFIG_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        lines.push({ name: trimmed.slice(0, eq).trim(), url: trimmed.slice(eq + 1).trim() });
      }
    }
  }
  let recording;
  try { recording = loadConfig(); } catch (error) { recording = { error: error.message }; }
  json(res, { systems: lines, channel: BROWSER_CHANNEL, recording });
}

function handleStartRecord(req, res) {
  if (currentRecord && !currentRecord.exited) {
    return json(res, { error: '录制已在进行中' }, 409);
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let requestData;
    try { requestData = JSON.parse(body || '{}'); } catch (error) { return json(res, { error: `请求 JSON 无效: ${error.message}` }, 400); }
    const { url, flowName } = requestData;
    let effectiveConfig;
    try { effectiveConfig = loadConfig(); } catch (error) { addLog(error.message, 'error'); return json(res, { error: error.message }, 400); }

    const safeName = (flowName || '录制').replace(/[\\/:*?"<>|]/g, '_').trim() || '录制';
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    let folderName;
    do { folderName = `${dateStr}_${safeName}_${timeStr}_${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`; } while (fs.existsSync(path.join(OUTPUT_DIR, folderName)));
    const outFolder = path.join(OUTPUT_DIR, folderName);
    fs.mkdirSync(outFolder, { recursive: true });

    const args = [CUSTOM_RECORDER, url || '', outFolder];

    const proc = spawn(NODE_EXE, args, {
      // 保留 IPC 通道，让“完成并保存”由录制器自行收尾并写出证据包。
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(TOOL_DIR, 'ms-playwright'),
        RECORDER_BROWSER_CHANNEL: BROWSER_CHANNEL,
      },
    });

    currentRecord = {
      proc,
      url: url || '(手动导航)',
      flowName: safeName,
      outFolder,
      exited: false,
      exitCode: null,
      startTime: Date.now(),
      stopping: false,
      forced: false,
      config: effectiveConfig,
      stopTimer: null,
    };

    addLog(`录制开始: ${safeName} | ${url || '手动导航'}`, 'info');

    proc.stdout.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      lines.forEach(l => addLog(l, 'info'));
    });

    proc.stderr.on('data', d => {
      const lines = d.toString().split('\n').filter(l => l.trim());
      lines.forEach(l => addLog(l, 'error'));
    });

    proc.on('exit', (code) => {
      if (currentRecord.stopTimer) clearTimeout(currentRecord.stopTimer);
      currentRecord.exited = true;
      currentRecord.exitCode = code;
      const evidenceFile = path.join(currentRecord.outFolder, 'evidence.json');
      const evidenceExists = fs.existsSync(evidenceFile);
      const evidenceSize = evidenceExists ? fs.statSync(evidenceFile).size : 0;
      let complete = false;
      try { complete = evidenceExists && JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).complete === true; } catch (_) {}
      const success = evidenceSize > 0 && complete;
      addLog(`录制结束: ${safeName} | ${success ? '成功' : '失败(错误码=' + code + ')'} | 文件: ${evidenceSize}字节`, success ? 'success' : 'error');
      const logFile = path.join(OUTPUT_DIR, '录制日志.txt');
      const logLine = `[${new Date().toLocaleString()}] ${safeName} | ${url || '手动导航'} | ${success ? '成功' : '失败(code=' + code + ')'}`;
      fs.appendFileSync(logFile, logLine + '\n');
    });

    json(res, { message: '录制已启动', folder: folderName });
  });
}

function handleRecordStatus(res) {
  if (!currentRecord) return json(res, { status: 'idle' });

  const elapsed = Math.round((Date.now() - currentRecord.startTime) / 1000);

  // 主动检测：进程已退出但事件未触发的情况
  if (!currentRecord.exited && currentRecord.proc && currentRecord.proc.exitCode !== null) {
    currentRecord.exited = true;
    currentRecord.exitCode = currentRecord.proc.exitCode;
  }

  // 文件检测：以 evidence.json 的完整性状态为准
  const evidenceFile = path.join(currentRecord.outFolder, 'evidence.json');
  const evidenceExists = fs.existsSync(evidenceFile);
  const evidenceSize = evidenceExists ? fs.statSync(evidenceFile).size : 0;
  let complete = false;
  try { complete = evidenceExists && JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).complete === true; } catch (_) {}

  if (currentRecord.exited || evidenceSize > 0) {
    const success = evidenceSize > 0 && complete;
    return json(res, {
      status: success ? 'completed' : 'error',
      exitCode: currentRecord.exitCode,
      elapsed,
      folder: currentRecord.outFolder,
      evidenceFile: evidenceExists ? evidenceFile : null,
      evidenceSize,
      archiveFile: fs.existsSync(path.join(currentRecord.outFolder, 'evidence.zip')) ? path.join(currentRecord.outFolder, 'evidence.zip') : null,
      forced: currentRecord.forced,
    });
  }

  return json(res, { status: 'recording', elapsed, stopping: currentRecord.stopping });
}

function handleStopRecord(res) {
  if (currentRecord && !currentRecord.exited) {
    if (currentRecord.stopping) {
      return json(res, { message: '正在保存录制结果' });
    }
    if (!currentRecord.proc.connected) {
      return json(res, { error: '录制进程无法接收保存请求' }, 500);
    }

    currentRecord.stopping = true;
    currentRecord.proc.send({ type: 'stop' }, (error) => {
      if (error) addLog(`保存请求发送失败: ${error.message}`, 'error');
    });
    currentRecord.stopTimer = setTimeout(() => {
      if (!currentRecord.exited) {
        currentRecord.forced = true;
        addLog(`录制保存超过 15 秒，强制结束: ${currentRecord.flowName}`, 'error');
        currentRecord.proc.kill();
      }
    }, 15000);
    addLog(`正在保存录制: ${currentRecord.flowName}`, 'info');
    json(res, { message: '正在保存录制结果' });
  } else {
    json(res, { message: '没有进行中的录制' });
  }
}

function handleDelete(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let folderPath;
    try { folderPath = JSON.parse(body || '{}').folderPath; } catch (error) { return json(res, { error: `请求 JSON 无效: ${error.message}` }, 400); }
    if (!folderPath || !fs.existsSync(folderPath)) {
      return json(res, { error: '文件夹不存在' }, 400);
    }
    // 安全检查：只允许删除 output 目录下的文件夹
    const resolvedFolder = path.resolve(folderPath);
    const resolvedOutput = path.resolve(OUTPUT_DIR);
    if (resolvedFolder === resolvedOutput || !resolvedFolder.startsWith(resolvedOutput + path.sep)) {
      return json(res, { error: '不允许删除此目录' }, 403);
    }
    fs.rmSync(resolvedFolder, { recursive: true, force: true });
    addLog(`已删除: ${path.basename(resolvedFolder)}`, 'info');
    json(res, { message: '已删除' });
  });
}

function handleListFiles(res) {
  const folders = [];
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      const full = path.join(OUTPUT_DIR, name);
      if (!fs.statSync(full).isDirectory()) continue;
      const files = {};
      for (const f of fs.readdirSync(full)) {
        const fp = path.join(full, f);
        files[f] = { size: fs.statSync(fp).size, path: fp };
      }
      folders.push({ name, path: full, files });
    }
  }
  json(res, { folders });
}

function handleOpenInExplorer(url, res) {
  const filePath = url.searchParams.get('path');
  if (!filePath || !fs.existsSync(filePath)) {
    json(res, { error: '文件不存在' }, 404);
    return;
  }
  const { exec } = require('child_process');
  exec(`explorer /select,"${filePath}"`);
  addLog(`已在资源管理器中打开: ${path.basename(filePath)}`);
  json(res, { message: '已打开' });
}

function handleGetLogs(res) {
  json(res, { logs });
}

function handleGetChannel(res) {
  json(res, { channel: BROWSER_CHANNEL });
}

// ========== 工具函数 ==========

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType, downloadName) {
  const content = fs.readFileSync(filePath);
  const headers = { 'Content-Type': contentType + '; charset=utf-8' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(downloadName)}"`;
  res.writeHead(200, headers);
  res.end(content);
}

function runCommand(exe, args) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const proc = spawn(exe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(TOOL_DIR, 'ms-playwright') },
    });
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else { const e = new Error(`Exit code ${code}`); e.stderr = stderr; reject(e); }
    });
  });
}

// ========== 启动 ==========

server.listen(PORT, () => {
  addLog('Recording_tools v2.0 已启动', 'success');
  addLog('--- 环境检查 ---');
  addLog(`Node.js: ${process.version} (${process.platform} ${process.arch})`);
  addLog(`浏览器引擎: ${BROWSER_CHANNEL} ${BROWSER_CHANNEL === 'chrome' ? '(Chrome)' : '(Edge)'}`);
  addLog(`录制脚本: ${fs.existsSync(CUSTOM_RECORDER) ? 'custom-recorder.js ✅' : 'custom-recorder.js ❌ 缺失'}`);
  addLog(`播放器组件: ${fs.existsSync(path.join(TOOL_DIR, 'ms-playwright', 'ffmpeg-1011')) ? 'ffmpeg ✅' : 'ffmpeg ❌ 缺失'}`);
  addLog(`输出目录: ${OUTPUT_DIR}`);
  addLog(`服务地址: http://localhost:${PORT}`);
  addLog('--- 等待操作 ---');
  // 自动打开浏览器
  const { exec } = require('child_process');
  exec(`start http://localhost:${PORT}`);
});
