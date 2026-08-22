import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

/**
 * Contract test for public/openapi.json.
 *
 * 1. Discovers every HTTP method handler exported by app/api/v1/**\/route.ts
 *    and asserts the spec documents that exact path + method (catches a
 *    route added later without a matching spec entry).
 * 2. Runs a minimal JSON-Schema-subset validator (type/required/enum/$ref,
 *    no external dependency) against the spec's `components.schemas`.
 * 3. Calls each v1 route's cheap-to-trigger error branch (missing
 *    X-API-Key -> 401) and validates the real response body against the
 *    spec's ErrorResponse schema, so the documented shape can't silently
 *    drift from app/api/**'s real `{ ok: false, error, details? }` shape
 *    (lib/types.ts ErrorResponse).
 */

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    prisma: { usageLog: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() } },
    validateApiToken: vi.fn().mockResolvedValue(null),
    checkRateLimit: vi.fn(),
  };
});

import { GET as projectsGET, POST as projectsPOST, DELETE as projectsDELETE } from "@/app/api/v1/projects/route";
import { POST as generatePOST } from "@/app/api/v1/generate/route";
import { GET as previewGET } from "@/app/api/v1/preview/route";
import { POST as publishPOST } from "@/app/api/v1/publish/route";
import { validateApiToken, prisma } from "@/lib/db";
import { readPreviewData } from "@/lib/v1-shared";

const mValidateToken = vi.mocked(validateApiToken);
const mFindMany = vi.mocked(prisma.usageLog.findMany);
const mCount = vi.mocked(prisma.usageLog.count);

const APP_API_ROOT = path.resolve(__dirname, "../../app/api");
const OPENAPI_PATH = path.resolve(__dirname, "../../public/openapi.json");

