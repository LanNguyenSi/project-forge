import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Alert, Field, Input, Label, Textarea } from "@/components/ui/primitives";

describe("Field + Label + Input association", () => {
  it("names a text input by its label", () => {
    render(
      <Field>
        <Label>Email</Label>
        <Input type="email" />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
  });

  it("names a textarea by its label", () => {
    render(
      <Field>
        <Label>Description</Label>
        <Textarea />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Description" })).toBeTruthy();
  });

  it("names an input that has no placeholder (password)", () => {
    render(
      <Field>
        <Label>Password</Label>
        <Input type="password" />
      </Field>,
    );
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("gives each Field its own id so two fields do not share a name", () => {
    render(
      <>
        <Field>
          <Label>First</Label>
          <Input />
        </Field>
        <Field>
          <Label>Second</Label>
          <Input />
        </Field>
      </>,
    );
    const first = screen.getByRole("textbox", { name: "First" });
    const second = screen.getByRole("textbox", { name: "Second" });
    expect(first.id).not.toBe("");
    expect(first.id).not.toBe(second.id);
  });

  it("keeps the required marker out of the accessible name", () => {
    render(
      <Field>
        <Label required>Project Name</Label>
        <Input required />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Project Name" })).toBeTruthy();
  });

  it("an explicit id and htmlFor win over the Field id", () => {
    render(
      <Field>
        <Label htmlFor="custom">Custom</Label>
        <Input id="custom" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Custom" });
    expect(input.id).toBe("custom");
  });

  it("an explicit id wins over the Field id on a textarea", () => {
    render(
      <Field>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Notes" }).id).toBe("notes");
  });

  it("works without a Field when id and htmlFor are given explicitly", () => {
    render(
      <>
        <Label htmlFor="solo">Solo</Label>
        <Input id="solo" />
      </>,
    );
    expect(screen.getByRole("textbox", { name: "Solo" })).toBeTruthy();
  });

  it("renders no association outside a Field when nothing is passed", () => {
    render(
      <>
        <Label>Loose</Label>
        <Input />
      </>,
    );
    expect(screen.queryByRole("textbox", { name: "Loose" })).toBeNull();
  });
});

describe("Alert live-region role", () => {
  it("announces the error variant assertively with role=alert", () => {
    render(<Alert variant="error">Broke</Alert>);
    expect(screen.getByRole("alert").textContent).toContain("Broke");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["success", "info", "warning"] as const)(
    "announces the %s variant politely with role=status",
    (variant) => {
      render(<Alert variant={variant}>Note</Alert>);
      expect(screen.getByRole("status").textContent).toContain("Note");
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("defaults to the info variant (role=status)", () => {
    render(<Alert>Default</Alert>);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
