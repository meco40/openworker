import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Master rigged avatar asset contract', () => {
  const modelPath = path.join(process.cwd(), 'public/models/master-avatar-rigged.glb');
  const manifestPath = path.join(process.cwd(), 'public/models/master-avatar-rigged.manifest.json');

  it('ships a rigged production GLB and manifest', () => {
    expect(fs.existsSync(modelPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('manifest requires the full Oculus viseme set and core body bones', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      requiredBones?: string[];
      requiredBlendshapes?: string[];
    };

    expect(manifest.requiredBones).toContain('Armature');
    expect(manifest.requiredBones).toContain('Hips');
    expect(manifest.requiredBones).toContain('Head');
    expect(manifest.requiredBones).toContain('LeftArm');
    expect(manifest.requiredBones).toContain('RightArm');

    expect(manifest.requiredBlendshapes).toContain('viseme_aa');
    expect(manifest.requiredBlendshapes).toContain('viseme_E');
    expect(manifest.requiredBlendshapes).toContain('viseme_I');
    expect(manifest.requiredBlendshapes).toContain('viseme_O');
    expect(manifest.requiredBlendshapes).toContain('viseme_U');
    expect(manifest.requiredBlendshapes).toContain('viseme_PP');
    expect(manifest.requiredBlendshapes).toContain('viseme_SS');
    expect(manifest.requiredBlendshapes).toContain('viseme_TH');
    expect(manifest.requiredBlendshapes).toContain('viseme_DD');
    expect(manifest.requiredBlendshapes).toContain('viseme_FF');
    expect(manifest.requiredBlendshapes).toContain('viseme_kk');
    expect(manifest.requiredBlendshapes).toContain('viseme_nn');
    expect(manifest.requiredBlendshapes).toContain('viseme_RR');
    expect(manifest.requiredBlendshapes).toContain('viseme_CH');
    expect(manifest.requiredBlendshapes).toContain('viseme_sil');
  });
});
