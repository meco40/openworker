'use client';

/**
 * useGrokVoiceAgent
 *
 * Full-duplex voice loop powered by the xAI Grok Realtime API.
 *
 * Flow:
 *   1. Fetch ephemeral token from /api/master/voice-session (server holds API key)
 *   2. Open WebSocket to wss://api.x.ai/v1/realtime via ephemeral token subprotocol
 *   3. Mic → getUserMedia → ScriptProcessor → downsample → PCM16 base64 → WS append
 *   4. xAI server VAD detects speech boundaries automatically
 *   5. Response audio chunks (PCM16 base64) → collect → AudioBuffer → play
 *   6. AnalyserNode measures RMS during playback → amplitude → drives MasterFaceCanvas
 *
 * Drop-in replacement for useVoiceAgent — same return shape.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FaceState } from '../components/MasterFaceCanvas';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VoiceAgentStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'unsupported';

export interface UseGrokVoiceAgentOptions {
  personaId?: string;
  workspaceId?: string;
  onStatusChange?: (status: VoiceAgentStatus) => void;
}

export interface UseGrokVoiceAgentResult {
  status: VoiceAgentStatus;
  faceState: FaceState;
  amplitude: number;
  transcript: string;
  aiResponse: string;
  error: string | null;
  sttSupported: boolean;
  ttsSupported: boolean;
  connected: boolean;
  startListening: () => void;
  stopListening: () => void;
  cancel: () => void;
  submitText: (text: string) => Promise<void>;
  replay: () => void;
}

// ─── Module-level constants ───────────────────────────────────────────────────

const GROK_WS_URL = 'wss://api.x.ai/v1/realtime';
const OUTPUT_SAMPLE_RATE = 16_000;
const INPUT_SAMPLE_RATE = 16_000;

// ─── Pure helpers (no React state) ───────────────────────────────────────────

function int16ToBase64(arr: Int16Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function float32ToInt16Downsampled(
  float32: Float32Array,
  nativeSR: number,
  targetSR: number,
): Int16Array {
  const ratio = nativeSR / targetSR;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const sample = float32[Math.floor(i * ratio)];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGrokVoiceAgent({
  onStatusChange,
}: UseGrokVoiceAgentOptions = {}): UseGrokVoiceAgentResult {
  const [status, setStatusState] = useState<VoiceAgentStatus>('idle');
  const [amplitude, setAmplitude] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const statusRef = useRef<VoiceAgentStatus>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const playAnalyserRef = useRef<AnalyserNode | null>(null);
  const ampRafRef = useRef<number>(0);
  const audioChunksRef = useRef<Int16Array[]>([]);
  const lastAudioBufferRef = useRef<AudioBuffer | null>(null);
  const playSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);
  const unmountedRef = useRef(false);

  // Stable setter that also updates ref and fires callback
  const setStatus = useCallback(
    (s: VoiceAgentStatus) => {
      statusRef.current = s;
      setStatusState(s);
      onStatusChange?.(s);
    },
    [onStatusChange],
  );

  // ── Amplitude loop ────────────────────────────────────────────────────────

  const stopAmplitudeLoop = useCallback(() => {
    cancelAnimationFrame(ampRafRef.current);
    setAmplitude(0);
  }, []);

  const startAmplitudeLoop = useCallback(
    (analyser: AnalyserNode) => {
      stopAmplitudeLoop();
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
    },
    [stopAmplitudeLoop],
  );

  // ── Mic teardown ──────────────────────────────────────────────────────────

  const stopMic = useCallback(() => {
    stopAmplitudeLoop();
    processorRef.current?.disconnect();
    processorRef.current = null;
    micAnalyserRef.current?.disconnect();
    micAnalyserRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
  }, [stopAmplitudeLoop]);

  // ── Audio playback ────────────────────────────────────────────────────────

  const playCollectedChunks = useCallback(() => {
    const chunks = audioChunksRef.current;
    if (chunks.length === 0) {
      if (statusRef.current === 'speaking') setStatus('idle');
      return;
    }

    // Merge all Int16 chunks into one
    const totalLen = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Int16Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    // Convert to Float32
    const float32 = new Float32Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      float32[i] = merged[i] / 32768.0;
    }

    // Create/reuse playback AudioContext
    if (!playCtxRef.current || playCtxRef.current.state === 'closed') {
      playCtxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }
    const ctx = playCtxRef.current;

    const audioBuffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    audioBuffer.copyToChannel(float32, 0);
    lastAudioBufferRef.current = audioBuffer;

    // Connect source → analyser → destination
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    playAnalyserRef.current = analyser;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    playSourceRef.current = source;

    source.onended = () => {
      stopAmplitudeLoop();
      playAnalyserRef.current = null;
      if (!unmountedRef.current && statusRef.current === 'speaking') {
        setStatus('idle');
      }
    };

    source.start();
    startAmplitudeLoop(analyser);
  }, [setStatus, startAmplitudeLoop, stopAmplitudeLoop]);

  // ── WebSocket connect ─────────────────────────────────────────────────────

  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    fetch('/api/master/voice-session')
      .then(async (res) => {
        if (!res.ok) {
          let body: Record<string, unknown> = {};
          try {
            body = (await res.json()) as Record<string, unknown>;
          } catch {
            /* non-JSON error body */
          }
          throw new Error((body.error as string | undefined) ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ token: string; voice: string }>;
      })
      .then(({ token, voice }) => {
        if (unmountedRef.current) return;

        const ws = new WebSocket(GROK_WS_URL, [`xai-client-secret.${token}`]);
        wsRef.current = ws;

        ws.onopen = () => {
          if (unmountedRef.current) return;
          setConnected(true);
          reconnectCountRef.current = 0;
          setError(null);

          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                voice: voice ?? 'Ara',
                instructions:
                  'Du bist OpenClaw Master Agent — ein hochentwickelter KI-Assistent. Antworte präzise und hilfreich, bevorzugt auf Deutsch, außer der Nutzer spricht eine andere Sprache.',
                turn_detection: { type: 'server_vad' },
                audio: {
                  input: { format: { type: 'audio/pcm', rate: INPUT_SAMPLE_RATE } },
                  output: { format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE } },
                },
              },
            }),
          );
        };

        ws.onmessage = (event) => {
          if (unmountedRef.current) return;
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(event.data as string) as Record<string, unknown>;
          } catch {
            return;
          }

          const type = data.type as string;

          switch (type) {
            case 'input_audio_buffer.speech_started':
              audioChunksRef.current = [];
              setTranscript('');
              setAiResponse('');
              setStatus('listening');
              break;

            case 'response.created':
              setStatus('thinking');
              break;

            case 'response.output_audio.delta': {
              const delta = data.delta as string | undefined;
              if (delta) {
                audioChunksRef.current.push(base64ToInt16(delta));
                setStatus('speaking');
              }
              break;
            }

            case 'response.output_audio_transcript.delta': {
              const delta = data.delta as string | undefined;
              if (delta) setAiResponse((prev) => prev + delta);
              break;
            }

            case 'conversation.item.input_audio_transcription.completed': {
              const t = data.transcript as string | undefined;
              if (t) setTranscript(t);
              break;
            }

            case 'response.output_audio.done':
              playCollectedChunks();
              break;

            case 'response.done':
              // No audio was generated (text-only turn)
              if (
                audioChunksRef.current.length === 0 &&
                (statusRef.current === 'thinking' || statusRef.current === 'listening')
              ) {
                setStatus('idle');
              }
              break;

            default:
              break;
          }
        };

        ws.onerror = () => {
          if (unmountedRef.current) return;
          setConnected(false);
          setError('Voice connection error');
        };

        ws.onclose = () => {
          if (unmountedRef.current) return;
          setConnected(false);
          wsRef.current = null;
          // Attempt one reconnect after 3 s
          if (reconnectCountRef.current < 1) {
            reconnectCountRef.current++;
            reconnectTimerRef.current = setTimeout(() => {
              connectRef.current?.();
            }, 3_000);
          } else {
            setError('Voice connection lost. Please reload.');
          }
        };
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        const msg = err instanceof Error ? err.message : 'Failed to connect';
        setError(msg);
        setStatus('error');
      });
  }, [setStatus, playCollectedChunks]);

  // Keep connectRef up-to-date
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      stopMic();
      stopAmplitudeLoop();
      playSourceRef.current?.stop();
      playCtxRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── startListening ────────────────────────────────────────────────────────

  const startListening = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('Voice service not connected');
      return;
    }
    if (statusRef.current === 'listening') return;

    setError(null);
    setStatus('listening');

    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
      .then((stream) => {
        if (unmountedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;

        const ctx = new AudioContext();
        micCtxRef.current = ctx;

        const source = ctx.createMediaStreamSource(stream);

        // Analyser for live mic amplitude
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        micAnalyserRef.current = analyser;
        source.connect(analyser);

        // ScriptProcessor for raw PCM → downsample → send to xAI
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        processor.connect(ctx.destination);

        startAmplitudeLoop(analyser);

        processor.onaudioprocess = (e) => {
          if (statusRef.current !== 'listening') return;
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;

          const inputData = e.inputBuffer.getChannelData(0);
          const int16 = float32ToInt16Downsampled(inputData, ctx.sampleRate, INPUT_SAMPLE_RATE);
          ws.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: int16ToBase64(int16),
            }),
          );
        };
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Microphone access denied';
        setError(msg);
        setStatus('error');
      });
  }, [setStatus, startAmplitudeLoop]);

  // ── stopListening ─────────────────────────────────────────────────────────

  const stopListening = useCallback(() => {
    stopMic();
    if (statusRef.current === 'listening') setStatus('idle');
  }, [stopMic, setStatus]);

  // ── submitText ────────────────────────────────────────────────────────────

  const submitText = useCallback(
    async (text: string): Promise<void> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setError('Voice service not connected');
        return;
      }
      if (statusRef.current === 'thinking' || statusRef.current === 'speaking') return;

      setError(null);
      setTranscript(text);
      setAiResponse('');
      audioChunksRef.current = [];
      setStatus('thinking');

      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        }),
      );
      ws.send(JSON.stringify({ type: 'response.create' }));
    },
    [setStatus],
  );

  // ── cancel ────────────────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    stopMic();
    playSourceRef.current?.stop();
    playSourceRef.current = null;
    stopAmplitudeLoop();
    setStatus('idle');
  }, [stopMic, stopAmplitudeLoop, setStatus]);

  // ── replay ────────────────────────────────────────────────────────────────

  const replay = useCallback(() => {
    const buf = lastAudioBufferRef.current;
    if (!buf) return;

    if (!playCtxRef.current || playCtxRef.current.state === 'closed') {
      playCtxRef.current = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    }
    const ctx = playCtxRef.current;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    playAnalyserRef.current = analyser;

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    playSourceRef.current = source;

    setStatus('speaking');
    source.onended = () => {
      stopAmplitudeLoop();
      if (statusRef.current === 'speaking') setStatus('idle');
    };
    source.start();
    startAmplitudeLoop(analyser);
  }, [setStatus, startAmplitudeLoop, stopAmplitudeLoop]);

  // ── Derived state ─────────────────────────────────────────────────────────

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
    sttSupported: true,
    ttsSupported: true,
    connected,
    startListening,
    stopListening,
    cancel,
    submitText,
    replay,
  };
}
