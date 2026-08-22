import { NextRequest, NextResponse } from "next/server";
import type { ProjectInput } from "@/lib/types";
import { getAiCapabilities, generateStructuredJson } from "@/lib/ai-provider";

const PROMPT_SYSTEM_PROMPT = `You are a project specification assistant. Extract project details from user descriptions and return structured JSON.

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

// File-mode system prompt. The intent is extraction from existing
// documents (arc42, RFCs, charters, ADRs), not invention. We explicitly
// permit empty arrays when the document is silent on a dimension — the
// user's intake form shows the result and they'll fill gaps manually.
// Keeping features/targetUsers non-empty is still required because
// downstream validation rejects empty arrays; we surface a sensible
// fallback rather than leaving the user to fight validation.
const FILE_SYSTEM_PROMPT = `You extract project intake from uploaded project documents (arc42, RFCs, charters, ADRs, one-pagers).

Return ONLY a JSON object (no markdown, no code blocks, no explanations) with these fields:
- projectName: string (kebab-case, lowercase, max 50 chars — derived from the document's named project or subject)
- summary: string (1-2 sentences paraphrasing the document's stated purpose)
- features: string[] (core capabilities the document describes, 2-5 items; if the document doesn't enumerate features, infer the 2-3 most visible ones — do NOT invent scope beyond what's stated)
- constraints: string[] (technical/architectural constraints literally stated in the document, 0-5 items; empty if none are stated)
- targetUsers: string[] (user/operator groups the document names, at least 1 item; "users" or "operators" as a safe default if unnamed)

Guidelines:
- Prefer facts stated in the document over speculation. If a field has no evidence in the text, use the minimum default, not a guess.
- Extract named technologies from the document into constraints (e.g. "PostgreSQL", "TypeScript", "Kubernetes").
- Preserve the document's own terminology where possible — don't rename features unless translation is necessary.
- Output JSON only.`;

export async function GET() {
  const capabilities = getAiCapabilities();
  return NextResponse.json({
    enabled: capabilities.enabled,
    provider: capabilities.provider,
    model: capabilities.model,
    features: capabilities.features,
  });
}

interface AiAssistRequest {
  mode?: "prompt" | "file";
  prompt?: string;
  fileContent?: string;
  fileName?: string;
}

// Server-side cap on file-mode content. Mirrors the UI's 50k char limit
// so a direct API caller (bypassing the browser) can't drive unbounded
// token costs at our provider. Matches the same cap planforge's v0.1b
// ingest enforces further down the pipeline.
const FILE_MODE_MAX_CHARS = 50_000;
// Filename is user-controlled and goes verbatim into the userPrompt.
// Strip newlines (prevents in-prompt instruction smuggling via a crafted
// filename that fakes a system-prompt break) and truncate so a pathologically
// long name doesn't eat into the content budget.
function sanitizeFileName(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "document";
  return s.replace(/[\r\n]+/g, " ").slice(0, 200) || "document";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AiAssistRequest;
    // Back-compat: an older client that sends only `{ prompt }` is
    // treated as mode="prompt". New clients explicitly pass mode.
    const mode: "prompt" | "file" = body.mode === "file" ? "file" : "prompt";

    let systemPrompt: string;
    let userPrompt: string;

    if (mode === "file") {
      const fileContent = typeof body.fileContent === "string" ? body.fileContent : "";
      const fileName = sanitizeFileName(body.fileName);
      if (fileContent.trim().length === 0) {
        return NextResponse.json(
          { ok: false, error: "fileContent is required for mode=file" },
          { status: 400 },
        );
      }
      if (fileContent.length > FILE_MODE_MAX_CHARS) {
        return NextResponse.json(
          {
            ok: false,
            error: "fileContent exceeds size limit",
            details: `${fileContent.length.toLocaleString()} chars; limit is ${FILE_MODE_MAX_CHARS.toLocaleString()}`,
          },
          { status: 413 },
        );
      }
      systemPrompt = FILE_SYSTEM_PROMPT;
      // Prefix the filename so the model has the document's identity
      // (arc42.md vs CHARTER.md vs rfc-0003.md often changes tone). The
      // document body follows verbatim.
      userPrompt = `Document filename: ${fileName}\n\n---\n\n${fileContent}`;
    } else {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (prompt.length === 0) {
        return NextResponse.json({ ok: false, error: "Prompt is required" }, { status: 400 });
      }
      systemPrompt = PROMPT_SYSTEM_PROMPT;
      userPrompt = prompt;
    }

    const capabilities = getAiCapabilities();
    if (!capabilities.enabled) {
      return NextResponse.json({ ok: false, error: "No AI provider configured" }, { status: 500 });
    }

    // File mode carries materially more input than prompt mode (up to
    // 50k chars, ~12.5k tokens). 500 output tokens is still enough for
    // the extract schema; going higher doesn't help because the shape
    // is bounded. Temperature stays higher for prompt mode (creative
    // interpretation) and lower for file mode (faithful extraction).
    const result = await generateStructuredJson<ProjectInput>(systemPrompt, userPrompt, {
      temperature: mode === "file" ? 0.2 : 0.7,
      maxTokens: 500,
    });
    const projectData = result.data;

    if (!projectData.projectName || !projectData.summary) {
      return NextResponse.json({ ok: false, error: "AI response missing required fields" }, { status: 500 });
    }

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
    return NextResponse.json({ ok: false, error: "AI assist failed", details: msg }, { status: 500 });
  }
}
