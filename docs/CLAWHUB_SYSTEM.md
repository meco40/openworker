# ClawHub System

## Metadata

- Purpose: Verbindliche Referenz fuer ClawHub-Integration im Skill-Subsystem.
- Scope: Katalogsuche, Installation/Update, Aktivierungsstatus und Prompt-Integration.
- Source of Truth: This is the active system documentation for this domain and overrides archived documents on conflicts.
- Last Reviewed: 2026-03-04
- Related Runbooks: N/A

---

## 1. Funktionserläuterung

ClawHub erweitert das Skills-System um Suche, Installation und Lebenszyklus-Management externer Skills.

### Kernkonzepte

- **Katalogsuche**: Skills im ClawHub-Katalog finden
- **Install/Update**: Skills lokal installieren und aktualisieren
- **Aktivierungsstatus**: Installierte Skills gezielt aktivieren/deaktivieren
- **Prompt Block**: Laufzeit-Prompt-Kontext für ClawHub-Features

---

## 2. Code-Referenz

- API-Routen: `app/api/clawhub/*`
- Service: `src/server/clawhub/clawhubService.ts`
- Repository: `src/server/clawhub/clawhubRepository.ts`
- Prompt Builder: `src/server/clawhub/clawhubPromptBuilder.ts`
- Query Parser: `src/server/clawhub/searchParser.ts`

---

## 3. API-Referenz

| Methode | Pfad                     | Zweck                             |
| ------- | ------------------------ | --------------------------------- |
| GET     | `/api/clawhub/search`    | Katalog-Suche                     |
| GET     | `/api/clawhub/installed` | Installierte Skills auflisten     |
| POST    | `/api/clawhub/install`   | Skill installieren                |
| POST    | `/api/clawhub/update`    | Installierte Skills aktualisieren |
| GET     | `/api/clawhub/prompt`    | Prompt-Block abrufen              |
| PATCH   | `/api/clawhub/[slug]`    | Skill aktiv/deaktiviert setzen    |
| DELETE  | `/api/clawhub/[slug]`    | Skill deinstallieren              |

---

## 4. Operative Hinweise

- `PATCH /api/clawhub/[slug]` erwartet `{"enabled": boolean}`.
- Slugs werden serverseitig validiert (`isValidClawHubSlug`).
- Route-Zugriffe sind authentifiziert (User-Kontext erforderlich).

---

## 5. Siehe auch

- `docs/SKILLS_SYSTEM.md`
- `docs/API_REFERENCE.md`
- `docs/archive/plans/completed/2026-02-13-clawhub-dual-lane-design.md` (historisches Design, archiviert)
