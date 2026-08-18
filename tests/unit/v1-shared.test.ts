import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  validateProjectName,
  SESSION_UUID_RE,
  SESSION_TTL_MS,
  isSessionExpired,
  readForgeMeta,
  parseTasks,
  buildFileTree,
  readPreviewData,
  resolveDependsOn,
} from "@/lib/v1-shared";
import type { ForgeMeta } from "@/lib/v1-shared";

describe("validateProjectName", () => {
  it("accepts a simple lowercase name", () => {
    expect(validateProjectName("my-project")).toBe(true);
  });

  it("accepts letters, digits, dots, hyphens, and underscores", () => {
    expect(validateProjectName("MyApp_v2.0-beta")).toBe(true);
  });

  it("accepts a single character", () => {
    expect(validateProjectName("a")).toBe(true);
  });

  it("accepts exactly 100 characters (boundary)", () => {
    expect(validateProjectName("a".repeat(100))).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateProjectName("")).toBe(false);
  });

  it("rejects a string with a space", () => {
    expect(validateProjectName("my project")).toBe(false);
  });

  it("rejects a forward slash (path separator)", () => {
    expect(validateProjectName("my/project")).toBe(false);
  });

  it("rejects a backslash", () => {
    expect(validateProjectName("my\\project")).toBe(false);
  });

  it("rejects 101 characters (over limit)", () => {
    expect(validateProjectName("a".repeat(101))).toBe(false);
  });

  it("rejects a dot-dot traversal attempt", () => {
    expect(validateProjectName("../../etc")).toBe(false);
  });

  it("rejects a name with special shell characters", () => {
    expect(validateProjectName("foo;bar")).toBe(false);
  });

  it("rejects null bytes", () => {
    expect(validateProjectName("foo\0bar")).toBe(false);
  });
});

