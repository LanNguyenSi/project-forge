import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchGitHubUser, GitHubAuthError, GitHubUnreachableError } from "@/lib/github";

/**
 * Unit tests for lib/github.ts fetchGitHubUser — asserts the error
 * CLASSES returned for each failure mode (network error vs 401/403/404
 * vs 5xx), not just that a throw happens, since callers branch on
 * `instanceof`.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchGitHubUser", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("throws GitHubUnreachableError when fetch itself rejects (network error)", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchGitHubUser("tok")).rejects.toBeInstanceOf(GitHubUnreachableError);
  });

  it("network-error message includes the underlying error text", async () => {
    fetchSpy.mockRejectedValue(new TypeError("ECONNRESET"));

    await expect(fetchGitHubUser("tok")).rejects.toThrow(/Could not reach GitHub: ECONNRESET/);
  });

  it("throws GitHubAuthError (not GitHubUnreachableError) on 401", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { message: "Bad credentials" }));

    const err = await fetchGitHubUser("tok").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubAuthError);
    expect(err).not.toBeInstanceOf(GitHubUnreachableError);
  });

  it("throws GitHubAuthError on 403", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { message: "Forbidden" }));

    await expect(fetchGitHubUser("tok")).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubAuthError on 404", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, { message: "Not Found" }));

    await expect(fetchGitHubUser("tok")).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubUnreachableError (not GitHubAuthError) on 500", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { message: "Internal Server Error" }));

    const err = await fetchGitHubUser("tok").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubUnreachableError);
    expect(err).not.toBeInstanceOf(GitHubAuthError);
  });

  it("throws GitHubUnreachableError on 503", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(503, { message: "Service Unavailable" }));

    await expect(fetchGitHubUser("tok")).rejects.toBeInstanceOf(GitHubUnreachableError);
  });

  it("resolves with the parsed user object on 200", async () => {
    const ghUser = {
      id: 12345,
      login: "octocat",
      name: "The Octocat",
      avatar_url: "https://example.com/avatar.png",
      email: "octocat@example.com",
    };
    fetchSpy.mockResolvedValue(jsonResponse(200, ghUser));

    const result = await fetchGitHubUser("tok");

    expect(result).toEqual(ghUser);
  });

  it("sends the access token as a Bearer Authorization header against api.github.com/user", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { id: 1, login: "x", name: null, avatar_url: "", email: null })
    );

    await fetchGitHubUser("my-token-123");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token-123",
          Accept: "application/vnd.github+json",
        }),
      })
    );
  });
});
