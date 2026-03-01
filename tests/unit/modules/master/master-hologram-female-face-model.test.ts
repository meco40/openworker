import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Master hologram full-body GLTF asset', () => {
  const modelPath = path.join(process.cwd(), 'public/models/hologram-female-face.gltf');

  it('exists as a GLTF file in public/models', () => {
    expect(fs.existsSync(modelPath)).toBe(true);
  });

  it('contains full avatar nodes for head, body, hands, feet, eyes and mouth', () => {
    const source = fs.readFileSync(modelPath, 'utf8');
    const gltf = JSON.parse(source) as {
      nodes?: Array<{ name?: string }>;
    };
    const names = (gltf.nodes ?? []).map((node) => node.name ?? '');
    expect(names).toContain('HologramAvatarFullBody');
    expect(names).not.toContain('HologramComputerFace');
    expect(names).toContain('Head_Main');
    expect(names).toContain('Torso_Main');
    expect(names).toContain('Arm_Left');
    expect(names).toContain('Arm_Right');
    expect(names).toContain('Leg_Left');
    expect(names).toContain('Leg_Right');
    expect(names).toContain('Hand_Left');
    expect(names).toContain('Hand_Right');
    expect(names).toContain('Foot_Left');
    expect(names).toContain('Foot_Right');
    expect(names).toContain('Eye_Left');
    expect(names).toContain('Eye_Right');
    expect(names).toContain('Mouth_Main');
  });
});