describe("SESSION_UUID_RE", () => {
  it("accepts a well-formed lowercase UUID v4", () => {
    expect(SESSION_UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts a well-formed uppercase UUID", () => {
    expect(SESSION_UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects a path traversal attempt '../../etc/passwd'", () => {
    expect(SESSION_UUID_RE.test("../../etc/passwd")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(SESSION_UUID_RE.test("")).toBe(false);
  });

  it("rejects a UUID with wrong segment lengths", () => {
    expect(SESSION_UUID_RE.test("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });

  it("rejects a UUID missing dashes", () => {
    expect(SESSION_UUID_RE.test("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  it("rejects a string with non-hex characters", () => {
    expect(SESSION_UUID_RE.test("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")).toBe(false);
  });
});

describe("isSessionExpired", () => {
  function metaWithAge(ageMs: number): ForgeMeta {
    return {
      userId: "user-1",
      projectName: "test-proj",
      createdAt: new Date(Date.now() - ageMs).toISOString(),
    };
  }

  it("returns false when createdAt is 59 minutes ago (within TTL)", () => {
    const meta = metaWithAge(59 * 60 * 1000);
    expect(isSessionExpired(meta)).toBe(false);
  });

  it("returns true when createdAt is 61 minutes ago (past TTL)", () => {
    const meta = metaWithAge(61 * 60 * 1000);
    expect(isSessionExpired(meta)).toBe(true);
  });

  it("SESSION_TTL_MS is exactly 1 hour", () => {
    expect(SESSION_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("returns false for a brand-new session (age ≈ 0)", () => {
    const meta = metaWithAge(0);
    expect(isSessionExpired(meta)).toBe(false);
  });

  it("returns true for a session created exactly at TTL + 1ms (just over boundary)", () => {
    const meta = metaWithAge(SESSION_TTL_MS + 1);
    expect(isSessionExpired(meta)).toBe(true);
  });

  it("returns false for a session created at TTL - 1ms (just under boundary)", () => {
    const meta = metaWithAge(SESSION_TTL_MS - 1);
    expect(isSessionExpired(meta)).toBe(false);
  });
});

describe("resolveDependsOn", () => {
  it("returns undefined when raw is undefined", () => {
    expect(resolveDependsOn(undefined, new Set(["001"]))).toBeUndefined();
  });

  it("returns undefined when raw is an empty array", () => {
    expect(resolveDependsOn([], new Set(["001"]))).toBeUndefined();
  });

  it("dedups repeated ids", () => {
    expect(resolveDependsOn(["001", "001"], new Set(["001"]))).toEqual(["001"]);
  });

  it("drops ids not present in knownIds", () => {
    expect(resolveDependsOn(["001", "999"], new Set(["001"]))).toEqual(["001"]);
  });

  it("returns undefined (not []) when every id is dropped", () => {
    expect(resolveDependsOn(["998", "999"], new Set(["001"]))).toBeUndefined();
  });

  it("does not special-case the literal string 'None' -- that filtering is a caller concern", () => {
    // resolveDependsOn only checks knownIds membership; if a caller's
    // knownIds happens to contain "None" (see app/api/generate/route.ts's
    // knownIds comment), this helper alone would let it through. The
    // "None" sentinel exclusion is deliberately NOT shared helper behavior.
    expect(resolveDependsOn(["None"], new Set(["None"]))).toEqual(["None"]);
  });
});

// ---------------------------------------------------------------------------
// readForgeMeta / parseTasks / buildFileTree / readPreviewData
//
// These operate on real filesystem temp dirs (fs.mkdtemp) rather than mocks,
// since resolvePlanforgeOutputPaths already degrades gracefully to
// tempDir-relative default paths when no planforge-index.json is present —
// no need to mock it for these direct-artifact-layout tests.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "v1-shared-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readForgeMeta", () => {
  it("parses a valid .forge-meta.json from the temp dir", async () => {
    const dir = await makeTempDir();
    const meta: ForgeMeta = {
      tokenId: "tok-1",
      userId: "user-1",
      projectName: "my-project",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await fs.writeFile(path.join(dir, ".forge-meta.json"), JSON.stringify(meta));

    const result = await readForgeMeta(dir);

    expect(result).toEqual(meta);
  });

  it("parses meta without the optional tokenId field", async () => {
    const dir = await makeTempDir();
    const meta = { userId: "user-2", projectName: "legacy-project", createdAt: "2026-02-01T00:00:00.000Z" };
    await fs.writeFile(path.join(dir, ".forge-meta.json"), JSON.stringify(meta));

    const result = await readForgeMeta(dir);

    expect(result).toEqual(meta);
    expect(result.tokenId).toBeUndefined();
  });

  it("rejects when .forge-meta.json does not exist", async () => {
    const dir = await makeTempDir();

    await expect(readForgeMeta(dir)).rejects.toThrow();
  });
});

describe("parseTasks", () => {
  it("returns [] when the tasks dir does not exist", async () => {
    const dir = await makeTempDir();

    const tasks = await parseTasks(dir);

    expect(tasks).toEqual([]);
  });

  it("parses id/title/wave/category/priority/summary from a fully-formed task file", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, "01-setup.md"),
      [
        "# Task 1: Setup the project",
        "",
        "## Wave",
        "",
        "wave-1",
        "",
        "## Category",
        "",
        "feature",
        "",
        "## Priority",
        "",
        "P1",
        "",
        "## Summary",
        "",
        "Bootstrap the repo scaffolding.",
        "",
      ].join("\n")
    );

    const tasks = await parseTasks(dir);

    expect(tasks).toEqual([
      {
        id: "01",
        title: "Setup the project",
        wave: "wave-1",
        category: "feature",
        priority: "P1",
        summary: "Bootstrap the repo scaffolding.",
      },
    ]);
  });

  it("falls back to filename-derived id/title and default wave/category/priority when fields are missing, and leaves summary undefined", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "no-frontmatter.md"), "Just some unstructured content.");

    const tasks = await parseTasks(dir);

    expect(tasks).toEqual([
      {
        id: "no-frontmatter",
        title: "no-frontmatter.md",
        wave: "wave-1",
        category: "feature",
        priority: "P1",
        summary: undefined,
      },
    ]);
  });

  it("ignores non-.md files in the tasks dir", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "01-real.md"), "# Task 1: Real task\n");
    await fs.writeFile(path.join(tasksDir, "notes.txt"), "not a task");

    const tasks = await parseTasks(dir);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("01");
  });

  it("parses multiple task files", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "01-a.md"), "# Task 1: First\n\n## Wave\n\nwave-1\n");
    await fs.writeFile(path.join(tasksDir, "02-b.md"), "# Task 2: Second\n\n## Wave\n\nwave-2\n");

    const tasks = await parseTasks(dir);

    expect(tasks.map((t) => t.id).sort()).toEqual(["01", "02"]);
    expect(tasks.map((t) => t.wave).sort()).toEqual(["wave-1", "wave-2"]);
  });
});

