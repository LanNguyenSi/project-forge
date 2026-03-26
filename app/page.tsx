"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const features = [
  {
    icon: "🧠",
    title: "AI-Planned",
    desc: "Every project is planned by agent-planforge — tasks, waves, and architecture automatically generated.",
  },
  {
    icon: "⚒️",
    title: "Scaffolded",
    desc: "scaffoldkit generates the file structure, Makefile, CI, and docs. Ready to clone and build.",
  },
  {
    icon: "🔑",
    title: "Agent-Ready API",
    desc: "One POST request from your agent creates a GitHub repo. No PAT required — just your project-forge token.",
  },
  {
    icon: "🚀",
    title: "Zero to Repo in Seconds",
    desc: "From idea to a cloneable GitHub repository in under 30 seconds.",
  },
];

const steps = [
  { n: "1", title: "Describe your project", desc: "Fill in name, summary, features, and constraints." },
  { n: "2", title: "Review the plan", desc: "Browse tasks, architecture, and file tree. Regenerate if needed." },
  { n: "3", title: "Confirm & publish", desc: "One click creates the GitHub repo and pushes the scaffold." },
  { n: "4", title: "Clone & build", desc: "Hand off to your agent. The plan is already inside the repo." },
];

export default function LandingPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  if (status === "loading" || status === "authenticated") return null;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      {/* Nav */}
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
        <div className="flex items-center gap-2 font-bold text-lg">
          <span>⚒️</span> project-forge
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/docs" className="text-gray-400 hover:text-gray-200 transition">Docs</Link>
          <Link href="/login" className="text-gray-400 hover:text-gray-200 transition">Login</Link>
          <Link
            href="/login"
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-white hover:bg-blue-500 transition font-medium"
          >
            Get Started →
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 py-24 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-blue-800 bg-blue-950/40 px-4 py-1.5 text-sm text-blue-300 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
          AI-powered project scaffolding
        </div>
        <h1 className="text-5xl font-bold mb-6 leading-tight">
          From idea to{" "}
          <span className="text-blue-400">GitHub repo</span>
          <br />in seconds
        </h1>
        <p className="text-gray-400 text-xl mb-10 max-w-2xl mx-auto">
          project-forge uses planforge + scaffoldkit to turn your project description into a
          fully planned, scaffolded, and committed repository — ready for your agent to build.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/login"
            className="rounded-xl bg-blue-600 px-8 py-3.5 font-semibold text-white hover:bg-blue-500 transition text-lg"
          >
            Create a project →
          </Link>
          <Link
            href="/docs"
            className="rounded-xl border border-gray-700 px-8 py-3.5 font-semibold text-gray-300 hover:bg-gray-800 transition text-lg"
          >
            API Docs
          </Link>
        </div>

        {/* Code snippet */}
        <div className="mt-14 rounded-2xl border border-gray-800 bg-gray-900 p-6 text-left max-w-2xl mx-auto">
          <div className="flex items-center gap-2 mb-4">
            <div className="h-3 w-3 rounded-full bg-red-500" />
            <div className="h-3 w-3 rounded-full bg-yellow-500" />
            <div className="h-3 w-3 rounded-full bg-green-500" />
            <span className="text-gray-500 text-xs ml-2">agent.sh</span>
          </div>
          <pre className="text-sm font-mono text-gray-300 leading-relaxed overflow-x-auto">{`curl -X POST https://project-forge.opentriologue.ai/api/v1/projects \\
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

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-12">Everything your agent needs</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {features.map((f) => (
            <div key={f.title} className="rounded-xl border border-gray-800 bg-gray-900 p-6">
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-12">How it works</h2>
        <div className="relative">
          <div className="absolute left-5 top-0 bottom-0 w-px bg-gray-800 hidden sm:block" />
          <div className="space-y-8">
            {steps.map((step) => (
              <div key={step.n} className="flex gap-6">
                <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center font-bold text-white shrink-0 z-10">
                  {step.n}
                </div>
                <div className="pt-1.5">
                  <h3 className="font-semibold mb-1">{step.title}</h3>
                  <p className="text-gray-400 text-sm">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-2xl mx-auto px-6 py-20 text-center">
        <h2 className="text-3xl font-bold mb-4">Ready to forge your first project?</h2>
        <p className="text-gray-400 mb-8">Register, connect GitHub, create an API token — and start building.</p>
        <Link
          href="/login"
          className="inline-block rounded-xl bg-blue-600 px-10 py-4 font-semibold text-white hover:bg-blue-500 transition text-lg"
        >
          Get started for free →
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 px-6 py-8 text-center text-gray-600 text-sm">
        <p>⚒️ project-forge · Built with planforge + scaffoldkit · <a href="https://github.com/LanNguyenSi/project-forge" className="hover:text-gray-400 transition">GitHub</a></p>
      </footer>
    </main>
  );
}
