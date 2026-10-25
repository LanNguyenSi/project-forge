import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { PreviewPanel } from "@/components/PreviewPanel";
import type { GenerationPreview } from "@/lib/types";

const preview: GenerationPreview = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  projectName: "demo",
  tasks: [
    {
      id: "task-1",
      title: "Set up the repository",
      wave: "wave-1",
      category: "backend",
      priority: "high",
      summary: "Scaffold the initial commit.",
    },
  ],
  architectureOverview: "",
  fileTree: [],
  taskCount: 1,
  waveCount: 1,
};

describe("PreviewPanel task row contrast", () => {
  it("renders the task category in full text-forge-ash, not an opacity-reduced variant", () => {
    render(<PreviewPanel preview={preview} onConfirm={vi.fn()} onBack={vi.fn()} />);
    const category = screen.getByText("backend");
    expect(category.className).toContain("text-forge-ash");
    expect(category.className).not.toMatch(/text-forge-ash\/\d+/);
  });
});
