# project-forge ⚒️

**Von der Projektidee zum GitHub-Repository — vollautomatisch.**

project-forge ist eine Web-Plattform die aus einer Projektbeschreibung ein vollständiges, lauffähiges Repository scaffoldet. Der Mensch beschreibt was gebaut werden soll — [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) erstellt einen strukturierten Plan, [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) generiert die Dateistruktur, und project-forge pusht alles direkt auf GitHub.

**Live:** [project-forge.opentriologue.ai](https://project-forge.opentriologue.ai)

---

## Was ist neu? (Stand März 2026)

Die aktuelle Version wurde komplett neu aufgebaut. Der alte Stand konnte Formulare rendern — aber nichts ausführen. Was jetzt gebaut ist:

| Feature | Beschreibung |
|---------|-------------|
| **Planforge-Integration** | Server ruft agent-planforge auf, parst den generierten Plan und speichert Tasks in der DB |
| **Scaffoldkit-Pipeline** | Aus dem Plan wird ein vollständiges Datei-Gerüst generiert und als Preview angezeigt |
| **GitHub Repo Creation** | Repo erstellen + Initial Commit direkt via GitHub Git Data API — kein lokales git nötig |
| **Preview UI** | 3 Tabs: Tasks / Architecture / Files (Split-View mit Datei-Inhalt) |
| **Re-generation** | Inline-Panel um Summary, Features und Constraints zu überschreiben und neu zu scaffolden |
| **Confirmation Gate** | Klarer "Was passiert"-Screen mit Checkbox vor jeder GitHub-Aktion |
| **PostgreSQL-Backend** | Neues Schema: Project, Task, AgentAction — ersetzt das alte SQLite-Setup |

---

## Der Workflow in 7 Schritten

```
1. Projekt beschreiben
   Name, Summary, Features, Constraints, Stack eingeben

2. Plan generieren
   agent-planforge erstellt einen Step-by-Step Plan
   → Tasks werden als Datensätze in der DB gespeichert

3. Scaffold generieren
   scaffoldkit erstellt das Datei-Gerüst in einem Temp-Dir
   → Dateibaum + Inhalte werden als Preview geladen

4. Preview überprüfen
   Tab "Tasks": alle generierten Tasks mit Status und Wave
   Tab "Architecture": Architektur-Beschreibung aus dem Plan
   Tab "Files": Split-View — Dateibaum links, Datei-Inhalt rechts

5. Optional: Re-generieren
   "Adjust & Re-generate" öffnet ein Panel für Overrides
   Leere Felder = Projekt-Defaults

6. Confirmation
   Klare Übersicht: was wird auf GitHub erstellt?
   Repo-Name editierbar, Checkbox-Gate

7. GitHub Repo erstellen
   Repo wird angelegt, Initial Commit via Git Data API gepusht
   → Temp-Dir wird aufgeräumt
   → Success Screen mit GitHub-Link, Commit SHA, File-Count
```

---

## Voraussetzungen

project-forge benötigt zwei externe Tools auf demselben Server:

### 1. [agent-planforge](https://github.com/LanNguyenSi/agent-planforge)

```bash
git clone https://github.com/LanNguyenSi/agent-planforge.git ~/git/agent-planforge
cd ~/git/agent-planforge
npm install
```

Standardpfad: `~/git/agent-planforge` (konfigurierbar via `AGENT_PLANFORGE_DIR` in der Route)

### 2. [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit)

```bash
npm install -g scaffoldkit
# oder lokal im PATH verfügbar machen
```

### 3. GitHub App

project-forge nutzt eine GitHub App für die Repo-Erstellung (nicht mehr PAT).

Konfiguration in `.env`:

```
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=...   # Pfad zum .pem-File
GITHUB_APP_INSTALLATION_ID=...
```

---

## Quick Start

```bash
git clone https://github.com/LanNguyenSi/project-forge.git
cd project-forge
cp .env.example .env
# .env ausfüllen (GitHub App, Anthropic, DB-URL)

# Datenbank starten und migrieren
docker compose up -d postgres
npx prisma migrate deploy

# Dev-Server
npm run dev
```

---

## Tests

```bash
npm test
# 45/45 Tests, ~2s
```

---

## Tech Stack

- **Framework:** Next.js 16 + TypeScript + Tailwind CSS
- **Datenbank:** PostgreSQL via Prisma ORM
- **Planning:** [agent-planforge](https://github.com/LanNguyenSi/agent-planforge)
- **Scaffolding:** [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit)
- **GitHub:** GitHub App + Git Data API (kein lokales git)
- **AI:** Anthropic Claude (via planforge)

---

## Was noch fehlt

- Blob-Erstellung bei großen Projekten serialisieren (Rate-Limit-Schutz)
- Ordner-Icons in der Preview (aktuell immer 📄)
- Automatische Task-Zuweisung an Agents nach Repo-Erstellung
- Webhook-Handler für GitHub-Events

---

## Lizenz

MIT
