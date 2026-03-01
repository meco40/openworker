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

  it('assigns loaded GLTF scene to sceneRef humanGroup', () => {
    const source = loadSource();
    expect(source).toMatch(/sceneRef\.current\.humanGroup\s*=\s*gltf\.scene/);
  });

  it('supports direct user interaction via pointer drag and wheel zoom', () => {
    const source = loadSource();
    expect(source).toContain('pointerdown');
    expect(source).toContain('pointermove');
    expect(source).toContain('pointerup');
    expect(source).toContain('wheel');
  });

  it('loads the full-body avatar GLTF and binds all key body nodes', () => {
    const source = loadSource();
    expect(source).toContain('/models/hologram-female-face.gltf');
    expect(source).toContain("getObjectByName('Torso_Main')");
    expect(source).toContain("getObjectByName('Arm_Left')");
    expect(source).toContain("getObjectByName('Arm_Right')");
    expect(source).toContain("getObjectByName('Leg_Left')");
    expect(source).toContain("getObjectByName('Leg_Right')");
    expect(source).toContain("getObjectByName('Hand_Left')");
    expect(source).toContain("getObjectByName('Hand_Right')");
    expect(source).toContain("getObjectByName('Foot_Left')");
    expect(source).toContain("getObjectByName('Foot_Right')");
    expect(source).toContain("getObjectByName('Eye_Left')");
    expect(source).toContain("getObjectByName('Eye_Right')");
    expect(source).toContain("getObjectByName('Mouth_Main')");
  });

  it('supports room-scale locomotion with walk, jump and sit animation states', () => {
    const source = loadSource();
    expect(source).toContain('walkCycle');
    expect(source).toContain('jumpOffset');
    expect(source).toContain('sitAmount');
    expect(source).toContain("cs === 'thinking'");
    expect(source).toContain("cs === 'speaking'");
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

  it('does not render a decorative glow circle or moving scan line', () => {
    const source = loadSource();
    expect(source).not.toContain('SphereGeometry(200, 32, 32)');
    expect(source).not.toContain('PlaneGeometry(400, 2)');
    expect(source).not.toContain('glowMesh');
    expect(source).not.toContain('scanLine');
  });
});
