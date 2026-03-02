export function int16ToBase64(arr: Int16Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function float32ToInt16Downsampled(
  float32: Float32Array,
  nativeSampleRate: number,
  targetSampleRate: number,
): Int16Array {
  const ratio = nativeSampleRate / targetSampleRate;
  const outLength = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const sample = float32[Math.floor(i * ratio)];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }

  return out;
}

export function pcm16Rms(chunk: Int16Array): number {
  if (chunk.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const normalized = chunk[i] / 32768;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / chunk.length);
}

export function createTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
