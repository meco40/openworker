# Umsetzungsplan: Zuverlaessiges Memory/Knowledge ohne falsche Fakten

> **Hinweis fuer Claude:** Erforderliches Sub-Skill bei Umsetzung: `superpowers:executing-plans`.

**Ziel:** Das System soll nur sinnvolle, zeitlich korrekte und personen-korrekte Informationen speichern und spaeter korrekt abrufen.

**Einfach erklaert:**
Heute passieren drei Kernfehler:

1. Namen werden umgeschrieben (z. B. "Die Figur", "Der Protagonist").
2. Zeitangaben werden falsch alt (z. B. "in zwei Tagen" bleibt ewig "in zwei Tagen").
3. Unwichtige Saetze werden als Fakt gespeichert (z. B. "Guten Morgen, haben Sie nicht was vergessen?").

Dieser Plan behebt nicht nur Symptome, sondern die Grundlogik dahinter.

**Technik (kurz):** TypeScript, Next.js, Vitest, SQLite, Mem0.

---

## Architekturentscheidung (vorlaeufig festhalten)

**Option 1 (bevorzugt): Hybrid chat-first**

Diese Option wird als aktuelle Leitidee festgehalten, damit sie nicht verloren geht:

1. **Chat-Verlauf ist die primaere Wahrheit**
   - Alle Original-Nachrichten bleiben indexiert und durchsuchbar.
   - Bei Rueckfragen wird zuerst aus echten Chat-Belegen gearbeitet.

2. **Memory ist abgeleitetes Wissen, nicht die alleinige Wahrheit**
   - Memory darf Antworten beschleunigen, aber Chat-Evidenz hat Vorrang.
   - Unsichere oder veraltete Fakten duerfen Chat-Wahrheit nicht ueberstimmen.

3. **Knowledge/Memory nur mit Guardrails**
   - Keine Namens-Umschreibung.
   - Zeitliche Gueltigkeit muss geprueft werden.
   - Relevanzfilter gegen Smalltalk-Rauschen.

**Wichtig:** Bestehende Umschreibungen in Memory muessen bereinigt werden.  
Ohne diese Bereinigung bleibt Memory fachlich unzuverlaessig und damit nicht sinnvoll nutzbar.

---

## Tiefere Problemanalyse

### Problem A: Entitaets-Drift (Namen werden umgeschrieben)

**Beobachtung:**
Im Verlauf steht klar ein Name wie `Max`, aber in Knowledge/Facts wird daraus z. B. `Die Protagonistin`, `Die Figur`, `Der Protagonist`.

**Warum das gefaehrlich ist:**

- Folgefragen mit Namen werden unzuverlaessig.
- Widersprueche entstehen (einmal Name, einmal Rolle).
- Vertrauen sinkt, weil Antworten "kuenstlich" wirken.

**Technische Ursache (vereinfacht):**

- Die Extraktion darf frei formulieren.
- Es fehlt eine harte Regel: "Namen nicht umschreiben".
- Es fehlt eine Nachpruefung vor dem Speichern.

### Problem B: Zeit-Drift (relative Zeit wird falsch)

**Beobachtung:**
Ein Satz wie "In zwei Tagen planen sie einen Saunabesuch" wird als Fakt gespeichert.
Wochen spaeter wird auf die Frage "Wann ist der Saunabesuch?" immer noch "In zwei Tagen" geliefert.

**Warum das gefaehrlich ist:**

- Das System liefert objektiv falsche Antworten.
- Alte Planungen werden als aktuelle Wahrheit behandelt.

**Technische Ursache (vereinfacht):**

- Relative Zeitwoerter (morgen, in zwei Tagen, naechste Woche) werden nicht auf ein absolutes Datum umgerechnet.
- Es gibt keine Gueltigkeit (Ablaufdatum) fuer zeitliche Fakten.
- Retrieval prueft nicht, ob ein Fakt schon veraltet ist.

### Problem C: Relevanz-Drift (unsaubere Fakt-Auswahl)

**Beobachtung:**
Saetze wie "Guten Morgen, haben Sie nicht was vergessen?" koennen als Fakt gespeichert werden.

**Warum das gefaehrlich ist:**

- Memory wird mit Rauschen voll.
- Relevante Fakten gehen im Laerm unter.
- Antworten werden unpraezise.

**Technische Ursache (vereinfacht):**

- Es fehlt eine inhaltliche Relevanz-Pruefung vor dem Speichern.
- Es fehlt klare Trennung zwischen:
  - dauerhafter Info,
  - zeitlicher Planung,
  - Smalltalk/Interaktion,
  - persoenlichem Lernsignal.

### Grundproblem hinter allen drei Punkten

Die aktuelle Logik behandelt zu viel als "Fakt".
Es braucht eine sauberere Wissens-Typisierung mit Zeit- und Relevanzregeln.

---

## Zielbild (Best Case)

Im besten Fall arbeitet das System wie ein guter Notiz-Assistent:

1. **Namen bleiben Namen**
   - `Max` bleibt `Max`.
   - Keine Umschreibung auf Rollenwoerter.

2. **Zeit stimmt immer**
   - Aus "in zwei Tagen" wird beim Speichern ein echtes Datum.
   - Nach Ablauf wird der Eintrag nicht mehr als aktueller Plan genutzt.

3. **Nur wichtige Dinge werden gemerkt**
   - Smalltalk wird nicht als harter Fakt gespeichert.
   - Unwichtige Saetze landen hoechstens als "Kontext" oder gar nicht im Langzeitgedaechtnis.

4. **Antworten sind klar und ehrlich**
   - Bei alter Planung: "Das war fuer den 12.02. geplant, ist also vorbei."
   - Bei fehlenden Daten: "Dazu habe ich keinen aktuellen Eintrag."

---

## Neue Speicherlogik (einfaches Modell)

Jeder neue Kandidat wird vor dem Speichern eingeteilt:

1. **Dauerfakt**
   - Zeitunabhaengig, langfristig stabil.
   - Beispiel: "Max ist ihr Bruder." (nur als Beispiel fuer stabile Beziehungsaussage)

2. **Zeitfakt / Termin**
   - Hat Start/Ende oder Ziel-Datum.
   - Beispiel: "Saunabesuch in zwei Tagen" -> speichern als absolutes Datum + Ablauf.

