'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RecordingSession } = require('../custom-recorder');

async function run() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-index-'));
  const previousPolicy = process.env.RECORDER_CAPTURE_POLICY;
  try {
    process.env.RECORDER_CAPTURE_POLICY = JSON.stringify({
      mode: 'custom',
      screenshots: false,
      dom: false,
      networkMetadata: false,
      responseBodies: false,
      consoleErrors: false,
      trace: false,
      downloads: false,
      includeThirdParty: false,
      includeStatic: false,
      archive: false,
    });
    const session = new RecordingSession('', temp);
    await session.finalize(false);
    const evidence = JSON.parse(fs.readFileSync(path.join(temp, 'evidence.json'), 'utf8'));
    assert.strictEqual(evidence.complete, true);
    assert.strictEqual(evidence.capturePolicy.mode, 'custom');
    assert.strictEqual(evidence.files.network, null);
    assert.strictEqual(evidence.files.console, null);
    assert.strictEqual(evidence.files.pages, null);
    assert.strictEqual(evidence.files.archive, null);
    assert(evidence.captureSummary.disabled.some(item => item.item === 'dom'));
    assert(!fs.existsSync(path.join(temp, 'network.jsonl')));
    assert(!fs.existsSync(path.join(temp, 'console.jsonl')));
    assert(fs.existsSync(path.join(temp, 'actions.json')));
    console.log('recorder-index tests passed');
  } finally {
    if (previousPolicy == null) delete process.env.RECORDER_CAPTURE_POLICY;
    else process.env.RECORDER_CAPTURE_POLICY = previousPolicy;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
