import { describe, it, expect } from 'vitest';
import { runCommand } from '@/lib/subprocess';

/**
 * Unit tests for lib/subprocess.ts — uses real OS commands (no mocking).
 * Three branches:
 *   1. Successful command (exit 0) → resolves with stdout
 *   2. Nonzero exit code → rejects with message containing the code
 *   3. Binary not found → rejects with 'Failed to execute'
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
});
