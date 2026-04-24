import type { ProjectInput, Attachment } from "@/lib/types";
import { getAiCapabilities, generateStructuredJson, type AiProviderName } from "@/lib/ai-provider";

export interface PlanforgePlanningInput {
  projectName: string;
  summary: string;
  targetUsers: string[];
  coreFeatures: string[];
  constraints: string[];
  nonFunctionalRequirements?: string[];
  integrations?: string[];
  plannerProfile?: "startup" | "product" | "enterprise" | "platform";
  dataSensitivity?: "low" | "moderate" | "high" | "regulated";
  teamSize?: number | "solo" | "small" | "medium" | "large" | "enterprise";
  productionExpectedSoon?: boolean;
  liveUsers?: boolean;
  enterpriseRequirements?: string[];
  openQuestions?: string[];
  defaultBranch?: string;
}

export interface PlanforgeOrchestrationMetadata {
  mode: "deterministic" | "ai-enriched";
  aiUsed: boolean;
  provider: AiProviderName | null;
  model: string | null;
}

interface IntakeEnrichment {
  nonFunctionalRequirements?: string[];
  integrations?: string[];
  plannerProfile?: "startup" | "product" | "enterprise" | "platform";
  dataSensitivity?: "low" | "moderate" | "high" | "regulated";
  teamSize?: number | "solo" | "small" | "medium" | "large" | "enterprise";
  productionExpectedSoon?: boolean;
  liveUsers?: boolean;
  enterpriseRequirements?: string[];
  openQuestions?: string[];
}

const ENRICHMENT_SYSTEM_PROMPT = `You enrich project intake for agent-planforge.

Return ONLY a JSON object. Use only these optional fields when they add value:
- nonFunctionalRequirements: string[]
- integrations: string[]
- plannerProfile: "startup" | "product" | "enterprise" | "platform"
- dataSensitivity: "low" | "moderate" | "high" | "regulated"
- teamSize: number | "solo" | "small" | "medium" | "large" | "enterprise"
- productionExpectedSoon: boolean
- liveUsers: boolean
- enterpriseRequirements: string[]
- openQuestions: string[]

Rules:
- Do not rewrite or duplicate projectName, summary, targetUsers, coreFeatures, or constraints.
- Be conservative. If something is unclear, prefer openQuestions over inventing requirements.
- Only infer plannerProfile or dataSensitivity when there is a strong signal.
- Use short concrete strings, not paragraphs.
- If no enrichment is justified, return {}.
- If the user supplied \`additionalContext\` (uploaded arc42, RFCs, charters, prior ADRs), treat it as primary evidence for architectural decisions. Reflect its named integrations (databases, auth providers, queues), non-functional requirements (performance, compliance), data-sensitivity signals (PII, PHI, regulatory language), and enterprise requirements in the output. Prefer facts stated in additionalContext over speculation from the intake form alone.`;

function uniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function createBasePlanforgeInput(input: ProjectInput): PlanforgePlanningInput {
  const coreFeatures =
    input.features && input.features.length > 0 ? input.features : ["core functionality"];
  const targetUsers =
    input.targetUsers && input.targetUsers.length > 0 ? input.targetUsers : ["developers"];

  return {
    projectName: input.projectName,
    summary: input.summary,
    targetUsers,
    coreFeatures,
    constraints: input.constraints ?? [],
  };
}

function mergePlanforgeInput(
  base: PlanforgePlanningInput,
  enrichment: IntakeEnrichment
): PlanforgePlanningInput {
  return {
    ...base,
    ...(uniqueStrings(enrichment.nonFunctionalRequirements)
      ? { nonFunctionalRequirements: uniqueStrings(enrichment.nonFunctionalRequirements) }
      : {}),
    ...(uniqueStrings(enrichment.integrations)
      ? { integrations: uniqueStrings(enrichment.integrations) }
      : {}),
    ...(uniqueStrings(enrichment.enterpriseRequirements)
      ? { enterpriseRequirements: uniqueStrings(enrichment.enterpriseRequirements) }
      : {}),
    ...(uniqueStrings(enrichment.openQuestions)
      ? { openQuestions: uniqueStrings(enrichment.openQuestions) }
      : {}),
    ...(enrichment.plannerProfile ? { plannerProfile: enrichment.plannerProfile } : {}),
    ...(enrichment.dataSensitivity ? { dataSensitivity: enrichment.dataSensitivity } : {}),
    ...(typeof enrichment.teamSize !== "undefined" ? { teamSize: enrichment.teamSize } : {}),
    ...(typeof enrichment.productionExpectedSoon === "boolean"
      ? { productionExpectedSoon: enrichment.productionExpectedSoon }
      : {}),
    ...(typeof enrichment.liveUsers === "boolean" ? { liveUsers: enrichment.liveUsers } : {}),
  };
}

/**
 * Shape attachments pass into the enrichment prompt. Only `text`-tier
 * entries with non-empty `inlineText` contribute — other tiers are
 * shape-validated at the planforge service boundary but are no-ops
 * here until later slices add vision/structured parsing.
 */
function attachmentsForPrompt(
  attachments: Attachment[] | undefined,
): Array<{ name: string; inlineText: string }> {
  if (!attachments || attachments.length === 0) return [];
  const out: Array<{ name: string; inlineText: string }> = [];
  for (const a of attachments) {
    if (a.tier !== "text") continue;
    if (typeof a.inlineText !== "string" || a.inlineText.length === 0) continue;
    out.push({ name: a.name, inlineText: a.inlineText });
  }
  return out;
}

async function enrichIntake(
  input: ProjectInput,
  base: PlanforgePlanningInput,
  attachments?: Attachment[]
): Promise<{ enrichment: IntakeEnrichment; provider: AiProviderName; model: string }> {
  const additionalContext = attachmentsForPrompt(attachments);
  const userPrompt = JSON.stringify(
    {
      projectInput: input,
      currentPlanforgeInput: base,
      // Only include `additionalContext` when the user actually uploaded
      // something. Keeps the no-attachment call byte-identical to the
      // pre-v0.1d path so cached completions and test fixtures don't drift.
      ...(additionalContext.length > 0 ? { additionalContext } : {}),
    },
    null,
    2
  );

  const result = await generateStructuredJson<IntakeEnrichment>(
    ENRICHMENT_SYSTEM_PROMPT,
    userPrompt,
    { temperature: 0.1, maxTokens: 700 }
  );

  return {
    enrichment: result.data,
    provider: result.provider,
    model: result.model,
  };
}

export async function buildPlanforgeInput(
  input: ProjectInput,
  attachments?: Attachment[]
): Promise<{
  planforgeInput: PlanforgePlanningInput;
  orchestration: PlanforgeOrchestrationMetadata;
}> {
  const base = createBasePlanforgeInput(input);
  const capabilities = getAiCapabilities();

  if (!capabilities.features.intakeEnrichment) {
    return {
      planforgeInput: base,
      orchestration: {
        mode: "deterministic",
        aiUsed: false,
        provider: capabilities.provider,
        model: capabilities.model,
      },
    };
  }

  try {
    const { enrichment, provider, model } = await enrichIntake(input, base, attachments);
    return {
      planforgeInput: mergePlanforgeInput(base, enrichment),
      orchestration: {
        mode: "ai-enriched",
        aiUsed: true,
        provider,
        model,
      },
    };
  } catch (error) {
    console.warn("AI intake enrichment failed, falling back to deterministic intake:", error);
    return {
      planforgeInput: base,
      orchestration: {
        mode: "deterministic",
        aiUsed: false,
        provider: capabilities.provider,
        model: capabilities.model,
      },
    };
  }
}