3. **Kontextsatz / Smalltalk**
   - Kurzlebig, nicht als harter Fakt.
   - Beispiel: "Guten Morgen, haben Sie nicht was vergessen?"

4. **Lernsignal**
   - Wiederkehrendes Muster oder Korrektur.
   - Beispiel: "Wenn ich so frage, brauche ich eine Erinnerung" (nur wenn mehrfach bestaetigt).

---

## Sonderfall: Zaehlfragen ohne Doppelzaehlung (3 statt 5)

Damit Fragen wie "Wie viele Tage insgesamt ...?" korrekt sind, reicht reiner Freitext nicht.
Wir brauchen zusaetzlich eine kleine, klare Ereignis-Logik.

### 1) Neues Ereignis-Format (pro erkanntem Ereignis)

Pro relevantem Satz wird ein Ereignis gespeichert (zusetzlich zu normalem Fact-Text):

- `eventType` (z. B. `shared_sleep_same_bed`)
- `subjectEntityId` (hier: `Nata`)
- `counterpartEntityId` (hier: `Max`)
- `startDate` und `endDate` (absolute Daten, keine relativen Worte)
- `dayCountRaw` (z. B. 2)
- `sourceSeq[]` (Belege aus Chat)
- `confidence`

### 2) Regel gegen Doppelzaehlung

Wenn spaeter ein neuer Satz kommt, wird geprueft:

1. Gleicher Ereignistyp?
2. Gleiche Personen (`Nata` + `Max`)?
3. Zeitbereich gleich oder ueberlappend?
4. Sprachsignal eher "Bestaetigung/Wiederholung" statt neues Ereignis?

Typische Wiederhol-Signale:

- "Ja, es ist richtig ..."
- "wie gesagt ..."
- "nochmal ..."
- inhaltlich dieselbe Aussage kurz nach dem ersten Satz

Wenn diese Punkte passen, wird **kein neues Ereignis** gezaehlt.
Stattdessen wird der neue Satz nur als weiterer Beleg (`sourceSeq`) am selben Ereignis angehaengt.

### 3) Zaehlregel fuer "insgesamt wie viele Tage"

Es wird nicht einfach `2 + 2 + 1` gerechnet.
Stattdessen:

1. Alle passenden Ereignisse laden.
2. Jeden Zeitraum in einzelne Kalendertage aufloesen.
3. Tage in eine Menge legen (ein Tag nur einmal).
4. Anzahl eindeutiger Tage ausgeben.

### 4) Dein Beispiel mit dieser Logik

1. Satz A: "die letzten zwei Tage ..." -> Tage `D-1` und `D`.
2. Satz B (1h spaeter): Wiederholung/Bestaetigung derselben zwei Tage -> kein neues Ereignis.
3. Satz C (eine Woche spaeter): "gestern wieder ..." -> neuer Tag `W-1`.

Ergebnis: eindeutige Tage = 3.  
Damit lautet die Antwort korrekt: **3** (nicht 5).

---

## Sonderfall: Sprecher-Trennung (Nata vs. User)

Im selben Chat koennen Persona und User aehnliche Saetze sagen ("ich habe ...").
Darum muss technisch klar sein, **wer** etwas gesagt hat und **auf wen** sich "ich/mein" bezieht.

### 1) Pflicht-Metadaten pro Ereignis/Fakt

Jeder Eintrag bekommt zusaetzlich:

- `speakerRole` (`assistant` oder `user`)
- `speakerEntityId` (z. B. `persona:nata` oder `user:<id>`)
- `subjectEntityId` (wer die Handlung getan hat)
- `subjectOwner` (z. B. `nata` bei "mein Bruder" von Nata)
- `sourceSeq[]` (Belegstellen)

### 2) Grundregel fuer "ich/mein"

Die Aufloesung von "ich/mein" darf **nicht** nur aus dem Satztext kommen.
Sie muss primaer aus der Nachrichtenrolle kommen:

- Nachricht von Persona -> "ich/mein" gehoert zu Nata
- Nachricht vom User -> "ich/mein" gehoert zum User

### 3) Regel fuer Rueckfragen wie "Wie oft hast du ...?"

Bei "hast du" in Persona-Chat ist Zielsubjekt: Persona (`Nata`).
Darum:

1. Recall aktivieren.
2. Nur Ereignisse mit `subjectEntityId = persona:nata` zaehlen.
3. User-Ereignisse mit aehnlichem Inhalt aus der Summe ausschliessen.

### 4) Beispiel ohne Verwechslung

- Nata: "Die letzten zwei Tage habe ich mit meinem Bruder geschlafen." -> zaehlt fuer Nata.
- User: "Ich kenne das, ich habe auch mal mit meinem Bruder schlafen muessen." -> zaehlt nur fuer User.
- Frage: "Wie oft hast du mit deinem Bruder geschlafen?" -> nur Nata-Daten, keine Vermischung.

---

## Sonderfall: Wissens-Graph fuer Personen und Informationen

Damit spaetere Aussagen sauber verknuepft werden, braucht das System einen allgemeinen Wissens-Graph.
Ziel: nicht nur Personenbezug, sondern auch Aufgaben, Projekte, Technologien und Ergebnisse.

Beispiel aus Produktiv-Nutzung:

- User: "Erstelle eine Notes WebApp."
- Persona startet Umsetzung.
- Graph speichert verknuepfte Knoten:
  - `projekt:notes-webapp`
  - `tech:nextjs`
  - `artifact:notes2`
- Kanten:
  - `projekt:notes-webapp` -> `built_with` -> `tech:nextjs`
  - `artifact:notes2` -> `implements` -> `projekt:notes-webapp`

So erinnert sich die Persona spaeter korrekt, **was** gebaut wurde und **wie** es gebaut wurde.

### 1) Entitaeten mit Besitzer-Scope

Jede Person/Referenz bekommt eine eindeutige ID:

- `entityId` (z. B. `persona:nata`, `persona:nata:brother`, `user:123:brother`, `projekt:notes-webapp`, `tech:nextjs`, `artifact:notes2`)
- `ownerScope` (`persona:nata`, `user:123`, `global`)
- `entityType` (`person`, `role_anchor`, `project`, `artifact`, `technology`, `task`, `feature`, `decision`, `note`)
- `displayName`

Wichtig:

