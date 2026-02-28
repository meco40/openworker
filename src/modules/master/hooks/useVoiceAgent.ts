'use client';

/**
 * useVoiceAgent
 *
 * Handles the full voice loop for the Master entry page:
 *   1. Microphone → SpeechRecognition → transcript
 *   2. Transcript → /api/master/runs (objective) → polling for result
 *   3. Result text → SpeechSynthesis (speak aloud)
 *   4. AudioContext AnalyserNode → live amplitude for face animation
 *
 * Browser support: Chromium-based browsers have the best Web Speech API support.
 * Firefox falls back to text-only mode gracefully.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FaceState } from '../components/MasterFaceCanvas';
import { createRun, fetchRunDetail } from '../api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceAgentStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'unsupported';

export interface UseVoiceAgentOptions {
  /** Pre-selected persona ID (optional; defaults to empty → server picks default) */
  personaId?: string;
  /** Pre-selected workspace ID (optional) */
  workspaceId?: string;
  /** Called when status changes, useful for external logging */
  onStatusChange?: (status: VoiceAgentStatus) => void;
}

export interface UseVoiceAgentResult {
  status: VoiceAgentStatus;
  faceState: FaceState;
  /** 0–1 audio amplitude, for face animation */
  amplitude: number;
  /** What the user said (current or last transcript) */
  transcript: string;
  /** What the AI responded (current or last response) */
  aiResponse: string;
  /** Any error message */
  error: string | null;
  /** Whether the browser supports STT */
  sttSupported: boolean;
  /** Whether the browser supports TTS */
  ttsSupported: boolean;
  /** Start listening for user speech */
  startListening: () => void;
  /** Stop listening immediately */
  stopListening: () => void;
  /** Cancel any in-flight request or speech */
  cancel: () => void;
  /** Directly submit a text message (bypasses STT) */
  submitText: (text: string) => Promise<void>;
  /** Skip TTS and re-speak the current AI response */
  replay: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set([
  'ANALYZING',
  'PLANNING',
  'DELEGATING',
  'EXECUTING',
  'VERIFYING',
  'REFINING',
  'AWAITING_APPROVAL',
]);

const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_ATTEMPTS = 80; // 2 minutes

async function pollUntilDone(
  runId: string,
  personaId: string,
  workspaceId: string,
  signal: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const detail = await fetchRunDetail(runId, personaId, workspaceId);
    if (!detail) continue;

    const { status, resultBundle, lastError } = detail.run;

    if (status === 'COMPLETED') {
      if (resultBundle) {
        try {
          const parsed = JSON.parse(resultBundle) as Record<string, unknown>;
          // Try common response patterns
          const msg =
            (parsed.summary as string) ??
            (parsed.result as string) ??
            (parsed.message as string) ??
            (parsed.output as string) ??
            JSON.stringify(parsed, null, 2);
          return msg;
        } catch {
          return resultBundle;
        }
      }
      return 'Task completed successfully.';
    }

    if (status === 'FAILED') {
      throw new Error(lastError ?? 'Run failed without an error message.');
    }

    if (status === 'CANCELLED') {
      throw new DOMException('Cancelled', 'AbortError');
    }

    if (!ACTIVE_STATUSES.has(status)) {
      // Unknown terminal
      return `Run finished with status: ${status}`;
    }
  }
  throw new Error('Timed out waiting for master run to complete.');
}

// ─── SpeechSynthesis helpers ──────────────────────────────────────────────────

function getBestVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined') return null;
  const voices = window.speechSynthesis.getVoices();
  // Prefer a natural-sounding English voice
  const priorities = ['Google UK English Female', 'Samantha', 'Karen', 'Microsoft Zira'];
  for (const name of priorities) {
    const v = voices.find((v) => v.name === name);
    if (v) return v;
  }
  return voices.find((v) => v.lang.startsWith('en')) ?? voices[0] ?? null;
}

// ─── Main hook ────────────────────────────────────────────────────────────────

