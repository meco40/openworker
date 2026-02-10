import { describe, expect, it } from 'vitest';
import { createPcmBlob, decodeBase64, encodeBase64 } from '../services/audio';

describe('audio utilities', () => {
  it('encodes and decodes base64 without data loss', () => {
    const source = Uint8Array.from([0, 1, 2, 3, 127, 255]);
    const encoded = encodeBase64(source);
    const decoded = decodeBase64(encoded);

    expect(Array.from(decoded)).toEqual(Array.from(source));
  });

  it('clamps PCM data to int16 bounds', () => {
    const pcm = new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]);
    const encoded = createPcmBlob(pcm);
    const decoded = decodeBase64(encoded);
    const int16 = new Int16Array(decoded.buffer);

    expect(Array.from(int16)).toEqual([
      -32768,
      -32768,
      -16384,
      0,
      16384,
      32767,
      32767,
    ]);
  });
});
