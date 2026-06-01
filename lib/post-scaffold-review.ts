import * as fs from "fs/promises";
import * as path from "path";
import { getAiCapabilities, generateStructuredJson, type AiProviderName } from "@/lib/ai-provider";
import { resolvePlanforgeOutputPaths } from "@/lib/planforge-output";
import type { ScaffoldFitPreview } from "@/lib/types";

type CheckStatus = "pass" | "warn" | "fail";
type ReviewStatus = "ok" | "review-recommended" | "mismatch";
type AiFitStatus = "good-fit" | "partial-fit" | "mismatch";

interface ScaffoldkitInput {
  projectName?: string;
  blueprint?: string;
  blueprintCandidates?: string[];
  blueprintReason?: string;
  blueprintConfidence?: string;
  agentMustCreateStructure?: boolean;
  scaffoldExecutionSummary?: string;
  scaffoldExecutionReason?: string;
  plannerProfile?: string;
  summary?: string;
  features?: string[];
  constraints?: string[];
}

interface ReviewCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

interface AiFitAssessment {
  fitStatus: AiFitStatus;
  summary: string;
  reasons: string[];
  recommendedActions: string[];
}

export interface PostScaffoldReview {
  version: "1.0";
  generatedBy: "project-forge";
  scaffoldInputPresent: boolean;
  scaffoldApplied: boolean;
  aiUsed: boolean;
  provider: AiProviderName | null;
  model: string | null;
  blueprint: {
    selected: string | null;
    candidates: string[];
    confidence: string | null;
    agentMustCreateStructure: boolean;
    reason: string | null;
    executionSummary: string | null;
    executionReason: string | null;
  };
  runtimeIndicators: {
    topLevelPaths: string[];
    samplePaths: string[];
  };
  checks: ReviewCheck[];
  verdict: {
    status: ReviewStatus;
    summary: string;
    recommendedActions: string[];
    mustReviewBeforeImplementation: boolean;
  };
  aiAssessment?: AiFitAssessment;
  followUpTask?: {
    path: string;
    title: string;
    mustCompleteBeforeWave: "wave-1";
  };
}

interface ReviewPayload {
  projectName: string;
  projectSummary: string | null;
  plannerProfile: string | null;
  blueprint: {
    selected: string | null;
    candidates: string[];
    confidence: string | null;
    agentMustCreateStructure: boolean;
    reason: string | null;
  };
  features: string[];
  constraints: string[];
  runtimeIndicators: {
    topLevelPaths: string[];
    samplePaths: string[];
  };
}

// Planforge artifacts that should NOT be counted as runtime scaffold signals.
// Since the output reorganization (bf7a491), most JSON files moved into
// planning/, handoff/, and exports/ subdirectories, and the planning prose
// docs now live under .planforge/docs/. The directory entries below cover
// the subdirs (including the .planforge/ namespace) and the root-level
// markdown/index files. The bare root-level doc names are retained so older
// flat-root tarballs still match.
const PLANFORGE_TOP_LEVEL_PATHS = new Set([
  // Directories
  ".ai",
  ".planforge",
  "adrs",
  "exports",
  "governance",
  // Back-compat: agent-planforge stops emitting handoff/ once the runner vision
  // is removed (Phase 3). Retained so older flat tarballs still match; safe to
  // drop after the migration window.
  "handoff",
  "planning",
  "prompts",
  "runbooks",
  "specs",
  "tasks",
  // Root-level files
  "AGENTS.md",
  "BRANCH_INFO.md",
  "CLAUDE.md",
  "PROJECT.md",
  "architecture-overview.md",
  "delivery-plan.md",
  "intake-questionnaire.md",
  "planforge-index.json",
  "project-charter.md",
  "project-input.json",
]);

// "Runtime structure present" means actual source code was generated, not just
// a manifest (pyproject.toml / package.json) or a bare src/ directory. An empty
// scaffold (e.g. a non-TypeScript selection of a TS-only blueprint) leaves a
// manifest plus empty dirs; treating those as runtime structure is exactly the
// "full scaffold" overclaim this check exists to catch, so require a real
// source file instead.
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".php", ".java", ".kt",
  ".cs", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".scala", ".ex", ".exs", ".clj", ".sql",
]);

