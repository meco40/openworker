# World Model Incident Runbook

_Ziel:_ Operative Anleitung für den Umgang mit World-Model-Ausfällen, Degradations­zuständen und Recovery-Szenarien.

## Überblick

Dieses Runbook ergänzt das [World-Model-Rollout-Runbook](./WORLD_MODEL_ROLLOUT.md) um dokumentierte Incident-Antworten. Failed Drills sind im [Failure-Drill-Skript](../../scripts/world-model-failure-drill.ts) automatisiert.

## Incident-Klassifikation

| Severity | Beschreibung                                                             | Reaktion                                  |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| P1       | World Model nicht erreichbar; `required`/`canonical` blockiert Ingestion | Sofortige Diagnose, Rollback auf `shadow` |
| P2       | Outbox wächst; Delivery-Receipts fehlen; Embedding-Worker im Dauerfehler | Innerhalb 1h                              |
| P3       | Einzelne fehlgeschlagene Follow-up-Zustellung; Reconciliation Drift      | Innerhalb 24h                             |
| P4       | Graphiti-Ausfall; keine kritische Funktionsbeeinträchtigung              | Beobachten, nächster Wartungszyklus       |

## Runbooks

### 1. PostgreSQL-Ausfall (P1)

**Symptome:**

- Health-Route `/api/health/world-model` meldet `unavailable`/`unhealthy`
- `bridgeChatMessages`-Fehler in Logs (`[world-model:bridge] observation write failed`)
- Im `canonical`-Modus: Ingestion blockiert

**Diagnose:**

```powershell
docker compose -f docker-compose.postgres.yml ps
docker compose -f docker-compose.postgres.yml logs db
```

**Recovery:**

1. Container starten: `docker compose -f docker-compose.postgres.yml up -d`
2. Health prüfen: `curl http://localhost:3000/api/health/world-model`
3. Migrationen validieren: `pnpm run world-model:reconcile -- --dry-run`
4. Wenn notwendig, Modus auf `shadow` zurückstellen (`.env.local`):
   ```
   WORLD_MODEL_MODE=shadow
   ```
5. Nach Wiederherstellung: `pnpm run world-model:reconcile`

### 2. Outbox-Stau (P2)

**Symptome:**

- `pending`-Events in `world_model_outbox_events` wachsen
- Health-Route meldet `outbox.degraded`

**Diagnose:**

```sql
SELECT status, COUNT(*) FROM world_model_outbox_events
GROUP BY status;
SELECT id, event_type, error_message, created_at
FROM world_model_outbox_events
WHERE status = 'failed' ORDER BY created_at DESC LIMIT 20;
```

**Recovery:**

1. Fehlerursache identifizieren (handler-Ausnahmen im Scheduler-Log)
2. Fehler beheben (z.B. Kanal-Credentials)
3. Fehlgeschlagene Events erneut einreihen:
   ```sql
   UPDATE world_model_outbox_events SET status = 'pending' WHERE status = 'failed';
   ```
4. Dispatcher-Watchdog prüft automatisch in 10s

### 3. Scheduler-Neustart (P2)

**Symptome:**

- Kein Follow-up-Versand nach Neustart
- Prospective Runtime nicht aktiv

**Verhalten:**

- Outbox-Events sind idempotent (`idempotency_key`)
- Fällige Open Loops werden beim nächsten Tick neu geclaimt
- `FOR UPDATE SKIP LOCKED` verhindert Doppelversand

**Überprüfung:**

```powershell
pnpm run world-model:drill -- --scenario scheduler-restart
```

### 4. Embedding-Worker-Ausfall (P3)

**Symptome:**

- `world_model_embeddings` wächst nicht
- Health-Route meldet `embeddings.degraded`

**Recovery:**

1. Worker-Log prüfen
2. Embedding-Endpunkt testen
3. Worker neu starten:
   ```powershell
   pnpm run world-model:rebuild-projections -- --type embeddings
   ```

### 5. Graphiti-Ausfall (P3)

**Symptome:**

- Graphiti-Health-Check nicht erreichbar
- Circuit Breaker aktiv

**Verhalten:**

- Retrieval fällt kontrolliert auf PostgreSQL zurück
- Keine Auswirkung auf strukturierte Antworten

**Recovery:**

1. Graphiti-Container starten
2. Rebuild auslösen:
   ```powershell
   pnpm run world-model:rebuild-projections -- --type graphiti --scope user1:persona1:workspace1
   ```

### 6. Doppelter Webhook (P2)

**Symptome:**

- Wiederholte Observations in der DB

**Verhalten:**

- `UNIQUE (user_id, persona_id, workspace_id, source_type, source_id)` verhindert Duplikate
- Outbox-Events verwenden `idempotency_key`

**Überprüfung:**

```powershell
pnpm run world-model:drill -- --scenario duplicate-webhook
```

## Alerting-Regeln

| Regel                               | Bedingung                                         | Severity |
| ----------------------------------- | ------------------------------------------------- | -------- |
| `wm_outbox_age_seconds > 3600`      | Ältestes pending/failed Outbox-Event älter als 1h | P2       |
| `wm_pending_observations > 100`     | Mehr als 100 unbeantwortete Observations          | P2       |
| `wm_scope_violations > 0`           | Wiederholte Scope-Verletzungen                    | P2       |
| `wm_followup_delivery_failures > 0` | Fehlgeschlagene Follow-up-Zustellung              | P3       |
| `wm_reconciliation_drift > 0`       | Reconcile-Report zeigt Abweichungen               | P3       |

## Backout

Bei nicht behebbaren Fehlern im `canonical`-Modus:

1. `WORLD_MODEL_MODE=shadow` in `.env.local` setzen
2. Scheduler und Web neu starten
3. Alle Altprojektionen (Mem0, SQLite Knowledge) bleiben lesbar
4. Nach Ursachenbehebung: Reconcile ausführen, dann Modus wieder heraufsetzen
