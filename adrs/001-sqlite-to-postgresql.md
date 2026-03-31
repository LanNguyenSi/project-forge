# ADR 001: Migration von SQLite auf PostgreSQL

**Status:** Akzeptiert  
**Datum:** 2026-03-31  
**Autoren:** Lan Nguyen Si, Ice

---

## Kontext

project-forge v1 nutzte SQLite als Datenbank via Prisma. Das war für die Entwicklungsphase akzeptabel: keine Infrastruktur nötig, kein Setup, einfaches Testen.

Mit dem Rebuild für Wave 1 (März 2026) wurden mehrere Anforderungen klar, die SQLite an seine Grenzen bringen würden:

1. **Mehrere gleichzeitige Schreibvorgänge:** Die Scaffold-Pipeline (planforge → scaffoldkit → GitHub API) erzeugt in kurzer Folge mehrere DB-Writes aus verschiedenen Prozessen. SQLite nutzt File-Locking — bei parallelen Requests entstehen Lock-Konflikte.

2. **Array-Felder im Schema:** Das neue Datenmodell braucht `features String[]` und `constraints String[]` auf dem Project-Model. SQLite hat keinen nativen Array-Typ. Mit Prisma wäre ein JSON-Workaround nötig gewesen — mit semantischen Einschränkungen bei Queries und Migrations.

3. **JSON-Felder mit echten Queries:** `planArtifacts Json?` auf Project wird in Zukunft querybar sein müssen (z.B. Filter nach Architecture Shape). PostgreSQL hat dafür `jsonb` mit Index-Support.

4. **Produktionsbereitschaft:** project-forge läuft auf einem VPS und soll als Plattform wachsen. SQLite in Produktion erfordert besondere Sorgfalt bei Backups, Replikation und Deployment. PostgreSQL ist in dieser Umgebung (Docker, Stone's VPS) die natürlichere Wahl.

---

## Entscheidung

Wechsel von SQLite auf **PostgreSQL 16** als primäre Datenbank, betrieben via Docker auf demselben Server wie die Applikation.

---

## Konsequenzen

### Positiv

- Native `String[]`-Arrays in Prisma ohne Workarounds
- `jsonb`-Felder mit echten Queries und Indizes
- Keine File-Lock-Probleme bei parallelen Requests
- Konsistent mit anderen Projekten im Stack (Triologue, depsight nutzen ebenfalls PostgreSQL)
- Vollständige Prisma-Migration-History statt `db:push`

### Negativ / Akzeptiert

- Lokales Setup braucht Docker (oder PostgreSQL-Installation)
- Kein einfaches "einfach starten ohne Infrastruktur" mehr für Entwickler

### Mitigiert durch

- `docker compose up -d postgres` reicht für den Start
- `.env.example` enthält vollständige Konfiguration
- `npx prisma migrate deploy` läuft automatisch im Makefile

---

## Alternativen die betrachtet wurden

| Alternative | Warum abgelehnt |
|-------------|----------------|
| SQLite mit JSON-Workarounds für Arrays | Erhöhte Komplexität, schlechte Query-Ergonomie, Lock-Probleme bleiben |
| Turso (libSQL, verteiltes SQLite) | Vendor Lock-in, zusätzliche Abhängigkeit, Overkill für dieses Setup |
| PlanetScale (serverless MySQL) | Managed Service = externe Abhängigkeit, Kosten, kein lokaler Dev ohne Tunnel |
| MongoDB | Schema-Flexibilität nicht benötigt, Prisma-Support für relationale Queries besser |

