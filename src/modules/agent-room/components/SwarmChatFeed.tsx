'use client';

/**
 * SwarmChatFeed — Discord-style chat feed for the Agent Room.
 *
 * Renders per-agent message bubbles with emoji avatars, phase dividers,
 * operator messages, and a pulsing "thinking" indicator while streaming.
 */

import React, { useEffect, useRef } from 'react';
import type { SwarmMessage } from '@/modules/agent-room/hooks/useSwarmMessages';

interface SwarmChatFeedProps {
  messages: SwarmMessage[];
  className?: string;
}

/** Deterministic pastel colour per persona ID */
function personaColor(personaId: string | null): string {
  if (!personaId) return '#6b7280';
  const palette = [
    '#6366f1',
    '#8b5cf6',
    '#ec4899',
    '#f59e0b',
    '#10b981',
    '#3b82f6',
    '#ef4444',
    '#14b8a6',
  ];
  let hash = 0;
  for (let i = 0; i < personaId.length; i++) {
    hash = (hash * 31 + personaId.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function PhaseDivider({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3 px-2">
      <div className="h-px flex-1 bg-(--border)" />
      <span className="rounded border border-(--border) px-2 py-0.5 text-xs font-semibold tracking-widest text-(--muted) uppercase select-none">
        {label}
      </span>
      <div className="h-px flex-1 bg-(--border)" />
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="ml-1 inline-flex items-center gap-0.5" aria-label="thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current opacity-60"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
        />
      ))}
    </span>
  );
}

/** Strip swarm control directives that leak into streamed text */
function stripDirectives(text: string): string {
  return text
    .replace(/\[VOTE:UP\]|\[VOTE:DOWN\]/gi, '')
    .replace(/\[CHANGE_PHASE:[^\]]+\]/gi, '')
    .trim();
}

function AgentBubble({ message }: { message: SwarmMessage }) {
  const color = personaColor(message.personaId);
  return (
    <div className="group flex items-start gap-2.5 rounded px-3 py-1.5 hover:bg-(--hover)">
      {/* Avatar */}
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold select-none"
        style={{ backgroundColor: `${color}22`, border: `1.5px solid ${color}44`, color }}
        title={message.personaName}
      >
        {message.personaEmoji}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold" style={{ color }}>
            {message.personaName}
          </span>
          <span className="text-[10px] leading-none text-(--muted) opacity-0 transition-opacity group-hover:opacity-100">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed wrap-break-word whitespace-pre-wrap text-(--foreground)">
          {stripDirectives(message.content) || ' '}
          {message.isStreaming && <ThinkingDots />}
        </p>
      </div>
    </div>
  );
}

function OperatorBubble({ message }: { message: SwarmMessage }) {
  return (
    <div className="group flex items-start gap-2.5 rounded px-3 py-1.5 hover:bg-(--hover)">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--accent) text-sm font-bold text-(--accent-foreground) select-none">
        {message.personaEmoji}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-(--accent)">{message.personaName}</span>
          <span className="text-[10px] leading-none text-(--muted) opacity-0 transition-opacity group-hover:opacity-100">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed wrap-break-word whitespace-pre-wrap text-(--foreground)">
          {message.content}
        </p>
      </div>
    </div>
  );
}

export function SwarmChatFeed({ messages, className = '' }: SwarmChatFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when new messages arrive, unless user has scrolled up
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div
        className={`flex h-full flex-col items-center justify-center text-(--muted) select-none ${className}`}
      >
        <span className="mb-2 text-3xl">💬</span>
        <span className="text-sm">The swarm hasn&apos;t started yet.</span>
        <span className="mt-1 text-xs">Deploy to watch agents discuss.</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`flex flex-col overflow-y-auto scroll-smooth py-2 ${className}`}
    >
      {messages.map((msg) => {
        if (msg.kind === 'phase-divider') {
          return <PhaseDivider key={msg.id} label={msg.content} />;
        }
        if (msg.kind === 'operator') {
          return <OperatorBubble key={msg.id} message={msg} />;
        }
        return <AgentBubble key={msg.id} message={msg} />;
      })}
      <div ref={bottomRef} />
    </div>
  );
}