export function useVoiceAgent({
  personaId = '',
  workspaceId = '',
  onStatusChange,
}: UseVoiceAgentOptions = {}): UseVoiceAgentResult {
  const [status, setStatusState] = useState<VoiceAgentStatus>('idle');
  const [amplitude, setAmplitude] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [error, setError] = useState<string | null>(null);

  // detect support
  const sttSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // refs for imperative access inside callbacks
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const ampRafRef = useRef<number>(0);
  const statusRef = useRef<VoiceAgentStatus>('idle');
  const aiResponseRef = useRef('');

  const setStatus = useCallback(
    (s: VoiceAgentStatus) => {
      statusRef.current = s;
      setStatusState(s);
      onStatusChange?.(s);
    },
    [onStatusChange],
  );

  // ── Amplitude analysis loop ──────────────────────────────────────────────
  const startAmplitudeLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      setAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 5));
      ampRafRef.current = requestAnimationFrame(tick);
    };
    ampRafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopAmplitudeLoop = useCallback(() => {
    cancelAnimationFrame(ampRafRef.current);
    setAmplitude(0);
  }, []);

  // ── Mic setup / teardown ─────────────────────────────────────────────────
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      startAmplitudeLoop();
    } catch {
      // mic permission denied – graceful degradation
    }
  }, [startAmplitudeLoop]);

  const stopMic = useCallback(() => {
    stopAmplitudeLoop();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, [stopAmplitudeLoop]);

  // ── TTS ──────────────────────────────────────────────────────────────────
  const speak = useCallback(
    (text: string): Promise<void> =>
      new Promise((resolve) => {
        if (!ttsSupported) {
          resolve();
          return;
        }
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.voice = getBestVoice();
        utter.rate = 0.95;
        utter.pitch = 1.05;
        utter.volume = 1;
        utteranceRef.current = utter;

        // Fake amplitude with oscillation during speech
        let fakeTick: ReturnType<typeof setInterval> | null = null;
        utter.onstart = () => {
          fakeTick = setInterval(() => {
            setAmplitude(0.3 + Math.random() * 0.6);
          }, 80);
        };
        utter.onend = () => {
          if (fakeTick) clearInterval(fakeTick);
          setAmplitude(0);
          resolve();
        };
        utter.onerror = () => {
          if (fakeTick) clearInterval(fakeTick);
          setAmplitude(0);
          resolve(); // resolve so we don't hang
        };

        // Chrome bug: long texts stop speaking. Workaround: chunk at sentences.
        if (text.length > 250) {
          const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
          window.speechSynthesis.cancel();
          sentences.forEach((s) => {
            const u = new SpeechSynthesisUtterance(s.trim());
            u.voice = getBestVoice();
            u.rate = utter.rate;
            u.pitch = utter.pitch;
            window.speechSynthesis.speak(u);
          });
          // Resolve when last chunk ends
          const last = new SpeechSynthesisUtterance('');
          last.onstart = () => {
            if (fakeTick) clearInterval(fakeTick);
            setAmplitude(0);
            resolve();
          };
          window.speechSynthesis.speak(last);
        } else {
          window.speechSynthesis.speak(utter);
        }
      }),
    [ttsSupported],
  );

  // ── Core submit flow ──────────────────────────────────────────────────────
  const submitText = useCallback(
    async (text: string) => {
      if (statusRef.current === 'thinking' || statusRef.current === 'speaking') return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setError(null);
      setTranscript(text);
      setStatus('thinking');

      try {
        const run = await createRun({
          title: text.slice(0, 80),
          contract: text,
          personaId,
          workspaceId,
        });

        const result = await pollUntilDone(run.id, personaId, workspaceId, ac.signal);

        if (ac.signal.aborted) return;

        aiResponseRef.current = result;
        setAiResponse(result);
        setStatus('speaking');

        await speak(result);

        if (!ac.signal.aborted) {
          setStatus('idle');
        }
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') {
          setStatus('idle');
          return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setError(msg);
        setStatus('error');
      }
    },
    [personaId, workspaceId, setStatus, speak],
  );

  // ── Start listening ──────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!sttSupported) {
      setStatus('unsupported');
      return;
    }
    if (statusRef.current === 'listening') return;

    // Cancel ongoing speech
    window.speechSynthesis?.cancel?.();
    abortRef.current?.abort();

    setError(null);
    setTranscript('');
    setStatus('listening');

    const SR: SpeechRecognitionConstructor | undefined =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;

    if (!SR) {
      setStatus('unsupported');
      return;
    }

    const rec = new SR();
    recognitionRef.current = rec;
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      setTranscript(final || interim);
      if (final) {
        stopMic();
        void submitText(final.trim());
      }
    };

    rec.onerror = (event) => {
      stopMic();
      if (event.error === 'aborted' || event.error === 'no-speech') {
        setStatus('idle');
      } else {
        setError(`Speech recognition error: ${event.error}`);
        setStatus('error');
      }
    };

    rec.onend = () => {
      if (statusRef.current === 'listening') {
        setStatus('idle');
      }
      stopMic();
    };

    void startMic();
    rec.start();
  }, [sttSupported, setStatus, startMic, stopMic, submitText]);

  // ── Stop listening ────────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopMic();
    if (statusRef.current === 'listening') {
      setStatus('idle');
    }
  }, [setStatus, stopMic]);

  // ── Cancel ────────────────────────────────────────────────────────────────
  const cancel = useCallback(() => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    window.speechSynthesis?.cancel?.();
    abortRef.current?.abort();
    stopMic();
    setStatus('idle');
    setAmplitude(0);
  }, [setStatus, stopMic]);

  // ── Replay ───────────────────────────────────────────────────────────────
  const replay = useCallback(() => {
    const text = aiResponseRef.current;
    if (!text) return;
    setStatus('speaking');
    void speak(text).then(() => {
      if (statusRef.current === 'speaking') setStatus('idle');
    });
  }, [setStatus, speak]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derive face state ─────────────────────────────────────────────────────
  const faceState: FaceState =
    status === 'listening'
      ? 'listening'
      : status === 'thinking'
        ? 'thinking'
        : status === 'speaking'
          ? 'speaking'
          : 'idle';

  return {
    status,
    faceState,
    amplitude,
    transcript,
    aiResponse,
    error,
    sttSupported,
    ttsSupported,
    startListening,
    stopListening,
    cancel,
    submitText,
    replay,
  };
}
