declare module '@met4citizen/talkinghead' {
  export interface TalkingHeadOptions {
    avatarOnly?: boolean;
    avatarOnlyCamera?: unknown;
    avatarOnlyScene?: unknown;
    cameraRotateEnable?: boolean;
    cameraPanEnable?: boolean;
    cameraZoomEnable?: boolean;
    modelPixelRatio?: number;
    modelFPS?: number;
    update?: (dtMs: number) => void;
  }

  export interface TalkingHeadAvatarOptions {
    url: string;
    body?: 'M' | 'F';
    avatarMood?: string;
    lipsyncLang?: string;
    ttsLang?: string;
    ttsVoice?: string;
  }

  export class TalkingHead {
    constructor(node: HTMLElement, options?: TalkingHeadOptions);
    opt: TalkingHeadOptions;
    armature?: {
      position?: { set: (x: number, y: number, z: number) => void };
      rotation?: { set: (x: number, y: number, z: number) => void };
      scale?: { set: (x: number, y: number, z: number) => void };
    };
    audioCtx: AudioContext;
    audioSpeechGainNode?: AudioNode;
    mtAvatar?: Record<string, { newvalue?: number; needsUpdate?: boolean }>;
    showAvatar(avatar: TalkingHeadAvatarOptions): Promise<void>;
    animate(dtMs: number): void;
    setMood?(mood: string): void;
    playGesture?(gesture: string, duration?: number): void;
    lookAtCamera?(ms?: number): void;
    streamStart?(
      options?: Record<string, unknown>,
      onAudioStart?: () => void,
      onAudioEnd?: () => void,
      onSubtitles?: (text: string) => void,
    ): void;
    streamAudio?(chunk: { audio: ArrayBuffer | Int16Array }): void;
    streamNotifyEnd?(): void;
    streamInterrupt?(): void;
    streamStop?(): void;
  }
}

declare module '@met4citizen/headaudio' {
  export class HeadAudio extends AudioWorkletNode {
    constructor(audioCtx: AudioContext, options?: Record<string, unknown>);
    loadModel(url: string, reset?: boolean): Promise<void>;
    update(dtMs: number): void;
    onvalue: null | ((key: string, value: number) => void);
  }
}

declare module '@met4citizen/headaudio/modules/headaudio.mjs' {
  export class HeadAudio extends AudioWorkletNode {
    constructor(audioCtx: AudioContext, options?: Record<string, unknown>);
    loadModel(url: string, reset?: boolean): Promise<void>;
    update(dtMs: number): void;
    onvalue: null | ((key: string, value: number) => void);
  }
}
