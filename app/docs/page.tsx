"use client";

import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function ApiDocsPage() {
  return (
    <main className="min-h-screen bg-gray-950">
      <div className="mx-auto max-w-7xl p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">API Documentation</h1>
          <p className="text-gray-400 mt-2">
            Interactive API reference for project-forge
          </p>
        </div>

        <div className="rounded-xl border border-gray-700 bg-gray-900 overflow-hidden">
          <SwaggerUI url="/openapi.json" />
        </div>

        <div className="mt-8 rounded-xl border border-gray-700 bg-gray-900 p-6">
          <h2 className="text-xl font-semibold mb-4">Quick Start</h2>
          <div className="space-y-4 text-sm">
            <div>
              <h3 className="font-semibold text-gray-200 mb-2">1. Get an API Token</h3>
              <p className="text-gray-400">
                Sign up at{" "}
                <a href="/login" className="text-blue-400 hover:text-blue-300">
                  /login
                </a>
                , configure your GitHub PAT, and create an API token in your{" "}
                <a href="/dashboard" className="text-blue-400 hover:text-blue-300">
                  dashboard
                </a>
                .
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-gray-200 mb-2">2. Make a Request</h3>
              <pre className="rounded bg-gray-800 px-3 py-2 font-mono text-gray-300 overflow-x-auto">
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
              <h3 className="font-semibold text-gray-200 mb-2">3. Clone & Develop</h3>
              <p className="text-gray-400">
                The API returns a GitHub repository URL. Clone it and start developing:
              </p>
              <pre className="rounded bg-gray-800 px-3 py-2 font-mono text-gray-300 mt-2">
                git clone https://github.com/username/my-app.git
              </pre>
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-xl border border-yellow-800 bg-yellow-950/30 p-6">
          <h3 className="font-semibold text-yellow-300 mb-2">⚠️ Rate Limits</h3>
          <p className="text-yellow-200 text-sm">
            Each API token is limited to <strong>10 projects per day</strong>. This limit resets every 24 hours from your first request.
          </p>
        </div>
      </div>
    </main>
  );
}