describe("buildFileTree", () => {
  it("sorts directories before files, and alphabetically within each group", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "zdir"), { recursive: true });
    await fs.writeFile(path.join(dir, "zdir", "inner.txt"), "inner");
    await fs.writeFile(path.join(dir, "afile.txt"), "content");

    const tree = await buildFileTree(dir);

    expect(tree).toEqual([
      {
        name: "zdir",
        path: "zdir",
        type: "directory",
        children: [{ name: "inner.txt", path: "zdir/inner.txt", type: "file" }],
      },
      { name: "afile.txt", path: "afile.txt", type: "file" },
    ]);
  });

  it("skips node_modules, .git, venv, and __pycache__ directories", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "pkg.json"), "{}");
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    await fs.writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await fs.mkdir(path.join(dir, "venv"), { recursive: true });
    await fs.writeFile(path.join(dir, "venv", "pyvenv.cfg"), "");
    await fs.mkdir(path.join(dir, "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(dir, "__pycache__", "cache.pyc"), "");
    await fs.writeFile(path.join(dir, "keep.txt"), "kept");

    const tree = await buildFileTree(dir);

    expect(tree).toEqual([{ name: "keep.txt", path: "keep.txt", type: "file" }]);
  });

  it("skips .forge-meta.json and .forge-published files", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, ".forge-meta.json"), "{}");
    await fs.writeFile(path.join(dir, ".forge-published"), "");
    await fs.writeFile(path.join(dir, "README.md"), "# hi");

    const tree = await buildFileTree(dir);

    expect(tree).toEqual([{ name: "README.md", path: "README.md", type: "file" }]);
  });

  it("recurses into nested subdirectories, tracking relative paths", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(dir, "a", "b", "deep.txt"), "deep");

    const tree = await buildFileTree(dir);

    expect(tree).toEqual([
      {
        name: "a",
        path: "a",
        type: "directory",
        children: [
          {
            name: "b",
            path: "a/b",
            type: "directory",
            children: [{ name: "deep.txt", path: "a/b/deep.txt", type: "file" }],
          },
        ],
      },
    ]);
  });
});

describe("readPreviewData", () => {
  it("returns safe defaults for a completely empty temp dir (no tasks, no artifacts)", async () => {
    const dir = await makeTempDir();

    const preview = await readPreviewData(dir, "empty-project");

    expect(preview.projectName).toBe("empty-project");
    expect(preview.tasks).toEqual([]);
    expect(preview.taskCount).toBe(0);
    expect(preview.waveCount).toBe(0);
    expect(preview.architectureOverview).toBe("(not generated)");
    // No scaffoldkit-input.json present -> readScaffoldPreview falls back to
    // the planning-baseline status.
    expect(preview.scaffold.status).toBe("planning-baseline");
    // No post-scaffold-review.json present -> toScaffoldFitPreview(null) is undefined.
    expect(preview.scaffoldFit).toBeUndefined();
  });

  it("aggregates tasks, architecture overview content, taskCount, and waveCount when artifacts are present", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "01-a.md"), "# Task 1: First\n\n## Wave\n\nwave-1\n");
    await fs.writeFile(path.join(tasksDir, "02-b.md"), "# Task 2: Second\n\n## Wave\n\nwave-2\n");
    await fs.writeFile(path.join(dir, "architecture-overview.md"), "# Architecture\n\nSome overview text.");

    const preview = await readPreviewData(dir, "real-project");

    expect(preview.projectName).toBe("real-project");
    expect(preview.taskCount).toBe(2);
    expect(preview.waveCount).toBe(2);
    expect(preview.architectureOverview).toBe("# Architecture\n\nSome overview text.");
    expect(preview.tasks.map((t) => t.id).sort()).toEqual(["01", "02"]);
  });

  it("never surfaces content from a traversal architecture index entry, only the '(not generated)' fallback literal (end-to-end containment)", async () => {
    const dir = await makeTempDir();
    // A file outside the session temp dir -- a hostile index could point
    // rootFiles.architecture straight at it (e.g. an SSH key, another
    // session's output). The resolver's containment guard must stop
    // readPreviewData from ever reading and mirroring it back in the API
    // response.
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "secret-architecture.md");
    await fs.writeFile(outsideFile, "TOP SECRET -- must never leak into the API response");

    // path.relative gives the exact `../` count needed to reach outsideFile
    // from dir, regardless of how deeply os.tmpdir() nests the two
    // directories on this platform.
    const traversalRelative = path.relative(dir, outsideFile);

    await fs.writeFile(
      path.join(dir, "planforge-index.json"),
      JSON.stringify({
        generatedBy: "agent-planforge",
        rootFiles: { architecture: traversalRelative },
        directories: { tasks: "tasks" },
        planning: { planOutput: "planning/plan-output.json" },
        exports: {},
        ai: {},
      })
    );

    const preview = await readPreviewData(dir, "leak-project");

    expect(preview.architectureOverview).toBe("(not generated)");
    expect(preview.architectureOverview).not.toContain("TOP SECRET");
  });

  it("positive control: resolves and reads a legitimate, in-bounds architecture index entry through readPreviewData", async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, "docs"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "docs", "architecture-overview.md"),
      "# Architecture\n\nLegitimate in-bounds content."
    );
    await fs.writeFile(
      path.join(dir, "planforge-index.json"),
      JSON.stringify({
        generatedBy: "agent-planforge",
        rootFiles: { architecture: "docs/architecture-overview.md" },
        directories: { tasks: "tasks" },
        planning: { planOutput: "planning/plan-output.json" },
        exports: {},
        ai: {},
      })
    );

    const preview = await readPreviewData(dir, "legit-project");

    // Proves the containment guard doesn't over-reject a legitimate,
    // index-resolved, in-bounds entry when read end-to-end.
    expect(preview.architectureOverview).toBe("# Architecture\n\nLegitimate in-bounds content.");
  });
});

