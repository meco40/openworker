import fs from 'node:fs';
import path from 'node:path';

function appendVertex(positions, x, y, z) {
  positions.push(x, y, z);
}

function buildSphere(radius, latSegments, lonSegments, deform) {
  const positions = [];
  const indices = [];

  for (let y = 0; y <= latSegments; y++) {
    const v = y / latSegments;
    const phi = v * Math.PI;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);

    for (let x = 0; x <= lonSegments; x++) {
      const u = x / lonSegments;
      const theta = u * Math.PI * 2;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);

      const nx = sinPhi * cosTheta;
      const ny = cosPhi;
      const nz = sinPhi * sinTheta;

      const [dx, dy, dz] = deform(nx, ny, nz);
      appendVertex(positions, dx * radius, dy * radius, dz * radius);
    }
  }

  for (let y = 0; y < latSegments; y++) {
    for (let x = 0; x < lonSegments; x++) {
      const a = y * (lonSegments + 1) + x;
      const b = a + lonSegments + 1;
      indices.push(a, b, a + 1);
      indices.push(b, b + 1, a + 1);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint16Array(indices),
  };
}

function buildSmileArc(segments, radiusOuter, radiusInner, startAngle, endAngle, zOffset) {
  const positions = [];
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    const t = startAngle + (i / segments) * (endAngle - startAngle);
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    appendVertex(positions, radiusOuter * cos, radiusOuter * sin, zOffset);
    appendVertex(positions, radiusInner * cos, radiusInner * sin, zOffset + 2);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b);
    indices.push(c, d, b);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint16Array(indices),
  };
}

