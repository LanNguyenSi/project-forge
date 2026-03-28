import { NextRequest, NextResponse } from "next/server";
import type { ProjectInput } from "@/lib/types";
import { getAiCapabilities, generateStructuredJson } from "@/lib/ai-provider";

const SYSTEM_PROMPT = `You are a project specification assistant. Extract project details from user descriptions and return structured JSON.

Return ONLY a JSON object (no markdown, no code blocks, no explanations) with these fields:
- projectName: string (kebab-case, no spaces, lowercase, max 50 chars)
- summary: string (1-2 sentences describing what the project does)
- features: string[] (array of core feature descriptions, 2-5 items)
- constraints: string[] (technical requirements/constraints, 0-3 items)
- targetUsers: string[] (who will use this, default ["developers"] if unclear, at least 1 item)

Guidelines:
- projectName should be descriptive but concise (e.g., "task-manager-app", "markdown-blog")
- features MUST have at least 2 items
- targetUsers MUST have at least 1 item
- If user mentions specific technologies, include them in constraints

Example input: "I want to build a todo app with React and TypeScript that syncs across devices"
Example output:
{"projectName":"todo-sync-app","summary":"A cross-device task management application with real-time synchronization","features":["Task CRUD operations","Real-time sync across devices","User authentication"],"constraints":["Use React","Use TypeScript"],"targetUsers":["productivity users","developers"]}`;

export async function GET() {
  const capabilities = getAiCapabilities();
  return NextResponse.json({
    enabled: capabilities.enabled,
    provider: capabilities.provider,
    model: capabilities.model,
    features: capabilities.features,
  });
}

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json() as { prompt: string };

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    const capabilities = getAiCapabilities();

    if (!capabilities.enabled) {
      return NextResponse.json({ error: "No AI provider configured" }, { status: 500 });
    }

    const result = await generateStructuredJson<ProjectInput>(SYSTEM_PROMPT, prompt.trim(), {
      temperature: 0.7,
      maxTokens: 500,
    });
    const projectData = result.data;

    if (!projectData.projectName || !projectData.summary) {
      return NextResponse.json({ error: "AI response missing required fields" }, { status: 500 });
    }

    // Ensure arrays are non-empty
    if (!projectData.features || projectData.features.length === 0) {
      projectData.features = ["core functionality"];
    }
    if (!projectData.targetUsers || projectData.targetUsers.length === 0) {
      projectData.targetUsers = ["developers"];
    }

    return NextResponse.json({
      ok: true,
      data: projectData,
      provider: result.provider,
      model: result.model,
    });
  } catch (error: unknown) {
    console.error("AI assist error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "AI assist failed", details: msg }, { status: 500 });
  }
}
