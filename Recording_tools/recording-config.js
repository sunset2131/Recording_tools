'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({
  captureResponseBodies: true,
  responseBodyMaxBytes: 1024 * 1024,
  domSnapshotMaxBytes: 5 * 1024 * 1024,
  trace: true,
  zip: true,
  network: {
    includeThirdParty: true,
    includeStatic: true,
  },
});

const CONFIG_FILE = path.join(__dirname, 'recording.config.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadConfig(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) return clone(DEFAULT_CONFIG);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`recording.config.json JSON 格式错误: ${error.message}`);
  }
  const errors = [];
  const allowed = new Set(['captureResponseBodies', 'responseBodyMaxBytes', 'domSnapshotMaxBytes', 'trace', 'zip', 'network']);
  for (const key of Object.keys(parsed || {})) if (!allowed.has(key)) errors.push(`未知字段: ${key}`);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push('配置根节点必须是对象');
  if (parsed && 'captureResponseBodies' in parsed && typeof parsed.captureResponseBodies !== 'boolean') errors.push('captureResponseBodies 必须是布尔值');
  if (parsed && 'trace' in parsed && typeof parsed.trace !== 'boolean') errors.push('trace 必须是布尔值');
  if (parsed && 'zip' in parsed && typeof parsed.zip !== 'boolean') errors.push('zip 必须是布尔值');
  for (const key of ['responseBodyMaxBytes', 'domSnapshotMaxBytes']) {
    if (parsed && key in parsed && (!Number.isInteger(parsed[key]) || parsed[key] < 1024 || parsed[key] > 100 * 1024 * 1024)) {
      errors.push(`${key} 必须是 1024 到 104857600 之间的整数`);
    }
  }
  if (parsed && 'network' in parsed) {
    if (!parsed.network || typeof parsed.network !== 'object' || Array.isArray(parsed.network)) errors.push('network 必须是对象');
    else for (const key of Object.keys(parsed.network)) if (!['includeThirdParty', 'includeStatic'].includes(key)) errors.push(`未知字段: network.${key}`);
    if (parsed.network && 'includeThirdParty' in parsed.network && typeof parsed.network.includeThirdParty !== 'boolean') errors.push('network.includeThirdParty 必须是布尔值');
    if (parsed.network && 'includeStatic' in parsed.network && typeof parsed.network.includeStatic !== 'boolean') errors.push('network.includeStatic 必须是布尔值');
  }
  if (errors.length) throw new Error(`录制配置校验失败: ${errors.join('; ')}`);
  const result = clone(DEFAULT_CONFIG);
  Object.assign(result, parsed);
  result.network = Object.assign({}, DEFAULT_CONFIG.network, parsed.network || {});
  return result;
}

module.exports = { DEFAULT_CONFIG, CONFIG_FILE, loadConfig };
