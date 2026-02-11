// ─── Worker Task Detail ─────────────────────────────────────
// Detail view with flow visualization, file browser, and live terminal.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerTask, WorkerStep, WorkspaceFile } from '../../types';
import { useWorkspaceFiles } from '../../src/modules/worker/hooks/useWorkspaceFiles';
import { getGatewayClient } from '../../src/modules/gateway/ws-client';

interface WorkerTaskDetailProps {
  task: WorkerTask;
  onBack: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onResume: (id: string) => void;
  onApprove: (id: string) => void;
  onDelete: (id: string) => void;
}

// ─── Status Config ──────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  queued: { label: 'In Warteschlange', color: '#6b7280', icon: '⏳' },
  planning: { label: 'Planung', color: '#3b82f6', icon: '🧠' },
  clarifying: { label: 'Rückfragen', color: '#8b5cf6', icon: '❓' },
  executing: { label: 'In Arbeit', color: '#f59e0b', icon: '⚙️' },
  waiting_approval: { label: 'Genehmigung benötigt', color: '#ec4899', icon: '🔒' },
  review: { label: 'Review', color: '#06b6d4', icon: '👀' },
  completed: { label: 'Abgeschlossen', color: '#10b981', icon: '✅' },
  failed: { label: 'Fehlgeschlagen', color: '#ef4444', icon: '❌' },
  cancelled: { label: 'Abgebrochen', color: '#6b7280', icon: '🚫' },
  interrupted: { label: 'Unterbrochen', color: '#f97316', icon: '⚡' },
};

const TYPE_ICONS: Record<string, string> = {
  research: '📚',
  webapp: '🌐',
  creative: '🎨',
  data: '📊',
  general: '📝',
};

// ─── File Icon Helper ───────────────────────────────────────
function getFileIcon(file: WorkspaceFile): string {
  if (file.isDirectory) return '📁';
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    json: '📋',
    md: '📝',
    txt: '📄',
    log: '📜',
    html: '🌐',
    css: '🎨',
    js: '⚡',
    ts: '🔷',
    tsx: '⚛️',
    jsx: '⚛️',
    png: '🖼️',
    jpg: '🖼️',
    jpeg: '🖼️',
    gif: '🖼️',
    svg: '🖼️',
    webp: '🖼️',
    pdf: '📕',
    mp4: '🎬',
    webm: '🎬',
    zip: '📦',
    py: '🐍',
    rb: '💎',
    go: '🐹',
    rs: '🦀',
  };
  return icons[ext] || '📄';
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── File Preview Component ─────────────────────────────────
const FilePreview: React.FC<{
  file: { path: string; type: string; content: string; mimeType?: string };
}> = ({ file }) => {
  const ext = file.path.split('.').pop()?.toLowerCase() || '';

  if (file.type === 'binary') {
    // Image preview
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
      return (
        <div className="worker-file-preview worker-file-preview--image">
          <img
            src={`data:${file.mimeType || 'image/png'};base64,${file.content}`}
            alt={file.path}
          />
        </div>
      );
    }
    // PDF preview
    if (ext === 'pdf') {
      return (
        <div className="worker-file-preview worker-file-preview--pdf">
          <iframe
            src={`data:application/pdf;base64,${file.content}`}
            title={file.path}
            style={{ width: '100%', height: '500px', border: 'none' }}
          />
        </div>
      );
    }
    // Video preview
    if (['mp4', 'webm'].includes(ext)) {
      return (
        <div className="worker-file-preview worker-file-preview--video">
          <video
            controls
            src={`data:${file.mimeType || 'video/mp4'};base64,${file.content}`}
            style={{ maxWidth: '100%' }}
          />
        </div>
      );
    }
    // Generic binary → download button
    return (
      <div className="worker-file-preview worker-file-preview--binary">
        <p>Binärdatei — Vorschau nicht verfügbar</p>
        <a
          href={`data:${file.mimeType || 'application/octet-stream'};base64,${file.content}`}
          download={file.path.split('/').pop()}
        >
          ⬇️ Herunterladen
        </a>
      </div>
    );
  }

  // Text preview with HTML iframe
  if (ext === 'html') {
    return (
      <div className="worker-file-preview worker-file-preview--html">
        <iframe
          srcDoc={file.content}
          title={file.path}
          sandbox="allow-scripts"
          style={{
            width: '100%',
            height: '400px',
            border: '1px solid var(--border-primary)',
            borderRadius: '8px',
          }}
        />
      </div>
    );
  }

  // Text / Code preview
  return (
    <div className="worker-file-preview worker-file-preview--code">
      <pre>
        <code>{file.content}</code>
      </pre>
    </div>
  );
};

