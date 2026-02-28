'use client';

import React from 'react';
import type { CronRule } from '@/modules/cron/types';
import { RuleStatusBadge } from '@/modules/cron/components/CronStatusBadge';
import type { UseCronRulesResult } from '@/modules/cron/hooks/useCronRules';

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface CronRuleTableProps {
  rules: CronRule[];
  selectedRuleId: string | null;
  pendingRuleId: string | null;
  onSelectRule: UseCronRulesResult['actions']['selectRule'];
  onRunNow: UseCronRulesResult['actions']['runNow'];
  onToggleRule: UseCronRulesResult['actions']['toggleRule'];
  onStartEdit: UseCronRulesResult['actions']['startEdit'];
  onDeleteRule: UseCronRulesResult['actions']['deleteRule'];
  onOpenFlowBuilder: (ruleId: string) => void;
}

export const CronRuleTable: React.FC<CronRuleTableProps> = ({
  rules,
  selectedRuleId,
  pendingRuleId,
  onSelectRule,
  onRunNow,
  onToggleRule,
  onStartEdit,
  onDeleteRule,
  onOpenFlowBuilder,
}) => {
  if (!rules.length) {
    return (
      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="mb-3 text-4xl opacity-30">⏰</div>
        <p className="text-sm font-semibold text-zinc-400">No cron jobs yet</p>
        <p className="mt-1 text-xs text-zinc-600">
          Create your first rule or pick a template to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-950/60">
            <th className="px-4 py-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Name
            </th>
            <th className="px-4 py-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Schedule
            </th>
            <th className="px-4 py-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Timezone
            </th>
            <th className="px-4 py-3 text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Status
            </th>
            <th className="px-4 py-3 text-right text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const isSelected = selectedRuleId === rule.id;
            const isPending = pendingRuleId === rule.id;
            return (
              <tr
                key={rule.id}
                onClick={() => onSelectRule(rule.id)}
                className={`cursor-pointer border-b border-zinc-800/60 transition-colors ${
                  isSelected
                    ? 'bg-indigo-950/30 ring-1 ring-indigo-700/30 ring-inset'
                    : 'hover:bg-zinc-800/20'
                } ${isPending ? 'opacity-60' : ''}`}
              >
                <td className="px-4 py-3">
                  <div className="font-semibold text-zinc-100">{rule.name}</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    Next: {formatDateTime(rule.nextRunAt)}
                  </div>
                  {rule.consecutiveFailures > 0 && (
                    <div className="mt-0.5 text-[10px] font-bold text-amber-400">
                      {rule.consecutiveFailures} consecutive failure
                      {rule.consecutiveFailures !== 1 ? 's' : ''}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <code className="rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[11px] text-indigo-300">
                    {rule.cronExpression}
                  </code>
                </td>
                <td className="px-4 py-3 text-zinc-400">{rule.timezone}</td>
                <td className="px-4 py-3">
                  <RuleStatusBadge rule={rule} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1.5">
                    <ActionButton
                      label="Run"
                      title="Trigger a manual run now"
                      disabled={isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRunNow(rule.id);
                      }}
                      variant="default"
                    />
                    <ActionButton
                      label={rule.enabled ? 'Pause' : 'Enable'}
                      title={rule.enabled ? 'Pause this rule' : 'Enable this rule'}
                      disabled={isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onToggleRule(rule.id, !rule.enabled);
                      }}
                      variant="default"
                    />
                    <ActionButton
                      label="Flow"
                      title="Open flow builder"
                      disabled={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFlowBuilder(rule.id);
                      }}
                      variant="default"
                    />
                    <ActionButton
                      label="Edit"
                      title="Edit this rule"
                      disabled={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartEdit(rule);
                      }}
                      variant="default"
                    />
                    <ActionButton
                      label="Delete"
                      title="Delete this rule"
                      disabled={isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteRule(rule.id);
                      }}
                      variant="danger"
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ─── Action Button ────────────────────────────────────────────────────────────

interface ActionButtonProps {
  label: string;
  title: string;
  disabled: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant: 'default' | 'danger';
}

const ActionButton: React.FC<ActionButtonProps> = ({
  label,
  title,
  disabled,
  onClick,
  variant,
}) => {
  const base =
    'rounded border px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40';
  const variantClass =
    variant === 'danger'
      ? 'border-rose-700/50 text-rose-300 hover:bg-rose-900/30 hover:border-rose-600/60'
      : 'border-zinc-700/60 text-zinc-300 hover:bg-zinc-800 hover:border-zinc-600';

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${variantClass}`}
    >
      {label}
    </button>
  );
};
