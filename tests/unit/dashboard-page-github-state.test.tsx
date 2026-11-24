import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, status: "authenticated" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/dashboard/ProjectsCard", () => ({
  ProjectsCard: () => <div data-testid="projects-card" />,
}));

import DashboardPage from "@/app/(dashboard)/dashboard/page";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function dashboard(user: Record<string, unknown>) {
  fetchMock.mockResolvedValue({ json: async () => ({ ok: true, user, tokens: [] }) });
}

describe("dashboard page GitHub state", () => {
  it("shows the connect card when no PAT is connected", async () => {
    dashboard({ id: "u1", githubPatConnected: false });
    render(<DashboardPage />);
    expect(await screen.findByText("Connect GitHub to get started")).toBeTruthy();
  });

  it("shows the create card when a PAT is connected", async () => {
    dashboard({ id: "u1", githubPatConnected: true });
    render(<DashboardPage />);
    expect(await screen.findByText("Create your first project")).toBeTruthy();
  });

  it("ignores a githubOwner field: /api/dashboard does not return it, only githubPatConnected counts", async () => {
    dashboard({ id: "u1", githubPatConnected: false, githubOwner: "someone" });
    render(<DashboardPage />);
    expect(await screen.findByText("Connect GitHub to get started")).toBeTruthy();
  });

  it("renders the projects card in both GitHub states", async () => {
    dashboard({ id: "u1", githubPatConnected: false });
    const { unmount } = render(<DashboardPage />);
    expect(await screen.findByTestId("projects-card")).toBeTruthy();
    unmount();
    dashboard({ id: "u1", githubPatConnected: true });
    render(<DashboardPage />);
    expect(await screen.findByTestId("projects-card")).toBeTruthy();
  });
});