- `persona:nata:brother` und `user:123:brother` sind nie derselbe Knoten.
- Eine Zusammenfuehrung passiert nur bei klarer Evidenz.

### 2) Alias- und Referenz-Aufloesung

Zusaetzlich gibt es Alias-Eintraege:

- `aliasText` (z. B. "mein Bruder", "Bruder", "Max")
- `ownerScope`
- `entityId`
- `confidence`
- `sourceSeq`

Beispiel:

- Nata sagt: "Ich habe ... mit meinem Bruder geschlafen." -> Alias `mein Bruder` im Scope `persona:nata` zeigt auf `persona:nata:brother`.
- Stunden spaeter: "Ja Max mein Bruder ist sehr nett." -> Alias `Max` im Scope `persona:nata` wird auf denselben Knoten verlinkt oder mit hoher Evidenz zusammengefuehrt.

### 3) Beziehungen als eigene Kanten

Beziehungen werden explizit gespeichert:

- `subjectEntityId`
- `relationType` (z. B. `sibling_of`, `slept_same_bed_with`, `built_with`, `implements`, `depends_on`, `has_feature`, `result_of_task`)
- `objectEntityId`
- `validFrom`, `validTo`
- `evidenceSeq[]`
- `confidence`

So entsteht:

- `persona:nata` -> `sibling_of` -> `persona:nata:brother`
- Event: `persona:nata` -> `slept_same_bed_with` -> `persona:nata:brother` (2 Tage)
- User separat: `user:123` -> `sibling_of` -> `user:123:brother`
- Projektbeispiel:
  - `projekt:notes-webapp` -> `built_with` -> `tech:nextjs`
  - `artifact:notes2` -> `implements` -> `projekt:notes-webapp`

### 4) Antwortregel mit Verlinkung

Wenn nach dem Bruder von Nata gefragt wird:

1. Zielsubjekt = `persona:nata`.
2. Passende Beziehung/Knoten nur aus `ownerScope=persona:nata`.
3. Events nur fuer diese verlinkte Person zaehlen.

Dadurch wird die User-Aussage nicht in die Persona-Zahl gemischt.
Und bei Projektfragen kann die Persona korrekt auf bestehende Arbeit verweisen.

---

## Systemweite Qualitaetsregeln (fuer korrektes Lernen)

Neben Event-Logik muessen diese Regeln dauerhaft gelten:

1. **Chat ist Wahrheit**
   - Memory darf Chat nie ueberstimmen.
2. **Zeit immer absolut speichern**
   - Relative Zeiten sofort aufloesen, inkl. User-Zeitzone.
3. **Unsicherheit sichtbar machen**
   - Eintraege mit `confidence`; bei niedrigem Wert vorsichtig antworten.
4. **Widersprueche versionieren**
   - Alt und neu markieren statt blind ueberschreiben.
5. **Relevanz vor Speicherung**
   - Smalltalk nicht als harten Fakt lernen.
6. **Gezieltes Vergessen**
   - Kurzlebige Infos ablaufen lassen, stabile Beziehungen behalten.
7. **Antworten mit Evidenz**
   - Interne Belegstellen (`seq`) fuer spaetere Korrektur.
8. **Regelmaessige Datenpflege**
   - Duplikate, Umschreibungen, veraltete Eintraege bereinigen.
9. **Messbare Qualitaet**
   - Tests und Kennzahlen fuer Zeitfehler, Sprecherfehler, Doppelzaehlung.
10. **Nutzerkontrolle**

- Memory-Eintraege einsehen, korrigieren, loeschen.

---

## Betrieb, Sicherheit und Governance (12 Pflichtpunkte)

Diese Punkte sind zusaetzlich verpflichtend, damit das System im Alltag stabil und sicher bleibt:

1. **Konflikt-Regeln**
   - Widersprueche bekommen klare Prioritaet (neuere, belegte Aussage gewinnt).
2. **Confidence-Schwellen**
   - Feste Grenzwerte fuer "sicher", "unsicher", "Rueckfrage noetig".
3. **Korrektur-Workflow**
   - Nutzerkorrekturen ("das ist falsch", "merke stattdessen ...") wirken sofort.
4. **Lebenszyklus pro Eintrag**
   - Jeder Eintrag hat Status: `neu`, `bestaetigt`, `veraltet`, `verworfen`.
5. **Datenschutz- und Loeschregeln**
   - Aufbewahrung, Sperrlisten und endgueltige Loeschung klar definieren.
6. **Schutz gegen Memory-Poisoning**
   - Manipulative oder injizierte Inhalte vor Speicherung blockieren.
7. **Migration und Backfill**
   - Alte Daten kontrolliert auf neues Schema heben, mit Dry-Run und Rollback.
8. **Performance- und Kostenbudgets**
   - Zielwerte fuer Latenz/Kosten pro Recall und Antwort verbindlich setzen.
9. **Messbare Qualitaetsmetriken**
   - Fehlerquoten fuer Zeit, Sprecher, Entity-Linking, Doppelzaehlung erfassen.
10. **Canary-Rollout mit Feature-Flags**

- Schrittweise aktivieren, beobachten, bei Problemen schnell zurueckrollen.

11. **Mehrsprachigkeit**

- Alias- und Entitaetsauflosung fuer DE/EN gemischt robust machen.

12. **Auditierbarkeit**

- Jede Antwort intern mit Graph- und Chat-Evidenz nachvollziehbar machen.

### Zusatz fuer Multi-Persona Betrieb (verbindlich)

Auch bei mehreren Personas pro User muessen harte Isolationsregeln gelten:

1. **Persona-Wechsel startet neue Konversation**
   - Kein stilles Weiterlaufen im selben Thread bei wechselnder Persona.
2. **Persona-Snapshot pro Nachricht**
   - Jede Message bekommt `persona_at_message`, damit spaetere Ingestion nicht falsch zuordnet.
3. **Persona-spezifische Speicherpolitik**
   - Z. B. RP-Persona kurze Retention, Assistant-Persona langfristig, Builder-Persona projektbezogen.

---

## Blind-Fleck-Schliessung fuer Realbetrieb (Pflicht)

Diese realen Faelle muessen explizit abgesichert werden:

