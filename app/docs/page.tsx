"use client";

import dynamic from "next/dynamic";
import { useSession } from "next-auth/react";
import "swagger-ui-react/swagger-ui.css";
import { AppShell } from "@/components/layout/AppShell";
import { PageShell } from "@/components/ui/PageShell";
import { Card, CardHeader, Alert } from "@/components/ui/primitives";
import { PublicNav } from "@/components/layout/PublicNav";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

function DocsContent() {
  return (
    <div className="space-y-6">
      <Card padding="none" className="overflow-hidden">
        <SwaggerUI url="/openapi.json" />
      </Card>

      <Card>
        <CardHeader title="Quick Start" />
        <div className="space-y-5 text-sm">
          <div>
            <h3 className="font-semibold text-forge-mist mb-2">1. Get an API Token</h3>
            <p className="text-forge-ash">
              Sign up at{" "}
              <a href="/login" className="text-ember hover:text-ember-soft transition">/login</a>,
              configure your GitHub PAT, and create an API token in your{" "}
              <a href="/dashboard" className="text-ember hover:text-ember-soft transition">dashboard</a>.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-forge-mist mb-2">2. Make a Request</h3>
            <pre className="rounded-card bg-forge-iron px-4 py-3 font-mono text-forge-mist overflow-x-auto">
{`curl -X POST https://project-forge.opentriologue.ai/api/v1/projects \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: pf_your_token_here" \\
  -d '{
    "projectName": "my-app",
    "summary": "A web application",
    "features": ["auth", "crud"],
    "constraints": ["TypeScript"]
  }'`}
            </pre>
          </div>
          <div>
            <h3 className="font-semibold text-forge-mist mb-2">3. Clone &amp; Develop</h3>
            <p className="text-forge-ash mb-2">
              The API returns a GitHub repository URL. Clone it and start developing:
            </p>
            <pre className="rounded-card bg-forge-iron px-4 py-3 font-mono text-forge-mist">
              git clone https://github.com/username/my-app.git
            </pre>
          </div>
        </div>
      </Card>

      <Alert variant="warning">
        <strong>Rate Limits:</strong> The REST API allows <strong>10 project publishes per user per day</strong>, shared across all of your API tokens. The generate, preview, and list/delete endpoints are unmetered, and the limit is a rolling 24-hour window.
      </Alert>
    </div>
  );
}

export default function ApiDocsPage() {
  const { status } = useSession();
  const isLoggedIn = status === "authenticated";

  if (isLoggedIn) {
    return (
      <AppShell>
        <PageShell title="API Documentation" subtitle="Interactive API reference for project-forge" maxWidth="7xl">
          <DocsContent />
        </PageShell>
      </AppShell>
    );
  }

  // Public view — standalone layout without sidebar
  return (
    <main className="min-h-screen bg-forge-void text-forge-mist">
      <PublicNav />

      <div className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold">API Documentation</h1>
            <p className="text-forge-ash mt-1 text-sm sm:text-base">Interactive API reference for project-forge</p>
          </div>
          <DocsContent />
        </div>
      </div>
    </main>
  );
}
