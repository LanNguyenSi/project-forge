import { describe, expect, it } from "vitest";
import { summarizePublishError } from "@/app/api/v1/publish/route";

describe("summarizePublishError", () => {
  it("maps the repo-name-exists code to a friendly reason", () => {
    expect(summarizePublishError("Error: repo_name_exists")).toMatch(/already exists/i);
  });

  it("maps a github_<status> code to an HTTP reason", () => {
    expect(summarizePublishError("Error: github_422")).toBe("GitHub rejected the request (HTTP 422)");
  });

  it("surfaces the git remote-rejected line (e.g. missing workflow scope)", () => {
    const raw = [
      "git exited with code 1",
      "Stdout: ",
      "Stderr: To https://github.com/lan/todo-app.git",
      " ! [remote rejected] main -> main (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
      "error: failed to push some refs",
    ].join("\n");
    const out = summarizePublishError(raw);
    expect(out).toMatch(/\[remote rejected\]/);
    expect(out).toMatch(/workflow.*scope/i);
  });

  it("strips a leading remote: prefix", () => {
    expect(summarizePublishError("remote: error: something went wrong")).toBe("error: something went wrong");
  });

  it("falls back to the last non-empty line for unrecognized errors", () => {
    expect(summarizePublishError("line one\nline two\n\n")).toBe("line two");
  });

  it("does NOT misread a github_NNN substring inside a push blob as an HTTP code", () => {
    const raw = [
      "git exited with code 1",
      "Stderr: ! [remote rejected] main -> main (push declined by github_500 rule)",
    ].join("\n");
    // The github_NNN match is anchored to the whole thrown code, so a blob
    // mentioning it surfaces the remote-rejected line instead.
    const out = summarizePublishError(raw);
    expect(out).toMatch(/\[remote rejected\]/);
    expect(out).not.toBe("GitHub rejected the request (HTTP 500)");
  });

  it("returns a safe fallback for empty input", () => {
    expect(summarizePublishError("")).toBe("unknown error");
    expect(summarizePublishError("   \n  \n")).toBe("unknown error");
  });

  it("never contains a leaked token (already sanitized upstream)", () => {
    // The caller sanitizes x-access-token:...@ before calling; confirm the
    // summarizer doesn't re-introduce anything from a clean input.
    const out = summarizePublishError("Stderr: ! [remote rejected] main -> main (push declined)");
    expect(out).not.toMatch(/x-access-token/);
  });
});