1. **Hypothetisch vs. real**
   - Risiko: "Stell dir vor ...", "Wenn ...", RP-Text wird als echter Fakt gespeichert.
   - Loesung: `factScope` pro Aussage (`real`, `hypothetical`, `roleplay`, `quoted`) und nur `real` in hartes Memory.

2. **Negation und Statuswechsel**
   - Risiko: "nicht mehr", "frueher", "nie wieder" wird nicht als Aenderung erkannt.
   - Loesung: Invalidation-Regeln, die alte Fakten auf `veraltet`/`verworfen` setzen.

3. **Unscharfe Zeit und DST/Zeitzonen**
   - Risiko: "am Wochenende", Reise mit Zeitzonenwechsel, Sommerzeit/Winterzeit fuehrt zu falschen Tagen.
   - Loesung: Zeitauflosung mit Nutzer-Zeitzone, DST-Tests und `timeResolutionConfidence`.

4. **Mehrkanal-Reihenfolge und Duplikate**
   - Risiko: Telegram/WhatsApp/Web liefern verspaetet oder doppelt.
   - Loesung: Idempotency-Key, Ordering-Guard und spaete Events als `late_arrival` markieren.

5. **Projekt-Disambiguierung**
   - Risiko: "Notes", "Notes2", "Notes v3" werden vermischt.
   - Loesung: `projectId`, `version`, `parentProjectId` und Merge nur mit harter Evidenz.

6. **Attachments als Evidenz**
   - Risiko: wichtige Fakten stehen nur in Datei/Code/Link und fehlen im Graph.
   - Loesung: Attachment-Evidenz extrahieren und mit `sourceAttachmentId` verlinken.

7. **Store-Konsistenz (Mem0/SQLite/Knowledge)**
   - Risiko: Teilfehler erzeugen inkonsistente Wahrheiten.
   - Loesung: Reconciliation-Job mit Delta-Report, Repair-Mode und Alerting.

8. **Loeschung ueber alle Ebenen**
   - Risiko: Fakt geloescht, aber Alias/Relation/Audit bleibt haengen.
   - Loesung: Cascade-Delete inkl. Tombstones und Loesch-Audit.

9. **Antwort-Sicherheitsregel bei Unsicherheit**
   - Risiko: Persona behauptet trotz schwacher Evidenz.
   - Loesung: Runtime-Policy: bei niedriger Sicherheit nur mit Hinweis antworten oder Rueckfrage stellen.

10. **Produktions-Drift erkennen**

- Risiko: Fehlerquote steigt langsam ohne Sichtbarkeit.
- Loesung: automatische Metrik-Alarme (Sprecherfehler, Zeitfehler, falsche Verlinkung, Duplicate-Rate).

---

## Umsetzungsaufgaben

### Aufgabe 1: Regressions-Tests fuer alle drei Problemklassen

**Dateien:**

- `tests/unit/knowledge/extractor.test.ts`
- `tests/unit/knowledge/retrieval-service.test.ts`
- `tests/unit/knowledge/ingestion-service.test.ts`

**Schritt 1: Tests fuer Namen-Umschreibung schreiben**

- Platzhalter-Text rein, echter Name muss erhalten bleiben.

**Schritt 2: Tests fuer Zeit-Drift schreiben**

- "in zwei Tagen" + alter Zeitstempel.
- Erwartung: Retrieval darf spaeter nicht mehr "in zwei Tagen" als aktuell liefern.

**Schritt 3: Tests fuer Relevanz schreiben**

- Smalltalk-Satz wird angeboten.
- Erwartung: nicht als harter Fakt speichern.

**Schritt 4: Tests laufen lassen (zunaechst FAIL)**

```bash
npm run test -- tests/unit/knowledge/extractor.test.ts
npm run test -- tests/unit/knowledge/ingestion-service.test.ts
npm run test -- tests/unit/knowledge/retrieval-service.test.ts
```

**Schritt 5: Commit**

```bash
git add tests/unit/knowledge/extractor.test.ts tests/unit/knowledge/ingestion-service.test.ts tests/unit/knowledge/retrieval-service.test.ts
git commit -m "test: regressions fuer entity-drift zeit-drift und relevanz-drift"
```

### Aufgabe 2: Extraktions-Prompt fuer Namens-Treue verschaerfen

**Datei:**

- `src/server/knowledge/prompts.ts`

**Schritt 1: Harte Regel einbauen**

- Namen exakt uebernehmen, keine Rollen-Umschreibung.

**Schritt 2: Verbotene Umschreibungen explizit nennen**

- `Figur`, `Protagonist`, `Protagonistin`, `Character`, `sie/er` als Ersatz fuer bekannte Namen.

**Schritt 3: Test laufen lassen**

```bash
npm run test -- tests/unit/knowledge/extractor.test.ts
```

**Schritt 4: Commit**

```bash
git add src/server/knowledge/prompts.ts
git commit -m "feat: knowledge prompt mit harter namens-treue"
```

### Aufgabe 3: Nach-Filter fuer Fakten (Name, Zeit, Relevanz)

**Dateien:**

- `src/server/knowledge/textQuality.ts`
- `src/server/knowledge/extractor.ts`
- optional neu: `src/server/knowledge/factNormalization.ts`

**Schritt 1: Entity-Filter einbauen**

- Erkennen, ob Platzhalter statt klarer Entitaeten genutzt werden.
- Unsichere Fakten verwerfen oder auf sicheren Fallback umstellen.

**Schritt 2: Zeit-Normalisierung einbauen**

- Relative Zeit in absolutes Datum umrechnen (bezogen auf Nachrichtenzeit).
- Metadaten speichern: `resolvedAt`, `validFrom`, `validTo`.

**Schritt 3: Relevanz-Filter einbauen**

- Smalltalk-/Meta-Saetze nicht als `fact` speichern.
- Solche Saetze entweder verwerfen oder als niedrig-priorisierten Kontext markieren.

**Schritt 4: Tests laufen lassen**

```bash
npm run test -- tests/unit/knowledge/extractor.test.ts
npm run test -- tests/unit/knowledge/ingestion-service.test.ts
```

**Schritt 5: Commit**

```bash
git add src/server/knowledge/textQuality.ts src/server/knowledge/extractor.ts src/server/knowledge/factNormalization.ts
git commit -m "feat: fakt-normalisierung fuer name zeit und relevanz"
```

