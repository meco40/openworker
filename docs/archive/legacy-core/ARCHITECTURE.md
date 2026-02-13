
# Architektur & Module

Das OpenClaw Gateway folgt einer strengen modularen Architektur, um Wartbarkeit und Skalierbarkeit zu gewährleisten.

## 1. Modularitäts-Prinzip
Keine Datei im Projekt überschreitet das Limit von **500 Zeilen**. Komplexe Logik wird in spezialisierte Sub-Module ausgelagert.

## 2. State-Management
Wir nutzen ein gehobenes State-Management in der Root-Komponente (`App.tsx`), um die Synchronisation zwischen verschiedenen Ansichten zu garantieren:
- **Teams State**: Verwaltet Organisationen und SaaS-Strukturen.
- **Tasks State**: Speichert den Status aller autonomen Worker-Nodes.
- **Skills State**: Ein globaler Pool an installierten Fähigkeiten (Tools).
- **Message Store**: Ein globaler Feed, der Nachrichten über alle gekoppelten Kanäle synchronisiert.

## 3. Shared Skill Pool
Ein zentraler Aspekt der Architektur ist, dass **Skills** als universelle Plugins fungieren:
- **Im Chat**: Die KI nutzt Skills via Function Calling, um Benutzeranfragen in Echtzeit zu beantworten (z.B. Browsing).
- **Im Worker**: Autonome Nodes erhalten beim Deployment eine Kopie des aktiven Skill-Pools. Sie können diese Tools für die langfristige Planung und autonome Ausführung komplexer Aufgaben nutzen.
- **Sicherheit**: Jeder Skill-Aufruf durch einen Worker wird im Workspace-Terminal mit dem Präfix `[TOOL_USE]` transparent geloggt.

## 4. Verzeichnisstruktur
- `/components`: UI-Komponenten (Sidebar, Dashboard, etc.)
- `/services`: Externe Schnittstellen (Gemini API, Audio-Processing)
- `/docs`: Diese Dokumentation
