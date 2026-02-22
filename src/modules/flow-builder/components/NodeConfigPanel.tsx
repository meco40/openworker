'use client';
import React from 'react';
import type { FlowNodeType, FlowNodeData } from '@/server/automation/flowTypes';

interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select';
  options?: { value: string; label: string }[];
}

const NODE_FIELDS: Partial<Record<FlowNodeType, FieldDef[]>> = {
  'trigger.cron': [{ key: 'cronExpression', label: 'Cron Expression', type: 'text' }],
  'trigger.webhook': [{ key: 'webhookPath', label: 'Webhook Path', type: 'text' }],
  'condition.filter': [
    { key: 'field', label: 'Field', type: 'text' },
    {
      key: 'operator',
      label: 'Operator',
      type: 'select',
      options: [
        { value: 'eq', label: 'equals' },
        { value: 'neq', label: 'not equals' },
        { value: 'contains', label: 'contains' },
        { value: 'gt', label: '>' },
        { value: 'lt', label: '<' },
      ],
    },
    { key: 'value', label: 'Value', type: 'text' },
  ],
  'condition.ai_classifier': [{ key: 'prompt', label: 'Classification Prompt', type: 'textarea' }],
  'condition.regex': [{ key: 'pattern', label: 'Regex Pattern', type: 'text' }],
  'action.run_prompt': [
    { key: 'prompt', label: 'Prompt', type: 'textarea' },
    { key: 'outputVar', label: 'Output Variable', type: 'text' },
  ],
  'action.skill': [
    {
      key: 'skillId',
      label: 'Skill',
      type: 'select',
      options: [
        { value: 'search', label: '🔍 Search' },
        { value: 'browser', label: '🌐 Browser' },
        { value: 'python-runtime', label: '🐍 Python Runtime' },
        { value: 'vision', label: '👁️ Vision' },
        { value: 'filesystem', label: '📁 Filesystem' },
        { value: 'github-manager', label: '🐙 GitHub Manager' },
        { value: 'shell-access', label: '💻 Shell Access' },
        { value: 'sql-bridge', label: '🗄️ SQL Bridge' },
      ],
    },
    { key: 'input', label: 'Input', type: 'textarea' },
  ],
  'action.send_message': [
    { key: 'channelId', label: 'Channel ID', type: 'text' },
    { key: 'message', label: 'Message', type: 'textarea' },
  ],
  'action.notify': [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'body', label: 'Body', type: 'textarea' },
  ],
};

interface NodeConfigPanelProps {
  nodeId: string;
  nodeType: FlowNodeType;
  nodeLabel: string;
  config: FlowNodeData['config'];
  onConfigChange: (nodeId: string, config: FlowNodeData['config']) => void;
  onLabelChange: (nodeId: string, label: string) => void;
}

export function NodeConfigPanel({
  nodeId,
  nodeType,
  nodeLabel,
  config,
  onConfigChange,
  onLabelChange,
}: NodeConfigPanelProps) {
  const fields = NODE_FIELDS[nodeType] ?? [];
  const cfg = (config ?? {}) as Record<string, string>;

  function handleField(key: string, value: string) {
    onConfigChange(nodeId, { ...cfg, [key]: value });
  }

  return (
    <aside className="flex w-56 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-4">
      <p className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">Node Config</p>

      {/* Label */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-400">Label</span>
        <input
          type="text"
          value={nodeLabel}
          onChange={(e) => onLabelChange(nodeId, e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-500"
        />
      </label>

      {/* Type-specific fields */}
      {fields.map((field) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">{field.label}</span>
          {field.type === 'textarea' ? (
            <textarea
              value={cfg[field.key] ?? ''}
              onChange={(e) => handleField(field.key, e.target.value)}
              rows={4}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-500"
            />
          ) : field.type === 'select' && field.options ? (
            <select
              value={cfg[field.key] ?? ''}
              onChange={(e) => handleField(field.key, e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-500"
            >
              <option value="">— select —</option>
              {field.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={cfg[field.key] ?? ''}
              onChange={(e) => handleField(field.key, e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-500"
            />
          )}
        </label>
      ))}

      {fields.length === 0 && <p className="text-[11px] text-zinc-600">No configurable fields.</p>}
    </aside>
  );
}
