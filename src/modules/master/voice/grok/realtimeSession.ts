import type { MutableRefObject } from 'react';
import {
  AUTO_DISCONNECT_DELAY_MS,
  DEFAULT_VOICE,
  GROK_WS_URL,
  INPUT_SAMPLE_RATE,
  MASTER_INSTRUCTIONS,
  MAX_RECONNECT_ATTEMPTS,
  OUTPUT_SAMPLE_RATE,
  RECONNECT_DELAY_MS,
} from './constants';
import { base64ToInt16 } from './audioCodec';
import type { RealtimeParsedEvent, VoiceAgentStatus } from './types';

export interface DisconnectOptions {
  stopMic?: boolean;
  keepStatus?: boolean;
}

export interface RealtimeSessionController {
  connect: () => Promise<WebSocket>;
  disconnect: (options?: DisconnectOptions) => void;
  clearAutoDisconnectTimer: () => void;
  scheduleAutoDisconnectAfterTurn: () => void;
  dispose: (options?: DisconnectOptions) => void;
  getSocket: () => WebSocket | null;
}

interface RealtimeSessionControllerInput {
  isUnmountedRef: MutableRefObject<boolean>;
  statusRef: MutableRefObject<VoiceAgentStatus>;
  setStatusRef: MutableRefObject<(status: VoiceAgentStatus) => void>;
  onRealtimeEventRef: MutableRefObject<(event: RealtimeParsedEvent) => void>;
  onSocketFaultRef: MutableRefObject<(message: string) => void>;
  setConnected: (connected: boolean) => void;
  setError: (message: string | null) => void;
  resetAmplitude: () => void;
  stopMicrophone: () => void;
}

function parseRealtimeEvent(data: Record<string, unknown>): RealtimeParsedEvent | null {
  const rawType = data.type;
  if (typeof rawType !== 'string') {
    return null;
  }

  switch (rawType) {
    case 'input_audio_buffer.speech_started':
      return { type: 'speech_started' };

    case 'response.created':
      return { type: 'response_created' };

    case 'response.output_audio.delta': {
      const delta = data.delta;
      if (typeof delta !== 'string' || delta.length === 0) {
        return null;
      }
      return {
        type: 'output_audio_delta',
        pcm16: base64ToInt16(delta),
      };
    }

    case 'response.output_audio_transcript.delta': {
      const delta = data.delta;
      if (typeof delta !== 'string' || delta.length === 0) {
        return null;
      }
      return {
        type: 'output_audio_transcript_delta',
        delta,
      };
    }

    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = data.transcript;
      if (typeof transcript !== 'string' || transcript.length === 0) {
        return null;
      }
      return {
        type: 'input_audio_transcription_completed',
        transcript,
      };
    }

    case 'response.output_audio.done':
      return { type: 'response_output_audio_done' };

    case 'response.done':
      return { type: 'response_done' };

    default:
      return null;
  }
}