function computeMinMaxVec3(floatArray) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < floatArray.length; i += 3) {
    const x = floatArray[i];
    const y = floatArray[i + 1];
    const z = floatArray[i + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

function toBuffer(typedArray) {
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

function align4(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  if (padding === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function createPrimitive(builder, geometry, materialIndex) {
  const positionBuffer = toBuffer(geometry.positions);
  const positionOffset = builder.offset;
  const alignedPosition = align4(positionBuffer);
  builder.chunks.push(alignedPosition);
  builder.offset += alignedPosition.length;

  const positionView = builder.bufferViews.length;
  builder.bufferViews.push({
    buffer: 0,
    byteOffset: positionOffset,
    byteLength: positionBuffer.length,
    target: 34962,
  });

  const { min, max } = computeMinMaxVec3(geometry.positions);
  const positionAccessor = builder.accessors.length;
  builder.accessors.push({
    bufferView: positionView,
    byteOffset: 0,
    componentType: 5126,
    count: geometry.positions.length / 3,
    type: 'VEC3',
    min,
    max,
  });

  // Calculate generic smooth normals
  const normals = new Float32Array(geometry.positions.length);
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const i1 = geometry.indices[i] * 3;
    const i2 = geometry.indices[i + 1] * 3;
    const i3 = geometry.indices[i + 2] * 3;
    const v1 = [geometry.positions[i1], geometry.positions[i1 + 1], geometry.positions[i1 + 2]];
    const v2 = [geometry.positions[i2], geometry.positions[i2 + 1], geometry.positions[i2 + 2]];
    const v3 = [geometry.positions[i3], geometry.positions[i3 + 1], geometry.positions[i3 + 2]];

    // cross product (v2 - v1) x (v3 - v1)
    const dx1 = v2[0] - v1[0];
    const dy1 = v2[1] - v1[1];
    const dz1 = v2[2] - v1[2];
    const dx2 = v3[0] - v1[0];
    const dy2 = v3[1] - v1[1];
    const dz2 = v3[2] - v1[2];
    const nx = dy1 * dz2 - dz1 * dy2;
    const ny = dz1 * dx2 - dx1 * dz2;
    const nz = dx1 * dy2 - dy1 * dx2;

    normals[i1] += nx;
    normals[i1 + 1] += ny;
    normals[i1 + 2] += nz;
    normals[i2] += nx;
    normals[i2 + 1] += ny;
    normals[i2 + 2] += nz;
    normals[i3] += nx;
    normals[i3 + 1] += ny;
    normals[i3 + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.sqrt(
      normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2],
    );
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
  }

  const normalBuffer = toBuffer(normals);
  const normalOffset = builder.offset;
  const alignedNormal = align4(normalBuffer);
  builder.chunks.push(alignedNormal);
  builder.offset += alignedNormal.length;

  const normalView = builder.bufferViews.length;
  builder.bufferViews.push({
    buffer: 0,
    byteOffset: normalOffset,
    byteLength: normalBuffer.length,
    target: 34962,
  });

  const normalAccessor = builder.accessors.length;
  builder.accessors.push({
    bufferView: normalView,
    byteOffset: 0,
    componentType: 5126,
    count: normals.length / 3,
    type: 'VEC3',
  });

  const indexBuffer = toBuffer(geometry.indices);
  const indexOffset = builder.offset;
  const alignedIndices = align4(indexBuffer);
  builder.chunks.push(alignedIndices);
  builder.offset += alignedIndices.length;

  const indexView = builder.bufferViews.length;
  builder.bufferViews.push({
    buffer: 0,
    byteOffset: indexOffset,
    byteLength: indexBuffer.length,
    target: 34963,
  });

  const indexAccessor = builder.accessors.length;
  builder.accessors.push({
    bufferView: indexView,
    byteOffset: 0,
    componentType: 5123,
    count: geometry.indices.length,
    type: 'SCALAR',
    min: [0],
    max: [Math.max(...geometry.indices)],
  });

  return {
    attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
    indices: indexAccessor,
    material: materialIndex,
    mode: 4,
  };
}

function buildFemaleHeadModel() {
  const head = buildSphere(64, 24, 24, (x, y, z) => {
    const front = Math.max(0, z);
    const jaw = Math.max(0, -y);
    const sx = 0.82 - jaw * 0.18;
    const sy = 1.06 - jaw * 0.04;
    const sz = 0.76 + front * 0.22;
    return [x * sx, y * sy, z * sz + 0.06];
  });

  const torso = buildSphere(58, 20, 20, (x, y, z) => [x * 0.74, y * 1.16, z * 0.5]);
  const arm = buildSphere(22, 14, 14, (x, y, z) => [x * 0.42, y * 2.3, z * 0.42]);
  const hand = buildSphere(14, 12, 12, (x, y, z) => [x * 0.78, y * 0.9, z * 0.74]);
  const leg = buildSphere(24, 16, 16, (x, y, z) => [x * 0.44, y * 2.5, z * 0.44]);
  const foot = buildSphere(17, 12, 12, (x, y, z) => [x * 0.72, y * 0.34, z * 1.24]);
  const eye = buildSphere(11, 12, 12, (x, y, z) => [x * 1.1, y * 0.58, z * 0.35]);
  const mouth = buildSmileArc(36, 24, 17, (202 * Math.PI) / 180, (338 * Math.PI) / 180, 0);

  const builder = {
    chunks: [],
    offset: 0,
    accessors: [],
    bufferViews: [],
  };

  const headPrimitive = createPrimitive(builder, head, 0);
  const torsoPrimitive = createPrimitive(builder, torso, 0);
  const armPrimitive = createPrimitive(builder, arm, 0);
  const handPrimitive = createPrimitive(builder, hand, 1);
  const legPrimitive = createPrimitive(builder, leg, 0);
  const footPrimitive = createPrimitive(builder, foot, 1);
  const eyePrimitive = createPrimitive(builder, eye, 2);
  const mouthPrimitive = createPrimitive(builder, mouth, 2);

  const binary = Buffer.concat(builder.chunks);
  const gltf = {
    asset: { version: '2.0', generator: 'openclaw-fullbody-avatar-generator' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'HologramAvatarFullBody', children: [1, 2, 3, 4, 5] },
      { name: 'Torso_Main', mesh: 1, translation: [0, -8, 0], children: [6] },
      { name: 'Arm_Left', mesh: 2, translation: [-62, 28, 0], children: [10] },
      { name: 'Arm_Right', mesh: 2, translation: [62, 28, 0], children: [11] },
      { name: 'Leg_Left', mesh: 4, translation: [-26, -122, 0], children: [12] },
      { name: 'Leg_Right', mesh: 4, translation: [26, -122, 0], children: [13] },
      { name: 'Head_Main', mesh: 0, translation: [0, 96, 0], children: [7, 8, 9] },
      { name: 'Eye_Left', mesh: 6, translation: [-21, 13, 53] },
      { name: 'Eye_Right', mesh: 6, translation: [21, 13, 53] },
      { name: 'Mouth_Main', mesh: 7, translation: [0, -14, 58] },
      { name: 'Hand_Left', mesh: 3, translation: [0, -58, 0] },
      { name: 'Hand_Right', mesh: 3, translation: [0, -58, 0] },
      { name: 'Foot_Left', mesh: 5, translation: [0, -74, 20] },
      { name: 'Foot_Right', mesh: 5, translation: [0, -74, 20] },
    ],
    meshes: [
      { name: 'HeadMesh', primitives: [headPrimitive] },
      { name: 'TorsoMesh', primitives: [torsoPrimitive] },
      { name: 'ArmMesh', primitives: [armPrimitive] },
      { name: 'HandMesh', primitives: [handPrimitive] },
      { name: 'LegMesh', primitives: [legPrimitive] },
      { name: 'FootMesh', primitives: [footPrimitive] },
      { name: 'EyeMesh', primitives: [eyePrimitive] },
      { name: 'MouthMesh', primitives: [mouthPrimitive] },
    ],
    materials: [
      {
        name: 'BodyMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: [0.08, 0.84, 1.0, 0.36],
          metallicFactor: 0.0,
          roughnessFactor: 0.52,
        },
        emissiveFactor: [0.08, 0.42, 0.56],
        alphaMode: 'BLEND',
        doubleSided: true,
      },
      {
        name: 'LimbAccentMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: [0.18, 0.95, 1.0, 0.5],
          metallicFactor: 0.0,
          roughnessFactor: 0.4,
        },
        emissiveFactor: [0.16, 0.48, 0.58],
        alphaMode: 'BLEND',
        doubleSided: true,
      },
      {
        name: 'FaceFeatureMaterial',
        pbrMetallicRoughness: {
          baseColorFactor: [0.96, 0.99, 1.0, 0.92],
          metallicFactor: 0.0,
          roughnessFactor: 0.24,
        },
        emissiveFactor: [0.24, 0.44, 0.5],
        alphaMode: 'BLEND',
      },
    ],
    accessors: builder.accessors,
    bufferViews: builder.bufferViews,
    buffers: [
      {
        byteLength: binary.length,
        uri: `data:application/octet-stream;base64,${binary.toString('base64')}`,
      },
    ],
  };

  return gltf;
}

const outPath = path.join(process.cwd(), 'public', 'models', 'hologram-female-face.gltf');
const gltf = buildFemaleHeadModel();
fs.writeFileSync(outPath, `${JSON.stringify(gltf, null, 2)}\n`, 'utf8');
console.log(`Created ${outPath}`);
