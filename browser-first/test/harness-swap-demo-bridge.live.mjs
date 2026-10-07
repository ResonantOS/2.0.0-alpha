import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyEvidence } from '../../scripts/harness-swap-demo.mjs';

// The in-process fixture certification never crosses the bridge, so it stayed green while every
// live run failed: the driver's own bridge client sent the control token to the POST read routes
// and let a host-closed stream reject with no listener. This runs the same driver the operator
// runs, in fixture mode, through the real bridge, dev server and browser (2026-09-27 field finding).
// It needs Playwright's Chromium and port 1430, so it runs through test:browser-first:harness-demo in
// the live-certification lane rather than the default gate, and it never skips: absent browser = red.
test('fixture demo through the real bridge completes and verifies', { timeout: 180000 }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'harness-swap-demo-bridge-'));
  const evidenceDir = path.join(parent, 'evidence');
  try {
    const script = fileURLToPath(new URL('../../scripts/harness-swap-demo.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, evidenceDir, '--fixture'], { encoding: 'utf8', timeout: 170000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.doesNotMatch(run.stderr, /permission-denied|unhandled|TypeError: terminated/);
    const bundle = JSON.parse(readFileSync(path.join(evidenceDir, 'evidence.json'), 'utf8'));
    assert.equal(verifyEvidence(bundle, { requireLive: false }), true);
    assert.equal(bundle.governance.degrade.upstreamAccepted, true);
  } catch (error) {
    error.message += `\nevidence kept at ${parent}`;
    throw error;
  }
  rmSync(parent, { recursive: true, force: true });
});
