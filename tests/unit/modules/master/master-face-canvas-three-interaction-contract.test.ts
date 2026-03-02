import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('MasterFaceCanvasThree interaction contract', () => {
  function loadSource(relativePath: string): string {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
  }

  it('keeps the component as a thin wrapper over runtime + view modules', () => {
    const source = loadSource('src/modules/master/components/MasterFaceCanvasThree.tsx');
    expect(source).toContain('useMasterFaceThreeRuntime');
    expect(source).toContain('MasterFaceThreeView');
    expect(source).not.toMatch(/from ['"]\.\/MasterFaceCanvas['"]/);
  });

  it('uses TalkingHead avatarOnly mode for rendering inside the existing scene', () => {
    const source = loadSource(
      'src/modules/master/components/master-face-three/useMasterFaceThreeRuntime.ts',
    );
    expect(source).toContain('../vendor/talkinghead/talkinghead.mjs');
    expect(source).toContain('avatarOnly: true');
    expect(source).toContain('avatarOnlyCamera: camera');
    expect(source).toContain('avatarOnlyScene: scene');
  });

  it('supports direct user interaction via pointer drag and wheel zoom', () => {
    const source = loadSource(
      'src/modules/master/components/master-face-three/useMasterFaceThreeRuntime.ts',
    );
    expect(source).toContain('pointerdown');
    expect(source).toContain('pointermove');
    expect(source).toContain('pointerup');
    expect(source).toContain('wheel');
  });

  it('loads the rigged production avatar and HeadAudio runtime assets', () => {
    const runtimeSource = loadSource(
      'src/modules/master/components/master-face-three/useMasterFaceThreeRuntime.ts',
    );
    const constantsSource = loadSource(
      'src/modules/master/components/master-face-three/constants.ts',
    );
    expect(constantsSource).toContain('/models/master-avatar-rigged.glb');
    expect(runtimeSource).toContain('/vendor/headaudio/headworklet.mjs');
    expect(runtimeSource).toContain('/vendor/headaudio/model-en-mixed.bin');
    expect(runtimeSource).toContain('@met4citizen/headaudio/modules/headaudio.mjs');
  });

  it('consumes outputAudioStream events via streamStart/streamAudio/streamNotifyEnd', () => {
    const source = loadSource(
      'src/modules/master/components/master-face-three/useMasterFaceThreeRuntime.ts',
    );
    expect(source).toContain('outputAudioStream');
    expect(source).toContain('streamStart');
    expect(source).toContain('streamAudio');
    expect(source).toContain('streamNotifyEnd');
  });

  it('does not force black scene or canvas backgrounds', () => {
    const runtimeSource = loadSource(
      'src/modules/master/components/master-face-three/useMasterFaceThreeRuntime.ts',
    );
    const viewSource = loadSource(
      'src/modules/master/components/master-face-three/MasterFaceThreeView.tsx',
    );
    expect(runtimeSource).not.toContain('scene.background = new THREE.Color(0x000000)');
    expect(viewSource).not.toContain("background: '#000000'");
  });

  it('contains a 3D-only retry path and does not switch to 2D fallback', () => {
    const wrapperSource = loadSource('src/modules/master/components/MasterFaceCanvasThree.tsx');
    const viewSource = loadSource(
      'src/modules/master/components/master-face-three/MasterFaceThreeView.tsx',
    );
    expect(viewSource).toContain('Retry');
    expect(wrapperSource).not.toMatch(/from ['"]\.\/MasterFaceCanvas['"]/);
  });
});
