'use strict';

const assert = require('assert');
const {
  PRESET_POLICIES,
  resolveCapturePolicy,
  createCaptureSummary,
  getModeDefinitions,
} = require('../capture-policy');

const slim = resolveCapturePolicy({ mode: 'slim' }, { zip: true }).policy;
assert.strictEqual(slim.screenshots, true);
assert.strictEqual(slim.dom, false);
assert.strictEqual(slim.networkMetadata, false);
assert.strictEqual(slim.archive, true);

const standard = resolveCapturePolicy(undefined, { zip: true }).policy;
assert.deepStrictEqual(standard, PRESET_POLICIES.standard);

const full = resolveCapturePolicy({ mode: 'full' }, { zip: true }).policy;
assert.strictEqual(full.responseBodies, true);
assert.strictEqual(full.trace, true);
assert.strictEqual(full.includeThirdParty, true);

const custom = resolveCapturePolicy({ mode: 'custom', screenshots: true, dom: false, networkMetadata: false, responseBodies: false }, { zip: true }).policy;
assert.strictEqual(custom.mode, 'custom');
assert.strictEqual(custom.screenshots, true);
assert.strictEqual(custom.dom, false);

assert.throws(() => resolveCapturePolicy({ mode: 'slim', dom: true }, { zip: true }), /不允许修改/);
assert.throws(() => resolveCapturePolicy({ mode: 'custom', responseBodies: true, networkMetadata: false }, { zip: true }), /networkMetadata/);
assert.throws(() => resolveCapturePolicy({ mode: 'custom', unknown: true }, { zip: true }), /未知字段/);
assert.throws(() => resolveCapturePolicy({ mode: 'custom', trace: 'yes' }, { zip: true }), /trace 必须是布尔值/);

const capped = resolveCapturePolicy({ mode: 'full' }, { zip: false });
assert.strictEqual(capped.policy.archive, false);
assert.strictEqual(capped.warnings[0].code, 'archive_disabled_by_config');

const summary = createCaptureSummary(slim);
assert(summary.enabled.includes('screenshots'));
assert(summary.disabled.some(item => item.item === 'dom' && item.reason === 'disabled_by_policy'));

const definitions = getModeDefinitions();
assert.strictEqual(definitions.defaultMode, 'standard');
assert.strictEqual(definitions.modes.slim.label, '精简');
assert(definitions.advancedItems.some(item => item.key === 'trace'));

console.log('capture-policy tests passed');
