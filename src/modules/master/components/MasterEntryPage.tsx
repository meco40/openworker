'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import MasterFaceCanvas from './MasterFaceCanvasThree';
import { useGrokVoiceAgent } from '../hooks/useGrokVoiceAgent';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MasterEntryPageProps {
  onEnterDashboard: () => void;
  personaId?: string;
  workspaceId?: string;
}

// ─── Status label map ─────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  idle: 'Ready — press the mic to speak',
  listening: 'Listening…',
  thinking: 'Processing your request…',
  speaking: 'Responding…',
  error: 'Something went wrong',
  unsupported: 'Voice not supported in this browser',
};

// ─── Wave bars (decorative, shown when speaking) ──────────────────────────────

function SpeakingWave({ amplitude }: { amplitude: number }) {
  const bars = 12;
  return (
    <div className="flex items-center justify-center gap-[3px]" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const height = 6 + amplitude * 28 * (0.4 + 0.6 * Math.sin((i / bars) * Math.PI));
        return (
          <div
            key={i}
            className="rounded-full bg-cyan-400/70 transition-all duration-75"
            style={{
              width: 3,
              height: `${height}px`,
            }}
          />
        );
      })}
    </div>
  );
}

// ─── Mic button ───────────────────────────────────────────────────────────────

function MicButton({
  status,
  onStart,
  onStop,
}: {
  status: string;
  onStart: () => void;
  onStop: () => void;
}) {
  const isListening = status === 'listening';
  const isDisabled = status === 'thinking' || status === 'speaking';

  return (
    <button
      type="button"
      aria-label={isListening ? 'Stop listening' : 'Start voice input'}
      disabled={isDisabled}
      onClick={isListening ? onStop : onStart}
      className={[
        'relative flex h-16 w-16 items-center justify-center rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
        isDisabled
          ? 'cursor-not-allowed opacity-40'
          : 'cursor-pointer hover:scale-105 active:scale-95',
        isListening
          ? 'bg-rose-500/90 shadow-[0_0_24px_6px_rgba(244,63,94,0.5)]'
          : 'bg-cyan-600/80 shadow-[0_0_20px_4px_rgba(6,182,212,0.35)]',
      ].join(' ')}
    >
      {/* Pulse ring when listening */}
      {isListening && (
        <>
          <span className="absolute inset-0 animate-ping rounded-full bg-rose-400/30" />
          <span className="absolute inset-[-10px] animate-[ping_1.5s_ease-in-out_infinite] rounded-full bg-rose-400/15" />
        </>
      )}

      {/* Thinking spinner */}
      {status === 'thinking' && (
        <span className="absolute inset-[-4px] animate-spin rounded-full border-2 border-transparent border-t-cyan-400/60" />
      )}

      {/* Icon */}
      {isListening ? (
        // Stop square
        <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      ) : (
        // Mic icon
        <svg
          className="h-7 w-7 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 2a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 10a7 7 0 0 1-14 0" />
          <line strokeLinecap="round" x1="12" y1="19" x2="12" y2="22" />
          <line strokeLinecap="round" x1="8" y1="22" x2="16" y2="22" />
        </svg>
      )}
    </button>
  );
}

// ─── Text input (fallback if STT not supported) ───────────────────────────────

function TextInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex w-full max-w-md gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) {
          onSubmit(value.trim());
          setValue('');
        }
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        placeholder="Type a message…"
        className="flex-1 rounded-xl border border-white/10 bg-white/8 px-4 py-2.5 text-sm text-white placeholder-white/30 backdrop-blur-sm transition-all focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/30 focus:outline-none disabled:opacity-40"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="rounded-xl bg-cyan-600/80 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-cyan-500/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}

// ─── Scrolling response panel ─────────────────────────────────────────────────

