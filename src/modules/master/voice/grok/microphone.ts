import type { MutableRefObject } from 'react';
import { INPUT_SAMPLE_RATE } from './constants';
import { float32ToInt16Downsampled, int16ToBase64 } from './audioCodec';

export interface MicrophoneRuntimeRefs {
  micCtxRef: MutableRefObject<AudioContext | null>;
  micStreamRef: MutableRefObject<MediaStream | null>;
  processorRef: MutableRefObject<ScriptProcessorNode | null>;
  micAnalyserRef: MutableRefObject<AnalyserNode | null>;
  ampRafRef: MutableRefObject<number>;
}

function stopAmplitudeLoop(input: {
  ampRafRef: MutableRefObject<number>;
  setAmplitude: (value: number) => void;
}): void {
  cancelAnimationFrame(input.ampRafRef.current);
  input.setAmplitude(0);
}

function startAmplitudeLoop(input: {
  analyser: AnalyserNode;
  ampRafRef: MutableRefObject<number>;
  setAmplitude: (value: number) => void;
}): void {
  stopAmplitudeLoop({ ampRafRef: input.ampRafRef, setAmplitude: input.setAmplitude });

  const data = new Uint8Array(input.analyser.fftSize);
  const tick = () => {
    input.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const value = (data[i] - 128) / 128;
      sum += value * value;
    }
    input.setAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 5));
    input.ampRafRef.current = requestAnimationFrame(tick);
  };

  input.ampRafRef.current = requestAnimationFrame(tick);
}

export function stopMicrophone(input: {
  runtimeRefs: MicrophoneRuntimeRefs;
  setAmplitude: (value: number) => void;
}): void {
  stopAmplitudeLoop({
    ampRafRef: input.runtimeRefs.ampRafRef,
    setAmplitude: input.setAmplitude,
  });

  input.runtimeRefs.processorRef.current?.disconnect();
  input.runtimeRefs.processorRef.current = null;

  input.runtimeRefs.micAnalyserRef.current?.disconnect();
  input.runtimeRefs.micAnalyserRef.current = null;

  input.runtimeRefs.micStreamRef.current?.getTracks().forEach((track) => track.stop());
  input.runtimeRefs.micStreamRef.current = null;

  input.runtimeRefs.micCtxRef.current?.close().catch(() => {});
  input.runtimeRefs.micCtxRef.current = null;
}

export function startMicrophone(input: {
  runtimeRefs: MicrophoneRuntimeRefs;
  isUnmountedRef: MutableRefObject<boolean>;
  isListening: () => boolean;
  getSocket: () => WebSocket | null;
  setAmplitude: (value: number) => void;
  onError: (message: string) => void;
}): void {
  navigator.mediaDevices
    .getUserMedia({ audio: true, video: false })
    .then((stream) => {
      if (input.isUnmountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      input.runtimeRefs.micStreamRef.current = stream;

      const ctx = new AudioContext();
      input.runtimeRefs.micCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      input.runtimeRefs.micAnalyserRef.current = analyser;
      source.connect(analyser);

      const processor = ctx.createScriptProcessor(4096, 1, 1);
      input.runtimeRefs.processorRef.current = processor;
      source.connect(processor);
      processor.connect(ctx.destination);

      startAmplitudeLoop({
        analyser,
        ampRafRef: input.runtimeRefs.ampRafRef,
        setAmplitude: input.setAmplitude,
      });

      processor.onaudioprocess = (event) => {
        if (!input.isListening()) return;

        const ws = input.getSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const channelData = event.inputBuffer.getChannelData(0);
        const pcm16 = float32ToInt16Downsampled(channelData, ctx.sampleRate, INPUT_SAMPLE_RATE);
        ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: int16ToBase64(pcm16),
          }),
        );
      };
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Microphone access denied';
      input.onError(message);
    });
}
