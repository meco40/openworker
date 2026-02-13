// ─── Worker Planning Tab ─────────────────────────────────────
// Interactive Q&A interface for the AI planning phase.
// Shows multiple-choice cards for each planning question.

import React, { useCallback, useEffect, useState } from 'react';

interface PlanningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PlanningQuestion {
  question: string;
  options: string[];
  context?: string;
}

interface PlanningSpecification {
  summary: string;
  steps: string[];
  constraints: string[];
}

interface WorkerPlanningTabProps {
  taskId: string;
  taskStatus: string;
}

const WorkerPlanningTab: React.FC<WorkerPlanningTabProps> = ({ taskId, taskStatus: _taskStatus }) => {
  const [messages, setMessages] = useState<PlanningMessage[]>([]);
  const [currentQuestion, setCurrentQuestion] = useState<PlanningQuestion | null>(null);
  const [specification, setSpecification] = useState<PlanningSpecification | null>(null);
  const [planningComplete, setPlanningComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState('');

  // ─── Load Planning State ──────────────────────────────────
  const loadPlanningState = useCallback(async () => {
    try {
      const res = await fetch(`/api/worker/${taskId}/planning`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.messages) setMessages(data.messages);
      setPlanningComplete(data.planningComplete || false);
    } catch {
      /* ignore */
    }
  }, [taskId]);

  useEffect(() => {
    loadPlanningState();
  }, [loadPlanningState]);

  // ─── Start Planning ───────────────────────────────────────
  const startPlanning = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/worker/${taskId}/planning`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || 'Fehler beim Starten der Planung');
        return;
      }
      setMessages(data.messages || []);
      setCurrentQuestion(data.currentQuestion || null);
      setPlanningComplete(data.planningComplete || false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Starten');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // ─── Answer Question ──────────────────────────────────────
  const sendAnswer = useCallback(
    async (answer: string) => {
      setLoading(true);
      setError(null);
      setCurrentQuestion(null);
      try {
        const res = await fetch(`/api/worker/${taskId}/planning/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer }),
        });
        const data = await res.json();
        if (!data.ok) {
          setError(data.error || 'Fehler bei der Verarbeitung');
          return;
        }
        setMessages(data.messages || []);
        setCurrentQuestion(data.currentQuestion || null);
        setPlanningComplete(data.planningComplete || false);
        if (data.specification) {
          setSpecification(data.specification);
        }
        setCustomAnswer('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Fehler beim Senden');
      } finally {
        setLoading(false);
      }
    },
    [taskId],
  );

  // ─── Not yet started ─────────────────────────────────────
  if (messages.length === 0 && !planningComplete) {
    return (
      <div className="worker-planning">
        <div className="worker-planning__empty">
          <div className="worker-planning__empty-icon">🧠</div>
          <h3>KI-Planungsphase</h3>
          <p>
            Die KI stellt gezielte Rückfragen, um die Aufgabe optimal zu verstehen und einen
            detaillierten Plan zu erstellen.
          </p>
          <button
            className="worker-btn worker-btn--primary"
            onClick={startPlanning}
            disabled={loading}
          >
            {loading ? '⏳ Wird gestartet…' : '🚀 Planung starten'}
          </button>
          {error && <p className="worker-planning__error">{error}</p>}
        </div>
      </div>
    );
  }

  // ─── Completed specification ──────────────────────────────
  if (planningComplete && specification) {
    return (
      <div className="worker-planning">
        <div className="worker-planning__complete">
          <div className="worker-planning__complete-icon">✅</div>
          <h3>Planung abgeschlossen</h3>
          <div className="worker-planning__spec">
            <h4>Spezifikation</h4>
            <p>{specification.summary}</p>
            {specification.steps.length > 0 && (
              <>
                <h4>Geplante Schritte</h4>
                <ol className="worker-planning__spec-steps">
                  {specification.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </>
            )}
            {specification.constraints.length > 0 && (
              <>
                <h4>Einschränkungen</h4>
                <ul className="worker-planning__spec-constraints">
                  {specification.constraints.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <p className="worker-planning__queued-info">
            📋 Task wurde in die Warteschlange verschoben und wird automatisch ausgeführt.
          </p>
        </div>
      </div>
    );
  }

  // ─── Completed without spec data ──────────────────────────
  if (planningComplete) {
    return (
      <div className="worker-planning">
        <div className="worker-planning__complete">
          <div className="worker-planning__complete-icon">✅</div>
          <h3>Planung abgeschlossen</h3>
          <p>Der Task wurde in die Warteschlange verschoben.</p>
        </div>
      </div>
    );
  }

  // ─── Active Q&A ────────────────────────────────────────────
  // Extract user messages for conversation display
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  return (
    <div className="worker-planning">
      {/* Conversation History */}
      <div className="worker-planning__history">
        {conversationMessages.map((msg, i) => (
          <div key={i} className={`worker-planning__message worker-planning__message--${msg.role}`}>
            <span className="worker-planning__message-role">
              {msg.role === 'assistant' ? '🧠 KI' : '👤 Du'}
            </span>
            <div className="worker-planning__message-content">
              {msg.content.length > 500 ? msg.content.slice(0, 500) + '…' : msg.content}
            </div>
          </div>
        ))}
      </div>

      {/* Current Question */}
      {currentQuestion && !loading && (
        <div className="worker-planning__question">
          <h3 className="worker-planning__question-text">{currentQuestion.question}</h3>
          {currentQuestion.context && (
            <p className="worker-planning__question-context">{currentQuestion.context}</p>
          )}
          <div className="worker-planning__options">
            {currentQuestion.options.map((option, i) => (
              <button
                key={i}
                className="worker-planning__option-card"
                onClick={() => sendAnswer(option)}
                disabled={loading}
              >
                <span className="worker-planning__option-letter">
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="worker-planning__option-text">{option}</span>
              </button>
            ))}
          </div>
          {/* Custom answer */}
          <div className="worker-planning__custom">
            <input
              type="text"
              className="worker-input"
              value={customAnswer}
              onChange={(e) => setCustomAnswer(e.target.value)}
              placeholder="Oder eigene Antwort eingeben…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customAnswer.trim()) {
                  sendAnswer(customAnswer.trim());
                }
              }}
            />
            <button
              className="worker-btn worker-btn--ghost"
              onClick={() => customAnswer.trim() && sendAnswer(customAnswer.trim())}
              disabled={!customAnswer.trim() || loading}
            >
              Senden
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="worker-planning__loading">
          <span className="worker-planning__spinner" />
          KI denkt nach…
        </div>
      )}

      {/* Error */}
      {error && <p className="worker-planning__error">{error}</p>}
    </div>
  );
};

export default WorkerPlanningTab;
