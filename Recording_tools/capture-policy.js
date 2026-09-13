'use strict';

const POLICY_VERSION = 1;
const MODES = ['slim', 'standard', 'full', 'custom'];
const POLICY_KEYS = [
  'screenshots',
  'dom',
  'networkMetadata',
  'responseBodies',
  'consoleErrors',
  'trace',
  'downloads',
  'includeThirdParty',
  'includeStatic',
  'archive',
];

const MODE_DEFINITIONS = Object.freeze({
  slim: {
    label: '精简',
    size: '小',
    description: '保留动作主线、定位、截图和错误级控制台信息。',
    enabled: ['screenshots', 'consoleErrors', 'archive'],
    disabled: ['dom', 'networkMetadata', 'responseBodies', 'trace', 'downloads', 'includeThirdParty', 'includeStatic'],
  },
  standard: {
    label: '标准',
    size: '中',
    description: '保留页面截图、DOM、网络元数据和错误级控制台信息。',
    enabled: ['screenshots', 'dom', 'networkMetadata', 'consoleErrors', 'archive'],
    disabled: ['responseBodies', 'trace', 'downloads', 'includeThirdParty', 'includeStatic'],
  },
  full: {
    label: '完整',
    size: '大',
    description: '保存全部可选采集项，适合完整排查，文件体积最大。',
    enabled: POLICY_KEYS.slice(),
    disabled: [],
  },
  custom: {
    label: '自定义',
    size: '可变',
    description: '按高级选项自由组合采集范围。',
    enabled: [],
    disabled: [],
  },
});

const ADVANCED_ITEMS = Object.freeze([
  { key: 'screenshots', label: '截图', description: '保存每个逻辑步骤前后的当前视口 PNG，便于确认页面状态。' },
  { key: 'dom', label: 'DOM', description: '保存 HTML 快照和可见文本摘要，可能包含表单原始值和敏感文本。' },
  { key: 'networkMetadata', label: '网络元数据', description: '保存请求 URL、方法、资源类型、状态、耗时和步骤关联，不保存响应正文。' },
  { key: 'responseBodies', label: '响应体', description: '按现有大小和 Content-Type 限制保存文本或 JSON 响应，可能显著增加体积。' },
  { key: 'consoleErrors', label: '控制台错误/页面异常', description: '保存 warning、error、未捕获异常和 page error，不保存普通日志。' },
  { key: 'trace', label: 'Playwright Trace', description: '保存可用 Trace Viewer 打开的 trace.zip，不是 Wireshark 抓包文件。' },
  { key: 'downloads', label: '下载文件', description: '保存录制期间触发的下载及其元数据，文件可能很大或含敏感信息。' },
  { key: 'includeThirdParty', label: '第三方请求', description: '网络开启时包含非目标站点请求，会增加体积和隐私范围。' },
  { key: 'includeStatic', label: '静态资源请求', description: '网络开启时包含图片、字体、脚本和样式等请求，通常数量较多。' },
  { key: 'archive', label: 'ZIP 归档', description: '将已生成的证据目录打包为 evidence.zip；关闭后仍保留目录本身。' },
]);

const STANDARD_POLICY = Object.freeze({
  version: POLICY_VERSION,
  mode: 'standard',
  screenshots: true,
  dom: true,
  networkMetadata: true,
  responseBodies: false,
  consoleErrors: true,
  trace: false,
  downloads: false,
  includeThirdParty: false,
  includeStatic: false,
  archive: true,
});

const PRESET_POLICIES = Object.freeze({
  slim: Object.freeze({ version: POLICY_VERSION, mode: 'slim', screenshots: true, dom: false, networkMetadata: false, responseBodies: false, consoleErrors: true, trace: false, downloads: false, includeThirdParty: false, includeStatic: false, archive: true }),
  standard: STANDARD_POLICY,
  full: Object.freeze({ version: POLICY_VERSION, mode: 'full', screenshots: true, dom: true, networkMetadata: true, responseBodies: true, consoleErrors: true, trace: true, downloads: true, includeThirdParty: true, includeStatic: true, archive: true }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function invalid(message) {
  throw new Error(`采集策略校验失败: ${message}`);
}

function validateShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('必须是对象');
  if (input.version != null && input.version !== POLICY_VERSION) invalid(`version 必须是 ${POLICY_VERSION}`);
  if (input.mode != null && !MODES.includes(input.mode)) invalid(`mode 必须是 ${MODES.join('、')}`);
  for (const key of Object.keys(input)) {
    if (key !== 'version' && key !== 'mode' && !POLICY_KEYS.includes(key)) invalid(`未知字段: ${key}`);
    if (POLICY_KEYS.includes(key) && typeof input[key] !== 'boolean') invalid(`${key} 必须是布尔值`);
  }
  if (input.responseBodies === true && input.networkMetadata === false) invalid('responseBodies=true 时 networkMetadata 必须为 true');
}

function resolveCapturePolicy(requested, recordingConfig = {}) {
  const input = requested == null ? { mode: 'standard' } : requested;
  validateShape(input);
  const mode = input.mode || 'standard';
  let policy;
  if (mode === 'custom') {
    policy = { ...clone(STANDARD_POLICY), ...clone(input), mode: 'custom', version: POLICY_VERSION };
  } else {
    const preset = PRESET_POLICIES[mode];
    for (const key of POLICY_KEYS) {
      if (key in input && input[key] !== preset[key]) invalid(`${mode} 模式不允许修改 ${key}，请使用 custom`);
    }
    policy = { ...clone(preset), ...clone(input), mode, version: POLICY_VERSION };
  }
  const warnings = [];
  if (recordingConfig.zip === false && policy.archive) {
    policy.archive = false;
    warnings.push({ scope: 'capture_policy', message: 'recording.config.json 已关闭 ZIP，当前录制不生成 evidence.zip', code: 'archive_disabled_by_config' });
  }
  return { policy, warnings };
}

function createCaptureSummary(policy) {
  const enabled = [];
  const disabled = [];
  for (const key of POLICY_KEYS) {
    if (policy[key]) enabled.push(key);
    else disabled.push({ item: key, reason: 'disabled_by_policy' });
  }
  return { enabled, disabled };
}

function getModeDefinitions() {
  return {
    version: POLICY_VERSION,
    defaultMode: 'standard',
    modes: clone(MODE_DEFINITIONS),
    presets: clone(PRESET_POLICIES),
    advancedItems: clone(ADVANCED_ITEMS),
  };
}

module.exports = {
  POLICY_VERSION,
  POLICY_KEYS,
  PRESET_POLICIES,
  STANDARD_POLICY,
  resolveCapturePolicy,
  createCaptureSummary,
  getModeDefinitions,
};
