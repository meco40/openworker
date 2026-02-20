import React, { useEffect, useRef, useState } from 'react';
import { Modality, LiveServerMessage } from '@google/genai';
import { ai, LIVE_MODE_SUPPORTED, SYSTEM_INSTRUCTION } from '@/services/gateway';
import { decodeBase64, decodeAudioData, createPcmBlob } from '@/services/audio';

interface VoiceOverlayProps {
  onClose: () => void;
}

type LiveSession = Awaited<ReturnType<typeof ai.live.connect>>;
type WindowWithWebkitAudioContext = Window &
  typeof globalThis & { webkitAudioContext?: typeof AudioContext };

const VoiceOverlay: React.FC<VoiceOverlayProps> = ({ onClose }) => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState('Connecting...');

  const audioContextIn = useRef<AudioContext | null>(null);
  const audioContextOut = useRef<AudioContext | null>(null);
  const nextStartTime = useRef(0);
  const sources = useRef(new Set<AudioBufferSourceNode>());
  const sessionRef = useRef<LiveSession | null>(null);

  useEffect(() => {
    const startVoice = async () => {
      if (!LIVE_MODE_SUPPORTED) {
        setStatus('Voice mode requires server websocket bridge.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const audioContextCtor =
          window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
        if (!audioContextCtor) {
          throw new Error('AudioContext not supported');
        }
        audioContextIn.current = new audioContextCtor({ sampleRate: 16000 });
        audioContextOut.current = new audioContextCtor({ sampleRate: 24000 });

        const outputNode = audioContextOut.current.createGain();
        outputNode.connect(audioContextOut.current.destination);

        // Define a session promise to handle potential race conditions and stale closures in audio processing.
        const sessionPromise = ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
          callbacks: {
            onopen: () => {
              setStatus('Listening...');
              setIsActive(true);
              const source = audioContextIn.current!.createMediaStreamSource(stream);
              const scriptProcessor = audioContextIn.current!.createScriptProcessor(4096, 1, 1);
              scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmData = createPcmBlob(inputData);
                // Rely solely on sessionPromise to send data to the model.
                void sessionPromise
                  .then((session) => {
                    session.sendRealtimeInput({
                      media: { data: pcmData, mimeType: 'audio/pcm;rate=16000' },
                    });
                  })
                  .catch((error: unknown) => {
                    console.error('Voice session unavailable during audio processing:', error);
                  });
              };
              source.connect(scriptProcessor);
              scriptProcessor.connect(audioContextIn.current!.destination);
            },
            onmessage: async (message: LiveServerMessage) => {
              const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
              if (base64Audio && audioContextOut.current) {
                nextStartTime.current = Math.max(
                  nextStartTime.current,
                  audioContextOut.current.currentTime,
                );
                const audioBuffer = await decodeAudioData(
                  decodeBase64(base64Audio),
                  audioContextOut.current,
                  24000,
                  1,
                );
                const source = audioContextOut.current.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputNode);
                source.start(nextStartTime.current);
                nextStartTime.current += audioBuffer.duration;
                sources.current.add(source);
                source.onended = () => sources.current.delete(source);
              }

              if (message.serverContent?.interrupted) {
                sources.current.forEach((s) => s.stop());
                sources.current.clear();
                nextStartTime.current = 0;
              }
            },
            onerror: (e: unknown) => {
              console.error('Voice Error:', e);
              setStatus('Error connecting.');
            },
            onclose: () => {
              setIsActive(false);
              setStatus('Disconnected.');
            },
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } } },
            systemInstruction: SYSTEM_INSTRUCTION,
          },
        });

        void sessionPromise
          .then((session) => {
            sessionRef.current = session;
          })
          .catch((error: unknown) => {
            console.error('Failed to establish live voice session:', error);
          });
      } catch (err) {
        console.error('Failed to init voice:', err);
        setStatus('Microphone access denied.');
      }
    };

    startVoice();

    return () => {
      if (sessionRef.current) sessionRef.current.close();
      if (audioContextIn.current) audioContextIn.current.close();
      if (audioContextOut.current) audioContextOut.current.close();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-8 text-center shadow-2xl">
        <div className="relative inline-block">
          <div
            className={`flex h-24 w-24 items-center justify-center rounded-full bg-indigo-600 transition-transform duration-500 ${isActive ? 'scale-110' : 'scale-100'}`}
          >
            <svg
              className="h-10 w-10 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
              />
            </svg>
          </div>
          {isActive && (
            <div className="absolute inset-0 animate-ping rounded-full border-4 border-indigo-500 opacity-25" />
          )}
        </div>

        <div className="space-y-2">
          <h2 className="text-xl font-bold tracking-tight text-white">OpenClaw Voice Mode</h2>
          <p className="font-mono text-sm tracking-widest text-zinc-500 uppercase">{status}</p>
        </div>

        <div className="pt-4">
          <button
            onClick={onClose}
            className="w-full rounded-lg bg-zinc-800 py-3 text-sm font-bold tracking-widest text-zinc-300 uppercase transition-all hover:bg-zinc-700"
          >
            End Conversation
          </button>
        </div>
      </div>
    </div>
  );
};

export default VoiceOverlay;
