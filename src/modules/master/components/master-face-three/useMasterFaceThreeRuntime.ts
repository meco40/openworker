'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Clock,
  AmbientLight,
  DirectionalLight,
  SRGBColorSpace,
} from 'three';
import type { HeadAudio } from '@met4citizen/headaudio';
import type { TalkingHead } from '@met4citizen/talkinghead';
import type { MasterAvatarAudioEvent } from '../../types';
import {
  AVATAR_BASE_Y,
  AVATAR_MODEL_URL,
  CAMERA_BASE_Y,
  CAMERA_LOOK_AT_Y,
  MAX_CAMERA_Z,
  MAX_PITCH,
  MIN_CAMERA_Z,
  MIN_PITCH,
  ROTATION_SENSITIVITY,
  ZOOM_SENSITIVITY,
  clamp,
  getMoodByState,
} from './constants';
import { toErrorMessage } from '@/shared/lib/errors';
import type { MasterFaceCanvasThreeProps, FaceState } from './types';

type HeadAudioCtor = typeof HeadAudio;
type TalkingHeadCtor = typeof TalkingHead;

interface AvatarRuntime {
  head: TalkingHead | null;
  headAudio: HeadAudio | null;
  currentMood: string;
  streamActiveTurnId: string | null;
  streamStarted: boolean;
  lastGestureAt: number;
  lastLookAtAt: number;
}

