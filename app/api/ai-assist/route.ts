import { NextRequest, NextResponse } from "next/server";
import type { ProjectInput } from "@/lib/types";

const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENAI_MODEL = "gpt-4o-mini";

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

async function callGroq(prompt: string): Promise<ProjectInput> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`Groq API error: ${res.status}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content) as ProjectInput;
}

async function callOpenAI(prompt: string): Promise<ProjectInput> {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    max_tokens: 500,
    response_format: { type: "json_object" },
  });
  const content = completion.choices[0]?.message?.content ?? "";
  return JSON.parse(content) as ProjectInput;
}

export async function GET() {
  const enabled = !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY);
  const provider = process.env.GROQ_API_KEY ? "groq" : process.env.OPENAI_API_KEY ? "openai" : null;
  return NextResponse.json({ enabled, provider });
}

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json() as { prompt: string };

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: "No AI provider configured" }, { status: 500 });
    }

    let projectData: ProjectInput;

    // Prefer Groq (faster + free), fall back to OpenAI
    if (process.env.GROQ_API_KEY) {
      projectData = await callGroq(prompt.trim());
    } else {
      projectData = await callOpenAI(prompt.trim());
    }

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

    return NextResponse.json({ ok: true, data: projectData });
  } catch (error: unknown) {
    console.error("AI assist error:", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "AI assist failed", details: msg }, { status: 500 });
  }
}
