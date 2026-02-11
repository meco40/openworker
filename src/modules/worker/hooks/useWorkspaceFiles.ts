// ─── Workspace Files Hook ───────────────────────────────────
// Hook for browsing and reading workspace files via API.

import { useState, useCallback } from 'react';
import type { WorkspaceFile } from '../../../../types';

interface FileContent {
  path: string;
  type: 'text' | 'binary';
  content: string;
  mimeType?: string;
  size: number;
}

export function useWorkspaceFiles(taskId: string) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ─── Fetch File Listing ───────────────────────────────────
  const fetchFiles = useCallback(async () => {
    if (!taskId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/worker/${taskId}/files`);
      if (!res.ok) {
        if (res.status === 404) {
          setFiles([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setFiles(data.files || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // ─── Open File ────────────────────────────────────────────
  const openFile = useCallback(
    async (filePath: string) => {
      if (!taskId) return;
      try {
        setError(null);
        const res = await fetch(`/api/worker/${taskId}/files?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSelectedFile(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Fehler beim Öffnen');
      }
    },
    [taskId],
  );

  // ─── Close File ───────────────────────────────────────────
  const closeFile = useCallback(() => {
    setSelectedFile(null);
  }, []);

  return {
    files,
    loading,
    error,
    selectedFile,
    openFile,
    closeFile,
    refreshFiles: fetchFiles,
  };
}
