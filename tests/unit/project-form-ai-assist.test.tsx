import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectForm } from "@/components/ProjectForm";

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
    fetchMock.mockResolvedValue(jsonResponse(401, { ok: false, error: "Not authenticated" }));
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
});
