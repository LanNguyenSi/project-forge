import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { ProjectsCard } from "@/components/dashboard/ProjectsCard";

const fetchMock = vi.fn();

function respond(body: unknown) {
  fetchMock.mockResolvedValue({ json: async () => body });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("dashboard ProjectsCard", () => {
  it("shows a loading state first", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ProjectsCard />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading/);
  });

  it("lists projects with a safe external link and a date", async () => {
    respond({
      ok: true,
      total: 2,
      projects: [
        { id: "1", repoUrl: "https://github.com/me/alpha", projectName: "alpha", createdAt: "2026-03-05T10:00:00.000Z" },
        { id: "2", repoUrl: "https://github.com/me/beta", projectName: "beta", createdAt: "2026-02-01T10:00:00.000Z" },
      ],
    });
    render(<ProjectsCard />);
    const link = await screen.findByRole("link", { name: "alpha" });
    expect(link.getAttribute("href")).toBe("https://github.com/me/alpha");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("2026-03-05")).toBeTruthy();
    expect(screen.queryByText(/more project/)).toBeNull();
    expect(screen.getByText(/Projects published from the web form are not recorded/)).toBeTruthy();
  });

  it("does not turn a non-http repo URL into a link", async () => {
    respond({
      ok: true,
      total: 1,
      projects: [{ id: "1", repoUrl: "javascript:alert(1)", projectName: "alert(1)", createdAt: "2026-03-05T10:00:00.000Z" }],
    });
    render(<ProjectsCard />);
    await screen.findByText("alert(1)");
    expect(screen.queryByRole("link", { name: "alert(1)" })).toBeNull();
  });

  it("says how many more exist when total exceeds the shown rows", async () => {
    respond({
      ok: true,
      total: 5,
      projects: [{ id: "1", repoUrl: "https://github.com/me/a", projectName: "a", createdAt: "2026-03-05T10:00:00.000Z" }],
    });
    render(<ProjectsCard />);
    expect(await screen.findByText(/4 more projects not shown/)).toBeTruthy();
  });

  it("uses the singular for one more", async () => {
    respond({
      ok: true,
      total: 2,
      projects: [{ id: "1", repoUrl: "https://github.com/me/a", projectName: "a", createdAt: "2026-03-05T10:00:00.000Z" }],
    });
    render(<ProjectsCard />);
    expect(await screen.findByText(/1 more project not shown/)).toBeTruthy();
  });

  it("shows the empty state with a CTA to /create", async () => {
    respond({ ok: true, total: 0, projects: [] });
    render(<ProjectsCard />);
    expect(await screen.findByText(/published through the API or your agent appear here/)).toBeTruthy();
    const cta = screen.getByRole("link", { name: "Create a Project" });
    expect(cta.getAttribute("href")).toBe("/create");
  });

  it("shows an error state when the response is not ok", async () => {
    respond({ ok: false, error: "Unauthorized" });
    render(<ProjectsCard />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText(/No projects yet/)).toBeNull();
  });

  it("shows an error state when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    render(<ProjectsCard />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText(/No projects yet/)).toBeNull();
  });
});
