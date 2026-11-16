import OpenAI from "openai";

export type AiProviderName = "local" | "groq" | "openai";

export interface AiCapabilities {
  enabled: boolean;
  provider: AiProviderName | null;
  model: string | null;
  features: {
    magicFill: boolean;
    intakeEnrichment: boolean;
    postScaffoldReview: boolean;
  };
  /**
   * Conservative CHARACTER budget (not a token count) for an enrichment
   * payload sent to this provider. Used to proportionally truncate large
   * uploaded attachments so we do not silently overflow a small-context
   * local model's window. Roughly 4 chars per token, so 20000 chars is a
   * deliberately cautious ceiling for a typical 8k-token local model.
   */
  maxContextChars: number;
}

// Per-provider conservative character budgets for the enrichment payload.
// These are CHARACTER budgets, not token counts: local models often run an
// 8k-token (~32k char) window, so 20000 chars leaves comfortable headroom
// for the system prompt and the model's own output. Hosted providers (groq,
// openai) carry much larger windows, so 50000 chars is safe there.
const MAX_CONTEXT_CHARS: Record<AiProviderName, number> = {
  local: 20000,
  groq: 50000,
  openai: 50000,
};
// Default used when no provider is configured. Matches the hosted ceiling so
// deterministic-fallback callers that still read the field get a sane value.
const DEFAULT_MAX_CONTEXT_CHARS = 50000;

interface AiProviderConfig {
  provider: AiProviderName;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

// Groq retires models on its own schedule (llama-3.3-70b-versatile was
// shut down for free/developer tiers and then 404s), so the model is
// overridable via GROQ_MODEL without a release.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const OPENAI_MODEL = "gpt-4o-mini";

// gpt-oss models are reasoning models: their reasoning tokens are spent
// out of the same completion budget as the JSON answer. Callers size
// maxTokens for the answer alone, so reasoning models get low effort plus
// fixed headroom on top, otherwise the JSON gets truncated.
const REASONING_TOKEN_HEADROOM = 1024;

// Bounds for the client below. A caller that is a publishing request holds a
// quota reservation for the whole call, so the client must end well inside
// RESERVATION_TTL_MS (lib/db.ts). Retries multiply the bound: the worst case
// of one generateStructuredJson() call is AI_REQUEST_TIMEOUT_MS *
// (1 + AI_MAX_RETRIES). The SDK defaults (10 min timeout, 2 retries) are
// many times the reservation TTL, so both are pinned explicitly.
//
// Two limits of the SDK bound, stated because the reservation math depends
// on them: the `timeout` is armed per attempt and cleared once the response
// headers arrive, so a provider that sends headers and then stalls the body
// is not cut off; and before a retry the SDK sleeps (its own backoff, or the
// `Retry-After` / `retry-after-ms` header if present), which is waiting
// outside every attempt's timeout. Both are residuals of the worst-case sum
// next to RESERVATION_TTL_MS, not covered by the numbers here.
export const AI_REQUEST_TIMEOUT_MS = 45_000;
export const AI_MAX_RETRIES = 1;

function isReasoningModel(model: string): boolean {
  return model.startsWith("openai/gpt-oss-");
}

function getAiProviderConfig(): AiProviderConfig | null {
  if (process.env.LOCAL_AI_BASE_URL && process.env.LOCAL_AI_MODEL) {
    return {
      provider: "local",
      model: process.env.LOCAL_AI_MODEL,
      baseURL: process.env.LOCAL_AI_BASE_URL,
      apiKey: process.env.LOCAL_AI_API_KEY,
    };
  }

  if (process.env.GROQ_API_KEY) {
    return {
      provider: "groq",
      model: process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
      baseURL: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: OPENAI_MODEL,
      apiKey: process.env.OPENAI_API_KEY,
    };
  }

  return null;
}

function parseJsonObject<T>(content: string): T {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("AI returned an empty response");
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]) as T;
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }

    throw new Error("AI response was not valid JSON");
  }
}

export function getAiCapabilities(): AiCapabilities {
  const config = getAiProviderConfig();

  return {
    enabled: !!config,
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    features: {
      magicFill: !!config,
      intakeEnrichment: !!config,
      postScaffoldReview: !!config,
    },
    maxContextChars: config ? MAX_CONTEXT_CHARS[config.provider] : DEFAULT_MAX_CONTEXT_CHARS,
  };
}

export async function generateStructuredJson<T>(
  systemPrompt: string,
  userPrompt: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
  }
): Promise<{ data: T; provider: AiProviderName; model: string }> {
  const config = getAiProviderConfig();

  if (!config) {
    throw new Error("No AI provider configured");
  }

  const client = new OpenAI({
    apiKey: config.apiKey ?? "local-dev",
    baseURL: config.baseURL,
    timeout: AI_REQUEST_TIMEOUT_MS,
    maxRetries: AI_MAX_RETRIES,
  });

  const reasoning = isReasoningModel(config.model);
  const answerTokens = options?.maxTokens ?? 800;

  const completion = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: options?.temperature ?? 0.2,
    max_tokens: reasoning ? answerTokens + REASONING_TOKEN_HEADROOM : answerTokens,
    ...(reasoning ? { reasoning_effort: "low" as const } : {}),
    ...(config.provider === "local" ? {} : { response_format: { type: "json_object" as const } }),
  });

  const content = completion.choices[0]?.message?.content ?? "";
  return {
    data: parseJsonObject<T>(content),
    provider: config.provider,
    model: config.model,
  };
}