### Aufgabe 4: Ingestion nur mit gueltigen Fakten

**Datei:**

- `src/server/knowledge/ingestionService.ts`

**Schritt 1: Speicher-Guard einbauen**

- Nur Fakten speichern, die den neuen Filter bestehen.
- Zeitfakten mit Ablauf versehen.

**Schritt 2: Logging verbessern**

- Bei verworfenem Fakt kurz den Grund loggen (z. B. `placeholder`, `expired`, `low_relevance`).

**Schritt 3: Tests laufen lassen**

```bash
npm run test -- tests/unit/knowledge/ingestion-service.test.ts
```

**Schritt 4: Commit**

```bash
git add src/server/knowledge/ingestionService.ts
git commit -m "fix: ingestion speichert nur gepruefte und gueltige fakten"
```

### Aufgabe 5: Ereignis-Index + Duplikat-Logik fuer Summenfragen

**Dateien:**

- neu: `src/server/knowledge/eventTypes.ts`
- neu: `src/server/knowledge/eventExtractor.ts`
- neu: `src/server/knowledge/eventDedup.ts`
- neu: `src/server/knowledge/speakerResolution.ts`
- `src/server/knowledge/sqliteKnowledgeRepository.ts`
- `src/server/knowledge/ingestionService.ts`
- `tests/unit/knowledge/event-dedup.test.ts`
- `tests/unit/knowledge/event-aggregation.test.ts`
- `tests/unit/knowledge/speaker-disambiguation.test.ts`

**Schritt 1: Ereignis-Schema einfuehren**

- Tabelle `knowledge_events` mit:
  - `event_type`, `subject_entity`, `counterpart_entity`
  - `speaker_role`, `speaker_entity`, `subject_owner`
  - `start_date`, `end_date`
  - `source_seq_json`, `confidence`, `created_at`

**Schritt 2: Ereignisse aus Text ableiten**

- Ausdruecke wie "letzten zwei Tage", "gestern", "vorgestern" in absolute Tagesfenster umwandeln.

**Schritt 3: Duplikat-Regeln umsetzen**

- Wiederholungen/Bestaetigungen nicht als neues Ereignis speichern.
- Stattdessen `sourceSeq` am bestehenden Ereignis erweitern.

**Schritt 4: Sprecher-Aufloesung erzwingen**

- "ich/mein" aus `message.role` + `speakerEntityId` aufloesen.
- "mein Bruder" von Persona und "mein Bruder" vom User getrennt fuehren.

**Schritt 5: Aggregationsfunktion bauen**

- `countUniqueDaysForEvent(subject, counterpart, eventType, range?)`
- Tage als eindeutige Menge zaehlen.
- Nur fuer das angefragte Subjekt (bei "hast du" -> Persona) rechnen.

**Schritt 6: Tests laufen lassen**

```bash
npm run test -- tests/unit/knowledge/event-dedup.test.ts
npm run test -- tests/unit/knowledge/event-aggregation.test.ts
npm run test -- tests/unit/knowledge/speaker-disambiguation.test.ts
```

**Schritt 7: Commit**

```bash
git add src/server/knowledge/eventTypes.ts src/server/knowledge/eventExtractor.ts src/server/knowledge/eventDedup.ts src/server/knowledge/speakerResolution.ts src/server/knowledge/sqliteKnowledgeRepository.ts src/server/knowledge/ingestionService.ts tests/unit/knowledge/event-dedup.test.ts tests/unit/knowledge/event-aggregation.test.ts tests/unit/knowledge/speaker-disambiguation.test.ts
git commit -m "feat: event-index mit dedup speaker-trennung und unique-day-aggregation"
```

### Aufgabe 6: Beziehungs-Graph + Verweis-Aufloesung

**Dateien:**

- neu: `src/server/knowledge/entityLinking.ts`
- neu: `src/server/knowledge/relationGraph.ts`
- `src/server/knowledge/sqliteKnowledgeRepository.ts`
- `src/server/knowledge/ingestionService.ts`
- `src/server/knowledge/retrievalService.ts`
- `tests/unit/knowledge/entity-linking.test.ts`
- `tests/unit/knowledge/relation-graph.test.ts`
- `tests/unit/knowledge/info-graph-linking.test.ts`

**Schritt 1: Tabellen erweitern**

- `knowledge_entities` (entitaeten mit `owner_scope`)
- `knowledge_entity_aliases` (alias -> entitaet)
- `knowledge_relations` (kanten mit evidenz)

**Schritt 2: Owner-Scoped Linking einbauen**

- "mein Bruder" im Persona-Text -> `persona:nata:brother`
- "mein Bruder" im User-Text -> `user:<id>:brother`
- Projekt-/Task-Begriffe zu Info-Knoten aufloesen:
  - "Notes WebApp" -> `project`
  - "Next.js" -> `technology`
  - "Notes2" -> `artifact`

**Schritt 3: Alias-Fusion mit Guardrails**

- "Max mein Bruder" darf Persona-Bruder mit `Max` verlinken.
- Keine Fusion zwischen Persona- und User-Scope ohne harte Evidenz.

**Schritt 4: Retrieval auf verlinkte Entitaeten umstellen**

- Bei Bruder-Fragen zuerst Beziehungspfad des Zielsubjekts aufloesen.
- Dann nur passende Events/Facts laden.
- Bei Projektfragen Graph-Pfad lesen (z. B. Projekt -> Tech -> Artefakt), statt nur Freitext zu raten.

**Schritt 5: Tests laufen lassen**

```bash
npm run test -- tests/unit/knowledge/entity-linking.test.ts
npm run test -- tests/unit/knowledge/relation-graph.test.ts
npm run test -- tests/unit/knowledge/info-graph-linking.test.ts
```

**Schritt 6: Commit**

```bash
git add src/server/knowledge/entityLinking.ts src/server/knowledge/relationGraph.ts src/server/knowledge/sqliteKnowledgeRepository.ts src/server/knowledge/ingestionService.ts src/server/knowledge/retrievalService.ts tests/unit/knowledge/entity-linking.test.ts tests/unit/knowledge/relation-graph.test.ts tests/unit/knowledge/info-graph-linking.test.ts
git commit -m "feat: owner-scoped knowledge graph fuer personen und informationsknoten"
```

### Aufgabe 7: Retrieval-Logik fuer Zeit und Relevanz korrigieren

