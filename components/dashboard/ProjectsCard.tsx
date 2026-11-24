"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/primitives";

interface ProjectRow {
  id: string;
  repoUrl: string;
  projectName: string;
  createdAt: string;
}

type State =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; projects: ProjectRow[]; total: number };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Only http(s) links are rendered as links; anything else shows as text. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function ProjectsCard() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/projects")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && Array.isArray(data.projects)) {
          setState({
            kind: "ready",
            projects: data.projects,
            total: typeof data.total === "number" ? data.total : data.projects.length,
          });
        } else {
          setState({ kind: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-labelledby="your-projects-heading">
      <h3 id="your-projects-heading" className="font-display text-lg font-semibold text-forge-mist mb-4">
        Your projects
      </h3>
      <Card tone="muted" padding="md">
        {state.kind === "loading" && (
          <p role="status" className="text-sm text-forge-ash">
            Loading your projects...
          </p>
        )}

        {state.kind === "error" && (
          <p role="alert" className="text-sm text-forge-ash">
            Your projects could not be loaded. Reload the page to try again.
          </p>
        )}

        {state.kind === "ready" && state.projects.length === 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <p className="text-sm text-forge-ash flex-1">
              No projects yet. Projects published through the API or your agent appear here.
            </p>
            <Link
              href="/create"
              className="shrink-0 inline-flex min-h-11 items-center text-sm font-medium text-ember hover:text-ember-soft transition"
            >
              Create a Project
            </Link>
          </div>
        )}

        {state.kind === "ready" && state.projects.length > 0 && (
          <>
            <ul className="divide-y divide-forge-steel">
              {state.projects.map((p) => (
                <li
                  key={p.id}
                  className="py-3 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1"
                >
                  {isHttpUrl(p.repoUrl) ? (
                    <a
                      href={p.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-ember hover:text-ember-soft transition break-all"
                    >
                      {p.projectName || p.repoUrl}
                    </a>
                  ) : (
                    <span className="text-sm font-medium text-forge-mist break-all">
                      {p.projectName || p.repoUrl}
                    </span>
                  )}
                  <span className="text-xs text-forge-ash shrink-0">{formatDate(p.createdAt)}</span>
                </li>
              ))}
            </ul>
            {state.total > state.projects.length && (
              <p className="mt-4 text-xs text-forge-ash">
                {state.total - state.projects.length} more{" "}
                {state.total - state.projects.length === 1 ? "project" : "projects"} not shown.
              </p>
            )}
            <p className="mt-4 text-xs text-forge-ash">
              Lists projects published through the API or your agent. Projects published from the web form are not recorded here.
            </p>
          </>
        )}
      </Card>
    </section>
  );
}
