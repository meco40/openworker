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
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    humanGroup: THREE.Group | null;
    scanLine: THREE.Mesh;
    glowMesh: THREE.Mesh;
    materials: THREE.Material[];
  } | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  // GLB laden
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    // Szene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Kamera
    const camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
    camera.position.set(0, 0, 700);

    // Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Glow-Mesh (Aura)
    const glowGeo = new THREE.SphereGeometry(200, 32, 32);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x0066ff,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const glowMesh = new THREE.Mesh(glowGeo, glowMat);
    glowMesh.position.y = 30;
    glowMesh.scale.set(1, 1.4, 0.7);
    scene.add(glowMesh);

    // Scan-Line
    const scanGeo = new THREE.PlaneGeometry(400, 2);
    const scanMat = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const scanLine = new THREE.Mesh(scanGeo, scanMat);
    scanLine.position.z = 50;
    scene.add(scanLine);

    // GLB laden
    const loader = new GLTFLoader();
    let humanGroup: THREE.Group | null = null;
    const materials: THREE.Material[] = [];

    loader.load(
      '/models/hologram-female.glb',
      (gltf) => {
        humanGroup = gltf.scene;

        // Anpassungen am Modell
        humanGroup.position.set(0, -20, 0);
        humanGroup.scale.set(1.2, 1.2, 1.2);

        // Sammle alle Materialien für Animation
        humanGroup.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            if (Array.isArray(child.material)) {
              materials.push(...child.material);
            } else {
              materials.push(child.material);
            }

            // Aktiviere AdditiveBlending für alle Materialien
            if (child.material instanceof THREE.Material) {
              child.material.blending = THREE.AdditiveBlending;
              child.material.depthWrite = false;
              child.material.transparent = true;
            }
          }
          if (child instanceof THREE.LineSegments) {
            if (Array.isArray(child.material)) {
              materials.push(...child.material);
            } else {
              materials.push(child.material);
            }
          }
          if (child instanceof THREE.Points) {
            if (Array.isArray(child.material)) {
              materials.push(...child.material);
            } else {
              materials.push(child.material);
            }
          }
        });

        scene.add(humanGroup);
        setIsLoaded(true);
        console.log('✅ GLB geladen:', materials.length, 'Materialien');
      },
      (progress) => {
        console.log('📥 Lade GLB:', ((progress.loaded / progress.total) * 100).toFixed(0) + '%');
      },
      (error) => {
        console.error('❌ Fehler beim Laden:', error);
      },
    );

    sceneRef.current = {
      scene,
      camera,
      renderer,
      humanGroup,
      scanLine,
      glowMesh,
      materials,
    };

    return () => {
      cancelAnimationFrame(frameRef.current);
      renderer.dispose();
      materials.forEach((m) => m.dispose());
      glowMat.dispose();
      scanMat.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [width, height]);

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

      if (scene.humanGroup) {
        // Sanfte Rotation
        scene.humanGroup.rotation.y = Math.sin(t * 0.25) * 0.08;

        // Atmung
        const breathFreq = cs === 'speaking' ? 4 : cs === 'listening' ? 2 : 0.8;
        const breath = 1 + Math.sin(t * breathFreq) * 0.015;
        scene.humanGroup.scale.set(1.2 * breath, 1.2 * breath, 1.2 * breath);

        // Glitch-Effekt beim Sprechen
        if (cs === 'speaking' && amp > 0.2) {
          if (Math.random() > 0.9) {
            scene.humanGroup.position.x = (Math.random() - 0.5) * 4 * amp;
          }
          if (Math.random() > 0.95) {
            scene.humanGroup.position.z = (Math.random() - 0.5) * 3 * amp;
          }
        } else {
          scene.humanGroup.position.x *= 0.9;
          scene.humanGroup.position.z *= 0.9;
        }
      }

      // Scan-Line Bewegung
      const scanY = Math.sin(t * 0.7) * 120;
      scene.scanLine.position.y = scanY;
      (scene.scanLine.material as THREE.MeshBasicMaterial).opacity =
        cs === 'speaking' ? 0.8 + amp * 0.2 : 0.5;

      // Glow-Pulsieren
      const glowPulse = 1 + Math.sin(t) * 0.05 + amp * 0.08;
      scene.glowMesh.scale.set(glowPulse, glowPulse * 1.4, glowPulse * 0.7);
      (scene.glowMesh.material as THREE.MeshBasicMaterial).opacity =
        cs === 'speaking' ? 0.15 + amp * 0.1 : 0.1;

      // Farbanpassung je nach State
      const hue = cs === 'thinking' ? 0.58 : cs === 'speaking' ? 0.52 : 0.55;
      const color = new THREE.Color().setHSL(hue, 1, 0.5);

      scene.materials.forEach((mat) => {
        if (mat instanceof THREE.LineBasicMaterial) {
          mat.color = color;
          mat.opacity = cs === 'speaking' ? 0.6 + amp * 0.25 : 0.5;
        }
        if (mat instanceof THREE.PointsMaterial) {
          mat.color = color;
          mat.opacity = cs === 'speaking' ? 0.9 + amp * 0.1 : 0.8;
        }
        if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
          if ('color' in mat) {
            mat.color = color;
          }
          if ('opacity' in mat) {
            mat.opacity = cs === 'speaking' ? 0.4 + amp * 0.2 : 0.3;
          }
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
        background: '#000000',
        position: 'relative',
      }}
      aria-label="AI avatar 3D wireframe visualisation"
    >
      {!isLoaded && (
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
    </div>
  );
}
