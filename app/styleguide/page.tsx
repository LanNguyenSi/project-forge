"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives/Button";
import { Card, CardHeader } from "@/components/ui/primitives/Card";
import { Input, Textarea, Label } from "@/components/ui/primitives/Input";
import { Badge } from "@/components/ui/primitives/Badge";
import { Alert } from "@/components/ui/primitives/Alert";

// ── Section wrapper ─────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-16">
      <h2 className="font-display text-xl font-semibold text-forge-mist mb-6 pb-3 border-b border-forge-steel">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-sm font-medium text-forge-ash uppercase tracking-widest mb-4">{title}</h3>
      {children}
    </div>
  );
}

// ── Color swatch ─────────────────────────────────────────────────────────────
interface SwatchProps {
  name: string;
  hex: string;
  bg: string;
  textColor?: string;
}

function Swatch({ name, hex, bg, textColor = "text-forge-mist" }: SwatchProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={`h-14 w-full rounded-card ${bg} border border-forge-steel/40`} />
      <div className={`text-xs font-medium ${textColor}`}>{name}</div>
      <div className="text-xs text-forge-ash font-mono">{hex}</div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function StyleguidePage() {
  const [alertOpen, setAlertOpen] = useState(true);
  const [alertSuccessOpen, setAlertSuccessOpen] = useState(true);

  return (
    <div className="min-h-screen bg-forge-void px-6 py-12">
      <div className="mx-auto max-w-5xl">

        {/* Page header */}
        <div className="mb-16">
          <div className="heat-seam rounded-card bg-forge-iron p-8">
            <h1 className="font-display text-3xl font-bold text-forge-mist mb-2">
              Forge Design System
            </h1>
            <p className="text-forge-ash text-sm">
              Visual language reference for project-forge — dark-only, ember-accented.
            </p>
            <div className="mt-4 flex gap-2">
              <Badge variant="info">v1.0</Badge>
              <Badge variant="default">dark-only</Badge>
            </div>
          </div>
        </div>

        {/* ── 1. Colors ───────────────────────────────────────────────────── */}
        <Section title="Colors">
          <SubSection title="Forge surface scale">
            <div className="grid grid-cols-5 gap-4">
              <Swatch name="forge.void"  hex="#0B0D10" bg="bg-forge-void border border-forge-steel" />
              <Swatch name="forge.iron"  hex="#14181D" bg="bg-forge-iron" />
              <Swatch name="forge.steel" hex="#222A32" bg="bg-forge-steel" />
              <Swatch name="forge.ash"   hex="#8A93A0" bg="bg-forge-ash" textColor="text-forge-void" />
              <Swatch name="forge.mist"  hex="#E7ECF2" bg="bg-forge-mist" textColor="text-forge-void" />
            </div>
          </SubSection>

          <SubSection title="Accent palette">
            <div className="grid grid-cols-5 gap-4">
              <Swatch name="ember"       hex="#F5641E" bg="bg-ember"      textColor="text-forge-void" />
              <Swatch name="ember.soft"  hex="#FB7A33" bg="bg-ember-soft" textColor="text-forge-void" />
              <Swatch name="gold"        hex="#FFB02E" bg="bg-gold"       textColor="text-forge-void" />
            </div>
          </SubSection>

          <SubSection title="Semantic">
            <div className="grid grid-cols-5 gap-4">
              <Swatch name="success" hex="#34D399" bg="bg-success" textColor="text-forge-void" />
              <Swatch name="warning" hex="#FBBF24" bg="bg-warning" textColor="text-forge-void" />
              <Swatch name="danger"  hex="#FB7185" bg="bg-danger"  textColor="text-forge-void" />
            </div>
          </SubSection>
        </Section>

        {/* ── 2. Typography ────────────────────────────────────────────────── */}
        <Section title="Typography">
          <SubSection title="Display — Space Grotesk (500, 700)">
            <div className="space-y-3 bg-forge-iron rounded-card p-6">
              <p className="font-display font-bold text-4xl text-forge-mist">Display Heading 4xl</p>
              <p className="font-display font-bold text-3xl text-forge-mist">Display Heading 3xl</p>
              <p className="font-display font-bold text-2xl text-forge-mist">Display Heading 2xl</p>
              <p className="font-display font-semibold text-xl text-forge-mist">Display Heading xl</p>
              <p className="font-display font-medium text-lg text-forge-mist">Display Heading lg</p>
              <p className="font-display font-medium text-base text-forge-ash">Display base — secondary</p>
            </div>
          </SubSection>

          <SubSection title="Body — IBM Plex Sans (400, 500, 600)">
            <div className="space-y-3 bg-forge-iron rounded-card p-6">
              <p className="font-sans font-semibold text-lg text-forge-mist">Semibold body — lg</p>
              <p className="font-sans font-medium text-base text-forge-mist">Medium body — base. The quick brown fox jumps over the lazy dog.</p>
              <p className="font-sans font-normal text-sm text-forge-mist">Regular body — sm. Crafted for legibility at small sizes in dense UIs.</p>
              <p className="font-sans font-normal text-sm text-forge-ash">Muted body — forge.ash. Used for secondary copy and descriptions.</p>
              <p className="font-sans font-normal text-xs text-forge-ash">Extra-small — xs. Labels, meta, timestamps.</p>
            </div>
          </SubSection>

          <SubSection title="Mono — IBM Plex Mono (400, 500)">
            <div className="space-y-3 bg-forge-iron rounded-card p-6">
              <p className="font-mono font-medium text-sm text-forge-mist">Medium mono — npm run build</p>
              <p className="font-mono font-normal text-sm text-forge-ash">Regular mono — const token = &apos;#F5641E&apos;;</p>
              <p className="font-mono font-normal text-xs text-forge-ash">XS mono — 2026-06-19T08:00:00Z</p>
            </div>
          </SubSection>
        </Section>

        {/* ── 3. Button ────────────────────────────────────────────────────── */}
        <Section title="Button">
          <SubSection title="Variants — md size">
            <div className="flex flex-wrap gap-3 items-center">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="success">Success</Button>
              <Button variant="ghost">Ghost</Button>
            </div>
          </SubSection>

          <SubSection title="Sizes">
            <div className="flex flex-wrap gap-3 items-center">
              <Button variant="primary" size="sm">Small</Button>
              <Button variant="primary" size="md">Medium</Button>
              <Button variant="primary" size="lg">Large</Button>
            </div>
          </SubSection>

          <SubSection title="States">
            <div className="flex flex-wrap gap-3 items-center">
              <Button variant="primary" loading>Loading</Button>
              <Button variant="secondary" loading>Loading</Button>
              <Button variant="primary" disabled>Disabled</Button>
              <Button variant="secondary" disabled>Disabled</Button>
              <Button variant="ghost" disabled>Disabled</Button>
            </div>
          </SubSection>

          <SubSection title="Block">
            <div className="max-w-sm">
              <Button variant="primary" block>Block Button</Button>
            </div>
          </SubSection>

          <SubSection title="Focus ring (simulated)">
            <div className="flex flex-wrap gap-3 items-center">
              <Button
                variant="primary"
                className="ring-2 ring-ember ring-offset-2 ring-offset-forge-void"
              >
                Primary focused
              </Button>
              <Button
                variant="secondary"
                className="ring-2 ring-forge-steel ring-offset-2 ring-offset-forge-void"
              >
                Secondary focused
              </Button>
            </div>
          </SubSection>
        </Section>

        {/* ── 4. Card ──────────────────────────────────────────────────────── */}
        <Section title="Card">
          <SubSection title="Tones">
            <div className="grid grid-cols-2 gap-4">
              <Card tone="default">
                <CardHeader title="Default card" subtitle="bg-forge-iron surface" />
                <p className="text-sm text-forge-ash">Primary raised surface for content blocks.</p>
              </Card>
              <Card tone="muted">
                <CardHeader title="Muted card" subtitle="60% iron opacity" />
                <p className="text-sm text-forge-ash">Subdued surface for secondary content.</p>
              </Card>
              <Card tone="accent">
                <CardHeader title="Accent card" subtitle="ember tinted surface" />
                <p className="text-sm text-forge-ash">Highlights primary actions or CTAs.</p>
              </Card>
              <Card tone="success">
                <CardHeader title="Success card" subtitle="green tinted" />
                <p className="text-sm text-forge-ash">Positive confirmation states.</p>
              </Card>
              <Card tone="warning">
                <CardHeader title="Warning card" subtitle="gold tinted" />
                <p className="text-sm text-forge-ash">Caution or review-required states.</p>
              </Card>
              <Card tone="danger">
                <CardHeader title="Danger card" subtitle="danger tinted" />
                <p className="text-sm text-forge-ash">Error or destructive action states.</p>
              </Card>
            </div>
          </SubSection>

          <SubSection title="Padding variants">
            <div className="grid grid-cols-3 gap-4">
              <Card padding="sm"><p className="text-xs text-forge-ash">Padding sm (p-4)</p></Card>
              <Card padding="md"><p className="text-xs text-forge-ash">Padding md (p-5/p-6)</p></Card>
              <Card padding="lg"><p className="text-xs text-forge-ash">Padding lg (p-6/p-8)</p></Card>
            </div>
          </SubSection>

          <SubSection title="Card + heat seam">
            <Card className="heat-seam">
              <CardHeader title="Heat seam card" subtitle="Top edge ember→gold gradient" />
              <p className="text-sm text-forge-ash">The heat-seam utility adds a 2px ember-to-gold gradient line at the top, compatible with rounded corners.</p>
            </Card>
          </SubSection>
        </Section>

        {/* ── 5. Input ─────────────────────────────────────────────────────── */}
        <Section title="Input">
          <SubSection title="Text input">
            <div className="max-w-md space-y-4">
              <div>
                <Label>Default input</Label>
                <Input placeholder="Placeholder text…" />
              </div>
              <div>
                <Label required hint="(optional note)">Required field</Label>
                <Input placeholder="Enter value…" defaultValue="" />
              </div>
              <div>
                <Label>Disabled</Label>
                <Input placeholder="Cannot edit" disabled />
              </div>
            </div>
          </SubSection>

          <SubSection title="Textarea">
            <div className="max-w-md space-y-4">
              <div>
                <Label>Description</Label>
                <Textarea placeholder="Describe your project…" rows={4} />
              </div>
              <div>
                <Label>Disabled textarea</Label>
                <Textarea placeholder="Read only" disabled rows={3} />
              </div>
            </div>
          </SubSection>
        </Section>

        {/* ── 6. Badge ─────────────────────────────────────────────────────── */}
        <Section title="Badge">
          <SubSection title="Variants">
            <div className="flex flex-wrap gap-3 items-center">
              <Badge variant="default">Default</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="danger">Danger</Badge>
              <Badge variant="info">Info</Badge>
            </div>
          </SubSection>

          <SubSection title="With icons (simulated)">
            <div className="flex flex-wrap gap-3 items-center">
              <Badge variant="success">
                <span aria-hidden>✓</span> Deployed
              </Badge>
              <Badge variant="warning">
                <span aria-hidden>⚠</span> Review
              </Badge>
              <Badge variant="danger">
                <span aria-hidden>✕</span> Failed
              </Badge>
              <Badge variant="info">
                <span aria-hidden>★</span> Beta
              </Badge>
              <Badge variant="default">
                v0.5.0
              </Badge>
            </div>
          </SubSection>
        </Section>

        {/* ── 7. Alert ─────────────────────────────────────────────────────── */}
        <Section title="Alert">
          <SubSection title="Variants">
            <div className="space-y-3 max-w-2xl">
              <Alert variant="error">
                <strong>Error:</strong> The scaffoldkit process failed. Check the logs for details.
              </Alert>
              <Alert variant="success">
                <strong>Success:</strong> Project created and repository published successfully.
              </Alert>
              <Alert variant="warning">
                <strong>Warning:</strong> Your API quota is at 80%. Consider upgrading your plan.
              </Alert>
              <Alert variant="info">
                <strong>Info:</strong> Generation is in progress — this may take up to 30 seconds.
              </Alert>
            </div>
          </SubSection>

          <SubSection title="Dismissible (interactive)">
            <div className="space-y-3 max-w-2xl">
              {alertOpen && (
                <Alert variant="error" onClose={() => setAlertOpen(false)}>
                  <strong>Dismissible error</strong> — click &times; to close.
                </Alert>
              )}
              {alertSuccessOpen && (
                <Alert variant="success" onClose={() => setAlertSuccessOpen(false)}>
                  <strong>Dismissible success</strong> — click &times; to close.
                </Alert>
              )}
              {!alertOpen && !alertSuccessOpen && (
                <p className="text-sm text-forge-ash italic">All alerts dismissed.</p>
              )}
            </div>
          </SubSection>
        </Section>

        {/* ── 8. Heat gradient + seam ──────────────────────────────────────── */}
        <Section title="Heat gradient + seam">
          <SubSection title="Heat gradient (bg-heat / .heat-gradient)">
            <div className="grid grid-cols-3 gap-4">
              <div className="h-20 w-full rounded-card bg-heat flex items-center justify-center">
                <span className="text-forge-void font-display font-bold text-sm">bg-heat</span>
              </div>
              <div className="h-20 w-full rounded-card heat-gradient flex items-center justify-center">
                <span className="text-forge-void font-display font-bold text-sm">.heat-gradient</span>
              </div>
              <div className="h-20 w-full rounded-card bg-heat flex items-center justify-center opacity-60">
                <span className="text-forge-void font-display font-bold text-sm">opacity-60</span>
              </div>
            </div>
          </SubSection>

          <SubSection title="Heat seam (.heat-seam)">
            <div className="grid grid-cols-2 gap-4">
              <div className="heat-seam rounded-card bg-forge-iron p-5">
                <p className="text-sm font-medium text-forge-mist">Card with heat seam</p>
                <p className="text-xs text-forge-ash mt-1">2px ember→gold top edge</p>
              </div>
              <div className="heat-seam rounded-card bg-forge-steel p-5">
                <p className="text-sm font-medium text-forge-mist">Steel surface + heat seam</p>
                <p className="text-xs text-forge-ash mt-1">Works on any background</p>
              </div>
            </div>
          </SubSection>

          <SubSection title="Text gradient (CSS example)">
            <p
              className="font-display font-bold text-3xl"
              style={{
                background: "linear-gradient(95deg, #F5641E, #FFB02E)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              Forge. Build. Ship.
            </p>
          </SubSection>
        </Section>

        {/* ── 9. Radius samples ────────────────────────────────────────────── */}
        <Section title="Border radius">
          <div className="flex flex-wrap gap-6 items-end">
            <div className="text-center">
              <div className="h-14 w-32 bg-forge-steel rounded-btn flex items-center justify-center">
                <span className="text-xs text-forge-ash font-mono">rounded-btn</span>
              </div>
              <p className="text-xs text-forge-ash mt-2">4px — buttons &amp; inputs</p>
            </div>
            <div className="text-center">
              <div className="h-14 w-32 bg-forge-steel rounded-card flex items-center justify-center">
                <span className="text-xs text-forge-ash font-mono">rounded-card</span>
              </div>
              <p className="text-xs text-forge-ash mt-2">10px — cards</p>
            </div>
            <div className="text-center">
              <div className="h-14 w-32 bg-forge-steel rounded-full flex items-center justify-center">
                <span className="text-xs text-forge-ash font-mono">rounded-full</span>
              </div>
              <p className="text-xs text-forge-ash mt-2">9999px — badges / pills</p>
            </div>
          </div>
        </Section>

        {/* Footer */}
        <footer className="mt-8 pt-6 border-t border-forge-steel text-xs text-forge-ash text-center">
          Forge design system — project-forge v0.5.0 — dark-only
        </footer>
      </div>
    </div>
  );
}
