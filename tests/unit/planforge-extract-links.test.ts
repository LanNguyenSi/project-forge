/**
 * Links and special files in the planforge archive.
 *
 * `tar` extracts symbolic links, hardlinks and FIFOs, and later reads of the
 * extracted tree would follow them. The client refuses the whole output when
 * the extracted tree holds one. Archives here are packed with the system `tar`
 * (GNU tar in CI and the image, bsdtar on macOS), so every case must hold for
 * both flavours.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { runPlanforgeViaHttp, PlanforgeClientError } from "../../lib/planforge-client";
import { findDisallowedEntry } from "../../lib/planforge-client";

const execFileP = promisify(execFile);

const scratch: string[] = [];
const realFetch = global.fetch;

async function makeDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  global.fetch = realFetch;
  // fs.rm unlinks a symlink without following it.
  await Promise.all(scratch.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  scratch.length = 0;
});

/** Packs `src` (contents, like the planforge server) into a base64 tar.gz. */
async function packBase64(src: string): Promise<string> {
  const { stdout } = await execFileP("tar", ["-czf", "-", "-C", src, "."], {
    encoding: "buffer",
  });
  return stdout.toString("base64");
}

function mockDone(outputTarGz: string): void {
  const body = `event: done\ndata: ${JSON.stringify({
    requestId: "r",
    planOutput: {},
    scaffoldkitInput: null,
    outputTarGz,
    exitCode: 0,
  })}\n\n`;
  global.fetch = vi.fn().mockResolvedValue(
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  ) as unknown as typeof fetch;
}

async function runWith(src: string): Promise<{ outdir: string }> {
  const outdir = await makeDir("extract-links-out-");
  mockDone(await packBase64(src));
  await runPlanforgeViaHttp({
    baseUrl: "http://planforge:8223",
    token: "t",
    input: {},
    outdir,
  });
  return { outdir };
}

