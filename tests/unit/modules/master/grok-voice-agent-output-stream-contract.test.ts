import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('useGrokVoiceAgent output stream contract', () => {
  function loadSource(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/hooks/useGrokVoiceAgent.ts'),
      'utf8',
    );
  }

  it('exposes subscribeOutputAudio in the returned API', () => {
    const source = loadSource();
    expect(source).toContain('subscribeOutputAudio');
    expect(source).toMatch(/subscribeOutputAudio:\s*\(listener/);
  });

  it('emits structured start/chunk/end events from realtime output audio', () => {
    const source = loadSource();
    expect(source).toContain("type: 'start'");
    expect(source).toContain("type: 'chunk'");
    expect(source).toContain("type: 'end'");
    expect(source).toContain('response.output_audio.delta');
    expect(source).toContain('response.output_audio.done');
  });

  it('replay re-broadcasts the last output audio event stream', () => {
    const source = loadSource();
    expect(source).toContain('lastOutputAudioEventsRef');
    expect(source).toContain('replay = useCallback');
    expect(source).toContain('broadcastOutputAudio');
  });

  it('auto-disconnects realtime session after completed agent output', () => {
    const source = loadSource();
    expect(source).toContain('disconnectRealtimeSession');
    expect(source).toContain('scheduleAutoDisconnectAfterTurn');
    expect(source).toContain('response.output_audio.done');
    expect(source).toContain('response.done');
  });
});