interface DiscoveredOperation {
  urlPath: string;
  method: string;
  file: string;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function discoverV1Operations(): DiscoveredOperation[] {
  const v1Root = path.join(APP_API_ROOT, "v1");
  const ops: DiscoveredOperation[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "route.ts") {
        const content = fs.readFileSync(full, "utf-8");
        const relDir = path.relative(APP_API_ROOT, path.dirname(full));
        const urlPath = "/api/" + relDir.split(path.sep).join("/");
        for (const method of HTTP_METHODS) {
          const re = new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`);
          if (re.test(content)) {
            ops.push({ urlPath, method: method.toLowerCase(), file: full });
          }
        }
      }
    }
  }

  walk(v1Root);
  return ops;
}

// Loosely-typed JSON value / OpenAPI spec node: the spec is parsed at
// runtime from public/openapi.json, so its shape is not statically known
// beyond "JSON-ish object graph".
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type SpecNode = Record<string, JsonValue>;

function loadSpec(): SpecNode {
  return JSON.parse(fs.readFileSync(OPENAPI_PATH, "utf-8")) as SpecNode;
}

// ---------------------------------------------------------------------------
// Minimal JSON-Schema-subset validator: type, required, enum, nullable, $ref.
// Enough for the hand-authored schemas in public/openapi.json; not a general
// JSON Schema implementation.
// ---------------------------------------------------------------------------
function resolveSchema(spec: SpecNode, schema: SpecNode): SpecNode {
  if (schema && typeof schema === "object" && "$ref" in schema) {
    const refPath = (schema.$ref as string).replace(/^#\//, "").split("/");
    let node: JsonValue = spec;
    for (const seg of refPath) node = (node as SpecNode)[seg];
    return node as SpecNode;
  }
  return schema;
}

function validate(spec: SpecNode, schema: SpecNode, value: unknown, at = "$"): string[] {
  const resolved = resolveSchema(spec, schema);
  const errors: string[] = [];

  if (value === null) {
    if (resolved.nullable) return errors;
    errors.push(`${at}: null not allowed`);
    return errors;
  }

  if (resolved.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${at}: expected object, got ${typeof value}`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    const required = (resolved.required ?? []) as string[];
    for (const req of required) {
      if (!(req in obj)) errors.push(`${at}.${req}: missing required property`);
    }
    const properties = (resolved.properties ?? {}) as Record<string, SpecNode>;
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj) {
        errors.push(...validate(spec, propSchema, obj[key], `${at}.${key}`));
      }
    }
  } else if (resolved.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${at}: expected array, got ${typeof value}`);
      return errors;
    }
    if (resolved.items) {
      const itemSchema = resolved.items as SpecNode;
      value.forEach((item, i) => errors.push(...validate(spec, itemSchema, item, `${at}[${i}]`)));
    }
  } else if (resolved.type === "string") {
    if (typeof value !== "string") errors.push(`${at}: expected string, got ${typeof value}`);
  } else if (resolved.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${at}: expected boolean, got ${typeof value}`);
  } else if (resolved.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${at}: expected integer, got ${typeof value}`);
  }

  if (resolved.enum && Array.isArray(resolved.enum) && !resolved.enum.includes(value as JsonValue)) {
    errors.push(`${at}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(resolved.enum)}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("public/openapi.json contract", () => {
  it("documents every method exported by app/api/v1/**/route.ts", () => {
    const spec = loadSpec();
    const ops = discoverV1Operations();
    expect(ops.length).toBeGreaterThan(0);

    const paths = (spec.paths ?? {}) as Record<string, SpecNode>;
    const missing: string[] = [];
    for (const op of ops) {
      const pathItem = paths[op.urlPath];
      if (!pathItem || !pathItem[op.method]) {
        missing.push(`${op.method.toUpperCase()} ${op.urlPath} (${path.relative(process.cwd(), op.file)})`);
      }
    }

    if (missing.length > 0) {
      throw new Error(`openapi.json is missing operation(s):\n${missing.join("\n")}`);
    }
  });

  it("does not document operations that no longer exist", () => {
    const spec = loadSpec();
    const ops = new Set(discoverV1Operations().map((o) => `${o.method} ${o.urlPath}`));

    const paths = (spec.paths ?? {}) as Record<string, SpecNode>;
    const stale: string[] = [];
    for (const [urlPath, pathItem] of Object.entries(paths)) {
      if (!urlPath.startsWith("/api/v1/")) continue;
      for (const method of Object.keys(pathItem)) {
        if (!ops.has(`${method} ${urlPath}`)) stale.push(`${method.toUpperCase()} ${urlPath}`);
      }
    }

    expect(stale).toEqual([]);
  });

  it("ErrorResponse schema matches lib/types.ts ErrorResponse ({ ok: false, error, details? })", () => {
    const spec = loadSpec();
    const components = spec.components as SpecNode;
    const schemas = components.schemas as Record<string, SpecNode>;
    const schema = schemas.ErrorResponse;
    expect(schema).toBeDefined();
    const properties = schema.properties as Record<string, SpecNode>;
    expect(schema.required).toEqual(expect.arrayContaining(["ok", "error"]));
    expect(schema.required).not.toEqual(expect.arrayContaining(["details"]));
    expect(properties.ok.enum).toEqual([false]);
    expect(properties.error.type).toBe("string");
    expect(properties.details.type).toBe("string");
  });
});