**Datei:**

- `src/server/knowledge/retrievalService.ts`

**Schritt 1: Zeitgueltigkeit im Abruf pruefen**

- Abgelaufene Zeitfakten nicht als aktuell darstellen.
- Stattdessen klar markieren: vergangen oder ohne aktuellen Termin.

**Schritt 2: Namens-Treffer priorisieren**

- Bei Fragen mit `Max` zuerst Zeilen mit `Max` zeigen.

**Schritt 3: Smalltalk-Fakten abwerten**

- Niedrige Relevanz darf Antwort nicht dominieren.

**Schritt 4: Tests laufen lassen**

```bash
npm run test -- tests/unit/knowledge/retrieval-service.test.ts
npm run test -- tests/unit/channels/message-service-knowledge-recall.test.ts
```

**Schritt 5: Commit**

```bash
git add src/server/knowledge/retrievalService.ts tests/unit/knowledge/retrieval-service.test.ts tests/unit/channels/message-service-knowledge-recall.test.ts
git commit -m "feat: retrieval mit zeitgueltigkeit und entity-priorisierung"
```

### Aufgabe 8: Alt-Daten bereinigen (Knowledge + Memory, Pflicht)

**Dateien:**

- neu: `scripts/knowledge-cleanup-entity-drift.ts`
- neu oder erweitern: `scripts/memory-cleanup-entity-drift.ts`
- `package.json`
- `docs/MEMORY_SYSTEM.md`
- `docs/KNOWLEDGE_BASE_SYSTEM.md`

**Schritt 1: Script-Funktionen**

- Platzhalter-Faelle finden.
- Relative Zeitreste (z. B. "in zwei Tagen") in alten Fakten finden.
- Low-Relevance-Faelle finden.
- Sowohl `knowledge_*` Daten als auch Memory-Eintraege (inkl. Mem0-Facts) pruefen.

**Schritt 2: Dry-Run als Standard**

- Erst nur Bericht, kein Loeschen.

**Schritt 3: Apply-Modus**

- Verwerfen, korrigieren oder fuer Re-Ingestion markieren.
- Bei Memory-Rewrites: umgeschriebene Fakten loeschen oder mit evidenznaher Form neu schreiben.

**Schritt 4: Command hinterlegen**

```bash
npm run knowledge:cleanup-entity-drift
npm run memory:cleanup-entity-drift
```

**Schritt 5: Commit**

```bash
git add scripts/knowledge-cleanup-entity-drift.ts scripts/memory-cleanup-entity-drift.ts package.json docs/MEMORY_SYSTEM.md docs/KNOWLEDGE_BASE_SYSTEM.md
git commit -m "chore: verpflichtende bereinigung fuer alte knowledge- und memory-rewrite daten"
```

### Aufgabe 9: Betrieb, Sicherheit und Governance umsetzen (12 Pflichtpunkte)

**Dateien:**

- neu: `docs/runbooks/memory-governance.md`
- neu: `docs/runbooks/memory-rollout-canary.md`
- neu: `src/server/knowledge/conflictResolution.ts`
- neu: `src/server/knowledge/confidencePolicy.ts`
- neu: `src/server/knowledge/memoryLifecycle.ts`
- neu: `src/server/knowledge/security/memoryPoisoningGuard.ts`
- neu: `src/server/channels/messages/personaIsolationPolicy.ts`
- neu: `src/server/knowledge/factScopeClassifier.ts`
- neu: `src/server/knowledge/statusInvalidation.ts`
- neu: `src/server/channels/messages/messageOrderingGuard.ts`
- neu: `src/server/knowledge/projectDisambiguation.ts`
- neu: `src/server/knowledge/attachmentEvidence.ts`
- neu: `src/server/knowledge/reconciliationJob.ts`
- neu: `src/server/knowledge/deleteCascade.ts`
- neu: `src/server/knowledge/answerSafetyPolicy.ts`
- neu: `docs/runbooks/memory-alerting.md`
- optional: `scripts/knowledge-backfill-graph.ts`
- `src/server/knowledge/retrievalService.ts`
- `src/server/knowledge/ingestionService.ts`
- `src/server/channels/messages/service.ts`
- `src/server/channels/messages/sqliteMessageRepository.ts`
- `tests/unit/knowledge/conflict-resolution.test.ts`
- `tests/unit/knowledge/confidence-policy.test.ts`
- `tests/unit/knowledge/memory-poisoning-guard.test.ts`
- `tests/unit/knowledge/multilingual-alias.test.ts`
- `tests/unit/channels/persona-isolation.test.ts`
- `tests/unit/knowledge/hypothetical-filter.test.ts`
- `tests/unit/knowledge/status-invalidation.test.ts`
- `tests/unit/knowledge/timezone-dst.test.ts`
- `tests/unit/channels/message-ordering.test.ts`
- `tests/unit/knowledge/project-disambiguation.test.ts`
- `tests/unit/knowledge/attachment-evidence.test.ts`
- `tests/unit/knowledge/reconciliation-job.test.ts`
- `tests/unit/knowledge/delete-cascade.test.ts`
- `tests/unit/knowledge/answer-safety-policy.test.ts`

**Schritt 1: Konflikt-, Confidence- und Lifecycle-Policies implementieren**

- Konfliktregeln fuer Alt/Neu + Evidenz.
- Confidence-Schwellen fuer Antwortverhalten.
- Statusmodell pro Eintrag (`neu`, `bestaetigt`, `veraltet`, `verworfen`).

**Schritt 2: Korrektur-Workflow und Auditspur verankern**

- Nutzerkorrekturen direkt auf Eintraege/Relationen anwenden.
- Antwortpfad intern mit `sourceSeq`, `entityId`, `relationId` protokollieren.

**Schritt 3: Security, Datenschutz, Migration**

- Memory-Poisoning-Guard vor Speicherung aktivieren.
- Loesch-/Retention-Regeln dokumentieren und technisch abbilden.
- Backfill-Script mit Dry-Run und Rollback-Hinweis bereitstellen.

**Schritt 4: Performance/Kosten + Rollout**

- Zielwerte definieren (z. B. Recall-Latenz, Tokenbudget).
- Feature-Flags fuer Graph-Recall und Canary-Rollout nutzen.

