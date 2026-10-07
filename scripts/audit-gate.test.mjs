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

// npm derives metadata.vulnerabilities from the same package map the gate walks, and the
// gate cross-checks the two, so a synthetic report needs its tally recomputed after
// its map is edited.
function withTally(report) {
  const copy = structuredClone(report);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const entry of Object.values(copy.vulnerabilities)) {
    if (entry.severity in counts && entry.severity !== 'total') counts[entry.severity] += 1;
    counts.total += 1;
  }
  copy.metadata = { ...copy.metadata, vulnerabilities: counts };
  return copy;
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
  return JSON.stringify(withTally(report));
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

// Hardened gate: metadata cross-check and sanitised npm stderr. These cases run the
// script as a child process like the ones above, on this tree's real npm output.
const HG_BASES = [['report.json', JSON.parse(REPORT_TEXT)]];
const HG_ID = 'GHSA-vfj7-8cjw-p6xm';

function hgRun({ report, stdout, stderr = '', status = 1, argv }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-hardened-'));
  try {
    const review = new Date();
    review.setUTCDate(review.getUTCDate() + 30);
    fs.writeFileSync(
      path.join(dir, 'allow.json'),
      JSON.stringify({ entries: [{ id: HG_ID, reason: 'test entry', reviewBy: review.toISOString().slice(0, 10) }] }),
    );
    fs.writeFileSync(path.join(dir, 'out.json'), stdout ?? JSON.stringify(report));
    fs.writeFileSync(path.join(dir, 'err.txt'), stderr);
    const args = argv
      ? argv(dir)
      : [
          '--allowlist', path.join(dir, 'allow.json'),
          '--status', String(status),
          '--stdout', path.join(dir, 'out.json'),
          '--stderr', path.join(dir, 'err.txt'),
        ];
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: result.status, text: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hgWithCounts(report, counts) {
  const copy = structuredClone(report);
  copy.metadata = { ...copy.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, ...counts } };
  return copy;
}

for (const [name, base] of HG_BASES) {
  test(`hardened gate: the real report's own metadata tally is not UNCLASSIFIED (${name})`, () => {
    const { code, text } = hgRun({ report: base });
    assert.equal(code, 0, text);
    assert.match(text, /^npm audit gate: CLEAN: /m);
  });
}

const [HG_NAME, HG_BASE] = HG_BASES[0];
const HG_TALLY = withTally(HG_BASE).metadata.vulnerabilities;

test(`hardened gate: a tally with criticals the map does not show is UNCLASSIFIED (${HG_NAME})`, () => {
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: HG_TALLY.high, critical: HG_TALLY.critical + 2 }) });
  assert.equal(code, 3, text);
  assert.match(text, /UNCLASSIFIED: inconsistent audit report/);
  assert.doesNotMatch(text, /CLEAN/);
});

test('hardened gate: a tally lower than the map is UNCLASSIFIED', () => {
  assert.ok(HG_TALLY.high > 0, 'fixture must carry a high advisory');
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: HG_TALLY.high - 1, critical: HG_TALLY.critical }) });
  assert.equal(code, 3, text);
  assert.doesNotMatch(text, /CLEAN/);
});

test('hardened gate: a report without a metadata tally is UNCLASSIFIED', () => {
  const copy = structuredClone(HG_BASE);
  delete copy.metadata;
  const { code, text } = hgRun({ report: copy });
  assert.equal(code, 3, text);
  assert.match(text, /no metadata\.vulnerabilities tally/);
});

test('hardened gate: a negative count that still sums to the map size is UNCLASSIFIED', () => {
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: HG_TALLY.high + HG_TALLY.critical + 1, critical: -1 }) });
  assert.equal(code, 3, text);
  assert.match(text, /not non-negative integers/);
});

test('hardened gate: non-integer counts are UNCLASSIFIED', () => {
  const { code, text } = hgRun({ report: hgWithCounts(HG_BASE, { high: String(HG_TALLY.high), critical: 0 }) });
  assert.equal(code, 3, text);
});

const HG_FORGED = [
  '::error::forged finding',
  'npm error ::set-output name=x::y',
  '::stop-commands::token',
  'npm error line\u2028::warning::split',
].join('\n');

test('hardened gate: no npm stderr line starts a workflow command', () => {
  const { text } = hgRun({ report: HG_BASE, stderr: HG_FORGED });
  for (const line of text.split('\n')) {
    assert.equal(/^::(?!(error|warning)::npm audit gate: )/.test(line), false, line);
  }
  assert.ok(!text.includes('::stop-commands::'));
  assert.ok(!text.includes('::set-output'));
  assert.ok(!text.includes('::error::forged'));
  assert.ok(!text.includes('::warning::split'));
  assert.ok(text.includes('npm stderr| '));
  assert.ok(text.includes('forged finding'));
});

test('hardened gate: the same holds when the stderr text decides an outage', () => {
  const { code, text } = hgRun({ stdout: '', stderr: '::error::forged\nnpm error code ENOTFOUND' });
  assert.equal(code, 2, text);
  assert.ok(!text.includes('\n::error::forged'));
  assert.ok(!text.startsWith('::error::forged'));
});

test('hardened gate: a long stderr is bounded', () => {
  const { text } = hgRun({ report: HG_BASE, stderr: 'x\n'.repeat(500) });
  assert.ok(text.split('\n').length < 80);
  assert.ok(text.includes('more line(s) omitted'));
});

test('hardened gate: an unreadable captured stderr is UNCLASSIFIED', () => {
  const { code, text } = hgRun({
    report: HG_BASE,
    argv: (dir) => [
      '--allowlist', path.join(dir, 'allow.json'),
      '--status', '1',
      '--stdout', path.join(dir, 'out.json'),
      '--stderr', path.join(dir, 'gone.txt'),
    ],
  });
  assert.equal(code, 3, text);
  assert.match(text, /captured npm audit output cannot be read/);
});

test('hardened gate: early exits still print the sanitised npm stderr', () => {
  const forged = '::error::forged\nnpm error ::stop-commands::tok';
  const cases = [
    // allowlist unreadable
    (dir) => ['--allowlist', path.join(dir, 'nope.json'), '--status', '1', '--stdout', path.join(dir, 'out.json'), '--stderr', path.join(dir, 'err.txt')],
    // captured stdout unreadable
    (dir) => ['--allowlist', path.join(dir, 'allow.json'), '--status', '1', '--stdout', path.join(dir, 'gone.json'), '--stderr', path.join(dir, 'err.txt')],
    // usage error (bad status) with a --stderr file given
    (dir) => ['--allowlist', 'a', '--status', 'x', '--stdout', 'b', '--stderr', path.join(dir, 'err.txt')],
  ];
  for (const argv of cases) {
    const { code, text } = hgRun({ report: HG_BASE, stderr: forged, argv });
    assert.equal(code, 3, text);
    assert.ok(text.includes('npm stderr| : :error: :forged'), text);
    assert.ok(text.includes('npm stderr| npm error : :stop-commands: :tok'), text);
    for (const line of text.split('\n')) {
      assert.equal(/^::(?!error::npm audit gate: )/.test(line), false, line);
      assert.equal(line.startsWith('::error::forged'), false, line);
    }
  }
});
