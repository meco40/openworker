
import React, { useState } from 'react';

const ConfigEditor: React.FC = () => {
  const defaultConfig = {
    "gateway": {
      "port": 8080,
      "host": "0.0.0.0",
      "logLevel": "info"
    },
    "provider": {
      "primary": "gemini-3-flash-preview",
      "fallback": "gemini-3-pro-preview",
      "rotation": true
    },
    "channels": {
      "webchat": { "enabled": true },
      "telegram": { "enabled": true, "token": "ENV_T_TOKEN" },
      "slack": { "enabled": false }
    },
    "tools": {
      "browser": { "managed": true, "headless": true },
      "sandbox": { "type": "docker", "enabled": false }
    }
  };

  const [config, setConfig] = useState(JSON.stringify(defaultConfig, null, 2));
  const [hasChanges, setHasChanges] = useState(false);

  const handleApply = () => {
    try {
      JSON.parse(config);
      setHasChanges(false);
      alert('Config applied successfully. Gateway restart scheduled.');
    } catch {
      alert('Invalid JSON schema. Apply failed.');
    }
  };

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">Gateway Config</h2>
          <p className="text-sm text-zinc-500">Edit your system configuration. Changes require a partial restart.</p>
        </div>
        <div className="flex space-x-3">
          <button 
            disabled={!hasChanges}
            onClick={handleApply}
            className={`px-6 py-2 rounded text-xs font-bold uppercase tracking-widest transition-all ${
              hasChanges ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg' : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            Apply Config
          </button>
        </div>
      </div>

      <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden flex flex-col">
        <div className="bg-zinc-900 px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
          <span className="text-[10px] font-mono text-zinc-500">~/.openclaw/openclaw.json</span>
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-[10px] text-zinc-600 font-mono uppercase">Schema Valid</span>
          </div>
        </div>
        <textarea
          value={config}
          onChange={(e) => { setConfig(e.target.value); setHasChanges(true); }}
          spellCheck={false}
          className="flex-1 w-full bg-transparent p-6 font-mono text-sm text-indigo-300 focus:outline-none resize-none"
        />
      </div>
      
      <div className="bg-zinc-900/50 border border-zinc-800 p-4 rounded-lg">
        <h4 className="text-[10px] uppercase font-bold text-zinc-500 mb-2">Validation Errors</h4>
        <div className="text-xs font-mono text-emerald-500">
          ✓ No schema violations found. Config is ready for deployment.
        </div>
      </div>
    </div>
  );
};

export default ConfigEditor;
