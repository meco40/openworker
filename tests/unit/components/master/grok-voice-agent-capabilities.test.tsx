import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useGrokVoiceAgent } from '@/modules/master/voice/grok/useGrokVoiceAgent';

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalAudioContext = window.AudioContext;
const originalWebSocket = window.WebSocket;

function setMediaDevices(value: MediaDevices | undefined) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  if (originalMediaDevicesDescriptor) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevicesDescriptor);
  } else {
    setMediaDevices(undefined);
  }
  window.AudioContext = originalAudioContext;
  window.WebSocket = originalWebSocket;
});

describe('useGrokVoiceAgent capability gates', () => {
  it('reports unsupported STT and blocks mic start without getUserMedia', async () => {
    setMediaDevices(undefined);
    window.AudioContext = class AudioContextMock {} as typeof AudioContext;

    const { result } = renderHook(() => useGrokVoiceAgent());

    expect(result.current.sttSupported).toBe(false);
    expect(result.current.ttsSupported).toBe(true);

    await act(async () => {
      await result.current.startListening();
    });

    expect(result.current.status).toBe('unsupported');
    expect(result.current.error).toMatch(/not supported/i);
  });
});