function ResponsePanel({
  transcript,
  aiResponse,
  status,
}: {
  transcript: string;
  aiResponse: string;
  status: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [aiResponse]);

  if (!transcript && !aiResponse) return null;

  return (
    <div className="scrollbar-thin scrollbar-thumb-white/10 max-h-40 w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 p-4 text-sm backdrop-blur-md">
      {transcript && (
        <div className="flex gap-2.5">
          <span className="mt-0.5 shrink-0 text-cyan-400">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 2a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 10a7 7 0 0 1-14 0" />
            </svg>
          </span>
          <p className="leading-relaxed text-white/80">{transcript}</p>
        </div>
      )}
      {aiResponse && (
        <div className="flex gap-2.5">
          <span className="mt-0.5 shrink-0">
            <svg
              className="h-4 w-4 text-indigo-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"
              />
            </svg>
          </span>
          <p className="leading-relaxed text-indigo-100">{aiResponse}</p>
        </div>
      )}
      {status === 'thinking' && (
        <div className="flex items-center gap-1.5 pl-6">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400 [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400 [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400 [animation-delay:300ms]" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MasterEntryPage({
  onEnterDashboard,
  personaId,
  workspaceId,
}: MasterEntryPageProps) {
  const voice = useGrokVoiceAgent({ personaId, workspaceId });
  const outputAudioStream = useMemo(
    () => ({ subscribe: voice.subscribeOutputAudio }),
    [voice.subscribeOutputAudio],
  );

  // animated subtitle ticker
  const [subtitleVisible, setSubtitleVisible] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setSubtitleVisible((v) => !v), 3200);
    return () => clearInterval(id);
  }, []);

  const statusLabel = STATUS_LABELS[voice.status] ?? 'Ready';

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden bg-[#071a46] px-4 py-8 select-none">
      {/* ── Connection badge (top-right) ─────────────────────────────────── */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-1.5 rounded-full border border-white/10 bg-cyan-950/35 px-2.5 py-1 text-[10px] backdrop-blur-sm">
        <span
          className={[
            'h-1.5 w-1.5 rounded-full transition-colors duration-500',
            voice.connected
              ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]'
              : 'bg-white/20',
          ].join(' ')}
        />
        <span className={voice.connected ? 'text-emerald-300/70' : 'text-white/25'}>
          {voice.connected ? 'Grok Live' : 'Nicht verbunden'}
        </span>
      </div>

      {/* ── Deep space ambient gradient ──────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 70% 60% at 50% 40%, rgba(26,56,120,0.82) 0%, rgba(8,25,78,0.92) 65%, rgba(7,26,70,0.98) 100%)',
        }}
      />

      {/* ── Top label ────────────────────────────────────────────────────── */}
      <p className="relative z-10 mb-2 text-xs font-semibold tracking-[0.25em] text-cyan-500/70 uppercase">
        OpenClaw Master Agent
      </p>

      {/* ── Particle face ────────────────────────────────────────────────── */}
      <div className="relative z-10 transition-all duration-500">
        <MasterFaceCanvas
          state={voice.faceState}
          amplitude={voice.amplitude}
          outputAudioStream={outputAudioStream}
          width={340}
          height={442}
        />

        {/* Speaking wave overlay */}
        {voice.status === 'speaking' && (
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2">
            <SpeakingWave amplitude={voice.amplitude} />
          </div>
        )}
      </div>

      {/* ── Status text ──────────────────────────────────────────────────── */}
      <div className="relative z-10 mt-4 h-5 text-center">
        <p
          className={[
            'text-sm font-medium transition-all duration-500',
            voice.status === 'listening'
              ? 'text-rose-300'
              : voice.status === 'thinking'
                ? 'animate-pulse text-cyan-300'
                : voice.status === 'speaking'
                  ? 'text-indigo-300'
                  : voice.status === 'error'
                    ? 'text-rose-400'
                    : 'text-white/40',
          ].join(' ')}
        >
          {statusLabel}
        </p>
      </div>

      {/* ── Transcript / response panel ───────────────────────────────────── */}
      <div className="relative z-10 mt-4 flex w-full justify-center">
        <ResponsePanel
          transcript={voice.transcript}
          aiResponse={voice.aiResponse}
          status={voice.status}
        />
      </div>

      {/* ── Error toast ───────────────────────────────────────────────────── */}
      {voice.error && (
        <div className="relative z-10 mt-3 w-full max-w-lg rounded-xl border border-rose-700/40 bg-rose-900/30 px-4 py-2.5 text-xs text-rose-300">
          {voice.error}
        </div>
      )}

      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="relative z-10 mt-6 flex flex-col items-center gap-4">
        {/* Mic button */}
        {voice.sttSupported ? (
          <div className="flex flex-col items-center gap-2">
            <MicButton
              status={voice.status}
              onStart={voice.startListening}
              onStop={voice.stopListening}
            />
            {voice.status === 'idle' && <p className="text-[11px] text-white/25">tap & speak</p>}
          </div>
        ) : (
          <TextInput
            onSubmit={voice.submitText}
            disabled={voice.status === 'thinking' || voice.status === 'speaking'}
          />
        )}

        {/* Text input shown below mic as alternative when STT is supported */}
        {voice.sttSupported && (
          <TextInput
            onSubmit={voice.submitText}
            disabled={
              voice.status === 'thinking' ||
              voice.status === 'speaking' ||
              voice.status === 'listening'
            }
          />
        )}

        {/* Replay button */}
        {voice.aiResponse && voice.status === 'idle' && (
          <button
            type="button"
            onClick={voice.replay}
            className="flex items-center gap-1.5 text-xs text-white/30 transition-colors hover:text-cyan-400/70"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Replay
          </button>
        )}
      </div>

      {/* ── Open Dashboard CTA ────────────────────────────────────────────── */}
      <div className="relative z-10 mt-8 flex flex-col items-center gap-2.5">
        <button
          type="button"
          onClick={onEnterDashboard}
          className="rounded-xl border border-white/10 bg-white/5 px-6 py-2.5 text-sm font-medium text-white/60 backdrop-blur-sm transition-all duration-200 hover:border-cyan-500/30 hover:bg-cyan-950/40 hover:text-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
        >
          Open Dashboard
        </button>
        <p
          className={[
            'text-[11px] text-white/20 transition-opacity duration-700',
            subtitleVisible ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
        >
          Full run control, metrics &amp; history
        </p>
      </div>

      {/* ── Browser support hint ──────────────────────────────────────────── */}
      {!voice.sttSupported && !voice.ttsSupported && (
        <p className="relative z-10 mt-4 text-center text-xs text-white/20">
          Voice features require a Chromium-based browser (Chrome, Edge).
        </p>
      )}
    </div>
  );
}
