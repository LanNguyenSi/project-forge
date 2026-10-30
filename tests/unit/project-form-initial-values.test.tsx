import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ProjectForm } from "@/components/ProjectForm";
import type { ProjectInput } from "@/lib/types";

const first: ProjectInput = {
  projectName: "Alpha",
  summary: "first summary",
  features: ["a", "b"],
  constraints: [],
};
const second: ProjectInput = {
  projectName: "Beta",
  summary: "second summary",
  features: ["c"],
  constraints: [],
};

describe("ProjectForm initialValues seeding", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ enabled: false }), { status: 200 }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seeds the fields on first render", () => {
    render(<ProjectForm onSubmit={vi.fn()} initialValues={first} />);
    expect((screen.getByRole("textbox", { name: /Project Name/ }) as HTMLInputElement).value).toBe("Alpha");
    expect((screen.getByRole("textbox", { name: /Summary/ }) as HTMLTextAreaElement).value).toBe("first summary");
  });

  it("re-seeds the fields when a different initialValues object arrives", () => {
    const { rerender } = render(<ProjectForm onSubmit={vi.fn()} initialValues={first} />);
    rerender(<ProjectForm onSubmit={vi.fn()} initialValues={second} />);
    expect((screen.getByRole("textbox", { name: /Project Name/ }) as HTMLInputElement).value).toBe("Beta");
    expect((screen.getByRole("textbox", { name: /Summary/ }) as HTMLTextAreaElement).value).toBe("second summary");
  });

  it("seeds late when initialValues arrives after the first render", () => {
    const { rerender } = render(<ProjectForm onSubmit={vi.fn()} />);
    rerender(<ProjectForm onSubmit={vi.fn()} initialValues={first} />);
    expect((screen.getByRole("textbox", { name: /Project Name/ }) as HTMLInputElement).value).toBe("Alpha");
  });

  it("keeps user edits when the same initialValues object is passed again", () => {
    const { rerender } = render(<ProjectForm onSubmit={vi.fn()} initialValues={first} />);
    const input = screen.getByRole("textbox", { name: /Project Name/ }) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "Edited");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    rerender(<ProjectForm onSubmit={vi.fn()} initialValues={first} />);
    expect((screen.getByRole("textbox", { name: /Project Name/ }) as HTMLInputElement).value).toBe("Edited");
  });

  it("leaves the fields alone when initialValues goes back to undefined", () => {
    const { rerender } = render(<ProjectForm onSubmit={vi.fn()} initialValues={first} />);
    rerender(<ProjectForm onSubmit={vi.fn()} />);
    expect((screen.getByRole("textbox", { name: /Project Name/ }) as HTMLInputElement).value).toBe("Alpha");
  });
});
