// Dependency-free self-test for scripts/audit-gate.mjs (node:test, no npm deps).
// Run: node --test scripts/audit-gate.test.mjs
//
// The fixture scripts/fixtures/audit-gate/report.json is the real output of
// `npm audit --audit-level=high --json` for this repo's lockfile, captured on
// 2026-10-06 with npm 11.18 (exit status 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'audit-gate.mjs');
const REPORT_TEXT = fs.readFileSync(path.join(HERE, 'fixtures', 'audit-gate', 'report.json'), 'utf8');
const BRACES_ID = 'GHSA-vfj7-8cjw-p6xm';
const OTHER_ID = 'GHSA-cccc-ffff-gggg';

function isoDay(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function allowlist(overrides = {}) {
  return JSON.stringify({
    entries: [
      { id: BRACES_ID, reason: 'test entry', reviewBy: isoDay(30), ...overrides },
    ],
  });
}

// The real report plus one more HIGH advisory that no allowlist entry covers.
function reportWithOtherHigh() {
  const report = JSON.parse(REPORT_TEXT);
  report.vulnerabilities['other-pkg'] = {
    name: 'other-pkg',
    severity: 'high',
    isDirect: false,
    via: [
      {
        source: 1,
        name: 'other-pkg',
        dependency: 'other-pkg',
        title: 'synthetic advisory',
        url: `https://github.com/advisories/${OTHER_ID}`,
        severity: 'high',
        range: '*',
      },
    ],
    effects: [],
    range: '*',
    nodes: ['node_modules/other-pkg'],
    fixAvailable: false,
  };
  return JSON.stringify(report);
}

function setup({ stdout = REPORT_TEXT, stderr = '', allow = allowlist() }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-test-'));
  fs.writeFileSync(path.join(dir, 'out.json'), stdout);
  fs.writeFileSync(path.join(dir, 'err.txt'), stderr);
  fs.writeFileSync(path.join(dir, 'allow.json'), allow);
  return dir;
}

function gate(dir, { status = '1', script = SCRIPT } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      script,
      '--allowlist', path.join(dir, 'allow.json'),
      '--status', status,
      '--stdout', path.join(dir, 'out.json'),
      '--stderr', path.join(dir, 'err.txt'),
    ],
    { encoding: 'utf8' },
  );
  return { code: result.status, out: result.stdout + result.stderr };
}

test('allowlisted-only report exits 0 with the excepted line and CLEAN', () => {
  const { code, out } = gate(setup({}));
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(`excepted by allowlist: ${BRACES_ID}`));
  assert.match(out, /CLEAN/);
});

test('allowlisted advisory plus another HIGH advisory exits 1', () => {
  const { code, out } = gate(setup({ stdout: reportWithOtherHigh() }));
  assert.equal(code, 1, out);
  assert.match(out, /FINDINGS/);
  assert.match(out, new RegExp(OTHER_ID));
});

test('expired allowlist entry exits 1', () => {
  const { code, out } = gate(setup({ allow: allowlist({ reviewBy: isoDay(-1) }) }));
  assert.equal(code, 1, out);
  assert.match(out, /expired/);
});

test('malformed allowlist exits 3', () => {
  const { code, out } = gate(setup({ allow: '{"entries": "nope"}' }));
  assert.equal(code, 3, out);
  assert.match(out, /UNCLASSIFIED/);
});

test('npm error JSON without a report exits 2 (outage)', () => {
  const errorBody = JSON.stringify({
    error: {
      code: 'ENOTFOUND',
      summary: 'audit endpoint returned an error',
      detail: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed',
    },
  });
  const { code, out } = gate(setup({ stdout: errorBody, stderr: 'npm error code ENOTFOUND\n' }));
  assert.equal(code, 2, out);
  assert.match(out, /OUTAGE/);
});

test('script spawned through a symlink still exits 1 with a FINDINGS line on the findings fixture', () => {
  const dir = setup({ stdout: reportWithOtherHigh() });
  const link = path.join(dir, 'audit-gate-link.mjs');
  fs.symlinkSync(SCRIPT, link);
  const { code, out } = gate(dir, { script: link });
  assert.equal(code, 1, out);
  assert.match(out, /FINDINGS/);
});