const REVIEW_SYSTEM_PROMPT = `You review whether a scaffold blueprint is a good fit for a project after scaffolding.

Return ONLY a JSON object with:
- fitStatus: "good-fit" | "partial-fit" | "mismatch"
- summary: string
- reasons: string[]
- recommendedActions: string[]

Rules:
- Focus on blueprint fit and obvious structural mismatch.
- Prefer "partial-fit" over "mismatch" unless the scaffold clearly points the implementation in the wrong direction.
- If the scaffold should be treated only as a baseline and re-evaluated by the implementing agent, say so in recommendedActions.
- Keep all strings concise and concrete.`;

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function collectRuntimePaths(rootDir: string, maxPaths = 60): Promise<{ topLevelPaths: string[]; samplePaths: string[] }> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const topLevelPaths = entries
    .map((entry) => entry.name)
    .filter((name) => !PLANFORGE_TOP_LEVEL_PATHS.has(name) && name !== ".git" && name !== "node_modules")
    .sort();

  const samplePaths: string[] = [];

  async function visit(relativeDir: string) {
    if (samplePaths.length >= maxPaths) {
      return;
    }

    const fullDir = path.join(rootDir, relativeDir);
    const children = await fs.readdir(fullDir, { withFileTypes: true }).catch(() => []);

    for (const child of children) {
      if (samplePaths.length >= maxPaths) {
        return;
      }

      const childRelative = relativeDir ? path.join(relativeDir, child.name) : child.name;
      if (child.name === ".git" || child.name === "node_modules") {
        continue;
      }

      samplePaths.push(childRelative);
      if (child.isDirectory()) {
        await visit(childRelative);
      }
    }
  }

  for (const topLevelPath of topLevelPaths) {
    if (samplePaths.length >= maxPaths) {
      break;
    }
    await visit(topLevelPath);
  }

  return {
    topLevelPaths,
    samplePaths,
  };
}

