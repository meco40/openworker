# Spec-Kit Solo Lite Adjustment

## Ziel

Spec-kit für Solo-Entwicklung entschlacken, ohne Qualitätsgates zu verlieren.

## Entscheidung

- Einführung eines `Solo Lite`-Pfads für kleine, nicht-breaking, nicht-security-kritische Änderungen.
- Kernartefakte bleiben verpflichtend: `spec.md` und `plan.md`.
- `tasks.md` ist in Solo Lite optional und darf durch eine kurze 3-7 Punkte-Checkliste in `plan.md` ersetzt werden.

## Geänderte Dateien

- `docs/SPEC_KIT.md`
- `.specify/memory/constitution.md`
- `.specify/templates/plan-template.md`
- `.specify/templates/tasks-template.md`

## Ergebnis

- Weniger Overhead für Solo-Arbeit.
- Klarer Trigger, wann Full Flow statt Solo Lite nötig ist.
- Qualitätskontrolle bleibt über Constitution Check und Verifikation erhalten.