// ---------------------------------------------------------------------------
// readPreviewData: dependsOn/wave merge from plan-output.json
//
// agent-planforge's bootstrap-plan.js writes tasks/*.md as
// `${task.id}-${slug}.md` using plan-output.json's zero-padded task ids
// verbatim ("001", "002", ...), and parseTasks' /^(\d+)-/ prefix match
// recovers that exact string. The id space is therefore pinned to that
// 3-digit zero-padded form in these fixtures, matching what the real CLI
// writes.
// ---------------------------------------------------------------------------

describe("readPreviewData: plan-output.json dependsOn/wave merge", () => {
  it("merges dependsOn from planning/plan-output.json (index-resolved path, not hardcoded), ids in the CLI's zero-padded form", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "planforge-index.json"),
      JSON.stringify({
        generatedBy: "agent-planforge",
        rootFiles: { architecture: "architecture-overview.md" },
        directories: { tasks: "tasks" },
        planning: { planOutput: "planning/plan-output.json" },
        exports: {},
        ai: {},
      })
    );
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "001-setup.md"), "# Task 1: Setup\n\n## Wave\n\nwave-1\n");
    await fs.writeFile(path.join(tasksDir, "002-build.md"), "# Task 2: Build\n\n## Wave\n\nwave-2\n");
    const planningDir = path.join(dir, "planning");
    await fs.mkdir(planningDir, { recursive: true });
    await fs.writeFile(
      path.join(planningDir, "plan-output.json"),
      JSON.stringify({
        tasks: [
          { id: "001", dependsOn: [] },
          { id: "002", dependsOn: ["001"] },
        ],
      })
    );

    const preview = await readPreviewData(dir, "dep-project");

    const byId = new Map(preview.tasks.map((t) => [t.id, t]));
    expect(byId.get("001")?.dependsOn).toBeUndefined();
    expect(byId.get("002")?.dependsOn).toEqual(["001"]);
  });

  it("degrades to no dependsOn, without error, when plan-output.json is missing", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "001-setup.md"), "# Task 1: Setup\n");

    const preview = await readPreviewData(dir, "no-plan-output");

    expect(preview.tasks).toHaveLength(1);
    expect(preview.tasks[0].dependsOn).toBeUndefined();
  });

  it("degrades to no dependsOn, without error, when plan-output.json is corrupt JSON", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "001-setup.md"), "# Task 1: Setup\n");
    await fs.writeFile(path.join(dir, "plan-output.json"), "{ not valid json ");

    const preview = await readPreviewData(dir, "corrupt-plan-output");

    expect(preview.tasks).toHaveLength(1);
    expect(preview.tasks[0].dependsOn).toBeUndefined();
  });

  it("filters a dangling dependsOn id that does not match any parsed task id in this response", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "001-setup.md"), "# Task 1: Setup\n");
    await fs.writeFile(
      path.join(dir, "plan-output.json"),
      JSON.stringify({ tasks: [{ id: "001", dependsOn: ["999"] }] })
    );

    const preview = await readPreviewData(dir, "dangling-project");

    expect(preview.tasks[0].dependsOn).toBeUndefined();
  });

  it("backfills wave from plan-output.json only when the task file has no Wave section, and never overwrites an explicit one", async () => {
    const dir = await makeTempDir();
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "001-no-wave.md"), "# Task 1: No wave section\n");
    await fs.writeFile(path.join(tasksDir, "002-explicit-wave.md"), "# Task 2: Explicit wave\n\n## Wave\n\nwave-9\n");
    await fs.writeFile(
      path.join(dir, "plan-output.json"),
      JSON.stringify({
        tasks: [
          { id: "001", wave: "wave-3" },
          { id: "002", wave: "wave-5" },
        ],
      })
    );

    const preview = await readPreviewData(dir, "wave-backfill-project");

    const byId = new Map(preview.tasks.map((t) => [t.id, t]));
    expect(byId.get("001")?.wave).toBe("wave-3");
    expect(byId.get("002")?.wave).toBe("wave-9");
  });

  async function writePlanFixture(planTasks: unknown): Promise<string> {
    const dir = await makeTempDir();
    await fs.writeFile(
      path.join(dir, "planforge-index.json"),
      JSON.stringify({
        generatedBy: "agent-planforge",
        rootFiles: { architecture: "architecture-overview.md" },
        directories: { tasks: "tasks" },
        planning: { planOutput: "planning/plan-output.json" },
        exports: {},
        ai: {},
      })
    );
    const tasksDir = path.join(dir, "tasks");
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tasksDir, "001-setup.md"), "# Task 1: Setup\n\n## Wave\n\nwave-1\n");
    await fs.writeFile(path.join(tasksDir, "002-build.md"), "# Task 2: Build\n\n## Wave\n\nwave-1\n");
    const planningDir = path.join(dir, "planning");
    await fs.mkdir(planningDir, { recursive: true });
    await fs.writeFile(path.join(planningDir, "plan-output.json"), JSON.stringify({ tasks: planTasks }));
    return dir;
  }

  it("dedups a plan entry listing the same dependency twice", async () => {
    const dir = await writePlanFixture([
      { id: "001", dependsOn: [] },
      { id: "002", dependsOn: ["001", "001"] },
    ]);
    const preview = await readPreviewData(dir, "dedup-project");
    expect(preview.tasks.find((t) => t.id === "002")?.dependsOn).toEqual(["001"]);
  });

  it("filters non-string entries out of dependsOn", async () => {
    const dir = await writePlanFixture([
      { id: "001", dependsOn: [] },
      { id: "002", dependsOn: [null, 42, { id: "001" }, "001"] },
    ]);
    const preview = await readPreviewData(dir, "typeguard-project");
    expect(preview.tasks.find((t) => t.id === "002")?.dependsOn).toEqual(["001"]);
  });

  it("degrades malformed plan-output shapes (tasks as object, null entries, non-string ids) without throwing", async () => {
    for (const planTasks of [{ not: "an array" }, [null, ["nested"], { dependsOn: ["001"] }, { id: 2, dependsOn: ["001"] }]]) {
      const dir = await writePlanFixture(planTasks);
      const preview = await readPreviewData(dir, "malformed-project");
      expect(preview.tasks).toHaveLength(2);
      for (const t of preview.tasks) {
        expect(t.dependsOn).toBeUndefined();
      }
    }
  });

  it("invariant: every emitted dependsOn id references an id of the same response", async () => {
    const dir = await writePlanFixture([
      { id: "001", dependsOn: ["002", "ghost-a"] },
      { id: "002", dependsOn: ["001", "999", "001"] },
    ]);
    const preview = await readPreviewData(dir, "invariant-project");
    const ids = new Set(preview.tasks.map((t) => t.id));
    for (const t of preview.tasks) {
      for (const dep of t.dependsOn ?? []) {
        expect(ids.has(dep)).toBe(true);
      }
    }
    expect(preview.tasks.find((t) => t.id === "001")?.dependsOn).toEqual(["002"]);
    expect(preview.tasks.find((t) => t.id === "002")?.dependsOn).toEqual(["001"]);
  });
});