describe("real v1 error responses validate against the spec's ErrorResponse schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const spec = loadSpec();
  const errorSchemaRef = { $ref: "#/components/schemas/ErrorResponse" };

  function makeReq(url: string, init: { method?: string; body?: string } = {}): NextRequest {
    return new NextRequest(url, {
      method: init.method,
      body: init.body,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("GET /api/v1/projects 401 body matches ErrorResponse", async () => {
    const res = await projectsGET(makeReq("http://test/api/v1/projects"));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(validate(spec, errorSchemaRef, body)).toEqual([]);
  });

  it("DELETE /api/v1/projects 401 body matches ErrorResponse", async () => {
    const res = await projectsDELETE(makeReq("http://test/api/v1/projects?id=x"));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(validate(spec, errorSchemaRef, body)).toEqual([]);
  });

  it("POST /api/v1/projects 401 body matches ErrorResponse", async () => {
    const res = await projectsPOST(makeReq("http://test/api/v1/projects", { method: "POST", body: "{}" }));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(validate(spec, errorSchemaRef, body)).toEqual([]);
  });

  it("POST /api/v1/generate 401 body matches ErrorResponse", async () => {
    const res = await generatePOST(makeReq("http://test/api/v1/generate", { method: "POST", body: "{}" }));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(validate(spec, errorSchemaRef, body)).toEqual([]);
  });

  it("GET /api/v1/preview 401 body matches ErrorResponse", async () => {
    const res = await previewGET(makeReq("http://test/api/v1/preview?sessionId=x"));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(validate(spec, errorSchemaRef, body)).toEqual([]);
  });

  it("POST /api/v1/publish 401 body matches ErrorResponse", async () => {
    const res = await publishPOST(makeReq("http://test/api/v1/publish", { method: "POST", body: "{}" }));
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(validate(spec, errorSchemaRef, body)).toEqual([]);
  });
});

describe("real v1 success responses validate against the spec's schemas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const spec = loadSpec();

  it("GET /api/v1/projects 200 body matches ListProjectsResponse", async () => {
    mValidateToken.mockResolvedValueOnce({
      id: "tok-1",
      userId: "user-1",
      user: { id: "user-1" },
    } as never);
    mFindMany.mockResolvedValueOnce([
      {
        id: "proj-1",
        repoUrl: "https://github.com/user/my-app",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        deletedAt: null,
      },
    ] as never);
    mCount.mockResolvedValueOnce(1 as never);

    const res = await projectsGET(
      new NextRequest("http://test/api/v1/projects", {
        headers: { "Content-Type": "application/json", "X-API-Key": "pf_test" },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(validate(spec, { $ref: "#/components/schemas/ListProjectsResponse" }, body)).toEqual([]);
  });
});

describe("readPreviewData output validates against the spec's GenerationPreview schema", () => {
  // Two-directional key-set check, in both directions:
  //  - declaredButAbsent: regression for the sessionId mismatch
  //    (public/openapi.json's GenerationPreview once declared a sessionId
  //    property that lib/v1-shared.ts readPreviewData never actually
  //    returns -- see GenerationPreview's schema description and
  //    readPreviewData's Omit<GenerationPreview, "sessionId"> return type).
  //  - undeclaredButPresent: catches the opposite drift, an actual field
  //    readPreviewData returns that the schema never documents.
  // validate() alone only checks properties present in the value and any
  // schema `required` entries, so on its own it would not flag either
  // direction of key-set drift; these two assertions are what catch them.
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  });

  it("readPreviewData's return shape has exactly the keys GenerationPreview declares (no extra, no missing beyond the optional scaffoldFit), and passes the structural validator", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openapi-contract-preview-"));
    tempDirs.push(dir);

    const preview = await readPreviewData(dir, "contract-test-project");
    // NextResponse.json (JSON.stringify under the hood) drops any key whose
    // value is undefined -- e.g. scaffoldFit for a temp dir with no
    // post-scaffold-review.json (see tests/unit/v1-shared.test.ts). Round-trip
    // through JSON so this test validates exactly what a real client
    // receives, not readPreviewData's raw in-memory return value.
    const wirePreview = JSON.parse(JSON.stringify(preview)) as Record<string, unknown>;

    const spec = loadSpec();
    const components = spec.components as SpecNode;
    const schemas = components.schemas as Record<string, SpecNode>;
    const schema = schemas.GenerationPreview;
    const declaredKeys = Object.keys(schema.properties as Record<string, SpecNode>).sort();
    const actualKeys = Object.keys(wirePreview).sort();

    const declaredButAbsent = declaredKeys.filter((k) => !actualKeys.includes(k));
    // A sessionId regression would surface here as an extra, always-absent
    // entry (readPreviewData never returns it): if this ever fails with
    // "sessionId" included, the schema and readPreviewData have drifted
    // again -- see the block comment above.
    expect(declaredButAbsent).toEqual(["scaffoldFit"]);

    const undeclaredButPresent = actualKeys.filter((k) => !declaredKeys.includes(k));
    // The reverse direction: a field readPreviewData starts returning that
    // GenerationPreview never documents (e.g. an undocumented new field)
    // must fail here too.
    expect(undeclaredButPresent).toEqual([]);

    expect(validate(spec, { $ref: "#/components/schemas/GenerationPreview" }, wirePreview)).toEqual([]);
  });
});
