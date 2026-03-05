import type { FaceState } from '../../components/master-face-three/types';
import type { MasterAvatarAudioListener } from '../../types';

export type VoiceAgentStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'unsupported';

export interface UseGrokVoiceAgentOptions {
  personaId?: string;
  workspaceId?: string;
  onStatusChange?: (status: VoiceAgentStatus) => void;
}

export interface UseGrokVoiceAgentResult {
  status: VoiceAgentStatus;
  faceState: FaceState;
  amplitude: number;
  transcript: string;
  aiResponse: string;
  error: string | null;
  sttSupported: boolean;
  ttsSupported: boolean;
  connected: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  cancel: () => void;
  submitText: (text: string) => Promise<void>;
  replay: () => void;
  subscribeOutputAudio: (listener: MasterAvatarAudioListener) => () => void;
}

export type RealtimeParsedEvent =
  | { type: 'speech_started' }
  | { type: 'response_created' }
  | { type: 'output_audio_delta'; pcm16: Int16Array }
  | { type: 'output_audio_transcript_delta'; delta: string }
  | { type: 'input_audio_transcription_completed'; transcript: string }
  | { type: 'response_output_audio_done' }
  | { type: 'response_done' };
