import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ProjectForm } from "@/components/ProjectForm";
import { Field, Label, Textarea } from "@/components/ui/primitives";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProjectForm accessible names and heading order", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // Magic fill enabled, so the prompt input and the heading are rendered.
    fetchMock.mockResolvedValue(jsonResponse(200, { enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names every project field by its label, not its placeholder", async () => {
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByRole("heading", { level: 2, name: /AI Magic Fill/ });
    expect(screen.getByRole("textbox", { name: "Project Name" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Core Features" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Constraints" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Target Users" })).toBeTruthy();
  });

  it("keeps the hint out of the accessible name and in the description", async () => {
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByRole("heading", { level: 2, name: /AI Magic Fill/ });
    for (const name of ["Core Features", "Constraints", "Target Users"]) {
      const control = screen.getByRole("textbox", { name });
      expect(control).toHaveAccessibleDescription("(one per line)");
    }
  });

  it("gives a field without a hint or an error no aria-describedby", async () => {
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByRole("heading", { level: 2, name: /AI Magic Fill/ });
    expect(screen.getByRole("textbox", { name: "Project Name" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("names the hint in one field's description", () => {
    render(
      <Field>
        <Label required hint="(one per line)">Core Features</Label>
        <Textarea rows={2} defaultValue="" />
      </Field>,
    );
    const control = screen.getByRole("textbox", { name: "Core Features" });
    expect(control).toHaveAccessibleDescription("(one per line)");
  });

  it("names the magic-fill prompt input through its screen-reader label", async () => {
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByRole("heading", { level: 2, name: /AI Magic Fill/ });
    expect(screen.getByRole("textbox", { name: "AI seed prompt" })).toBeTruthy();
  });

  it("names the magic-fill file input through its screen-reader label", async () => {
    render(<ProjectForm onSubmit={vi.fn()} />);
    await screen.findByRole("heading", { level: 2, name: /AI Magic Fill/ });
    fireEvent.click(await screen.findByRole("tab", { name: "File" }));
    const fileInput = screen.getByLabelText("Upload a project document");
    expect(fileInput.getAttribute("type")).toBe("file");
  });

  it("keeps the magic-fill heading an h2 under the page h1", async () => {
    render(<ProjectForm onSubmit={vi.fn()} />);
    expect(await screen.findByRole("heading", { level: 2, name: /AI Magic Fill/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3, name: /AI Magic Fill/ })).toBeNull();
  });
});
