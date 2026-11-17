import { describe, it, expect } from 'vitest';
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
 */

const OPTS = { cwd: '/tmp', timeoutMs: 10_000 };

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

  it('returns complete stdout larger than the pipe buffer', async () => {
    // head writes straight to the pipe and exits; the last chunk is still
    // unread by the parent when "exit" fires.
    const size = 4 * 1024 * 1024;
    const result = await runCommand('head', ['-c', String(size), '/dev/zero'], OPTS);
    expect(result.stdout.length).toBe(size);
  });

  it('waits for output written after the child exited (stdio still open)', async () => {
    // The child exits 0 at once; a grandchild holding the pipe writes later.
    // Settling on "exit" would return '' here, every time.
    const script =
      `require('child_process').spawn(process.execPath,` +
      `['-e','setTimeout(()=>process.stdout.write("late-output"),300)'],` +
      `{stdio:'inherit',detached:true}).unref();`;
    const result = await runCommand('node', ['-e', script], OPTS);
    expect(result.stdout).toBe('late-output');
  });

  it('settles after the grace period when a grandchild keeps the pipes open', async () => {
    const script =
      `require('child_process').spawn(process.execPath,` +
      `['-e','setTimeout(()=>{},3000)'],{stdio:'inherit',detached:true}).unref();` +
      `process.stdout.write('partial');`;
    const started = Date.now();
    const result = await runCommand('node', ['-e', script], {
      ...OPTS,
      closeGraceMs: 200,
    });
    expect(result.stdout).toBe('partial');
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