**Schritt 5: Multi-Persona Isolation technisch erzwingen**

- Persona-Wechsel triggert neue Konversation statt Thread-Mix.
- `persona_at_message` in Message-Schema speichern und in Ingestion/Recall respektieren.
- Persona-spezifische Retention/Memory-Policy konfigurierbar machen.

**Schritt 6: Blind-Fleck-Guards implementieren**

- `factScope` fuer hypothetisch/real/RP/quoted einbauen.
- Negations-/Statuswechsel-Invaliderung aktivieren.
- Ordering-Guard und Idempotency fuer Mehrkanal-Nachrichten aktivieren.
- Projekt-Disambiguierung mit `projectId`/Version umsetzen.
- Attachment-Evidenz, Reconciliation-Job und Cascade-Delete implementieren.
- Answer-Safety-Policy bei niedriger Sicherheit erzwingen.

**Schritt 7: Tests laufen lassen**

```bash
npm run test -- tests/unit/knowledge/conflict-resolution.test.ts
npm run test -- tests/unit/knowledge/confidence-policy.test.ts
npm run test -- tests/unit/knowledge/memory-poisoning-guard.test.ts
npm run test -- tests/unit/knowledge/multilingual-alias.test.ts
npm run test -- tests/unit/channels/persona-isolation.test.ts
npm run test -- tests/unit/knowledge/hypothetical-filter.test.ts
npm run test -- tests/unit/knowledge/status-invalidation.test.ts
npm run test -- tests/unit/knowledge/timezone-dst.test.ts
npm run test -- tests/unit/channels/message-ordering.test.ts
npm run test -- tests/unit/knowledge/project-disambiguation.test.ts
npm run test -- tests/unit/knowledge/attachment-evidence.test.ts
npm run test -- tests/unit/knowledge/reconciliation-job.test.ts
npm run test -- tests/unit/knowledge/delete-cascade.test.ts
npm run test -- tests/unit/knowledge/answer-safety-policy.test.ts
```

**Schritt 8: Commit**

```bash
git add docs/runbooks/memory-governance.md docs/runbooks/memory-rollout-canary.md docs/runbooks/memory-alerting.md src/server/knowledge/conflictResolution.ts src/server/knowledge/confidencePolicy.ts src/server/knowledge/memoryLifecycle.ts src/server/knowledge/security/memoryPoisoningGuard.ts src/server/channels/messages/personaIsolationPolicy.ts src/server/knowledge/factScopeClassifier.ts src/server/knowledge/statusInvalidation.ts src/server/channels/messages/messageOrderingGuard.ts src/server/knowledge/projectDisambiguation.ts src/server/knowledge/attachmentEvidence.ts src/server/knowledge/reconciliationJob.ts src/server/knowledge/deleteCascade.ts src/server/knowledge/answerSafetyPolicy.ts scripts/knowledge-backfill-graph.ts src/server/knowledge/retrievalService.ts src/server/knowledge/ingestionService.ts src/server/channels/messages/service.ts src/server/channels/messages/sqliteMessageRepository.ts tests/unit/knowledge/conflict-resolution.test.ts tests/unit/knowledge/confidence-policy.test.ts tests/unit/knowledge/memory-poisoning-guard.test.ts tests/unit/knowledge/multilingual-alias.test.ts tests/unit/channels/persona-isolation.test.ts tests/unit/knowledge/hypothetical-filter.test.ts tests/unit/knowledge/status-invalidation.test.ts tests/unit/knowledge/timezone-dst.test.ts tests/unit/channels/message-ordering.test.ts tests/unit/knowledge/project-disambiguation.test.ts tests/unit/knowledge/attachment-evidence.test.ts tests/unit/knowledge/reconciliation-job.test.ts tests/unit/knowledge/delete-cascade.test.ts tests/unit/knowledge/answer-safety-policy.test.ts
git commit -m "feat: governance security und rollout fuer zuverlaessiges memory-system"
```

### Aufgabe 10: Gesamt-Verifikation und Rollout

**Dateien:**

- `docs/plans/README.md`
- optional: `docs/runbooks/openai-worker-data-governance.md`

**Schritt 1: Fokus-Tests**

```bash
npm run test -- tests/unit/knowledge/extractor.test.ts
npm run test -- tests/unit/knowledge/ingestion-service.test.ts
npm run test -- tests/unit/knowledge/retrieval-service.test.ts
npm run test -- tests/unit/channels/message-service-knowledge-recall.test.ts
```

**Schritt 2: Knowledge-Block komplett**

```bash
npm run test -- tests/unit/knowledge
```

**Schritt 3: Manuelle Smoke-Fragen**

- "Hast du die letzten Tage mit Max zusammen geschlafen?"
- "Wann ist der Saunabesuch geplant?"
- "Guten Morgen, haben Sie nicht was vergessen?"
- Szenario Doppelmeldung:
  - A: "Ich habe die letzten zwei Tage mit Max geschlafen."
  - B: "Ja, es war die letzten zwei Tage ..." (nur Bestaetigung)
  - C: "Gestern wieder ..."
  - Frage: "Wie viele Tage insgesamt ...?"
  - Erwartung: `3` (nicht `5`)
- Szenario Sprecher-Verwechslung:
  - Persona: "Ich habe mit meinem Bruder geschlafen."
  - User: "Ich habe auch mit meinem Bruder geschlafen."
  - Frage: "Wie oft hast du mit deinem Bruder geschlafen?"
  - Erwartung: nur Persona-Ereignisse zaehlen, User-Ereignis ignorieren.
- Szenario Beziehungen/Verweise:
  - User: "Ja ich kenne das, musste ich auch mit meinem Bruder."
  - Persona: "Ich habe die letzten zwei Tage mit meinem Bruder geschlafen."
  - Persona spaeter: "Ja Max mein Bruder ist sehr nett."
  - Erwartung:
    - Relation `persona:nata` -> `brother` bleibt im Persona-Scope.
    - `Max` wird auf Persona-Bruder verlinkt.
    - User-Bruder bleibt getrennt.
- Szenario Informations-Graph:
  - User: "Erstelle eine Notes WebApp."
  - Persona: "Ich baue sie mit Next.js, Projektname Notes2."
  - Frage spaeter: "Was hast du fuer die Notes WebApp gebaut und womit?"
  - Erwartung:
    - `projekt:notes-webapp` ist vorhanden.
    - Verlinkung zu `tech:nextjs` und `artifact:notes2` ist vorhanden.
    - Antwort kommt aus den verlinkten Knoten, nicht aus unsicherem Freitext.
