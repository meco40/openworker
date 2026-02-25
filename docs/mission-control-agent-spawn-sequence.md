# Mission Control: Task -> Planning -> Agent Spawn -> Dispatch

## Sequenzdiagramm (Planning -> Auto-Spawn -> Dispatch)

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant UI as TaskModal/PlanningTab
    participant TasksAPI as /api/tasks
    participant PlanningAPI as /api/tasks/{id}/planning(+poll/+answer)
    participant DB as SQLite
    participant Runtime as OpenClawClient (integrated)
    participant DispatchAPI as /api/tasks/{id}/dispatch

    User->>UI: Neue Task mit "Planning Mode"
    UI->>TasksAPI: POST /api/tasks (status=planning)
    TasksAPI->>DB: INSERT task
    TasksAPI-->>UI: task{id}

    UI->>PlanningAPI: POST /api/tasks/{id}/planning
    PlanningAPI->>Runtime: chat.send(sessionKey=agent:main:planning:{taskId})
    PlanningAPI->>DB: UPDATE task (planning_session_key, planning_messages, status=planning)
    PlanningAPI-->>UI: planning started

    loop Frage/Antwort Zyklus
        UI->>PlanningAPI: POST /planning/answer
        PlanningAPI->>Runtime: chat.send(answerPrompt)
        UI->>PlanningAPI: GET /planning/poll
        PlanningAPI->>Runtime: chat.history(sessionKey)
        PlanningAPI-->>UI: naechste Frage ODER complete
    end

    alt Planner liefert complete + agents[]
        PlanningAPI->>DB: INSERT INTO agents (...) for each planned agent
        PlanningAPI->>DB: UPDATE task.assigned_agent_id = firstAgentId
        PlanningAPI->>DispatchAPI: POST /api/tasks/{id}/dispatch
        DispatchAPI->>DB: create/find openclaw_session
        DispatchAPI->>Runtime: chat.send(task assignment)
        DispatchAPI->>DB: UPDATE task.status=in_progress, agent.status=working
        DispatchAPI-->>PlanningAPI: success
        PlanningAPI->>DB: planning_complete=1
        PlanningAPI-->>UI: complete + autoDispatched=true
    else complete ohne agents[]
        PlanningAPI->>DB: planning_complete=1, status=inbox
        PlanningAPI-->>UI: complete + autoDispatched=false
    end
```

## Optional: separater Sub-Agent-Spawn-Pfad

```mermaid
sequenceDiagram
    autonumber
    participant Orchestrator as Orchestrator Helper
    participant SubAPI as /api/tasks/{id}/subagent
    participant DB as SQLite
    participant SSE as SSE Broadcast
    participant UI as Sessions/Live Feed

    Orchestrator->>SubAPI: POST {openclaw_session_id, agent_name}
    alt agent_name unbekannt
        SubAPI->>DB: INSERT agents(role='Sub-Agent')
    end
    SubAPI->>DB: INSERT openclaw_sessions(session_type='subagent')
    SubAPI->>SSE: event agent_spawned
    SSE-->>UI: Sub-Agent erscheint in Session/Feed
```

## Code-Anker

- Planning-Start/Session-Key: `app/api/tasks/[id]/planning/route.ts:132`
- Planner fordert `agents[]` bei Completion: `app/api/tasks/[id]/planning/answer/route.ts:56`
- Auto-Spawn (`INSERT INTO agents`): `app/api/tasks/[id]/planning/poll/route.ts:76`
- Auto-Assign + Auto-Dispatch: `app/api/tasks/[id]/planning/poll/route.ts:158`
- Dispatch-Logik (Session + `chat.send` + Statusupdate): `app/api/tasks/[id]/dispatch/route.ts:91`
- Sub-Agent Registrierung: `app/api/tasks/[id]/subagent/route.ts:14`
