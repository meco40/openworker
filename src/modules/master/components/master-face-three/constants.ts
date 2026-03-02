import type { FaceState } from './types';

export const MIN_CAMERA_Z = 1.4;
export const MAX_CAMERA_Z = 3.4;
export const ROTATION_SENSITIVITY = 0.0045;
export const ZOOM_SENSITIVITY = 0.0022;
export const MIN_PITCH = -0.45;
export const MAX_PITCH = 0.35;
export const AVATAR_MODEL_URL = '/models/master-avatar-rigged.glb';
export const CAMERA_BASE_Y = 1.2;
export const CAMERA_LOOK_AT_Y = 1.1;
export const AVATAR_BASE_Y = -0.75;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getMoodByState(state: FaceState): string {
  switch (state) {
    case 'listening':
      return 'neutral';
    case 'thinking':
      return 'sad';
    case 'speaking':
      return 'happy';
    default:
      return 'neutral';
  }
}