async function expectRefused(
  src: string,
  kind: string,
  relPath: string,
): Promise<{ message: string; outdir: string }> {
  const outdir = await makeDir("extract-links-out-");
  mockDone(await packBase64(src));
  let caught: unknown;
  try {
    await runPlanforgeViaHttp({
      baseUrl: "http://planforge:8223",
      token: "t",
      input: {},
      outdir,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PlanforgeClientError);
  const message = (caught as Error).message;
  expect(message).toContain(kind);
  expect(message).toContain(JSON.stringify(relPath));
  return { message, outdir };
}

describe("planforge archive with links", () => {
  it("extracts a clean archive of files and directories as before", async () => {
    const src = await makeDir("extract-links-src-");
    await fs.mkdir(join(src, "planning"));
    await fs.mkdir(join(src, "empty-dir"));
    await fs.mkdir(join(src, "a", "b"), { recursive: true });
    await fs.writeFile(join(src, "planning", "plan-output.json"), "{}");
    await fs.writeFile(join(src, "a", "b", "deep.txt"), "deep");
    await fs.writeFile(join(src, "README.md"), "# hi");

    const { outdir } = await runWith(src);

    expect(await fs.readFile(join(outdir, "planning", "plan-output.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(join(outdir, "a", "b", "deep.txt"), "utf8")).toBe("deep");
    expect((await fs.stat(join(outdir, "empty-dir"))).isDirectory()).toBe(true);
  });

  it("refuses a symlink to an absolute path and does not name the target", async () => {
    const src = await makeDir("extract-links-src-");
    const secretDir = await makeDir("extract-links-secret-");
    await fs.writeFile(join(secretDir, "token.txt"), "secret");
    await fs.writeFile(join(src, "ok.txt"), "ok");
    await fs.symlink(join(secretDir, "token.txt"), join(src, "architecture-overview.md"));

    const { message } = await expectRefused(src, "symbolic link", "architecture-overview.md");

    expect(message).not.toContain("token.txt");
    expect(message).not.toContain(secretDir);
  });

  it("refuses a relative ../ symlink", async () => {
    const src = await makeDir("extract-links-src-");
    await fs.mkdir(join(src, "planning"));
    await fs.symlink("../../../../../../etc/hostname", join(src, "planning", "plan-output.json"));

    const { message } = await expectRefused(src, "symbolic link", "planning/plan-output.json");

    expect(message).not.toContain("etc/hostname");
  });

  it("refuses a symlink that points inside the tree (any link is refused)", async () => {
    const src = await makeDir("extract-links-src-");
    await fs.writeFile(join(src, "real.txt"), "real");
    await fs.symlink("real.txt", join(src, "alias.txt"));

    await expectRefused(src, "symbolic link", "alias.txt");
  });

  it("refuses a symlink to a directory (it must not be walked as a directory)", async () => {
    const src = await makeDir("extract-links-src-");
    await fs.mkdir(join(src, "real-dir"));
    await fs.writeFile(join(src, "real-dir", "file.txt"), "x");
    await fs.symlink("real-dir", join(src, "dir-alias"));

    await expectRefused(src, "symbolic link", "dir-alias");
  });

  it("refuses a link nested several directories deep", async () => {
    const src = await makeDir("extract-links-src-");
    await fs.mkdir(join(src, "x", "y", "z"), { recursive: true });
    await fs.writeFile(join(src, "x", "plain.txt"), "plain");
    await fs.symlink("/", join(src, "x", "y", "z", "root"));

    await expectRefused(src, "symbolic link", "x/y/z/root");
  });

  it("refuses a hardlink pair, naming the first of the two names", async () => {
    const src = await makeDir("extract-links-src-");
    await fs.writeFile(join(src, "a.txt"), "shared");
    await fs.link(join(src, "a.txt"), join(src, "b.txt"));

    await expectRefused(src, "hardlink", "a.txt");
  });

  it("refuses a FIFO when the platform can pack one", async (ctx) => {
    const src = await makeDir("extract-links-src-");
    try {
      await execFileP("mkfifo", [join(src, "pipe")]);
    } catch {
      ctx.skip("mkfifo is not available in this environment");
      return;
    }
    await fs.writeFile(join(src, "ok.txt"), "ok");

    await expectRefused(src, "FIFO", "pipe");
  });
});

describe("findDisallowedEntry", () => {
  it("returns null for plain files and directories", async () => {
    const root = await makeDir("extract-walk-");
    await fs.mkdir(join(root, "d", "e"), { recursive: true });
    await fs.writeFile(join(root, "d", "e", "f.txt"), "f");
    await fs.writeFile(join(root, "top.txt"), "t");

    expect(await findDisallowedEntry(root)).toBeNull();
  });

  it("reports a symlink to a directory without entering it", async () => {
    const root = await makeDir("extract-walk-");
    const outside = await makeDir("extract-walk-outside-");
    await fs.writeFile(join(outside, "inner.txt"), "i");
    await fs.symlink(outside, join(root, "linked-dir"));

    expect(await findDisallowedEntry(root)).toEqual({
      kind: "symbolic link",
      path: "linked-dir",
    });
  });

  it("reports a dangling symlink", async () => {
    const root = await makeDir("extract-walk-");
    await fs.symlink("does-not-exist", join(root, "dangling"));

    expect(await findDisallowedEntry(root)).toEqual({
      kind: "symbolic link",
      path: "dangling",
    });
  });

  it("reports a nested symlink with its path relative to the root", async () => {
    const root = await makeDir("extract-walk-");
    await fs.mkdir(join(root, "a", "b"), { recursive: true });
    await fs.symlink("..", join(root, "a", "b", "up"));

    expect(await findDisallowedEntry(root)).toEqual({
      kind: "symbolic link",
      path: "a/b/up",
    });
  });

  it("reports a regular file that has a second name outside the tree", async () => {
    const root = await makeDir("extract-walk-");
    const outside = await makeDir("extract-walk-outside-");
    await fs.writeFile(join(outside, "origin.txt"), "o");
    await fs.link(join(outside, "origin.txt"), join(root, "linked.txt"));

    expect(await findDisallowedEntry(root)).toEqual({
      kind: "hardlink",
      path: "linked.txt",
    });
  });

  it("reports a hardlink pair inside the tree", async () => {
    const root = await makeDir("extract-walk-");
    await fs.mkdir(join(root, "sub"));
    await fs.writeFile(join(root, "one.txt"), "1");
    await fs.link(join(root, "one.txt"), join(root, "sub", "two.txt"));

    expect(await findDisallowedEntry(root)).toEqual({ kind: "hardlink", path: "one.txt" });
  });

  it("reports a unix socket as a socket", async (ctx) => {
    const root = await makeDir("extract-walk-");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(join(root, "s"), resolve);
      });
    } catch {
      server.close();
      ctx.skip("a unix socket cannot be bound in this environment");
      return;
    }
    try {
      expect(await findDisallowedEntry(root)).toEqual({ kind: "socket", path: "s" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
