import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MasterFaceCanvasThree interaction contract', () => {
  function loadSource(): string {
    return fs.readFileSync(
      path.join(process.cwd(), 'src/modules/master/components/MasterFaceCanvasThree.tsx'),
      'utf8',
    );
  }

  it('uses TalkingHead avatarOnly mode for rendering inside the existing scene', () => {
    const source = loadSource();
    expect(source).toContain('../vendor/talkinghead/talkinghead.mjs');
    expect(source).toContain('avatarOnly: true');
    expect(source).toContain('avatarOnlyCamera: camera');
    expect(source).toContain('avatarOnlyScene: scene');
  });

  it('supports direct user interaction via pointer drag and wheel zoom', () => {
    const source = loadSource();
    expect(source).toContain('pointerdown');
    expect(source).toContain('pointermove');
    expect(source).toContain('pointerup');
    expect(source).toContain('wheel');
  });

  it('loads the rigged production avatar and HeadAudio runtime assets', () => {
    const source = loadSource();
    expect(source).toContain('/models/master-avatar-rigged.glb');
    expect(source).toContain('/vendor/headaudio/headworklet.mjs');
    expect(source).toContain('/vendor/headaudio/model-en-mixed.bin');
    expect(source).toContain('@met4citizen/headaudio/modules/headaudio.mjs');
  });

  it('consumes outputAudioStream events via streamStart/streamAudio/streamNotifyEnd', () => {
    const source = loadSource();
    expect(source).toContain('outputAudioStream');
    expect(source).toContain('streamStart');
    expect(source).toContain('streamAudio');
    expect(source).toContain('streamNotifyEnd');
  });

  it('does not force black scene or canvas backgrounds', () => {
    const source = loadSource();
    expect(source).not.toContain('scene.background = new THREE.Color(0x000000)');
    expect(source).not.toContain("background: '#000000'");
  });

  it('contains a 3D-only retry path and does not switch to 2D fallback', () => {
    const source = loadSource();
    expect(source).toContain('Retry');
    expect(source).not.toMatch(/from ['"]\.\/MasterFaceCanvas['"]/);
  });
});
