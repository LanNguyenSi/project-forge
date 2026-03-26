import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ProjectInput } from "@/lib/types";

export async function GET() {
  // Status endpoint - check if AI assist is available
  const enabled = !!(process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY);
  return NextResponse.json({ enabled });
}

export async function POST(req: NextRequest) {
  try {
    const { prompt } = await req.json();

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return NextResponse.json(
        { error: "Prompt is required" },
        { status: 400 }
      );
    }

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OpenAI API key not configured" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a project specification assistant. Extract project details from user descriptions and return structured JSON.

Return ONLY a JSON object (no markdown, no explanations) with these fields:
- projectName: string (kebab-case, no spaces, lowercase, max 50 chars)
- summary: string (1-2 sentences describing what the project does)
- features: string[] (array of core feature descriptions, 2-5 items)
- constraints: string[] (technical requirements/constraints, 0-3 items)
- targetUsers: string[] (who will use this, default ["developers"] if unclear)

Guidelines:
- projectName should be descriptive but concise (e.g., "task-manager-app", "markdown-blog")
- summary should be clear and concise
- features should be specific and actionable
- constraints should mention tech stack, deployment, or other requirements if specified
- If the user mentions specific technologies, include them in constraints

Example input: "I want to build a todo app with React and TypeScript that syncs across devices"
Example output:
{
  "projectName": "todo-sync-app",
  "summary": "A cross-device task management application with real-time synchronization",
  "features": ["Task CRUD operations", "Real-time sync across devices", "User authentication"],
  "constraints": ["Use React", "Use TypeScript", "Real-time sync required"],
  "targetUsers": ["productivity users", "developers"]
}`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      return NextResponse.json(
        { error: "No response from AI" },
        { status: 500 }
      );
    }

    // Parse JSON response
    let projectData: ProjectInput;
    try {
      projectData = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { error: "Failed to parse AI response", details: content },
        { status: 500 }
      );
    }

    // Validate required fields
    if (!projectData.projectName || !projectData.summary) {
      return NextResponse.json(
        { error: "AI response missing required fields" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: projectData,
    });
  } catch (error: any) {
    console.error("AI assist error:", error);
    return NextResponse.json(
      { error: "AI assist failed", details: error.message },
      { status: 500 }
    );
  }
}
