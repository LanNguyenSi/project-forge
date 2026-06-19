"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { PublicNav } from "@/components/layout/PublicNav";
import { ForgeMark } from "@/components/layout/ForgeMark";
import { Card } from "@/components/ui/primitives/Card";

const features = [
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
    title: "AI-Planned",
    desc: "Every project is planned by agent-planforge. Tasks, waves, and architecture are generated automatically.",
  },
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.25 5.25a2.121 2.121 0 11-3-3l5.25-5.25m0 0L15.66 3.93a2.25 2.25 0 013.18 0l1.23 1.23a2.25 2.25 0 010 3.18l-8.25 8.25M3.75 4.5h3.75" />
      </svg>
    ),
    title: "Scaffolded",
    desc: "scaffoldkit generates the file structure, Makefile, CI, and docs. Ready to clone and build.",
  },
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
      </svg>
    ),
    title: "Agent-Ready API",
    desc: "One POST request from your agent creates a GitHub repo. No PAT required, just your project-forge token.",
  },
  {
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
      </svg>
    ),
    title: "Zero to Repo in Seconds",
    desc: "From idea to a cloneable GitHub repository in under 30 seconds.",
  },
];

const steps = [
  { title: "Describe your project", desc: "Fill in name, summary, features, and constraints." },
  { title: "Review the plan", desc: "Browse tasks, architecture, and file tree. Regenerate if needed." },
  { title: "Confirm & publish", desc: "One click creates the GitHub repo and pushes the scaffold." },
  { title: "Clone & build", desc: "Hand off to your agent. The plan is already inside the repo." },
];

