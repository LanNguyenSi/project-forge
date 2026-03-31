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
}

interface AiProviderConfig {
  provider: AiProviderName;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENAI_MODEL = "gpt-4o-mini";

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
      model: GROQ_MODEL,
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
  });

  const completion = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? 800,
    ...(config.provider === "local" ? {} : { response_format: { type: "json_object" as const } }),
  });

  const content = completion.choices[0]?.message?.content ?? "";
  return {
    data: parseJsonObject<T>(content),
    provider: config.provider,
    model: config.model,
  };
}
