import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectForm } from "@/components/ProjectForm";
import { PROMPT_MODE_MAX_CHARS } from "@/lib/limits";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProjectForm AI magic fill and the session gate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides the magic fill panel when the capabilities request is rejected with 401", async () => {
    // The body claims enabled: true so only the status check can hide the panel.
    fetchMock.mockResolvedValue(jsonResponse(401, { enabled: true }));
    render(<ProjectForm onSubmit={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ai-assist"));
    // let the promise chain settle
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("AI Magic Fill")).toBeNull();
  });

  it("shows the panel when capabilities are enabled", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { enabled: true }));
    render(<ProjectForm onSubmit={vi.fn()} />);
    expect(await screen.findByText("AI Magic Fill")).toBeTruthy();
  });

  it("shows the session-expired message when the fill request is rejected with 401", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse(401, { ok: false, error: "Not authenticated" })
        : jsonResponse(200, { enabled: true }),
    );
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByText("AI Magic Fill");
    fireEvent.change(screen.getByPlaceholderText(/todo app/i), {
      target: { value: "a todo app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill Form" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your session has expired");
  });

  it("caps the prompt input at PROMPT_MODE_MAX_CHARS via maxLength", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { enabled: true }));
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByText("AI Magic Fill");
    const input = screen.getByRole("textbox", { name: "AI seed prompt" });
    expect(input.getAttribute("maxlength")).toBe(String(PROMPT_MODE_MAX_CHARS));
  });

  it("shows a prompt counter wired to the input through aria-describedby", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { enabled: true }));
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByText("AI Magic Fill");
    const input = screen.getByRole("textbox", { name: "AI seed prompt" });
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const counter = document.getElementById(describedBy as string);
    expect(counter).not.toBeNull();
    const cap = PROMPT_MODE_MAX_CHARS.toLocaleString("en-US");
    expect(counter!.textContent).toBe(`0 / ${cap}`);
    fireEvent.change(input, { target: { value: "a todo app" } });
    expect(counter!.textContent).toBe(`10 / ${cap}`);
    // A programmatic set can bypass the native maxLength, so the change
    // handler clamps to the cap: the counter and the field stop there.
    fireEvent.change(input, { target: { value: "x".repeat(PROMPT_MODE_MAX_CHARS + 5) } });
    expect((input as HTMLInputElement).value).toHaveLength(PROMPT_MODE_MAX_CHARS);
    expect(counter!.textContent).toBe(`${cap} / ${cap}`);
  });

  it("shows the 413 details next to the error message", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse(413, {
            ok: false,
            error: "prompt exceeds size limit",
            details: "10,001 chars; limit is 10,000",
          })
        : jsonResponse(200, { enabled: true }),
    );
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByText("AI Magic Fill");
    fireEvent.change(screen.getByPlaceholderText(/todo app/i), {
      target: { value: "a todo app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill Form" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("prompt exceeds size limit");
    expect(alert.textContent).toContain("10,001 chars; limit is 10,000");
  });

  it("shows only the error when the failure answer carries no details", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? jsonResponse(400, { ok: false, error: "Prompt is required" })
        : jsonResponse(200, { enabled: true }),
    );
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByText("AI Magic Fill");
    fireEvent.change(screen.getByPlaceholderText(/todo app/i), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fill Form" }));
    const alert = await screen.findByRole("alert");
    const message = alert.querySelector("div.flex-1");
    expect(message?.textContent).toBe("Prompt is required");
  });
});
