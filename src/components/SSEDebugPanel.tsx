'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface SSELogEntry {
  timestamp: Date;
  type: string;
  data: unknown;
}

function formatLogData(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

export function SSEDebugPanel() {
  const [logs, setLogs] = useState<SSELogEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isEnabled, setIsEnabled] = useState(false);

  const addLog = useCallback((type: string, data: unknown) => {
    setLogs((prev) =>
      [
        {
          timestamp: new Date(),
          type,
          data,
        },
        ...prev,
      ].slice(0, 50),
    ); // Keep last 50
  }, []);

  useEffect(() => {
    // Check if debug mode is enabled
    const debugEnabled = localStorage.getItem('MC_DEBUG') === 'true';
    setIsEnabled(debugEnabled);

    if (!debugEnabled) return;

    // Intercept console.log for SSE events
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      originalLog.apply(console, args);

      // Capture SSE and STORE logs
      if (typeof args[0] === 'string') {
        const msg = args[0] as string;
        if (msg.includes('[SSE]') || msg.includes('[STORE]') || msg.includes('[API]')) {
          const type = msg.replace(/^\[([^\]]+)\].*$/, '$1');
          const message = msg.replace(/^\[[^\]]+\]\s*/, '');
          addLog(`${type}: ${message}`, args[1]);
        }
      }
    };

    return () => {
      console.log = originalLog;
    };
  }, [addLog]);

  // Re-check debug mode on storage changes
  useEffect(() => {
    const handleStorage = () => {
      const debugEnabled = localStorage.getItem('MC_DEBUG') === 'true';
      setIsEnabled(debugEnabled);
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  if (!isEnabled) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="bg-mc-bg-secondary border-mc-border flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
      >
        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="text-mc-accent">Debug</span>
        <span className="bg-mc-accent text-mc-bg rounded px-2 py-0.5 text-xs">{logs.length}</span>
      </button>

      {isOpen && (
        <div className="bg-mc-bg-secondary border-mc-border absolute bottom-12 left-0 max-h-80 w-96 overflow-hidden rounded-lg border shadow-xl">
          <div className="border-mc-border flex items-center justify-between border-b p-2">
            <span className="text-sm font-medium">Debug Events</span>
            <button
              onClick={() => setLogs([])}
              className="text-mc-text-secondary hover:text-mc-text text-xs"
            >
              Clear
            </button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto p-2 font-mono text-xs">
            {logs.length === 0 ? (
              <div className="text-mc-text-secondary py-4 text-center">Waiting for events...</div>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="bg-mc-bg border-mc-border rounded border p-2">
                  <div className="text-mc-text-secondary flex justify-between">
                    <span className="text-mc-accent">{log.type}</span>
                    <span>{log.timestamp.toLocaleTimeString()}</span>
                  </div>
                  {log.data !== null && log.data !== undefined && (
                    <pre className="text-mc-text mt-1 overflow-x-auto whitespace-pre-wrap">
                      {formatLogData(log.data)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
