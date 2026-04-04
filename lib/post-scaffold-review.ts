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
// planning/, handoff/, and exports/ subdirectories. The directory entries
// below cover both the subdirs and the root-level markdown/index files.
const PLANFORGE_TOP_LEVEL_PATHS = new Set([
  // Directories
  ".ai",
  "adrs",
  "exports",
  "governance",
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

const RUNTIME_SIGNAL_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "src",
  "app",
];

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
  const candidates = new Set<string>([
    ...runtimeIndicators.topLevelPaths,
    ...runtimeIndicators.samplePaths.map((filePath) => filePath.split(path.sep)[0] || filePath),
  ]);

  return RUNTIME_SIGNAL_FILES.some((signal) => candidates.has(signal));
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

  const handoffDir = path.dirname(artifacts.handoffManifestPath);
  await fs.mkdir(handoffDir, { recursive: true });
  await fs.writeFile(
    path.join(handoffDir, "post-scaffold-review.json"),
    `${JSON.stringify(review, null, 2)}\n`
  );
  await fs.writeFile(path.join(handoffDir, "post-scaffold-review.md"), renderReviewMarkdown(review));

  const followUpTask = createFollowUpTask(review);
  if (followUpTask) {
    await fs.writeFile(path.join(tempDir, followUpTask.path), followUpTask.contents);
    review.followUpTask = {
      path: followUpTask.path,
      title: "Review scaffold blueprint fit against the plan",
      mustCompleteBeforeWave: "wave-1",
    };
    await fs.writeFile(
      path.join(handoffDir, "post-scaffold-review.json"),
      `${JSON.stringify(review, null, 2)}\n`
    );
    await fs.writeFile(path.join(handoffDir, "post-scaffold-review.md"), renderReviewMarkdown(review));
  }

  return review;
}

export async function readPostScaffoldReview(tempDir: string): Promise<PostScaffoldReview | null> {
  const artifacts = await resolvePlanforgeOutputPaths(tempDir);
  return readJsonFile<PostScaffoldReview>(
    path.join(path.dirname(artifacts.handoffManifestPath), "post-scaffold-review.json")
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
};
