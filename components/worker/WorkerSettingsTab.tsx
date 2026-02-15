import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface WorkerSettingsPayload {
  ok: boolean;
  settings?: {
    defaultWorkspaceRoot: string | null;
    currentWorkspaceRoot: string;
    workspaceRootSource: 'user_setting' | 'system_default';
    updatedAt: string | null;
  };
  error?: string;
}

function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\')) return true;
  return value.startsWith('/');
}

const WorkerSettingsTab: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaultWorkspaceRoot, setDefaultWorkspaceRoot] = useState('');
  const [currentWorkspaceRoot, setCurrentWorkspaceRoot] = useState('');
  const [workspaceRootSource, setWorkspaceRootSource] = useState<'user_setting' | 'system_default'>(
    'system_default',
  );
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/worker/settings', { cache: 'no-store' });
      const payload = (await response.json()) as WorkerSettingsPayload;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      setDefaultWorkspaceRoot(payload.settings?.defaultWorkspaceRoot || '');
      setCurrentWorkspaceRoot(payload.settings?.currentWorkspaceRoot || '');
      setWorkspaceRootSource(payload.settings?.workspaceRootSource || 'system_default');
      setSavedAt(payload.settings?.updatedAt || null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Einstellungen konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const normalizedPath = defaultWorkspaceRoot.trim();
  const hasValidationError = useMemo(
    () => normalizedPath.length > 0 && !isAbsolutePath(normalizedPath),
    [normalizedPath],
  );

  const handleSave = useCallback(async () => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      if (hasValidationError) {
        setError('Bitte einen absoluten Pfad eingeben (z. B. H:\\clawdbot\\workspace).');
        return;
      }

      const response = await fetch('/api/worker/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultWorkspaceRoot: normalizedPath.length > 0 ? normalizedPath : null,
        }),
      });
      const payload = (await response.json()) as WorkerSettingsPayload;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      setDefaultWorkspaceRoot(payload.settings?.defaultWorkspaceRoot || '');
      setCurrentWorkspaceRoot(payload.settings?.currentWorkspaceRoot || '');
      setWorkspaceRootSource(payload.settings?.workspaceRootSource || 'system_default');
      setSavedAt(payload.settings?.updatedAt || null);
      setSuccess('Einstellungen gespeichert.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Speichern fehlgeschlagen.');
    } finally {
      setSaving(false);
    }
  }, [hasValidationError, normalizedPath]);

  return (
    <section className="worker-settings">
      <header className="worker-settings__header">
        <h2>Worker Settings</h2>
        <p>
          Jede Task bekommt weiter einen eigenen Ordner. Hier legst du fest, in welchem
          Basis-Verzeichnis diese Task-Ordner erstellt werden.
        </p>
      </header>

      {loading ? (
        <p>Einstellungen werden geladen…</p>
      ) : (
        <div className="worker-settings__panel">
          <label htmlFor="worker-default-workdir">Standard Workdir (absoluter Pfad)</label>
          <input
            id="worker-default-workdir"
            className="worker-input"
            type="text"
            value={defaultWorkspaceRoot}
            onChange={(event) => setDefaultWorkspaceRoot(event.target.value)}
            placeholder="H:\\clawdbot\\workspace"
          />
          <p className="worker-settings__hint">
            Beispiel: <code>H:\clawdbot\workspace</code> oder <code>/srv/claw/workspace</code>
          </p>
          <p className="worker-settings__current">
            Aktuell genutzter Root: <code>{currentWorkspaceRoot || '-'}</code>
          </p>
          <p className="worker-settings__source">
            Quelle: {workspaceRootSource === 'user_setting' ? 'User-Setting' : 'System-Default'}
          </p>

          {hasValidationError && (
            <p className="worker-alert worker-alert--error">
              Pfad ist nicht absolut. Bitte mit Laufwerk/Root beginnen.
            </p>
          )}
          {error && <p className="worker-alert worker-alert--error">{error}</p>}
          {success && <p className="worker-alert worker-alert--success">{success}</p>}

          <div className="worker-settings__actions">
            <button
              className="worker-btn worker-btn--ghost"
              type="button"
              onClick={() => setDefaultWorkspaceRoot('')}
              disabled={saving}
            >
              Standard zurücksetzen
            </button>
            <button
              className="worker-btn worker-btn--primary"
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? 'Speichert…' : 'Speichern'}
            </button>
          </div>

          <p className="worker-settings__meta">
            Letzte Änderung: {savedAt ? new Date(savedAt).toLocaleString() : 'noch nicht gespeichert'}
          </p>
        </div>
      )}
    </section>
  );
};

export default WorkerSettingsTab;
