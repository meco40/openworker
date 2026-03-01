'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: FaceState;
  amplitude?: number;
  width?: number;
  height?: number;
}

const MIN_CAMERA_Z = 620;
const MAX_CAMERA_Z = 1200;
const ROTATION_SENSITIVITY = 0.0065;
const ZOOM_SENSITIVITY = 0.3;
const MIN_PITCH = -0.45;
const MAX_PITCH = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function MasterFaceCanvasThree({
  state,
  amplitude = 0,
  width = 400,
  height = 520,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<FaceState>(state);
  const ampRef = useRef<number>(amplitude);
  const frameRef = useRef<number>(0);
  const timeRef = useRef<number>(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const facePartsRef = useRef({
    eyeLeft: null as THREE.Object3D | null,
    eyeRight: null as THREE.Object3D | null,
    mouth: null as THREE.Object3D | null,
    eyeLeftBaseY: 1,
    eyeRightBaseY: 1,
    mouthBaseY: 1,
    mouthBaseZ: 1,
    mouthOpen: 1,
  });
  const bodyPartsRef = useRef({
    torso: null as THREE.Object3D | null,
    armLeft: null as THREE.Object3D | null,
    armRight: null as THREE.Object3D | null,
    legLeft: null as THREE.Object3D | null,
    legRight: null as THREE.Object3D | null,
    handLeft: null as THREE.Object3D | null,
    handRight: null as THREE.Object3D | null,
    footLeft: null as THREE.Object3D | null,
    footRight: null as THREE.Object3D | null,
  });
  const locomotionRef = useRef({
    walkCycle: 0,
    jumpOffset: 0,
    sitAmount: 0,
    posX: 0,
    posZ: 0,
    targetX: 0,
    targetZ: 0,
  });
  const interactionRef = useRef({
    yaw: 0,
    targetYaw: 0,
    pitch: 0,
    targetPitch: 0,
    zoom: 820,
    targetZoom: 820,
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
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    humanGroup: THREE.Group | null;
    materials: THREE.Material[];
  } | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  // GLTF laden
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
      zoom: 820,
      targetZoom: 820,
    };
    pointerStateRef.current = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      baseYaw: 0,
      basePitch: 0,
    };
    facePartsRef.current = {
      eyeLeft: null,
      eyeRight: null,
      mouth: null,
      eyeLeftBaseY: 1,
      eyeRightBaseY: 1,
      mouthBaseY: 1,
      mouthBaseZ: 1,
      mouthOpen: 1,
    };
    bodyPartsRef.current = {
      torso: null,
      armLeft: null,
      armRight: null,
      legLeft: null,
      legRight: null,
      handLeft: null,
      handRight: null,
      footLeft: null,
      footRight: null,
    };
    locomotionRef.current = {
      walkCycle: 0,
      jumpOffset: 0,
      sitAmount: 0,
      posX: 0,
      posZ: 0,
      targetX: 0,
      targetZ: 0,
    };

    // Szene
    const scene = new THREE.Scene();

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x00ffff, 2.5);
    dirLight.position.set(50, 100, 200);
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x8800ff, 2.0);
    fillLight.position.set(-100, -20, 50);
    scene.add(fillLight);

    // Kamera
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
    camera.position.set(0, 0, interactionRef.current.zoom);
    camera.lookAt(0, -14, 0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = 'none';

    // GLTF laden
    const loader = new GLTFLoader();
    let humanGroup: THREE.Group | null = null;
    const materials: THREE.Material[] = [];

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

    loader.load(
      '/models/hologram-female-face.gltf',
      (gltf) => {
        humanGroup = gltf.scene;
        if (sceneRef.current) {
          sceneRef.current.humanGroup = gltf.scene;
        }

        // Anpassungen am Modell
        humanGroup.position.set(0, -48, 0);
        humanGroup.scale.set(1.06, 1.06, 1.06);

        // Sammle alle Materialien für Animation
        const additionalMeshes: THREE.Mesh[] = [];
        humanGroup.traverse((child) => {
          if (child instanceof THREE.Mesh && !child.userData.isWireframeMesh) {
            child.geometry.computeVertexNormals();

            // Apply a nice holographic tech material
            const material = new THREE.MeshStandardMaterial({
              color: 0x00aaff,
              emissive: 0x002244,
              transparent: true,
              opacity: 0.8,
              wireframe: false,
              roughness: 0.2,
              metalness: 0.8,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            });
            child.material = material;
            materials.push(material);

            // Add an outline/wireframe helper mesh for the tech look
            const wireMaterial = new THREE.MeshBasicMaterial({
              color: 0x00ffff,
              wireframe: true,
              transparent: true,
              opacity: 0.2,
              blending: THREE.AdditiveBlending,
            });
            const wireMesh = new THREE.Mesh(child.geometry, wireMaterial);
            wireMesh.userData.isWireframeMesh = true;
            // Add to our list to attach after traversal completes
            additionalMeshes.push(wireMesh);
            // Link to parent so we easily know where to attach it
            wireMesh.userData.parent = child;

            materials.push(wireMaterial);
          }
        });

        // Add additional meshes without triggering the infinite traverse loop
        additionalMeshes.forEach((mesh) => {
          if (mesh.userData.parent) {
            mesh.userData.parent.add(mesh);
          }
        });

        scene.add(humanGroup);
        const eyeLeft = humanGroup.getObjectByName('Eye_Left');
        const eyeRight = humanGroup.getObjectByName('Eye_Right');
        const mouth = humanGroup.getObjectByName('Mouth_Main');
        const torso = humanGroup.getObjectByName('Torso_Main');
        const armLeft = humanGroup.getObjectByName('Arm_Left');
        const armRight = humanGroup.getObjectByName('Arm_Right');
        const legLeft = humanGroup.getObjectByName('Leg_Left');
        const legRight = humanGroup.getObjectByName('Leg_Right');
        const handLeft = humanGroup.getObjectByName('Hand_Left');
        const handRight = humanGroup.getObjectByName('Hand_Right');
        const footLeft = humanGroup.getObjectByName('Foot_Left');
        const footRight = humanGroup.getObjectByName('Foot_Right');
        facePartsRef.current.eyeLeft = eyeLeft ?? null;
        facePartsRef.current.eyeRight = eyeRight ?? null;
        facePartsRef.current.mouth = mouth ?? null;
        bodyPartsRef.current.torso = torso ?? null;
        bodyPartsRef.current.armLeft = armLeft ?? null;
        bodyPartsRef.current.armRight = armRight ?? null;
        bodyPartsRef.current.legLeft = legLeft ?? null;
        bodyPartsRef.current.legRight = legRight ?? null;
        bodyPartsRef.current.handLeft = handLeft ?? null;
        bodyPartsRef.current.handRight = handRight ?? null;
        bodyPartsRef.current.footLeft = footLeft ?? null;
        bodyPartsRef.current.footRight = footRight ?? null;
        if (eyeLeft) {
          facePartsRef.current.eyeLeftBaseY = eyeLeft.scale.y || 1;
        }
        if (eyeRight) {
          facePartsRef.current.eyeRightBaseY = eyeRight.scale.y || 1;
        }
        if (mouth) {
          facePartsRef.current.mouthBaseY = mouth.scale.y || 1;
          facePartsRef.current.mouthBaseZ = mouth.scale.z || 1;
        }
        setIsLoaded(true);
        setLoadError(null);
        console.log('✅ GLTF geladen:', materials.length, 'Materialien');
      },
      (progress) => {
        console.log('📥 Lade GLB:', ((progress.loaded / progress.total) * 100).toFixed(0) + '%');
      },
      (error) => {
        const message = error instanceof Error ? error.message : 'Unbekannter GLB-Ladefehler';
        setLoadError(message);
        setIsLoaded(false);
        console.error('❌ Fehler beim Laden:', error);
      },
    );

    sceneRef.current = {
      scene,
      camera,
      renderer,
      humanGroup,
      materials,
    };

    return () => {
      cancelAnimationFrame(frameRef.current);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.dispose();
      materials.forEach((m) => m.dispose());
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [width, height, reloadKey]);

  // Animation Loop
  useEffect(() => {
    if (!sceneRef.current || !isLoaded) return;
    const scene = sceneRef.current;
    let lastTime = 0;

    const animate = (time: number) => {
      frameRef.current = requestAnimationFrame(animate);

      const dt = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      timeRef.current += dt;
      const t = timeRef.current;
      const cs = stateRef.current;
      const amp = Math.min(1, ampRef.current);
      const interaction = interactionRef.current;
      const lerpRate = 1 - Math.exp(-10 * dt);
      interaction.yaw += (interaction.targetYaw - interaction.yaw) * lerpRate;
      interaction.pitch += (interaction.targetPitch - interaction.pitch) * lerpRate;
      interaction.zoom += (interaction.targetZoom - interaction.zoom) * lerpRate;
      scene.camera.position.z = interaction.zoom;
      scene.camera.lookAt(0, -14, 0);

      if (scene.humanGroup) {
        const locomotion = locomotionRef.current;
        const targetSit = cs === 'thinking' ? 1 : 0;
        locomotion.sitAmount += (targetSit - locomotion.sitAmount) * Math.min(1, dt * 4.5);
        locomotion.walkCycle += dt * (2.4 - locomotion.sitAmount * 1.5);

        const roaming = cs !== 'thinking';
        locomotion.targetX = roaming ? Math.sin(t * 0.37) * 120 : 0;
        locomotion.targetZ = roaming ? Math.cos(t * 0.29) * 78 : -10;
        locomotion.posX += (locomotion.targetX - locomotion.posX) * Math.min(1, dt * 2.2);
        locomotion.posZ += (locomotion.targetZ - locomotion.posZ) * Math.min(1, dt * 2.2);

        const jumpTarget = cs === 'speaking' ? Math.max(0, Math.sin(t * 6.3)) * (28 + amp * 34) : 0;
        locomotion.jumpOffset += (jumpTarget - locomotion.jumpOffset) * Math.min(1, dt * 12);

        const walkCycle = locomotion.walkCycle;
        const jumpOffset = locomotion.jumpOffset;
        const sitAmount = locomotion.sitAmount;

        scene.humanGroup.position.x = locomotion.posX;
        scene.humanGroup.position.z = locomotion.posZ;
        scene.humanGroup.position.y = -48 + jumpOffset - sitAmount * 34;
        scene.humanGroup.rotation.y =
          Math.sin(t * 0.2) * 0.12 + interaction.yaw + locomotion.posX * 0.0018;
        scene.humanGroup.rotation.x = interaction.pitch * 0.45;

        const breathFreq = cs === 'speaking' ? 4.5 : cs === 'listening' ? 2.2 : 1.0;
        const breath = 1 + Math.sin(t * breathFreq) * 0.012;
        scene.humanGroup.scale.set(1.06 * breath, 1.06 * breath, 1.06 * breath);

        const bodyParts = bodyPartsRef.current;
        const stride = Math.sin(walkCycle * 5.8) * (0.52 * (1 - sitAmount));
        const armSwing = stride * 0.72;
        const handSwing = Math.sin(walkCycle * 5.8 + Math.PI * 0.5) * (0.24 * (1 - sitAmount));

        if (bodyParts.torso) {
          bodyParts.torso.rotation.x = -sitAmount * 0.46;
          bodyParts.torso.position.y = -8 - sitAmount * 14;
        }
        if (bodyParts.armLeft) {
          bodyParts.armLeft.rotation.x = armSwing - sitAmount * 0.3;
          bodyParts.armLeft.rotation.z = -0.12 - sitAmount * 0.25;
        }
        if (bodyParts.armRight) {
          bodyParts.armRight.rotation.x = -armSwing - sitAmount * 0.3;
          bodyParts.armRight.rotation.z = 0.12 + sitAmount * 0.25;
        }
        if (bodyParts.handLeft) {
          bodyParts.handLeft.rotation.x = handSwing + sitAmount * 0.2;
        }
        if (bodyParts.handRight) {
          bodyParts.handRight.rotation.x = -handSwing + sitAmount * 0.2;
        }
        if (bodyParts.legLeft) {
          bodyParts.legLeft.rotation.x = stride + sitAmount * 1.08;
        }
        if (bodyParts.legRight) {
          bodyParts.legRight.rotation.x = -stride + sitAmount * 1.08;
        }
        if (bodyParts.footLeft) {
          bodyParts.footLeft.rotation.x = -stride * 0.6 - sitAmount * 0.65;
        }
        if (bodyParts.footRight) {
          bodyParts.footRight.rotation.x = stride * 0.6 - sitAmount * 0.65;
        }
      }
      const faceParts = facePartsRef.current;
      const blinkCarrier = Math.sin(t * 0.7) + 0.35 * Math.sin(t * 1.9 + 1.2);
      const blink = blinkCarrier > 1.12 ? clamp((blinkCarrier - 1.12) / 0.2, 0, 1) : 0;
      const eyeOpen = 1 - blink * 0.9;
      if (faceParts.eyeLeft) {
        faceParts.eyeLeft.scale.y = faceParts.eyeLeftBaseY * eyeOpen;
        faceParts.eyeLeft.rotation.y = Math.sin(t * 0.9) * 0.05;
      }
      if (faceParts.eyeRight) {
        faceParts.eyeRight.scale.y = faceParts.eyeRightBaseY * eyeOpen;
        faceParts.eyeRight.rotation.y = Math.sin(t * 0.9) * 0.05;
      }

      const speakingOpen = 1 + amp * 1.55 * (0.7 + Math.max(0, Math.sin(t * 14)));
      const idleOpen = 1 + 0.04 * Math.sin(t * 1.2);
      const thinkingOpen = 1.08 + 0.02 * Math.sin(t * 2.6);
      const targetMouthOpen =
        cs === 'speaking' ? speakingOpen : cs === 'thinking' ? thinkingOpen : idleOpen;
      faceParts.mouthOpen += (targetMouthOpen - faceParts.mouthOpen) * Math.min(1, dt * 14);
      if (faceParts.mouth) {
        faceParts.mouth.scale.y = faceParts.mouthBaseY * faceParts.mouthOpen;
        faceParts.mouth.scale.z = faceParts.mouthBaseZ * (1 + (faceParts.mouthOpen - 1) * 0.42);
      }

      // Farbanpassung je nach State
      const hue = cs === 'thinking' ? 0.58 : cs === 'speaking' ? 0.52 : 0.55;
      const color = new THREE.Color().setHSL(hue, 1, 0.5);
      const emissiveColor = new THREE.Color().setHSL(hue, 1, 0.2);

      scene.materials.forEach((mat) => {
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.color = color;
          mat.emissive = emissiveColor;
          mat.opacity = cs === 'speaking' ? 0.8 + amp * 0.2 : 0.7;
        } else if (mat instanceof THREE.MeshBasicMaterial) {
          mat.color = new THREE.Color().setHSL(hue, 1, 0.7);
          mat.opacity = cs === 'speaking' ? 0.4 + amp * 0.2 : 0.25;
        }
      });

      scene.renderer.render(scene.scene, scene.camera);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [isLoaded]);

  return (
    <div
      ref={containerRef}
      style={{
        width,
        height,
        display: 'block',
        background: 'transparent',
        position: 'relative',
      }}
      aria-label="AI avatar 3D wireframe visualisation"
    >
      {!isLoaded && !loadError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#00ddff',
            fontSize: '12px',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          Lade Hologramm...
        </div>
      )}
      {loadError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            padding: '20px',
            background: 'linear-gradient(160deg, rgba(9,31,74,0.82), rgba(8,45,90,0.68))',
            color: '#a5f3fc',
            fontSize: '12px',
            fontFamily: 'system-ui, sans-serif',
            textAlign: 'center',
          }}
        >
          <strong style={{ fontSize: '13px' }}>3D Hologramm konnte nicht geladen werden</strong>
          <span style={{ opacity: 0.8 }}>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            style={{
              marginTop: '4px',
              border: '1px solid rgba(34, 211, 238, 0.5)',
              background: 'rgba(8, 47, 73, 0.65)',
              color: '#67e8f9',
              borderRadius: '8px',
              padding: '6px 12px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
