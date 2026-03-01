import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, 'public', 'models', 'master-avatar-rigged.manifest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  assert(
    fs.existsSync(manifestPath),
    'Manifest missing: public/models/master-avatar-rigged.manifest.json',
  );
  const manifest = readJson(manifestPath);

  assert(typeof manifest.name === 'string' && manifest.name.length > 0, 'Manifest: name missing');
  assert(typeof manifest.export?.path === 'string', 'Manifest: export.path missing');
  assert(Array.isArray(manifest.requiredBones), 'Manifest: requiredBones must be an array');
  assert(
    Array.isArray(manifest.requiredBlendshapes),
    'Manifest: requiredBlendshapes must be an array',
  );

  const exportGlbPath = path.join(repoRoot, manifest.export.path);
  const blendPath = path.join(repoRoot, manifest.source?.blend ?? '');
  const sourceGlbPath = path.join(repoRoot, manifest.source?.sourceGlb ?? '');

  assert(fs.existsSync(exportGlbPath), `Export GLB missing: ${manifest.export.path}`);
  assert(fs.existsSync(blendPath), `Blend source missing: ${manifest.source?.blend}`);
  assert(fs.existsSync(sourceGlbPath), `Source GLB missing: ${manifest.source?.sourceGlb}`);

  const ascii = Buffer.from(fs.readFileSync(exportGlbPath)).toString('latin1');

  const missingBones = manifest.requiredBones.filter((bone) => !ascii.includes(bone));
  const missingBlendshapes = manifest.requiredBlendshapes.filter((shape) => !ascii.includes(shape));

  assert(missingBones.length === 0, `GLB missing required bones: ${missingBones.join(', ')}`);
  assert(
    missingBlendshapes.length === 0,
    `GLB missing required blendshapes: ${missingBlendshapes.join(', ')}`,
  );

  process.stdout.write('[avatar:validate] master-avatar-rigged validation passed\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[avatar:validate] ${message}\n`);
  process.exit(1);
}