export function createRealtimeSessionController(
  input: RealtimeSessionControllerInput,
): RealtimeSessionController {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectCount = 0;
  let connectPromise: Promise<WebSocket> | null = null;
  let autoDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldReconnect = false;

  const clearAutoDisconnectTimer = () => {
    if (autoDisconnectTimer) {
      clearTimeout(autoDisconnectTimer);
      autoDisconnectTimer = null;
    }
  };

  const disconnect = (options?: DisconnectOptions) => {
    clearAutoDisconnectTimer();

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    shouldReconnect = false;
    reconnectCount = 0;

    if (options?.stopMic !== false) {
      input.stopMicrophone();
    }

    const currentSocket = ws;
    ws = null;
    if (
      currentSocket &&
      (currentSocket.readyState === WebSocket.OPEN ||
        currentSocket.readyState === WebSocket.CONNECTING)
    ) {
      currentSocket.close();
    }

    if (!input.isUnmountedRef.current) {
      input.setConnected(false);
      if (!options?.keepStatus && input.statusRef.current !== 'error') {
        input.setStatusRef.current('idle');
      }
      input.resetAmplitude();
    }
  };

  const scheduleAutoDisconnectAfterTurn = () => {
    clearAutoDisconnectTimer();
    autoDisconnectTimer = setTimeout(() => {
      if (input.isUnmountedRef.current) return;
      disconnect();
    }, AUTO_DISCONNECT_DELAY_MS);
  };

  const connect = (): Promise<WebSocket> => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(ws);
    }

    if (connectPromise) {
      return connectPromise;
    }

    if (input.isUnmountedRef.current) {
      return Promise.reject(new Error('Voice hook unmounted'));
    }

    shouldReconnect = true;

    connectPromise = fetch('/api/master/voice-session')
      .then(async (res) => {
        if (!res.ok) {
          let body: Record<string, unknown> = {};
          try {
            body = (await res.json()) as Record<string, unknown>;
          } catch {
            // ignore non-JSON bodies
          }
          throw new Error((body.error as string | undefined) ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ token: string; voice: string }>;
      })
      .then(
        ({ token, voice }) =>
          new Promise<WebSocket>((resolve, reject) => {
            if (input.isUnmountedRef.current) {
              reject(new Error('Voice hook unmounted'));
              return;
            }

            const socket = new WebSocket(GROK_WS_URL, [`xai-client-secret.${token}`]);
            ws = socket;
            let opened = false;

            socket.onopen = () => {
              if (input.isUnmountedRef.current) return;

              opened = true;
              input.setConnected(true);
              reconnectCount = 0;
              input.setError(null);

              socket.send(
                JSON.stringify({
                  type: 'session.update',
                  session: {
                    voice: voice ?? DEFAULT_VOICE,
                    instructions: MASTER_INSTRUCTIONS,
                    turn_detection: { type: 'server_vad' },
                    audio: {
                      input: { format: { type: 'audio/pcm', rate: INPUT_SAMPLE_RATE } },
                      output: { format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE } },
                    },
                  },
                }),
              );

              resolve(socket);
            };

            socket.onmessage = (event) => {
              if (input.isUnmountedRef.current) return;

              let data: Record<string, unknown>;
              try {
                data = JSON.parse(event.data as string) as Record<string, unknown>;
              } catch {
                return;
              }

              const parsed = parseRealtimeEvent(data);
              if (parsed) {
                input.onRealtimeEventRef.current(parsed);
              }
            };

            socket.onerror = () => {
              if (input.isUnmountedRef.current) return;

              input.setConnected(false);
              input.setError('Voice connection error');
              input.onSocketFaultRef.current('Voice connection error');

              if (!opened) {
                reject(new Error('Voice connection error'));
              }
            };

            socket.onclose = () => {
              if (input.isUnmountedRef.current) return;

              input.setConnected(false);
              ws = null;
              input.onSocketFaultRef.current('Voice connection closed');

              if (shouldReconnect && reconnectCount < MAX_RECONNECT_ATTEMPTS) {
                reconnectCount++;
                reconnectTimer = setTimeout(() => {
                  void connect();
                }, RECONNECT_DELAY_MS);
              } else if (shouldReconnect) {
                input.setError('Voice connection lost. Please reload.');
              }

              if (!opened) {
                reject(new Error('Voice connection closed'));
              }
            };
          }),
      )
      .catch((err: unknown) => {
        if (input.isUnmountedRef.current) throw err;

        const message = err instanceof Error ? err.message : 'Failed to connect';
        input.setError(message);
        input.setStatusRef.current('error');
        throw err;
      })
      .finally(() => {
        connectPromise = null;
      });

    return connectPromise;
  };

  const dispose = (options?: DisconnectOptions) => {
    disconnect({ keepStatus: true, ...options });
  };

  return {
    connect,
    disconnect,
    clearAutoDisconnectTimer,
    scheduleAutoDisconnectAfterTurn,
    dispose,
    getSocket: () => ws,
  };
}
