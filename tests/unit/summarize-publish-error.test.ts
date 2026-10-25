import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizePublishError } from "@/lib/publish-error";

/**
 * summarizePublishError maps known publish failures to fixed sentences and
 * everything else to the generic internal-error sentence with a reference id.
 * The full (secret-scrubbed) stderr is logged server-side, so these tests
 * also pin that the log keeps the detail while the client-facing sentence
 * carries none of it, that only the generic answer carries a reference id
 * (known cases are logged without one), and that the credentials case
 * matches GitHub-specific forms only, never local failures.
 */

const GENERIC = /^An internal error occurred\. Reference: [0-9a-f]{8}$/;

const WORKFLOW_STDERR = [
  "git exited with code 1",
  "Stdout: ",
  "Stderr: To https://github.com/lan/todo-app.git",
  " ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
  "error: failed to push some refs to 'https://github.com/lan/todo-app.git'",
].join("\n");

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The single logged line: { prefix: "[ref] Publish failed:", blob: ... }. */
function singleLog(): { prefix: string; blob: string } {
  expect(logSpy).toHaveBeenCalledTimes(1);
  const [prefix, blob] = logSpy.mock.calls[0] as [unknown, unknown];
  return { prefix: String(prefix), blob: String(blob) };
}

describe("known case: missing workflow scope", () => {
  it("maps GitHub's push rejection to the workflow-scope sentence", () => {
    const out = summarizePublishError(WORKFLOW_STDERR);
    expect(out).toMatch(/lacks the workflow scope/i);
    expect(out).toMatch(/\.github\/workflows/);
  });

  // The hook text names the credential type, and all three subjects below
  // are supported credentials (docs/api.md); the sentence must stay
  // neutral because the code cannot tell which token was used.
  const SUBJECTS: Array<[string, string]> = [
    ["an OAuth App", "without `workflow` scope"],
    ["a Personal Access Token", "without `workflow` scope"],
    ["a GitHub App", "without `workflows` permission"],
  ];
  for (const [subject, suffix] of SUBJECTS) {
    it(`maps the "${subject}" wording to the neutral workflow-scope sentence`, () => {
      const stderr = [
        "git exited with code 1",
        "Stderr: To https://github.com/lan/todo-app.git",
        ` ! [remote rejected] main -> main (refusing to allow ${subject} to create or update workflow \`.github/workflows/ci.yml\` ${suffix})`,
        "error: failed to push some refs to 'https://github.com/lan/todo-app.git'",
      ].join("\n");
      const out = summarizePublishError(stderr);
      expect(out).toBe(
        "The GitHub token used for publishing lacks the workflow scope or permission needed to create or update files under .github/workflows. Remove the workflow files from the project or grant that scope or permission, then publish again.",
      );
      expect(out).not.toMatch(/OAuth App|Personal Access Token|GitHub App/);
    });
  }

  it("does not match a workflow phrase whose subject exceeds the bounded window", () => {
    const subject = "a" + " very".repeat(8) + " long token"; // more than 40 characters
    expect(subject.length).toBeGreaterThan(41);
    const stderr = `remote: refusing to allow ${subject} to create or update workflow`;
    expect(summarizePublishError(stderr)).toMatch(GENERIC);
  });

  it("stays fast on a long run of the workflow phrase opener", () => {
    const evil = "refusing to allow a ".repeat(Math.ceil((200 * 1024) / 20));
    const t0 = performance.now();
    summarizePublishError(evil);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("keeps the remote URL out of the sentence but in the log", () => {
    const out = summarizePublishError(WORKFLOW_STDERR);
    expect(out).not.toContain("github.com/lan/todo-app.git");
    expect(singleLog().blob).toContain("https://github.com/lan/todo-app.git");
  });
});

describe("known case: authentication failure (GitHub-specific forms only)", () => {
  const inputs = [
    "git exited with code 128\nStderr: fatal: Authentication failed for 'https://github.com/owner/repo.git/'",
    "git exited with code 128\nStderr: The requested URL returned error: 403",
    "git exited with code 128\nStderr: The requested URL returned error: 401 Unauthorized",
    "remote: Invalid username or token.\nfatal: Authentication failed",
    "remote: Invalid username or password.",
    '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}',
    "remote: Permission to octo/demo.git denied to octo.",
    "Error: github_401",
    "Error: github_403",
    "github_403",
  ];
  for (const input of inputs) {
    it(`maps ${JSON.stringify(input.slice(0, 48))} to the credentials sentence`, () => {
      expect(summarizePublishError(input)).toMatch(/rejected the credentials/i);
    });
  }

  it("does not read digit runs like 1403 or port 443 as 401/403", () => {
    const out = summarizePublishError(
      "Compressing objects: 100% (1403/1403), done.\nfatal: the upstream ref is bogus on port 443",
    );
    expect(out).toMatch(GENERIC);
  });

  // Local, non-GitHub failures must never be blamed on GitHub credentials:
  // bare "permission denied" and free-standing 401/403 digits match fs,
  // local git, Postgres, UUID paths and hex hashes.
  const localFailures = [
    "Error: EACCES: permission denied, open '/tmp/project-forge/5e2a7f10-1234-4abc-8def-0123456789ab/.forge-meta.json'",
    "git exited with code 128\nStderr: fatal: could not lock config file .git/config: Permission denied",
    'An operation failed due to a database error: permission denied for table "UsageLog"',
    "git exited with code 128\nStderr: fatal: not a git repository: /tmp/project-forge/1f2e3d4c-403a-4b5c-9d8e-7f6a5b4c3d2e/repo/.git",
    "Invalid `prisma.project.update()` invocation:\nValue too long for type character varying(63) at position 403",
    "git exited with code 1\nStderr: error: object a401b9c corrupt, appears to be truncated",
    // SSH auth is not a publish path (both routes push over HTTPS), so
    // dropping the bare "permission denied" alternative makes this generic.
    "git exited with code 128\nStderr: git@github.com: Permission denied (publickey).",
  ];
  for (const input of localFailures) {
    it(`maps ${JSON.stringify(input.slice(0, 48))} to the generic sentence, not credentials`, () => {
      expect(summarizePublishError(input)).toMatch(GENERIC);
    });
  }
});

describe("credentials pattern anchors", () => {
  it("does not read a github_403 inside a line as a credentials failure", () => {
    const stderr = "git exited with code 1\nStderr: remote: see github_403 docs for details\nerror: failed to push some refs";
    expect(summarizePublishError(stderr)).toMatch(GENERIC);
  });

  it("does not read a longer status like 4030 as a credentials failure", () => {
    const stderr = "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 4030";
    expect(summarizePublishError(stderr)).toMatch(GENERIC);
  });

  it("does not read github_4030 at the start of a line as a credentials failure", () => {
    expect(summarizePublishError("github_4030")).toMatch(GENERIC);
  });

  it("does not read a github_403 that ends a longer line as a credentials failure", () => {
    expect(summarizePublishError("git exited with code 1\nsee github_403")).toMatch(GENERIC);
  });

  it("reads github_403 on its own line inside a multi-line message as a credentials failure", () => {
    expect(summarizePublishError("git exited with code 1\ngithub_403\ndone")).toMatch(/GitHub rejected the credentials/);
  });

  it("still reads a whole-line github_403 code as a credentials failure", () => {
    expect(summarizePublishError("github_403")).toMatch(/GitHub rejected the credentials/);
  });
});

describe("known case: repository already exists", () => {
  const inputs = [
    "Error: repo_name_exists",
    "remote: error: Repository 'octo/demo' already exists.",
    "remote: A request to create a repository named demo failed because a name already exists",
  ];
  for (const input of inputs) {
    it(`maps ${JSON.stringify(input.slice(0, 48))} to the name-taken sentence`, () => {
      expect(summarizePublishError(input)).toMatch(/already exists on your GitHub account/i);
    });
  }

  it("does not map git's own (already exists) ref rejection to the name-taken sentence", () => {
    const out = summarizePublishError(
      " ! [remote rejected] main -> main (already exists)\nerror: failed to push some refs",
    );
    expect(out).toMatch(GENERIC);
  });
});

describe("known case: rate limit", () => {
  const inputs = [
    "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    "remote: API rate limit exceeded for user ID 42. Support: https://support.github.com",
    "remote: You have triggered an abuse detection mechanism.",
  ];
  for (const input of inputs) {
    it(`maps ${JSON.stringify(input.slice(0, 48))} to the rate-limit sentence`, () => {
      expect(summarizePublishError(input)).toMatch(/rate limited the publish request/i);
    });
  }
});

describe("known case: network failure", () => {
  const inputs = [
    "git exited with code 128\nStderr: fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com",
    "git exited with code 128\nStderr: fatal: unable to access: Failed to connect to github.com port 443 after 21056 ms: Couldn't connect to server",
    "git exited with code 128\nStderr: kex_exchange_identification: Connection refused by remote host",
    "git exited with code 128\nStderr: write failure: Network is unreachable",
    "git exited with code 128\nStderr: error: RPC failed; fatal: the remote end hung up unexpectedly",
  ];
  for (const input of inputs) {
    it(`maps ${JSON.stringify(input.slice(0, 48))} to the network sentence`, () => {
      expect(summarizePublishError(input)).toMatch(/could not reach GitHub \(network failure\)/i);
    });
  }
});

describe("precedence (documented in lib/publish-error.ts)", () => {
  it("rate limit wins over the auth 403 case in a combined stderr", () => {
    const combined = [
      "git exited with code 1",
      "Stderr: The requested URL returned error: 403",
      "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "error: failed to push some refs to 'https://github.com/owner/repo.git'",
    ].join("\n");
    const out = summarizePublishError(combined);
    expect(out).toMatch(/rate limited the publish request/i);
    expect(out).not.toMatch(/credentials/i);
  });

  it("workflow scope wins over the network case in a combined stderr", () => {
    const combined = `${WORKFLOW_STDERR}\nfatal: the remote end hung up unexpectedly`;
    expect(summarizePublishError(combined)).toMatch(/lacks the workflow scope/i);
  });
});

describe("reference ids", () => {
  it("logs a known case without a reference id (the fixed sentence leaves nothing to tie)", () => {
    const out = summarizePublishError(WORKFLOW_STDERR);
    expect(out).toMatch(/lacks the workflow scope/i);
    expect(out).not.toMatch(/Reference: [0-9a-f]{8}/);
    const { prefix } = singleLog();
    expect(prefix).toBe("Publish failed:");
    expect(prefix).not.toMatch(/^\[[0-9a-f]{8}\]/);
  });

  it("returns a reference id for the generic answer that matches the logged id", () => {
    const out = summarizePublishError("git exited with code 1\nStderr: totally unknown state");
    const ref = out.match(/Reference: ([0-9a-f]{8})$/)![1];
    expect(singleLog().prefix).toBe(`[${ref}] Publish failed:`);
  });
});

describe("unknown failures", () => {
  const UNKNOWN_STDERR = [
    "git exited with code 1",
    "Stdout: ",
    "Stderr: fatal: bogus internal state while exporting /tmp/project-forge/abc123/repo to https://github.com/owner/repo.git",
  ].join("\n");

  it("answers with the generic sentence and reference id, without the path or the URL", () => {
    const out = summarizePublishError(UNKNOWN_STDERR);
    expect(out).toMatch(GENERIC);
    expect(out).not.toContain("/tmp/project-forge/abc123/repo");
    expect(out).not.toContain("https://github.com/owner/repo.git");
  });

  it("logs the full stderr under the same reference id the response carries", () => {
    const out = summarizePublishError(UNKNOWN_STDERR);
    const ref = out.match(/Reference: ([0-9a-f]{8})$/)![1];
    const { prefix, blob } = singleLog();
    expect(prefix).toBe(`[${ref}] Publish failed:`);
    expect(blob).toContain("/tmp/project-forge/abc123/repo");
    expect(blob).toContain("https://github.com/owner/repo.git");
  });

  it("maps an unrecognized internal github_<status> code to the generic sentence, not the raw code", () => {
    const out = summarizePublishError("Error: github_500");
    expect(out).toMatch(GENERIC);
    expect(out).not.toContain("github_500");
  });

  it("does not misread a github_NNN substring inside a push blob as a code", () => {
    const out = summarizePublishError(
      "git exited with code 1\nStderr: ! [remote rejected] main -> main (push declined by github_500 rule)",
    );
    expect(out).toMatch(GENERIC);
    expect(out).not.toMatch(/remote rejected/);
  });

  it("returns the generic sentence for empty input", () => {
    expect(summarizePublishError("")).toMatch(GENERIC);
    expect(summarizePublishError("   \n  \n")).toMatch(GENERIC);
  });
});

describe("secret scrubbing (shared lib/scrub-secrets)", () => {
  it("scrubs every token shape from the log before it is written", () => {
    const raw = [
      "fatal: Authentication failed for",
      "https://x-access-token:gho_SecretToken99@github.com/owner/repo.git",
      "retry with ghp_AnotherSecret1 or github_pat_11ABC0_DEF or https://ghu_YetAnotherToken@github.com/o/r.git",
    ].join(" ");
    const out = summarizePublishError(raw);
    expect(out).toMatch(/rejected the credentials/i);
    const { blob } = singleLog();
    expect(blob).not.toContain("gho_SecretToken99");
    expect(blob).not.toContain("ghp_AnotherSecret1");
    expect(blob).not.toContain("github_pat_11ABC0_DEF");
    expect(blob).not.toContain("ghu_YetAnotherToken");
    // The shared scrubber masks the x-access-token form into the generic
    // https userinfo form (`https://***@`), the pattern v1's private copy
    // lacked.
    expect(blob).toContain("https://***@");
  });

  it("scrubs the log of an unrecognized failure too", () => {
    summarizePublishError("fatal: opaque daemon hiccup, token github_pat_11XYZ0_QRS in payload");
    const { blob } = singleLog();
    expect(blob).toContain("github_pat_***");
    expect(blob).not.toContain("11XYZ0_QRS");
  });
});
