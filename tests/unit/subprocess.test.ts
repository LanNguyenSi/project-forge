import { describe, it, expect, afterEach } from 'vitest';
import { runCommand } from '@/lib/subprocess';

/**
 * Unit tests for lib/subprocess.ts — uses real OS commands (no mocking).
 * Branches:
 *   1. Successful command (exit 0) → resolves with stdout
 *   2. Nonzero exit code → rejects with message containing the code
 *   3. Binary not found → rejects with 'Failed to execute'
 *   4. Output larger than the pipe buffer, child exits right away → complete
 *   5. Output written after the child exited is still captured
 *   6. Grandchild holds the pipes open after the child exited → settles
 *      after the grace period with the output captured so far
 *   7. Grace path keeps the child's exit code, also when the child was
 *      killed by the timeout
 *   8. The closeGraceMs option is honoured
 */

const OPTS = { cwd: '/tmp', timeoutMs: 10_000 };

/** Script source: spawn a detached grandchild that holds the inherited pipes for `ms`, report its pid on stdout. */
const holder = (ms: number) =>
  `const g=require('child_process').spawn(process.execPath,` +
  `['-e','setTimeout(()=>{},${ms})'],{stdio:'inherit',detached:true});g.unref();` +
  `process.stdout.write('gc='+g.pid+';');`;

const grandchildren: number[] = [];

/** Record the grandchild pid found in a result or error text so afterEach can kill it. */
function track(text: string) {
  const m = /gc=(\d+);/.exec(text);
  if (m) grandchildren.push(Number(m[1]));
}

afterEach(() => {
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

describe('runCommand', () => {
  it('resolves with stdout when command exits 0', async () => {
    const result = await runCommand('echo', ['hello-from-subprocess'], OPTS);
    expect(result.stdout).toContain('hello-from-subprocess');
    // stderr may be empty or absent — only stdout matters here
  });

  it('resolves with empty stdout for command with no output', async () => {
    const result = await runCommand('true', [], OPTS);
    expect(result.stdout).toBe('');
  });

  it('rejects with exit-code message when command exits non-zero', async () => {
    await expect(
      runCommand('node', ['-e', 'process.exit(1)'], OPTS)
    ).rejects.toThrow(/exited with code 1/);
  });

  it('rejects with exit-code message when command exits with code 2', async () => {
    await expect(
      runCommand('node', ['-e', 'process.exit(2)'], OPTS)
    ).rejects.toThrow(/exited with code 2/);
  });

  it('rejects with "Failed to execute" when binary does not exist', async () => {
    await expect(
      runCommand('definitely-not-a-real-binary-xyz', [], OPTS)
    ).rejects.toThrow(/Failed to execute/);
  });

  it('returns complete stdout larger than the pipe buffer (regression check)', async () => {
    // Plain regression check: it also passes when settling on "exit"; the
    // late-output test below is the one that pins the close-based settle.
    const size = 4 * 1024 * 1024;
    const result = await runCommand('head', ['-c', String(size), '/dev/zero'], OPTS);
    expect(result.stdout.length).toBe(size);
  });

  it('waits for output written after the child exited (stdio still open)', async () => {
    // The child exits 0 at once; a grandchild holding the pipe writes later.
    // Settling on "exit" would return '' here, every time. A long grace makes
    // sure the result comes from "close", not from the grace timer.
    const script =
      `require('child_process').spawn(process.execPath,` +
      `['-e','setTimeout(()=>process.stdout.write("late-output"),300)'],` +
      `{stdio:'inherit',detached:true}).unref();`;
    const started = Date.now();
    const result = await runCommand('node', ['-e', script], {
      ...OPTS,
      closeGraceMs: 30_000,
    });
    expect(result.stdout).toBe('late-output');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('settles after the grace period when a grandchild keeps the pipes open', async () => {
    const script = holder(3000) + `process.stdout.write('partial');`;
    const started = Date.now();
    const result = await runCommand('node', ['-e', script], {
      ...OPTS,
      closeGraceMs: 200,
    });
    track(result.stdout);
    expect(result.stdout).toContain('partial');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('keeps a non-zero exit code on the grace path', async () => {
    const script = holder(3000) + `process.exitCode=3;`;
    const err = await runCommand('node', ['-e', script], {
      ...OPTS,
      closeGraceMs: 200,
    }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    track(err!.message);
    expect(err!.message).toMatch(/code 3/);
  });

  it('rejects a child killed by the timeout while a grandchild holds the pipes', async () => {
    const script = holder(3000) + `setInterval(()=>{},1000);`;
    const err = await runCommand('node', ['-e', script], {
      cwd: '/tmp',
      timeoutMs: 500,
      closeGraceMs: 200,
    }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).not.toBeNull();
    track(err!.message);
    expect(err!.message).toMatch(/exited with code/);
  });

  it('honours closeGraceMs (waits for the configured grace, not the default)', async () => {
    const script = holder(7000);
    const started = Date.now();
    const result = await runCommand('node', ['-e', script], {
      ...OPTS,
      closeGraceMs: 4000,
    });
    track(result.stdout);
    // Default grace is 2000 ms; a lower bound well above it shows the option is read.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3500);
  }, 15_000);
});
