'use client';

/**
 * useGrokVoiceAgent
 *
 * Full-duplex voice loop powered by the xAI Grok Realtime API.
 *
 * Flow:
 *   1. Fetch ephemeral token from /api/master/voice-session (server holds API key)
 *   2. Open WebSocket to wss://api.x.ai/v1/realtime via ephemeral token subprotocol
 *   3. Mic -> getUserMedia -> ScriptProcessor -> downsample -> PCM16 base64 -> WS append
 *   4. Realtime output audio deltas are emitted as stream events for the avatar engine
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FaceState } from '../components/MasterFaceCanvas';
import type {
  MasterAvatarAudioChunkEvent,
  MasterAvatarAudioEvent,
  MasterAvatarAudioListener,
} from '../types';

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
  subscribeOutputAudio: (listener: MasterAvatarAudioListener) => () => void;
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

function pcm16Rms(chunk: Int16Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const normalized = chunk[i] / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / chunk.length);
}

function cloneOutputEvent(event: MasterAvatarAudioEvent): MasterAvatarAudioEvent {
  if (event.type !== 'chunk') {
    return { ...event };
  }
  return {
    ...event,
    pcm16: new Int16Array(event.pcm16),
  } as MasterAvatarAudioChunkEvent;
}

function createTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ampRafRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);
  const connectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const autoDisconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(false);
  const unmountedRef = useRef(false);
  const currentTurnIdRef = useRef<string | null>(null);

  const outputAudioListenersRef = useRef<Set<MasterAvatarAudioListener>>(new Set());
  const lastOutputAudioEventsRef = useRef<MasterAvatarAudioEvent[]>([]);
  const replayTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Stable setter that also updates ref and fires callback
  const setStatus = useCallback(
    (s: VoiceAgentStatus) => {
      statusRef.current = s;
      setStatusState(s);
      onStatusChange?.(s);
    },
    [onStatusChange],
  );

  const broadcastOutputAudio = useCallback((event: MasterAvatarAudioEvent) => {
    const listeners = outputAudioListenersRef.current;
    if (listeners.size === 0) return;
    for (const listener of listeners) {
      listener(event);
    }
  }, []);

  const pushOutputAudioEvent = useCallback(
    (event: MasterAvatarAudioEvent, record: boolean) => {
      const cloned = cloneOutputEvent(event);
      if (record) {
        lastOutputAudioEventsRef.current.push(cloned);
      }
      broadcastOutputAudio(cloned);
    },
    [broadcastOutputAudio],
  );

  // ── Amplitude loop for microphone input ──────────────────────────────────

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

  const clearReplayTimers = useCallback(() => {
    replayTimersRef.current.forEach((timer) => clearTimeout(timer));
    replayTimersRef.current = [];
  }, []);

  const clearAutoDisconnectTimer = useCallback(() => {
    if (autoDisconnectTimerRef.current) {
      clearTimeout(autoDisconnectTimerRef.current);
      autoDisconnectTimerRef.current = null;
    }
  }, []);

  const disconnectRealtimeSession = useCallback(
    (options?: { stopMic?: boolean; keepStatus?: boolean }) => {
      clearAutoDisconnectTimer();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      shouldReconnectRef.current = false;
      reconnectCountRef.current = 0;

      if (options?.stopMic !== false) {
        stopMic();
      }

      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }

      if (!unmountedRef.current) {
        setConnected(false);
        if (!options?.keepStatus && statusRef.current !== 'error') {
          setStatus('idle');
        }
        setAmplitude(0);
      }
    },
    [clearAutoDisconnectTimer, setStatus, stopMic],
  );

  const scheduleAutoDisconnectAfterTurn = useCallback(() => {
    clearAutoDisconnectTimer();
    autoDisconnectTimerRef.current = setTimeout(() => {
      if (unmountedRef.current) return;
      disconnectRealtimeSession();
    }, 200);
  }, [clearAutoDisconnectTimer, disconnectRealtimeSession]);

  // ── WebSocket connect ─────────────────────────────────────────────────────

  const connectRef = useRef<(() => Promise<WebSocket>) | null>(null);

  const connect = useCallback((): Promise<WebSocket> => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return Promise.resolve(wsRef.current);
    }

    if (connectPromiseRef.current) {
      return connectPromiseRef.current;
    }

    if (unmountedRef.current) {
      return Promise.reject(new Error('Voice hook unmounted'));
    }

    shouldReconnectRef.current = true;

    const connectPromise = fetch('/api/master/voice-session')
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
      .then(
        ({ token, voice }) =>
          new Promise<WebSocket>((resolve, reject) => {
            if (unmountedRef.current) {
              reject(new Error('Voice hook unmounted'));
              return;
            }

            const ws = new WebSocket(GROK_WS_URL, [`xai-client-secret.${token}`]);
            wsRef.current = ws;
            let opened = false;

            ws.onopen = () => {
              if (unmountedRef.current) return;
              opened = true;
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
              resolve(ws);
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
                  setTranscript('');
                  setAiResponse('');
                  setStatus('listening');
                  break;

                case 'response.created': {
                  clearAutoDisconnectTimer();
                  currentTurnIdRef.current = createTurnId();
                  lastOutputAudioEventsRef.current = [];
                  pushOutputAudioEvent(
                    {
                      type: 'start',
                      turnId: currentTurnIdRef.current,
                      at: performance.now(),
                      sampleRate: OUTPUT_SAMPLE_RATE,
                    },
                    true,
                  );
                  setStatus('thinking');
                  break;
                }

                case 'response.output_audio.delta': {
                  const delta = data.delta as string | undefined;
                  if (!delta) break;
                  if (!currentTurnIdRef.current) {
                    currentTurnIdRef.current = createTurnId();
                    lastOutputAudioEventsRef.current = [];
                    pushOutputAudioEvent(
                      {
                        type: 'start',
                        turnId: currentTurnIdRef.current,
                        at: performance.now(),
                        sampleRate: OUTPUT_SAMPLE_RATE,
                      },
                      true,
                    );
                  }
                  const pcm16 = base64ToInt16(delta);
                  pushOutputAudioEvent(
                    {
                      type: 'chunk',
                      turnId: currentTurnIdRef.current,
                      at: performance.now(),
                      sampleRate: OUTPUT_SAMPLE_RATE,
                      pcm16,
                    },
                    true,
                  );
                  setStatus('speaking');
                  setAmplitude(Math.min(1, pcm16Rms(pcm16) * 5));
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

                case 'response.output_audio.done': {
                  if (currentTurnIdRef.current) {
                    pushOutputAudioEvent(
                      {
                        type: 'end',
                        turnId: currentTurnIdRef.current,
                        at: performance.now(),
                        sampleRate: OUTPUT_SAMPLE_RATE,
                      },
                      true,
                    );
                    currentTurnIdRef.current = null;
                  }
                  scheduleAutoDisconnectAfterTurn();
                  break;
                }

                case 'response.done':
                  if (currentTurnIdRef.current) {
                    pushOutputAudioEvent(
                      {
                        type: 'end',
                        turnId: currentTurnIdRef.current,
                        at: performance.now(),
                        sampleRate: OUTPUT_SAMPLE_RATE,
                      },
                      true,
                    );
                    currentTurnIdRef.current = null;
                  }
                  scheduleAutoDisconnectAfterTurn();
                  break;

                default:
                  break;
              }
            };

            ws.onerror = () => {
              if (unmountedRef.current) return;
              setConnected(false);
              setError('Voice connection error');
              if (currentTurnIdRef.current) {
                pushOutputAudioEvent(
                  {
                    type: 'error',
                    turnId: currentTurnIdRef.current,
                    at: performance.now(),
                    sampleRate: OUTPUT_SAMPLE_RATE,
                    message: 'Voice connection error',
                  },
                  true,
                );
              }
              if (!opened) {
                reject(new Error('Voice connection error'));
              }
            };

            ws.onclose = () => {
              if (unmountedRef.current) return;
              setConnected(false);
              wsRef.current = null;
              if (currentTurnIdRef.current) {
                pushOutputAudioEvent(
                  {
                    type: 'error',
                    turnId: currentTurnIdRef.current,
                    at: performance.now(),
                    sampleRate: OUTPUT_SAMPLE_RATE,
                    message: 'Voice connection closed',
                  },
                  true,
                );
                currentTurnIdRef.current = null;
              }
              // Attempt one reconnect after 3 s
              if (shouldReconnectRef.current && reconnectCountRef.current < 1) {
                reconnectCountRef.current++;
                reconnectTimerRef.current = setTimeout(() => {
                  void connectRef.current?.();
                }, 3_000);
              } else if (shouldReconnectRef.current) {
                setError('Voice connection lost. Please reload.');
              }
              if (!opened) {
                reject(new Error('Voice connection closed'));
              }
            };
          }),
      )
      .catch((err: unknown) => {
        if (unmountedRef.current) throw err;
        const msg = err instanceof Error ? err.message : 'Failed to connect';
        setError(msg);
        setStatus('error');
        throw err;
      })
      .finally(() => {
        connectPromiseRef.current = null;
      });
    connectPromiseRef.current = connectPromise;
    return connectPromise;
  }, [clearAutoDisconnectTimer, pushOutputAudioEvent, scheduleAutoDisconnectAfterTurn, setStatus]);

  // Keep connectRef up-to-date
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    unmountedRef.current = false;
    const outputAudioListeners = outputAudioListenersRef.current;
    return () => {
      unmountedRef.current = true;
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearReplayTimers();
      disconnectRealtimeSession({ stopMic: true, keepStatus: true });
      outputAudioListeners.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── startListening ────────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    if (statusRef.current === 'listening') return;

    setError(null);
    clearAutoDisconnectTimer();
    try {
      await connect();
    } catch {
      setError('Voice service not connected');
      return;
    }
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

        // ScriptProcessor for raw PCM -> downsample -> send to xAI
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
  }, [clearAutoDisconnectTimer, connect, setStatus, startAmplitudeLoop]);

  // ── stopListening ─────────────────────────────────────────────────────────

  const stopListening = useCallback(() => {
    disconnectRealtimeSession({ stopMic: true });
  }, [disconnectRealtimeSession]);

  // ── submitText ────────────────────────────────────────────────────────────

  const submitText = useCallback(
    async (text: string): Promise<void> => {
      if (statusRef.current === 'thinking' || statusRef.current === 'speaking') return;

      setError(null);
      clearAutoDisconnectTimer();
      let ws: WebSocket;
      try {
        ws = await connect();
      } catch {
        setError('Voice service not connected');
        return;
      }
      setTranscript(text);
      setAiResponse('');
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
    [clearAutoDisconnectTimer, connect, setStatus],
  );

  // ── subscribeOutputAudio ─────────────────────────────────────────────────

  const subscribeOutputAudio = useCallback((listener: MasterAvatarAudioListener): (() => void) => {
    outputAudioListenersRef.current.add(listener);
    return () => {
      outputAudioListenersRef.current.delete(listener);
    };
  }, []);

  // ── cancel ────────────────────────────────────────────────────────────────

  const cancel = useCallback(() => {
    clearReplayTimers();
    disconnectRealtimeSession({ stopMic: true });
    if (currentTurnIdRef.current) {
      pushOutputAudioEvent(
        {
          type: 'cancel',
          turnId: currentTurnIdRef.current,
          at: performance.now(),
          sampleRate: OUTPUT_SAMPLE_RATE,
        },
        true,
      );
      currentTurnIdRef.current = null;
    }
  }, [clearReplayTimers, disconnectRealtimeSession, pushOutputAudioEvent]);

  // ── replay ────────────────────────────────────────────────────────────────

  const replay = useCallback(() => {
    const events = lastOutputAudioEventsRef.current.map(cloneOutputEvent);
    if (events.length === 0) return;

    clearReplayTimers();
    setStatus('speaking');

    const startAt = events[0].at;
    for (const event of events) {
      const timer = setTimeout(
        () => {
          broadcastOutputAudio(cloneOutputEvent(event));
          if (event.type === 'chunk') {
            setAmplitude(Math.min(1, pcm16Rms(event.pcm16) * 5));
          }
        },
        Math.max(0, Math.round(event.at - startAt)),
      );
      replayTimersRef.current.push(timer);
    }

    const endOffset = Math.max(0, Math.round(events[events.length - 1].at - startAt)) + 160;
    const endTimer = setTimeout(() => {
      if (!unmountedRef.current && statusRef.current === 'speaking') {
        setStatus('idle');
      }
      setAmplitude(0);
    }, endOffset);
    replayTimersRef.current.push(endTimer);
  }, [broadcastOutputAudio, clearReplayTimers, setStatus]);

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
    subscribeOutputAudio,
  };
}