export default function LandingPage() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  if (status === "loading" || status === "authenticated") return null;

  return (
    <main className="min-h-screen bg-forge-void text-forge-mist">
      <PublicNav />

      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <section className="max-w-4xl mx-auto px-6 py-24 text-center">
        {/* Status pill */}
        <div className="inline-flex items-center gap-2 rounded-full border border-forge-steel bg-forge-iron/60 px-4 py-1.5 text-sm text-forge-ash mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-ember animate-pulse" />
          AI-powered project scaffolding
        </div>

        {/* Headline */}
        <h1 className="font-display text-4xl sm:text-6xl font-bold mb-6 leading-tight tracking-tight text-forge-mist">
          Cold idea.{" "}
          <br className="hidden sm:block" />
          Hot forge.{" "}
          <br />
          Shippable repo.
        </h1>

        {/* Sub-headline */}
        <p className="text-forge-ash text-lg sm:text-xl mb-10 max-w-2xl mx-auto leading-relaxed">
          project-forge uses planforge + scaffoldkit to turn your project description into a
          fully planned, scaffolded, and committed repository, ready for your agent to build.
        </p>

        {/* CTAs — heat gradient reserved for primary action only */}
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/login"
            className="rounded-btn bg-heat px-8 py-3.5 font-display font-medium text-forge-void hover:opacity-90 transition-opacity text-base"
          >
            Create a project &rarr;
          </Link>
          <Link
            href="/docs"
            className="rounded-btn bg-forge-steel px-8 py-3.5 font-medium text-forge-mist hover:bg-forge-steel/70 transition-colors text-base"
          >
            API Docs
          </Link>
        </div>

        {/* Terminal block — heat-seam touch, verbatim snippet */}
        <div className="mt-14 heat-seam rounded-card bg-forge-iron border border-forge-steel p-6 text-left max-w-2xl mx-auto">
          <div className="flex items-center gap-2 mb-4">
            {/* Forge-toned terminal dots: ember / gold / steel */}
            <div className="h-3 w-3 rounded-full bg-ember/70" />
            <div className="h-3 w-3 rounded-full bg-gold/70" />
            <div className="h-3 w-3 rounded-full bg-forge-steel border border-forge-steel" />
            <span className="text-forge-ash text-xs ml-2 font-mono">agent.sh</span>
          </div>
          <pre className="text-sm font-mono text-forge-mist leading-relaxed overflow-x-auto">{`curl -X POST https://project-forge.opentriologue.ai/api/v1/projects \\
  -H "X-API-Key: $PROJECTFORGE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectName": "my-cli-tool",
    "summary": "A CLI that syncs agent memory via Git",
    "features": ["push", "pull", "conflict resolution"]
  }'

# → { "ok": true, "result": { "repoUrl": "https://github.com/..." } }`}</pre>
        </div>
      </section>

      {/* ── Features ─────────────────────────────────────────────────────────── */}
      <section className="bg-forge-iron/20 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="font-display text-2xl font-bold text-center text-forge-mist mb-12">
            Everything your agent needs
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {features.map((f) => (
              <Card
                key={f.title}
                tone="default"
                className="border border-forge-steel/40 hover:border-forge-steel transition-colors group"
              >
                <div className="h-10 w-10 rounded-card bg-ember/10 border border-ember/20 flex items-center justify-center text-ember mb-4 group-hover:bg-ember/15 transition-colors">
                  {f.icon}
                </div>
                <h3 className="font-display font-semibold text-lg text-forge-mist mb-2">{f.title}</h3>
                <p className="text-forge-ash text-sm leading-relaxed">{f.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────────── */}
      <section className="py-20">
        <div className="max-w-3xl mx-auto px-6">
          <h2 className="font-display text-2xl font-bold text-center text-forge-mist mb-12">
            How it works
          </h2>
          <div className="relative">
            {/* Vertical connector behind step markers */}
            <div className="absolute left-5 top-5 bottom-5 w-px bg-forge-steel hidden sm:block" />
            <div className="space-y-8">
              {steps.map((step, i) => (
                <div key={i} className="flex gap-6">
                  {/* Step marker */}
                  <div className="h-10 w-10 rounded-card bg-forge-iron border border-forge-steel flex items-center justify-center shrink-0 z-10">
                    <span className="font-mono text-xs text-forge-ash font-medium">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="pt-1.5">
                    <h3 className="font-display font-semibold text-forge-mist mb-1">{step.title}</h3>
                    <p className="text-forge-ash text-sm">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ──────────────────────────────────────────────────────────────── */}
      <section className="max-w-2xl mx-auto px-6 py-20">
        <div className="heat-seam rounded-card bg-forge-iron border border-forge-steel p-10 text-center">
          <h2 className="font-display text-3xl font-bold text-forge-mist mb-4">
            Ready to forge your first project?
          </h2>
          <p className="text-forge-ash mb-8">
            Register, connect GitHub, create an API token, and start building.
          </p>
          <Link
            href="/login"
            className="inline-block rounded-btn bg-heat px-10 py-4 font-display font-medium text-forge-void hover:opacity-90 transition-opacity text-base"
          >
            Get started for free &rarr;
          </Link>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className="border-t border-forge-steel/50 px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ForgeMark className="h-5 w-5" />
            <span className="font-display text-sm font-medium text-forge-mist">project-forge</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-forge-ash">
            <a
              href="https://github.com/LanNguyenSi/project-forge"
              target="_blank"
              rel="noreferrer"
              className="hover:text-forge-mist transition-colors"
            >
              GitHub
            </a>
            <span className="text-forge-steel" aria-hidden>&#183;</span>
            <span className="text-forge-ash">Built with</span>
            <a
              href="https://github.com/LanNguyenSi/agent-planforge"
              target="_blank"
              rel="noreferrer"
              className="hover:text-forge-mist transition-colors"
            >
              planforge
            </a>
            <span className="text-forge-steel" aria-hidden>+</span>
            <a
              href="https://github.com/LanNguyenSi/scaffoldkit"
              target="_blank"
              rel="noreferrer"
              className="hover:text-forge-mist transition-colors"
            >
              scaffoldkit
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