- Szenario Persona-Wechsel:
  - User chattet zuerst mit RP-Persona.
  - Danach Wechsel auf Builder-Persona.
  - Erwartung:
    - neue Konversation wird gestartet oder klar getrennt.
    - RP-Inhalte tauchen nicht in Builder-Recall auf.
    - `persona_at_message` verhindert spaetere Fehlzuordnung.
- Szenario Hypothetisch vs Real:
  - "Stell dir vor, ich haette einen Bruder ..."
  - Erwartung: kein harter Fakt in `real` Memory.
- Szenario Negation/Statuswechsel:
  - "Ich trinke keinen Kaffee mehr."
  - Erwartung: alter Fakt "trinkt Kaffee" wird veraltet/inaktiv.
- Szenario Mehrkanal-Late-Arrival:
  - gleiche Nachricht kommt spaet aus zweitem Kanal.
  - Erwartung: keine Doppelzaehlung, als `late_arrival` markiert.
- Szenario Projekt-Version:
  - "Notes", spaeter "Notes2", spaeter "Notes v3".
  - Erwartung: getrennte Versionen, kein unkontrollierter Merge.
- Szenario Attachment-Evidenz:
  - entscheidende Info nur in Datei/Codeblock.
  - Erwartung: Graph-Eintrag mit Attachment-Referenz.
- Szenario Unsichere Evidenz:
  - Frage bei geringer Sicherheit.
  - Erwartung: Rueckfrage oder unsichere Antwort, keine harte Behauptung.

Erwartung:

- Name korrekt.
- Zeitlich korrekt (nicht veraltet).
- Kein Smalltalk als harter Fakt.
- Konflikt- und Confidence-Policy verhalten sich erwartbar.
- Auditspur zeigt, welche Evidenz zur Antwort gefuehrt hat.

**Schritt 4: Plan-Liste aktualisieren**

- Datei in `docs/plans/README.md` unter aktiv aufnehmen.

**Schritt 5: Commit**

```bash
git add docs/plans/README.md
git commit -m "docs: rollout-plan fuer zuverlaessiges memory/knowledge aktualisiert"
```

---

## Abnahmekriterien

1. Namen werden nicht mehr in generische Rollen umgeschrieben.
2. Relative Zeitangaben werden als absolute Zeit gespeichert oder als zeitlich begrenzt behandelt.
3. Abgelaufene Plan-Fakten werden nicht als aktuelle Wahrheit ausgegeben.
4. Unwichtige Saetze werden nicht mehr als harte Fakten gespeichert.
5. Recall liefert bei Namensfragen zuerst echte Namens-Belege.
6. Bereinigung alter Fehlerdaten ist reproduzierbar moeglich.
7. Bestehende umgeschriebene Memory-Eintraege sind bereinigt, damit Memory wieder nutzbar ist.
8. Wiederholte Bestaetigungen desselben Ereignisses werden nicht doppelt gezaehlt.
9. Summenfragen ("insgesamt wie viele Tage") nutzen eindeutige Tagesaggregation und liefern stabile Zahlen.
10. Persona- und User-Aussagen werden bei "ich/mein"-Formulierungen nicht verwechselt.
11. Beziehungen und Alias-Verweise sind owner-scoped getrennt (Persona vs User).
12. "Max mein Bruder" verlinkt korrekt auf den Persona-Bruder, ohne User-Beziehung zu vermischen.
13. Widersprueche, Unsicherheit, Ablauf und Nutzerkorrekturen sind im Speicherprozess beruecksichtigt.
14. Der Graph deckt auch Informationsknoten (Projekt/Tech/Artefakt/Aufgabe) ab und beantwortet Projektfragen korrekt.
15. Konfliktregeln, Confidence-Schwellen und Lifecycle-Status sind systemweit aktiv.
16. Memory-Poisoning-Guard, Datenschutzregeln und Loeschpfade sind implementiert und getestet.
17. Canary-Rollout mit Feature-Flags sowie messbare Qualitaetsmetriken sind dokumentiert und nutzbar.
18. Mehrsprachige Alias-Aufloesung (DE/EN) und Auditierbarkeit jeder Antwort sind nachweisbar vorhanden.
19. Persona-Wechsel fuehrt nicht zu Memory-Leaks zwischen Personas.
20. Jede Message hat `persona_at_message` und wird in Ingestion/Recall korrekt zugeordnet.
21. Persona-spezifische Speicherpolitik (Retention/Policy) ist konfiguriert und wirksam.
22. Hypothetische/RP/Quoted Inhalte werden nicht als reale harte Fakten gespeichert.
23. Negations- und Statuswechsel invalidieren alte Fakten korrekt.
24. DST/Zeitzonen- und unscharfe Zeitfaelle werden reproduzierbar korrekt aufgeloest.
25. Mehrkanal-Duplikate und spaete Nachrichten fuehren nicht zu falscher Chronologie oder Doppelzaehlung.
26. Projektversionen und aehnliche Namen werden disambiguiert statt blind gemerged.
27. Attachment-basierte Evidenz fliesst in Graph/Antworten ein.
28. Reconciliation-Job erkennt und repariert Store-Divergenzen nachvollziehbar.
29. Cascade-Delete entfernt Eintrag, Alias, Relation und Folgeverweise konsistent.
30. Antwort-Sicherheitsregel verhindert harte Behauptungen bei niedriger Evidenz.
31. Monitoring/Alerting erkennt Produktions-Drift fruehzeitig.

## Best-Case in sehr einfacher Sprache

Im besten Fall merkt sich das System nur das Richtige, zur richtigen Zeit, mit den richtigen Namen.

- Wenn `Max` gesagt wurde, bleibt `Max` gespeichert.
- Wenn etwas "in zwei Tagen" geplant war, wird spaeter nicht mehr so getan, als waere es noch aktuell.
- Wenn jemand nur "Guten Morgen" schreibt, wird das nicht als wichtiger Lebensfakt abgespeichert.

So werden Antworten klarer, ehrlicher und verlaesslicher.
Der Nutzer kann dem System wieder vertrauen.
