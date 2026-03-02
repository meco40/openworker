import type { MutableRefObject } from 'react';
import type {
  MasterAvatarAudioChunkEvent,
  MasterAvatarAudioEvent,
  MasterAvatarAudioListener,
} from '../../types';
import { pcm16Rms } from './audioCodec';
import type { VoiceAgentStatus } from './types';

export function cloneOutputEvent(event: MasterAvatarAudioEvent): MasterAvatarAudioEvent {
  if (event.type !== 'chunk') {
    return { ...event };
  }

  return {
    ...event,
    pcm16: new Int16Array(event.pcm16),
  } as MasterAvatarAudioChunkEvent;
}

export function broadcastOutputAudio(
  listenersRef: MutableRefObject<Set<MasterAvatarAudioListener>>,
  event: MasterAvatarAudioEvent,
): void {
  const listeners = listenersRef.current;
  if (listeners.size === 0) return;

  for (const listener of listeners) {
    listener(event);
  }
}

export function pushOutputAudioEvent(input: {
  listenersRef: MutableRefObject<Set<MasterAvatarAudioListener>>;
  eventBufferRef: MutableRefObject<MasterAvatarAudioEvent[]>;
  event: MasterAvatarAudioEvent;
  record: boolean;
}): void {
  const cloned = cloneOutputEvent(input.event);
  if (input.record) {
    input.eventBufferRef.current.push(cloned);
  }
  broadcastOutputAudio(input.listenersRef, cloned);
}

export function clearReplayTimers(
  replayTimersRef: MutableRefObject<ReturnType<typeof setTimeout>[]>,
): void {
  replayTimersRef.current.forEach((timer) => clearTimeout(timer));
  replayTimersRef.current = [];
}

export function replayOutputAudioEvents(input: {
  listenersRef: MutableRefObject<Set<MasterAvatarAudioListener>>;
  eventBufferRef: MutableRefObject<MasterAvatarAudioEvent[]>;
  replayTimersRef: MutableRefObject<ReturnType<typeof setTimeout>[]>;
  statusRef: MutableRefObject<VoiceAgentStatus>;
  unmountedRef: MutableRefObject<boolean>;
  setStatus: (status: VoiceAgentStatus) => void;
  setAmplitude: (value: number) => void;
}): void {
  const events = input.eventBufferRef.current.map(cloneOutputEvent);
  if (events.length === 0) return;

  clearReplayTimers(input.replayTimersRef);
  input.setStatus('speaking');

  const startAt = events[0].at;
  for (const event of events) {
    const timer = setTimeout(
      () => {
        broadcastOutputAudio(input.listenersRef, cloneOutputEvent(event));
        if (event.type === 'chunk') {
          input.setAmplitude(Math.min(1, pcm16Rms(event.pcm16) * 5));
        }
      },
      Math.max(0, Math.round(event.at - startAt)),
    );
    input.replayTimersRef.current.push(timer);
  }

  const endOffset = Math.max(0, Math.round(events[events.length - 1].at - startAt)) + 160;
  const endTimer = setTimeout(() => {
    if (!input.unmountedRef.current && input.statusRef.current === 'speaking') {
      input.setStatus('idle');
    }
    input.setAmplitude(0);
  }, endOffset);
  input.replayTimersRef.current.push(endTimer);
}