function hasRuntimeSignals(runtimeIndicators: { topLevelPaths: string[]; samplePaths: string[] }): boolean {
  // A generated source file (top-level or in any sampled directory, at any
  // depth) is the honest signal that runtime structure exists. A bare src/ dir
  // or a lone manifest does not count.
  return [...runtimeIndicators.topLevelPaths, ...runtimeIndicators.samplePaths].some(
    (filePath) => SOURCE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

function buildDeterministicChecks(
  scaffoldInput: ScaffoldkitInput | null,
  runtimeIndicators: { topLevelPaths: string[]; samplePaths: string[] }
): ReviewCheck[] {
  const checks: ReviewCheck[] = [];

  if (!scaffoldInput) {
    checks.push({
      id: "scaffold-input-present",
      status: "fail",
      message: "No scaffoldkit input was generated. The implementing agent should verify repository structure manually.",
    });
    return checks;
  }

  checks.push({
    id: "blueprint-selected",
    status: scaffoldInput.blueprint ? "pass" : "fail",
    message: scaffoldInput.blueprint
      ? `Blueprint selected: ${scaffoldInput.blueprint}.`
      : "No scaffold blueprint was selected.",
  });

  checks.push({
    id: "blueprint-confidence",
    status:
      scaffoldInput.agentMustCreateStructure || scaffoldInput.blueprintConfidence === "weak"
        ? "warn"
        : "pass",
    message:
      scaffoldInput.agentMustCreateStructure || scaffoldInput.blueprintConfidence === "weak"
        ? "Scaffoldkit already marked this scaffold as a partial fit. The implementing agent should review it before relying on the structure."
        : `Blueprint confidence is ${scaffoldInput.blueprintConfidence ?? "unknown"}.`,
  });

  checks.push({
    id: "runtime-structure-present",
    status: hasRuntimeSignals(runtimeIndicators) ? "pass" : "warn",
    message: hasRuntimeSignals(runtimeIndicators)
      ? "Runtime-oriented files or directories were generated beyond the planforge artifacts."
      : "No strong runtime structure signals were detected after scaffolding.",
  });

  return checks;
}

function summarizeDeterministicVerdict(checks: ReviewCheck[]): {
  status: ReviewStatus;
  summary: string;
  recommendedActions: string[];
  mustReviewBeforeImplementation: boolean;
} {
  const hasFail = checks.some((check) => check.status === "fail");
  const hasWarn = checks.some((check) => check.status === "warn");

  if (hasFail) {
    return {
      status: "mismatch",
      summary: "The scaffold output is incomplete or missing key selection data. The implementing agent should reassess the repository baseline before feature work.",
      recommendedActions: [
        "Review the selected scaffold inputs and confirm whether a blueprint should be applied at all.",
        "Establish the runtime structure deliberately before starting implementation tasks.",
      ],
      mustReviewBeforeImplementation: true,
    };
  }

  if (hasWarn) {
    return {
      status: "review-recommended",
      summary: "The scaffold exists, but it should be treated as a baseline that still needs agent review before implementation accelerates.",
      recommendedActions: [
        "Complete the blueprint-fit review in wave-0 before starting wave-1 implementation.",
        "Adjust or replace the scaffold if core architecture assumptions do not match the plan.",
      ],
      mustReviewBeforeImplementation: true,
    };
  }

  return {
    status: "ok",
    summary: "The scaffold output looks consistent enough to use as the initial repository baseline.",
    recommendedActions: [
      "Proceed with implementation, but keep the scaffold aligned with the generated plan artifacts.",
    ],
    mustReviewBeforeImplementation: false,
  };
}

function mergeAiVerdict(
  deterministic: {
    status: ReviewStatus;
    summary: string;
    recommendedActions: string[];
    mustReviewBeforeImplementation: boolean;
  },
  aiAssessment: AiFitAssessment | null
): {
  status: ReviewStatus;
  summary: string;
  recommendedActions: string[];
  mustReviewBeforeImplementation: boolean;
} {
  if (!aiAssessment) {
    return deterministic;
  }

  const aiStatus: ReviewStatus =
    aiAssessment.fitStatus === "good-fit"
      ? "ok"
      : aiAssessment.fitStatus === "partial-fit"
        ? "review-recommended"
        : "mismatch";

  const orderedStatus = [deterministic.status, aiStatus].sort((left, right) => {
    const rank: Record<ReviewStatus, number> = { ok: 0, "review-recommended": 1, mismatch: 2 };
    return rank[right] - rank[left];
  })[0] as ReviewStatus;

  const recommendedActions = Array.from(
    new Set([...(deterministic.recommendedActions || []), ...(aiAssessment.recommendedActions || [])])
  );

  return {
    status: orderedStatus,
    summary: aiAssessment.summary || deterministic.summary,
    recommendedActions,
    mustReviewBeforeImplementation: orderedStatus !== "ok",
  };
}

function renderReviewMarkdown(review: PostScaffoldReview): string {
  const checks = review.checks.map((check) => `- [${check.status.toUpperCase()}] ${check.id}: ${check.message}`).join("\n");
  const actions = review.verdict.recommendedActions.map((action) => `- ${action}`).join("\n");
  const aiSection = review.aiAssessment
    ? `## AI Fit Assessment

- Status: ${review.aiAssessment.fitStatus}
- Summary: ${review.aiAssessment.summary}

### Reasons

${review.aiAssessment.reasons.map((reason) => `- ${reason}`).join("\n")}
`
    : `## AI Fit Assessment

- Not run
`;

  return `# Post-Scaffold Review

## Verdict

- Status: ${review.verdict.status}
- Summary: ${review.verdict.summary}
- Must review before implementation: ${review.verdict.mustReviewBeforeImplementation ? "yes" : "no"}

## Blueprint

- Selected: ${review.blueprint.selected ?? "none"}
- Confidence: ${review.blueprint.confidence ?? "unknown"}
- Agent must create structure: ${review.blueprint.agentMustCreateStructure ? "yes" : "no"}

## Checks

${checks}

${aiSection}
## Recommended Actions

${actions}

## Execution Rule

${review.verdict.mustReviewBeforeImplementation
    ? "- Complete the blueprint-fit review in wave-0 before starting wave-1 implementation tasks."
    : "- No additional blueprint-fit review gate is required before wave-1 implementation."}
`;
}

async function evaluateFitWithAi(payload: ReviewPayload): Promise<{ assessment: AiFitAssessment; provider: AiProviderName; model: string }> {
  const result = await generateStructuredJson<AiFitAssessment>(
    REVIEW_SYSTEM_PROMPT,
    JSON.stringify(payload, null, 2),
    { temperature: 0.1, maxTokens: 700 }
  );

  return {
    assessment: {
      fitStatus: result.data.fitStatus ?? "partial-fit",
      summary: result.data.summary ?? "Review scaffold fit before starting implementation.",
      reasons: Array.isArray(result.data.reasons) ? result.data.reasons : [],
      recommendedActions: Array.isArray(result.data.recommendedActions)
        ? result.data.recommendedActions
        : [],
    },
    provider: result.provider,
    model: result.model,
  };
}

function createFollowUpTask(review: PostScaffoldReview): { path: string; contents: string } | null {
  if (review.verdict.status === "ok") {
    return null;
  }

  const filePath = "tasks/900-blueprint-fit-review.md";
  const title = "Review scaffold blueprint fit against the plan";
  const contents = `# Task 900: ${title}

## Wave

wave-0

## Category

foundation

## Priority

P0

## Summary

Confirm that the selected scaffold baseline is appropriate for this project before relying on it for implementation work. This task must be completed in wave-0 before wave-1 feature work starts.

## Context

- Current verdict: ${review.verdict.status}
- Blueprint: ${review.blueprint.selected ?? "none"}
- Confidence: ${review.blueprint.confidence ?? "unknown"}
- Review summary: ${review.verdict.summary}

## Acceptance Criteria

- Compare the scaffolded repository structure against the generated project plan.
- Confirm whether the chosen blueprint should be kept, adapted, or replaced.
- Document any structural changes required before wave-1 implementation starts.
- Do not begin wave-1 feature implementation until this review has been resolved.
`;

  return { path: filePath, contents };
}

const BLUEPRINT_GATE_TASK_ID = "900";
const BLUEPRINT_GATE_TASK_FILE = "tasks/900-blueprint-fit-review.md";

const AI_TASKS_WAVE0_BLOCK = `## wave-0

Resolve the blueprint-fit review before any wave-1 work.

### ${BLUEPRINT_GATE_TASK_ID} Review scaffold blueprint fit against the plan

- Priority: P0
- Category: foundation
- Depends on: none
- Summary: The selected scaffold blueprint may not match the plan; resolve \`${BLUEPRINT_GATE_TASK_FILE}\` before starting wave-1 implementation.

`;

const AGENTS_GATE_CALLOUT = `> Blocked: resolve the wave-0 blueprint-fit review in \`${BLUEPRINT_GATE_TASK_FILE}\` before any wave-1 work. The selected scaffold blueprint may not match the plan.`;

// planforge writes .ai/TASKS.md and the root AGENTS.md before project-forge runs
// the scaffold-fit review, so when this review emits the wave-0 blueprint-fit
// gate (tasks/900) neither entry doc references it: an agent following the
// entry path starts wave-1, which the gate forbids. Surface the gate at the
// front of both. Best-effort and idempotent: if the expected structure is
// absent, leave the file untouched rather than risk corrupting generated output.
// The regex anchors below mirror agent-planforge's generator output
// (scripts/bootstrap-plan.js: renderAiTasks for .ai/TASKS.md, the root AGENTS.md
// renderer for "## Build This Next"); if that format drifts, these patches
// no-op instead of mangling the file.
async function surfaceBlueprintGateInEntryArtifacts(tempDir: string): Promise<void> {
  await surfaceGateInAiTasks(path.join(tempDir, ".ai", "TASKS.md"));
  await surfaceGateInRootAgents(path.join(tempDir, "AGENTS.md"));
}

async function surfaceGateInAiTasks(filePath: string): Promise<void> {
  let body: string;
  try {
    body = await fs.readFile(filePath, "utf-8");
  } catch {
    return;
  }

  let next = body;

  // Prepend the gate to the Critical Path line (idempotent).
  next = next.replace(
    /(## Critical Path\n\n)([^\n]*)/,
    (match, heading: string, criticalPath: string) =>
      criticalPath.startsWith(`${BLUEPRINT_GATE_TASK_ID} -> `)
        ? match
        : `${heading}${BLUEPRINT_GATE_TASK_ID} -> ${criticalPath}`
  );

  // Insert a wave-0 section before the first wave section (idempotent).
  if (!next.includes("## wave-0") && /\n## wave-/.test(next)) {
    next = next.replace(/\n## wave-/, `\n${AI_TASKS_WAVE0_BLOCK}## wave-`);
  }

  if (next !== body) {
    await fs.writeFile(filePath, next);
  }
}

async function surfaceGateInRootAgents(filePath: string): Promise<void> {
  let body: string;
  try {
    body = await fs.readFile(filePath, "utf-8");
  } catch {
    return;
  }

  // The gate file path only appears here once surfaced, so it doubles as the
  // idempotency marker.
  if (body.includes(BLUEPRINT_GATE_TASK_FILE)) {
    return;
  }

  const next = body.replace(
    /(## Build This Next\n\n)/,
    `$1${AGENTS_GATE_CALLOUT}\n\n`
  );

  if (next !== body) {
    await fs.writeFile(filePath, next);
  }
}

// post-scaffold-review is project-forge's own assessment artifact, not part of
// the planforge handoff bundle. It is written under .planforge/ (a planner-side
// namespace) so it no longer depends on the handoff/ directory, which
// agent-planforge is removing in Phase 3.
function planforgeStateDir(tempDir: string): string {
  return path.join(tempDir, ".planforge");
}

export async function runPostScaffoldReview(tempDir: string): Promise<PostScaffoldReview> {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);
  const scaffoldInput = await readJsonFile<ScaffoldkitInput>(artifacts.scaffoldkitInputPath);
  const runtimeIndicators = await collectRuntimePaths(tempDir);
  const checks = buildDeterministicChecks(scaffoldInput, runtimeIndicators);
  const deterministicVerdict = summarizeDeterministicVerdict(checks);
  const capabilities = getAiCapabilities();

  let aiAssessment: AiFitAssessment | null = null;
  let provider: AiProviderName | null = capabilities.provider;
  let model: string | null = capabilities.model;
  let aiUsed = false;

  if (capabilities.features.postScaffoldReview && scaffoldInput) {
    try {
      const result = await evaluateFitWithAi({
        projectName: scaffoldInput.projectName ?? "unknown-project",
        projectSummary: scaffoldInput.summary ?? null,
        plannerProfile: scaffoldInput.plannerProfile ?? null,
        blueprint: {
          selected: scaffoldInput.blueprint ?? null,
          candidates: scaffoldInput.blueprintCandidates ?? [],
          confidence: scaffoldInput.blueprintConfidence ?? null,
          agentMustCreateStructure: Boolean(scaffoldInput.agentMustCreateStructure),
          reason: scaffoldInput.blueprintReason ?? null,
        },
        features: scaffoldInput.features ?? [],
        constraints: scaffoldInput.constraints ?? [],
        runtimeIndicators,
      });
      aiAssessment = result.assessment;
      provider = result.provider;
      model = result.model;
      aiUsed = true;
    } catch (error) {
      console.warn("Post-scaffold AI review failed, using deterministic review only:", error);
    }
  }

  const verdict = mergeAiVerdict(deterministicVerdict, aiAssessment);
  const review: PostScaffoldReview = {
    version: "1.0",
    generatedBy: "project-forge",
    scaffoldInputPresent: Boolean(scaffoldInput),
    scaffoldApplied: runtimeIndicators.topLevelPaths.length > 0,
    aiUsed,
    provider,
    model,
    blueprint: {
      selected: scaffoldInput?.blueprint ?? null,
      candidates: scaffoldInput?.blueprintCandidates ?? [],
      confidence: scaffoldInput?.blueprintConfidence ?? null,
      agentMustCreateStructure: Boolean(scaffoldInput?.agentMustCreateStructure),
      reason: scaffoldInput?.blueprintReason ?? null,
      executionSummary: scaffoldInput?.scaffoldExecutionSummary ?? null,
      executionReason: scaffoldInput?.scaffoldExecutionReason ?? null,
    },
    runtimeIndicators,
    checks,
    verdict,
    ...(aiAssessment ? { aiAssessment } : {}),
  };

  const reviewDir = planforgeStateDir(tempDir);
  await fs.mkdir(reviewDir, { recursive: true });
  await fs.writeFile(
    path.join(reviewDir, "post-scaffold-review.json"),
    `${JSON.stringify(review, null, 2)}\n`
  );
  await fs.writeFile(path.join(reviewDir, "post-scaffold-review.md"), renderReviewMarkdown(review));

  const followUpTask = createFollowUpTask(review);
  if (followUpTask) {
    await fs.writeFile(path.join(tempDir, followUpTask.path), followUpTask.contents);
    review.followUpTask = {
      path: followUpTask.path,
      title: "Review scaffold blueprint fit against the plan",
      mustCompleteBeforeWave: "wave-1",
    };
    await fs.writeFile(
      path.join(reviewDir, "post-scaffold-review.json"),
      `${JSON.stringify(review, null, 2)}\n`
    );
    await fs.writeFile(path.join(reviewDir, "post-scaffold-review.md"), renderReviewMarkdown(review));
    await surfaceBlueprintGateInEntryArtifacts(tempDir);
  }

  return review;
}

export async function readPostScaffoldReview(tempDir: string): Promise<PostScaffoldReview | null> {
  return readJsonFile<PostScaffoldReview>(
    path.join(planforgeStateDir(tempDir), "post-scaffold-review.json")
  );
}

export function toScaffoldFitPreview(review: PostScaffoldReview | null): ScaffoldFitPreview | undefined {
  if (!review) {
    return undefined;
  }

  return {
    status: review.verdict.status,
    summary: review.verdict.summary,
    blueprint: review.blueprint.selected,
    confidence: review.blueprint.confidence,
    agentMustCreateStructure: review.blueprint.agentMustCreateStructure,
    mustReviewBeforeImplementation: review.verdict.mustReviewBeforeImplementation,
    ...(review.followUpTask ? { followUpTaskPath: review.followUpTask.path } : {}),
  };
}

export const __internal = {
  buildDeterministicChecks,
  summarizeDeterministicVerdict,
  toScaffoldFitPreview,
  surfaceBlueprintGateInEntryArtifacts,
};
