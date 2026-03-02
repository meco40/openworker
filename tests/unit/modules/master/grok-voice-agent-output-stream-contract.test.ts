import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('useGrokVoiceAgent output stream contract', () => {
  function loadHookSource(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/voice/grok/useGrokVoiceAgent.ts'),
      'utf8',
    );
  }

  function loadRealtimeSource(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/voice/grok/realtimeSession.ts'),
      'utf8',
    );
  }

  function loadOutputAudioBusSource(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/voice/grok/outputAudioBus.ts'),
      'utf8',
    );
  }

  it('exposes subscribeOutputAudio in the returned API', () => {
    const source = loadHookSource();
    expect(source).toContain('subscribeOutputAudio');
    expect(source).toMatch(/const subscribeOutputAudio = useCallback\(\(listener/);
  });

  it('emits structured start/chunk/end events from realtime output audio', () => {
    const hookSource = loadHookSource();
    const realtimeSource = loadRealtimeSource();
    expect(hookSource).toContain("type: 'start'");
    expect(hookSource).toContain("type: 'chunk'");
    expect(hookSource).toContain("type: 'end'");
    expect(realtimeSource).toContain('response.output_audio.delta');
    expect(realtimeSource).toContain('response.output_audio.done');
  });

  it('replay re-broadcasts the last output audio event stream', () => {
    const hookSource = loadHookSource();
    const outputAudioBusSource = loadOutputAudioBusSource();
    expect(hookSource).toContain('lastOutputAudioEventsRef');
    expect(hookSource).toContain('replay = useCallback');
    expect(outputAudioBusSource).toContain('broadcastOutputAudio');
  });

  it('auto-disconnects realtime session after completed agent output', () => {
    const hookSource = loadHookSource();
    const realtimeSource = loadRealtimeSource();
    expect(hookSource).toContain('scheduleAutoDisconnectAfterTurn');
    expect(realtimeSource).toContain('response.output_audio.done');
    expect(realtimeSource).toContain('response.done');
  });
});
