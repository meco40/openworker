'use client';

/**
 * UserChatInput — Operator message input for the Agent Room.
 *
 * Supports @mention dropdown to tag a specific persona.
 * Enter = send, Shift+Enter = newline.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonaSummary } from '@/server/personas/personaTypes';

interface UserChatInputProps {
  onSend: (content: string, mentionedPersonaId?: string) => void;
  personas: PersonaSummary[];
  disabled?: boolean;
  placeholder?: string;
}

interface MentionState {
  active: boolean;
  query: string;
  startIndex: number;
}

export function UserChatInput({
  onSend,
  personas,
  disabled = false,
  placeholder = 'Guide the swarm… (@ to mention an agent)',
}: UserChatInputProps) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState>({
    active: false,
    query: '',
    startIndex: -1,
  });
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Personas filtered by current @mention query */
  const mentionMatches: PersonaSummary[] = mention.active
    ? personas.filter((p) => p.name.toLowerCase().startsWith(mention.query.toLowerCase()))
    : [];

  /** Reset mention state */
  const closeMention = useCallback(() => {
    setMention({ active: false, query: '', startIndex: -1 });
    setSelectedMentionIdx(0);
  }, []);

  /** Insert the persona name at the @mention position */
  const commitMention = useCallback(
    (persona: PersonaSummary) => {
      const before = text.slice(0, mention.startIndex);
      const after = text.slice(mention.startIndex + 1 + mention.query.length);
      const inserted = `@${persona.name} `;
      setText(before + inserted + after);
      closeMention();
      // Return focus to textarea after next paint
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [text, mention, closeMention],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);

      // Detect @ trigger
      const cursor = e.target.selectionStart ?? value.length;
      const textBeforeCursor = value.slice(0, cursor);
      const atIdx = textBeforeCursor.lastIndexOf('@');

      if (atIdx !== -1) {
        const fragment = textBeforeCursor.slice(atIdx + 1);
        // Only open if no space in the fragment (single word mention)
        if (!fragment.includes(' ')) {
          setMention({ active: true, query: fragment, startIndex: atIdx });
          setSelectedMentionIdx(0);
          return;
        }
      }
      closeMention();
    },
    [closeMention],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention.active && mentionMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedMentionIdx((i) => (i + 1) % mentionMatches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          commitMention(mentionMatches[selectedMentionIdx]);
          return;
        }
        if (e.key === 'Escape') {
          closeMention();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mention, mentionMatches, selectedMentionIdx, commitMention, closeMention, text],
  );

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;

    // Extract first @mentioned persona
    const mentionMatch = trimmed.match(/@([\w\s]+)/);
    let mentionedPersonaId: string | undefined;
    if (mentionMatch) {
      const mentionedName = mentionMatch[1].trim();
      const found = personas.find((p) => p.name.toLowerCase() === mentionedName.toLowerCase());
      mentionedPersonaId = found?.id;
    }

    onSend(trimmed, mentionedPersonaId);
    setText('');
    closeMention();
  }, [text, disabled, onSend, personas, closeMention]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [text]);

  return (
    <div className="relative flex flex-col">
      {/* @mention dropdown */}
      {mention.active && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-48 min-w-45 overflow-hidden overflow-y-auto rounded-lg border border-(--border) bg-(--card) shadow-lg">
          {mentionMatches.map((persona, idx) => (
            <button
              key={persona.id}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                idx === selectedMentionIdx
                  ? 'bg-(--accent) text-(--accent-foreground)'
                  : 'hover:bg-(--hover)'
              }`}
              onMouseEnter={() => setSelectedMentionIdx(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                commitMention(persona);
              }}
            >
              <span className="text-base leading-none">{persona.emoji}</span>
              <span className="font-medium">{persona.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div
        className={`flex items-end gap-2 rounded-xl border border-(--border) bg-(--card) px-3 py-2 transition-all ${
          disabled ? 'cursor-not-allowed opacity-50' : 'focus-within:border-(--accent)'
        }`}
      >
        <span className="pb-0.5 text-base leading-none select-none">👤</span>

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent text-sm leading-relaxed text-(--foreground) outline-none placeholder:text-(--muted) disabled:cursor-not-allowed"
          style={{ minHeight: '24px', maxHeight: '160px' }}
        />

        <button
          type="button"
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          aria-label="Send operator message"
          className="shrink-0 rounded-lg bg-(--accent) p-1.5 text-(--accent-foreground) transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M2 21L23 12 2 3v7l15 2-15 2v7z" />
          </svg>
        </button>
      </div>

      <p className="mt-1 pl-1 text-[10px] text-(--muted) select-none">
        Enter to send · Shift+Enter for newline · @name to mention
      </p>
    </div>
  );
}
