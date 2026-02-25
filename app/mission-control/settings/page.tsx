/**
 * Settings Page
 * Configure Mission Control paths, URLs, and preferences
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Save, RotateCcw, FolderOpen, Link as LinkIcon } from 'lucide-react';
import { getConfig, updateConfig, resetConfig, type MissionControlConfig } from '@/lib/config';

export default function SettingsPage() {
  const router = useRouter();
  const [config, setConfig] = useState<MissionControlConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfig(getConfig());
  }, []);

  const handleSave = async () => {
    if (!config) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);

    try {
      updateConfig(config);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (confirm('Reset all settings to defaults? This cannot be undone.')) {
      resetConfig();
      setConfig(getConfig());
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }
  };

  const handleChange = (field: keyof MissionControlConfig, value: string) => {
    if (!config) return;
    setConfig({ ...config, [field]: value });
  };

  if (!config) {
    return (
      <div className="bg-mc-bg flex min-h-screen items-center justify-center">
        <div className="text-mc-text-secondary">Loading settings...</div>
      </div>
    );
  }

  return (
    <div className="bg-mc-bg min-h-screen">
      {/* Header */}
      <div className="border-mc-border bg-mc-bg-secondary border-b">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/mission-control')}
              className="hover:bg-mc-bg-tertiary text-mc-text-secondary rounded p-2"
              title="Back to Mission Control"
            >
              ← Back
            </button>
            <Settings className="text-mc-accent h-6 w-6" />
            <h1 className="text-mc-text text-2xl font-bold">Settings</h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleReset}
              className="border-mc-border hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-2 rounded border px-4 py-2"
            >
              <RotateCcw className="h-4 w-4" />
              Reset to Defaults
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-mc-accent text-mc-bg hover:bg-mc-accent/90 flex items-center gap-2 rounded px-4 py-2 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-4xl px-6 py-8">
        {/* Success Message */}
        {saveSuccess && (
          <div className="mb-6 rounded border border-green-500/30 bg-green-500/10 p-4 text-green-400">
            ✓ Settings saved successfully
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mb-6 rounded border border-red-500/30 bg-red-500/10 p-4 text-red-400">
            ✗ {error}
          </div>
        )}

        {/* Workspace Paths */}
        <section className="bg-mc-bg-secondary border-mc-border mb-8 rounded-lg border p-6">
          <div className="mb-4 flex items-center gap-2">
            <FolderOpen className="text-mc-accent h-5 w-5" />
            <h2 className="text-mc-text text-xl font-semibold">Workspace Paths</h2>
          </div>
          <p className="text-mc-text-secondary mb-4 text-sm">
            Configure where Mission Control stores projects and deliverables.
          </p>

          <div className="space-y-4">
            <div>
              <label className="text-mc-text mb-2 block text-sm font-medium">
                Workspace Base Path
              </label>
              <input
                type="text"
                value={config.workspaceBasePath}
                onChange={(e) => handleChange('workspaceBasePath', e.target.value)}
                placeholder="~/Documents/Shared"
                className="bg-mc-bg border-mc-border text-mc-text focus:border-mc-accent w-full rounded border px-4 py-2 focus:outline-none"
              />
              <p className="text-mc-text-secondary mt-1 text-xs">
                Base directory for all Mission Control files. Use ~ for home directory.
              </p>
            </div>

            <div>
              <label className="text-mc-text mb-2 block text-sm font-medium">Projects Path</label>
              <input
                type="text"
                value={config.projectsPath}
                onChange={(e) => handleChange('projectsPath', e.target.value)}
                placeholder="~/Documents/Shared/projects"
                className="bg-mc-bg border-mc-border text-mc-text focus:border-mc-accent w-full rounded border px-4 py-2 focus:outline-none"
              />
              <p className="text-mc-text-secondary mt-1 text-xs">
                Directory where project folders are created. Each project gets its own folder.
              </p>
            </div>

            <div>
              <label className="text-mc-text mb-2 block text-sm font-medium">
                Default Project Name
              </label>
              <input
                type="text"
                value={config.defaultProjectName}
                onChange={(e) => handleChange('defaultProjectName', e.target.value)}
                placeholder="mission-control"
                className="bg-mc-bg border-mc-border text-mc-text focus:border-mc-accent w-full rounded border px-4 py-2 focus:outline-none"
              />
              <p className="text-mc-text-secondary mt-1 text-xs">
                Default name for new projects. Can be changed per project.
              </p>
            </div>
          </div>
        </section>

        {/* API Configuration */}
        <section className="bg-mc-bg-secondary border-mc-border mb-8 rounded-lg border p-6">
          <div className="mb-4 flex items-center gap-2">
            <LinkIcon className="text-mc-accent h-5 w-5" />
            <h2 className="text-mc-text text-xl font-semibold">API Configuration</h2>
          </div>
          <p className="text-mc-text-secondary mb-4 text-sm">
            Configure Mission Control API URL for agent orchestration.
          </p>

          <div className="space-y-4">
            <div>
              <label className="text-mc-text mb-2 block text-sm font-medium">
                Mission Control URL
              </label>
              <input
                type="text"
                value={config.missionControlUrl}
                onChange={(e) => handleChange('missionControlUrl', e.target.value)}
                placeholder="http://localhost:4000"
                className="bg-mc-bg border-mc-border text-mc-text focus:border-mc-accent w-full rounded border px-4 py-2 focus:outline-none"
              />
              <p className="text-mc-text-secondary mt-1 text-xs">
                URL where Mission Control is running. Auto-detected by default. Change for remote
                access.
              </p>
            </div>
          </div>
        </section>

        {/* Environment Variables Note */}
        <section className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-6">
          <h3 className="mb-2 text-lg font-semibold text-blue-400">📝 Environment Variables</h3>
          <p className="mb-3 text-sm text-blue-300">
            Some settings are also configurable via environment variables in{' '}
            <code className="bg-mc-bg rounded px-2 py-1">.env.local</code>:
          </p>
          <ul className="ml-4 list-disc space-y-1 text-sm text-blue-300">
            <li>
              <code>MISSION_CONTROL_URL</code> - API URL override
            </li>
            <li>
              <code>WORKSPACE_BASE_PATH</code> - Base workspace directory
            </li>
            <li>
              <code>PROJECTS_PATH</code> - Projects directory
            </li>
            <li>
              <code>OPENCLAW_GATEWAY_URL</code> - Gateway WebSocket URL
            </li>
            <li>
              <code>OPENCLAW_GATEWAY_TOKEN</code> - Gateway auth token
            </li>
          </ul>
          <p className="mt-3 text-xs text-blue-400">
            Environment variables take precedence over UI settings for server-side operations.
          </p>
        </section>
      </div>
    </div>
  );
}