export function useMasterFaceThreeRuntime({
  state,
  amplitude = 0,
  width = 400,
  height = 520,
  outputAudioStream,
}: MasterFaceCanvasThreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<FaceState>(state);
  const ampRef = useRef<number>(amplitude);
  const frameRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const interactionRef = useRef({
    yaw: 0,
    targetYaw: 0,
    pitch: 0,
    targetPitch: 0,
    zoom: 2.2,
    targetZoom: 2.2,
  });
  const pointerStateRef = useRef<{
    active: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
    baseYaw: number;
    basePitch: number;
  }>({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    baseYaw: 0,
    basePitch: 0,
  });
  const sceneRef = useRef<{
    scene: Scene;
    camera: PerspectiveCamera;
    renderer: WebGLRenderer;
    clock: Clock;
  } | null>(null);
  const runtimeRef = useRef<AvatarRuntime>({
    head: null,
    headAudio: null,
    currentMood: 'neutral',
    streamActiveTurnId: null,
    streamStarted: false,
    lastGestureAt: 0,
    lastLookAtAt: 0,
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    setIsLoaded(false);
    setLoadError(null);

    interactionRef.current = {
      yaw: 0,
      targetYaw: 0,
      pitch: 0,
      targetPitch: 0,
      zoom: 2.2,
      targetZoom: 2.2,
    };
    pointerStateRef.current = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      baseYaw: 0,
      basePitch: 0,
    };

    const scene = new Scene();

    const ambientLight = new AmbientLight(0xffffff, 1.1);
    scene.add(ambientLight);

    const keyLight = new DirectionalLight(0x9fdfff, 2.6);
    keyLight.position.set(2.8, 4.2, 2.8);
    scene.add(keyLight);

    const fillLight = new DirectionalLight(0x4667ff, 1.3);
    fillLight.position.set(-2.6, 2.0, 1.8);
    scene.add(fillLight);

    const rimLight = new DirectionalLight(0x80ffff, 0.8);
    rimLight.position.set(0.4, 1.7, -2.8);
    scene.add(rimLight);

    const camera = new PerspectiveCamera(42, width / height, 0.1, 100);
    camera.position.set(0, CAMERA_BASE_Y, interactionRef.current.zoom);
    camera.lookAt(0, CAMERA_LOOK_AT_Y, 0);

    const renderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    const clock = new Clock();

    const onPointerDown = (event: PointerEvent) => {
      pointerStateRef.current.active = true;
      pointerStateRef.current.pointerId = event.pointerId;
      pointerStateRef.current.startX = event.clientX;
      pointerStateRef.current.startY = event.clientY;
      pointerStateRef.current.baseYaw = interactionRef.current.targetYaw;
      pointerStateRef.current.basePitch = interactionRef.current.targetPitch;
      renderer.domElement.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (
        !pointerStateRef.current.active ||
        pointerStateRef.current.pointerId === null ||
        pointerStateRef.current.pointerId !== event.pointerId
      ) {
        return;
      }
      const dx = event.clientX - pointerStateRef.current.startX;
      const dy = event.clientY - pointerStateRef.current.startY;
      interactionRef.current.targetYaw =
        pointerStateRef.current.baseYaw + dx * ROTATION_SENSITIVITY;
      interactionRef.current.targetPitch = clamp(
        pointerStateRef.current.basePitch + dy * ROTATION_SENSITIVITY,
        MIN_PITCH,
        MAX_PITCH,
      );
    };

    const onPointerUp = (event: PointerEvent) => {
      if (pointerStateRef.current.pointerId !== event.pointerId) return;
      pointerStateRef.current.active = false;
      pointerStateRef.current.pointerId = null;
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      interactionRef.current.targetZoom = clamp(
        interactionRef.current.targetZoom + event.deltaY * ZOOM_SENSITIVITY,
        MIN_CAMERA_Z,
        MAX_CAMERA_Z,
      );
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    let disposed = false;

    const loadTalkingHead = async (): Promise<void> => {
      try {
        const [{ TalkingHead: TalkingHeadClass }, { HeadAudio: HeadAudioClass }] =
          await Promise.all([
            import('../../vendor/talkinghead/talkinghead.mjs') as unknown as Promise<{
              TalkingHead: TalkingHeadCtor;
            }>,
            import('@met4citizen/headaudio/modules/headaudio.mjs') as Promise<{
              HeadAudio: HeadAudioCtor;
            }>,
          ]);

        if (disposed) return;

        const head = new TalkingHeadClass(container, {
          avatarOnly: true,
          avatarOnlyCamera: camera,
          avatarOnlyScene: scene,
          cameraRotateEnable: false,
          cameraPanEnable: false,
          cameraZoomEnable: false,
          modelPixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          modelFPS: 30,
        });

        await head.showAvatar({
          url: AVATAR_MODEL_URL,
          body: 'F',
          avatarMood: 'neutral',
          lipsyncLang: 'en',
          ttsLang: 'en-US',
          ttsVoice: 'en-US-Standard-F',
        });

        if (disposed) {
          head.streamStop?.();
          return;
        }

        head.armature?.position?.set(0, AVATAR_BASE_Y, 0);
        head.armature?.scale?.set(1.0, 1.0, 1.0);

        await head.audioCtx.audioWorklet.addModule('/vendor/headaudio/headworklet.mjs');
        const headAudio = new HeadAudioClass(head.audioCtx, {
          parameterData: {
            vadGateActiveDb: -42,
            vadGateInactiveDb: -58,
          },
        });
        await headAudio.loadModel('/vendor/headaudio/model-en-mixed.bin');

        if (head.audioSpeechGainNode) {
          head.audioSpeechGainNode.connect(headAudio);
        }

        headAudio.onvalue = (key, value) => {
          const target = head.mtAvatar?.[key];
          if (!target) return;
          Object.assign(target, { newvalue: value, needsUpdate: true });
        };

        const previousUpdate = head.opt.update;
        head.opt.update = (dtMs: number) => {
          headAudio.update(dtMs);
          previousUpdate?.(dtMs);
        };

        runtimeRef.current = {
          head,
          headAudio,
          currentMood: 'neutral',
          streamActiveTurnId: null,
          streamStarted: false,
          lastGestureAt: 0,
          lastLookAtAt: 0,
        };

        setIsLoaded(true);
      } catch (error) {
        setLoadError(toErrorMessage(error));
        setIsLoaded(false);
      }
    };

    void loadTalkingHead();

    sceneRef.current = {
      scene,
      camera,
      renderer,
      clock,
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(frameRef.current);
      const runtime = runtimeRef.current;
      runtime.head?.streamInterrupt?.();
      runtime.head?.streamStop?.();
      runtime.headAudio?.disconnect();
      runtime.head = null;
      runtime.headAudio = null;
      runtime.streamActiveTurnId = null;
      runtime.streamStarted = false;

      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, [width, height, reloadKey]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!outputAudioStream || !runtime.head) return;

    const unsubscribe = outputAudioStream.subscribe((event: MasterAvatarAudioEvent) => {
      const activeRuntime = runtimeRef.current;
      const head = activeRuntime.head;
      if (!head) return;

      try {
        switch (event.type) {
          case 'start':
            if (activeRuntime.streamStarted) {
              head.streamInterrupt?.();
            }
            head.streamStart?.({
              sampleRate: event.sampleRate,
              lipsyncType: 'visemes',
              lipsyncLang: 'en',
              waitForAudioChunks: true,
              mood: getMoodByState(stateRef.current),
            });
            activeRuntime.streamStarted = true;
            activeRuntime.streamActiveTurnId = event.turnId;
            break;
          case 'chunk':
            if (!activeRuntime.streamStarted) {
              head.streamStart?.({
                sampleRate: event.sampleRate,
                lipsyncType: 'visemes',
                lipsyncLang: 'en',
                waitForAudioChunks: true,
                mood: getMoodByState(stateRef.current),
              });
              activeRuntime.streamStarted = true;
              activeRuntime.streamActiveTurnId = event.turnId;
            }
            head.streamAudio?.({ audio: event.pcm16 });
            break;
          case 'end':
            if (activeRuntime.streamActiveTurnId === event.turnId) {
              head.streamNotifyEnd?.();
              activeRuntime.streamStarted = false;
              activeRuntime.streamActiveTurnId = null;
            }
            break;
          case 'cancel':
          case 'error':
            if (activeRuntime.streamActiveTurnId === event.turnId) {
              head.streamInterrupt?.();
              activeRuntime.streamStarted = false;
              activeRuntime.streamActiveTurnId = null;
            }
            break;
          default:
            break;
        }
      } catch (error) {
        setLoadError(toErrorMessage(error));
      }
    });

    return () => unsubscribe();
  }, [outputAudioStream, isLoaded]);

  useEffect(() => {
    if (!sceneRef.current) return;

    const scene = sceneRef.current;

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);

      const dt = Math.min(scene.clock.getDelta(), 0.05);
      timeRef.current += dt;
      const t = timeRef.current;

      const interaction = interactionRef.current;
      const lerpRate = 1 - Math.exp(-10 * dt);
      interaction.yaw += (interaction.targetYaw - interaction.yaw) * lerpRate;
      interaction.pitch += (interaction.targetPitch - interaction.pitch) * lerpRate;
      interaction.zoom += (interaction.targetZoom - interaction.zoom) * lerpRate;

      scene.camera.position.x = Math.sin(interaction.yaw) * 0.85;
      scene.camera.position.y = CAMERA_BASE_Y + interaction.pitch * 0.7;
      scene.camera.position.z = interaction.zoom;
      scene.camera.lookAt(0, CAMERA_LOOK_AT_Y, 0);

      const runtime = runtimeRef.current;
      const head = runtime.head;
      if (head?.armature) {
        const speakingBoost = stateRef.current === 'speaking' ? ampRef.current * 0.04 : 0;
        const breathing = Math.sin(t * 1.5) * 0.012;
        head.armature.position?.set(0, AVATAR_BASE_Y + breathing + speakingBoost, 0);
        head.armature.rotation?.set(0, interaction.yaw * 0.9, 0);
      }

      if (head) {
        const targetMood = getMoodByState(stateRef.current);
        if (runtime.currentMood !== targetMood && typeof head.setMood === 'function') {
          head.setMood(targetMood);
          runtime.currentMood = targetMood;
        }

        const now = performance.now();
        if (
          stateRef.current === 'speaking' &&
          ampRef.current > 0.18 &&
          now - runtime.lastGestureAt > 1800 &&
          typeof head.playGesture === 'function'
        ) {
          runtime.lastGestureAt = now;
          try {
            head.playGesture('🙂', 2.1);
          } catch {
            // Ignore missing gesture template in avatar packs.
          }
        }

        if (
          (stateRef.current === 'listening' || stateRef.current === 'thinking') &&
          now - runtime.lastLookAtAt > 1200 &&
          typeof head.lookAtCamera === 'function'
        ) {
          runtime.lastLookAtAt = now;
          head.lookAtCamera(280);
        }

        head.animate(dt * 1000);
      }

      scene.renderer.render(scene.scene, scene.camera);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [isLoaded]);

  return {
    containerRef,
    isLoaded,
    loadError,
    retry: () => setReloadKey((value) => value + 1),
  };
}
