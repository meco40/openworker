'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MasterAvatarAudioEvent, MasterAvatarAudioListener } from '../../types';
import { createTurnId, pcm16Rms } from './audioCodec';
import { OUTPUT_SAMPLE_RATE } from './constants';
import { startMicrophone, stopMicrophone, type MicrophoneRuntimeRefs } from './microphone';
import { clearReplayTimers, pushOutputAudioEvent, replayOutputAudioEvents } from './outputAudioBus';
import { createRealtimeSessionController, type RealtimeSessionController } from './realtimeSession';
import type {
  RealtimeParsedEvent,
  UseGrokVoiceAgentOptions,
  UseGrokVoiceAgentResult,
  VoiceAgentStatus,
} from './types';

export type { UseGrokVoiceAgentOptions, UseGrokVoiceAgentResult, VoiceAgentStatus } from './types';

export function useGrokVoiceAgent({
  onStatusChange,
}: UseGrokVoiceAgentOptions = {}): UseGrokVoiceAgentResult {
  const [status, setStatusState] = useState<VoiceAgentStatus>('idle');
  const [amplitude, setAmplitude] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const statusRef = useRef<VoiceAgentStatus>('idle');
  const unmountedRef = useRef(false);
  const currentTurnIdRef = useRef<string | null>(null);

  const outputAudioListenersRef = useRef<Set<MasterAvatarAudioListener>>(new Set());
  const lastOutputAudioEventsRef = useRef<MasterAvatarAudioEvent[]>([]);
  const replayTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const micCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ampRafRef = useRef<number>(0);
  const microphoneRuntimeRefsRef = useRef<MicrophoneRuntimeRefs>({
    micCtxRef,
    micStreamRef,
    processorRef,
    micAnalyserRef,
    ampRafRef,
  });

  const setStatus = useCallback(
    (nextStatus: VoiceAgentStatus) => {
      statusRef.current = nextStatus;
      setStatusState(nextStatus);
      onStatusChange?.(nextStatus);
    },
    [onStatusChange],
  );

  const setStatusRef = useRef<(nextStatus: VoiceAgentStatus) => void>(() => {});
  setStatusRef.current = setStatus;

  const pushOutputEvent = useCallback((event: MasterAvatarAudioEvent, record: boolean) => {
    pushOutputAudioEvent({
      listenersRef: outputAudioListenersRef,
      eventBufferRef: lastOutputAudioEventsRef,
      event,
      record,
    });
  }, []);

  const realtimeEventHandlerRef = useRef<(event: RealtimeParsedEvent) => void>(() => {});
  const socketFaultHandlerRef = useRef<(message: string) => void>(() => {});

  const realtimeControllerRef = useRef<RealtimeSessionController | null>(null);
  if (!realtimeControllerRef.current) {
    realtimeControllerRef.current = createRealtimeSessionController({
      isUnmountedRef: unmountedRef,
      statusRef,
      setStatusRef,
      onRealtimeEventRef: realtimeEventHandlerRef,
      onSocketFaultRef: socketFaultHandlerRef,
      setConnected,
      setError,
      resetAmplitude: () => setAmplitude(0),
      stopMicrophone: () =>
        stopMicrophone({
          runtimeRefs: microphoneRuntimeRefsRef.current,
          setAmplitude,
        }),
    });
  }
  const realtime = realtimeControllerRef.current;

  const handleRealtimeEvent = useCallback(
    (event: RealtimeParsedEvent) => {
      switch (event.type) {
        case 'speech_started':
          setTranscript('');
          setAiResponse('');
          setStatus('listening');
          break;

        case 'response_created':
          realtime.clearAutoDisconnectTimer();
          currentTurnIdRef.current = createTurnId();
          lastOutputAudioEventsRef.current = [];
          pushOutputEvent(
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

        case 'output_audio_delta':
          if (!currentTurnIdRef.current) {
            currentTurnIdRef.current = createTurnId();
            lastOutputAudioEventsRef.current = [];
            pushOutputEvent(
              {
                type: 'start',
                turnId: currentTurnIdRef.current,
                at: performance.now(),
                sampleRate: OUTPUT_SAMPLE_RATE,
              },
              true,
            );
          }
          pushOutputEvent(
            {
              type: 'chunk',
              turnId: currentTurnIdRef.current,
              at: performance.now(),
              sampleRate: OUTPUT_SAMPLE_RATE,
              pcm16: event.pcm16,
            },
            true,
          );
          setStatus('speaking');
          setAmplitude(Math.min(1, pcm16Rms(event.pcm16) * 5));
          break;

        case 'output_audio_transcript_delta':
          setAiResponse((previous) => previous + event.delta);
          break;

        case 'input_audio_transcription_completed':
          setTranscript(event.transcript);
          break;

        case 'response_output_audio_done':
        case 'response_done':
          if (currentTurnIdRef.current) {
            pushOutputEvent(
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
          realtime.scheduleAutoDisconnectAfterTurn();
          break;

        default:
          break;
      }
    },
    [pushOutputEvent, realtime, setStatus],
  );

  const handleSocketFault = useCallback(
    (message: string) => {
      if (!currentTurnIdRef.current) return;
      pushOutputEvent(
        {
          type: 'error',
          turnId: currentTurnIdRef.current,
          at: performance.now(),
          sampleRate: OUTPUT_SAMPLE_RATE,
          message,
        },
        true,
      );
      currentTurnIdRef.current = null;
    },
    [pushOutputEvent],
  );

  realtimeEventHandlerRef.current = handleRealtimeEvent;
  socketFaultHandlerRef.current = handleSocketFault;

  useEffect(() => {
    unmountedRef.current = false;
    const outputAudioListeners = outputAudioListenersRef.current;
    return () => {
      unmountedRef.current = true;
      clearReplayTimers(replayTimersRef);
      realtimeControllerRef.current?.dispose({ stopMic: true, keepStatus: true });
      outputAudioListeners.clear();
    };
  }, []);

  const startListening = useCallback(async () => {
    if (statusRef.current === 'listening') return;

    setError(null);
    realtime.clearAutoDisconnectTimer();

    try {
      await realtime.connect();
    } catch {
      setError('Voice service not connected');
      return;
    }

    setStatus('listening');

    startMicrophone({
      runtimeRefs: microphoneRuntimeRefsRef.current,
      isUnmountedRef: unmountedRef,
      isListening: () => statusRef.current === 'listening',
      getSocket: () => realtime.getSocket(),
      setAmplitude,
      onError: (message) => {
        setError(message);
        setStatus('error');
      },
    });
  }, [realtime, setStatus]);

  const stopListening = useCallback(() => {
    realtime.disconnect({ stopMic: true });
  }, [realtime]);

  const submitText = useCallback(
    async (text: string): Promise<void> => {
      if (statusRef.current === 'thinking' || statusRef.current === 'speaking') return;

      setError(null);
      realtime.clearAutoDisconnectTimer();

      let ws: WebSocket;
      try {
        ws = await realtime.connect();
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
    [realtime, setStatus],
  );

  const subscribeOutputAudio = useCallback((listener: MasterAvatarAudioListener): (() => void) => {
    outputAudioListenersRef.current.add(listener);
    return () => {
      outputAudioListenersRef.current.delete(listener);
    };
  }, []);

  const cancel = useCallback(() => {
    clearReplayTimers(replayTimersRef);
    realtime.disconnect({ stopMic: true });

    if (!currentTurnIdRef.current) return;

    pushOutputEvent(
      {
        type: 'cancel',
        turnId: currentTurnIdRef.current,
        at: performance.now(),
        sampleRate: OUTPUT_SAMPLE_RATE,
      },
      true,
    );
    currentTurnIdRef.current = null;
  }, [pushOutputEvent, realtime]);

  const replay = useCallback(() => {
    replayOutputAudioEvents({
      listenersRef: outputAudioListenersRef,
      eventBufferRef: lastOutputAudioEventsRef,
      replayTimersRef,
      statusRef,
      unmountedRef,
      setStatus,
      setAmplitude,
    });
  }, [setStatus]);

  const faceState =
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
