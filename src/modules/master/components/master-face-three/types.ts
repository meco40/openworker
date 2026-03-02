import type { MasterAvatarAudioStream } from '../../types';

export type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface MasterFaceCanvasThreeProps {
  state: FaceState;
  amplitude?: number;
  width?: number;
  height?: number;
  outputAudioStream?: MasterAvatarAudioStream | null;
}