// ─── Main Component ─────────────────────────────────────────
const WorkerTaskDetail: React.FC<WorkerTaskDetailProps> = ({
  task,
  onBack,
  onCancel,
  onRetry,
  onResume,
  onApprove,
  onDelete,
}) => {
  const [activeTab, setActiveTab] = useState<'steps' | 'files' | 'output' | 'terminal'>('steps');
  const [steps, setSteps] = useState<WorkerStep[]>(task.steps || []);
  const {
    files,
    selectedFile,
    openFile,
    closeFile,
    refreshFiles,
    loading: filesLoading,
  } = useWorkspaceFiles(task.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const terminalRef = useRef<HTMLDivElement>(null);

  // WebSocket Live Terminal subscription
  useEffect(() => {
    if (activeTab !== 'terminal') return;

    const client = getGatewayClient();
    client.connect();

    // Subscribe to task-specific worker updates
    client.request('worker.task.subscribe', { taskId: task.id }).catch(() => {});

    const unsub = client.on('worker.status', (payload) => {
      try {
        const data = payload as { taskId: string; status?: string; message?: string };
        if (data.taskId === task.id) {
          const ts = new Date().toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          setTerminalLogs((prev) => [
            ...prev,
            `[${ts}] ${data.status?.toUpperCase() || 'UPDATE'}: ${data.message || JSON.stringify(data)}`,
          ]);
        }
      } catch { /* ignore */ }
    });

    // Also listen for SSE-bridged legacy event
    const unsubLegacy = client.on('worker-status', (payload) => {
      try {
        const data = payload as { taskId: string; status?: string; message?: string };
        if (data.taskId === task.id) {
          const ts = new Date().toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
          setTerminalLogs((prev) => [
            ...prev,
            `[${ts}] ${data.status?.toUpperCase() || 'UPDATE'}: ${data.message || JSON.stringify(data)}`,
          ]);
        }
      } catch { /* ignore */ }
    });

    return () => {
      unsub();
      unsubLegacy();
      client.request('worker.task.unsubscribe', { taskId: task.id }).catch(() => {});
    };
  }, [activeTab, task.id]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalLogs]);

  const handleExportZip = useCallback(() => {
    window.open(`/api/worker/${task.id}/export`, '_blank');
  }, [task.id]);

  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.queued;
  const typeIcon = TYPE_ICONS[task.workspaceType] || TYPE_ICONS.general;

  // Fetch task details with steps
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/worker/${task.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.task?.steps) setSteps(data.task.steps);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [task.id, task.status]);

  // Load files when files tab is selected
  useEffect(() => {
    if (activeTab === 'files') refreshFiles();
  }, [activeTab, refreshFiles]);

  const isActive = ['queued', 'planning', 'clarifying', 'executing', 'waiting_approval'].includes(
    task.status,
  );

  return (
    <div className="worker-detail">
      {/* Header */}
      <div className="worker-detail__header">
        <button className="worker-btn worker-btn--ghost" onClick={onBack}>
          ← Zurück
        </button>
        <div className="worker-detail__title-row">
          <span className="worker-detail__type">{typeIcon}</span>
          <h2>{task.title}</h2>
          <span
            className="worker-detail__status-badge"
            style={{ backgroundColor: `${config.color}22`, color: config.color }}
          >
            {config.icon} {config.label}
          </span>
        </div>
        <p className="worker-detail__objective">{task.objective}</p>
      </div>

      {/* Progress Bar */}
      {task.totalSteps > 0 && (
        <div className="worker-detail__progress">
          <div className="worker-detail__progress-bar">
            <div
              className="worker-detail__progress-fill"
              style={{
                width: `${Math.round((task.currentStep / task.totalSteps) * 100)}%`,
                backgroundColor: config.color,
              }}
            />
          </div>
          <span className="worker-detail__progress-label">
            {task.currentStep} / {task.totalSteps} Schritte
          </span>
        </div>
      )}

      {/* Error Message */}
      {task.errorMessage && (
        <div className="worker-alert worker-alert--error">
          <strong>Fehler:</strong> {task.errorMessage}
        </div>
      )}

      {/* Result Summary */}
      {task.resultSummary && (
        <div className="worker-alert worker-alert--success">
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{task.resultSummary}</pre>
        </div>
      )}

      {/* Action Buttons */}
      <div className="worker-detail__actions">
        {isActive && (
          <button className="worker-btn worker-btn--danger" onClick={() => onCancel(task.id)}>
            ⏹️ Abbrechen
          </button>
        )}
        {task.status === 'waiting_approval' && (
          <button className="worker-btn worker-btn--primary" onClick={() => onApprove(task.id)}>
            ✅ Genehmigen
          </button>
        )}
        {task.status === 'failed' && (
          <button className="worker-btn worker-btn--primary" onClick={() => onRetry(task.id)}>
            🔄 Wiederholen
          </button>
        )}
        {task.status === 'interrupted' && task.resumable && (
          <button className="worker-btn worker-btn--primary" onClick={() => onResume(task.id)}>
            ▶️ Fortsetzen
          </button>
        )}
        <button className="worker-btn worker-btn--ghost" onClick={handleExportZip}>
          📦 ZIP Export
        </button>
        {!isActive && (
          <button
            className="worker-btn worker-btn--danger-outline"
            onClick={() => {
              if (confirmDelete) {
                onDelete(task.id);
              } else {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 3000);
              }
            }}
          >
            {confirmDelete ? '⚠️ Wirklich löschen?' : '🗑️ Löschen'}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="worker-detail__tabs">
        <button
          className={`worker-tab ${activeTab === 'steps' ? 'worker-tab--active' : ''}`}
          onClick={() => setActiveTab('steps')}
        >
          📋 Schritte ({steps.length})
        </button>
        <button
          className={`worker-tab ${activeTab === 'files' ? 'worker-tab--active' : ''}`}
          onClick={() => setActiveTab('files')}
        >
          📁 Dateien ({files.filter((f) => !f.isDirectory).length})
        </button>
        <button
          className={`worker-tab ${activeTab === 'output' ? 'worker-tab--active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          📄 Output
        </button>
        <button
          className={`worker-tab ${activeTab === 'terminal' ? 'worker-tab--active' : ''}`}
          onClick={() => setActiveTab('terminal')}
        >
          💻 Terminal
        </button>
      </div>

      {/* Tab Content */}
      <div className="worker-detail__tab-content">
        {/* Steps Tab */}
        {activeTab === 'steps' && (
          <div className="worker-steps">
            {steps.length === 0 ? (
              <p className="worker-steps__empty">Noch keine Schritte verfügbar.</p>
            ) : (
              steps.map((step, i) => (
                <div key={step.id} className={`worker-step worker-step--${step.status}`}>
                  <div className="worker-step__index">
                    {step.status === 'completed'
                      ? '✅'
                      : step.status === 'running'
                        ? '⏳'
                        : step.status === 'failed'
                          ? '❌'
                          : `${i + 1}.`}
                  </div>
                  <div className="worker-step__content">
                    <p className="worker-step__description">{step.description}</p>
                    {step.output && <pre className="worker-step__output">{step.output}</pre>}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Files Tab */}
        {activeTab === 'files' && (
          <div className="worker-files">
            {selectedFile ? (
              <div className="worker-files__preview">
                <div className="worker-files__preview-header">
                  <button className="worker-btn worker-btn--ghost" onClick={closeFile}>
                    ← Zurück zur Dateiliste
                  </button>
                  <span className="worker-files__preview-path">{selectedFile.path}</span>
                </div>
                <FilePreview file={selectedFile} />
              </div>
            ) : (
              <>
                {filesLoading ? (
                  <p>Dateien laden…</p>
                ) : files.length === 0 ? (
                  <p className="worker-files__empty">Noch keine Dateien im Workspace.</p>
                ) : (
                  <div className="worker-files__list">
                    {files
                      .filter((f) => !f.isDirectory)
                      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
                      .map((f) => (
                        <button
                          key={f.relativePath}
                          className="worker-file-item"
                          onClick={() => openFile(f.relativePath)}
                        >
                          <span className="worker-file-item__icon">{getFileIcon(f)}</span>
                          <span className="worker-file-item__path">{f.relativePath}</span>
                          <span className="worker-file-item__size">{formatSize(f.size)}</span>
                        </button>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Output Tab */}
        {activeTab === 'output' && (
          <div className="worker-output">
            {task.resultSummary ? (
              <pre className="worker-output__content">{task.resultSummary}</pre>
            ) : (
              <p className="worker-output__empty">
                {isActive ? 'Output wird generiert…' : 'Kein Output verfügbar.'}
              </p>
            )}
          </div>
        )}

        {/* Terminal Tab */}
        {activeTab === 'terminal' && (
          <div className="worker-terminal">
            <div className="worker-terminal__header">
              <span className="worker-terminal__dot worker-terminal__dot--red" />
              <span className="worker-terminal__dot worker-terminal__dot--yellow" />
              <span className="worker-terminal__dot worker-terminal__dot--green" />
              <span className="worker-terminal__title">Worker Live Terminal — {task.title}</span>
              {isActive && <span className="worker-terminal__live">● LIVE</span>}
            </div>
            <div className="worker-terminal__body" ref={terminalRef}>
              {terminalLogs.length === 0 ? (
                <p className="worker-terminal__empty">
                  {isActive
                    ? 'Warte auf Live-Updates… (SSE verbunden)'
                    : 'Kein Live-Terminal für abgeschlossene Tasks.'}
                </p>
              ) : (
                terminalLogs.map((line, i) => (
                  <div key={i} className="worker-terminal__line">
                    <span className="worker-terminal__prompt">$</span>
                    <span>{line}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkerTaskDetail;
