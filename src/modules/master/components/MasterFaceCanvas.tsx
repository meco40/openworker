'use client';

import React, { useEffect, useRef } from 'react';

export type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: FaceState;
  amplitude?: number;
  width?: number;
  height?: number;
}

interface Vert {
  ox: number;
  oy: number;
  oz: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  px: number;
  py: number;
  depth: number;
}

interface Edge {
  a: number;
  b: number;
}

// ─── Model constants ──────────────────────────────────────────────────────────
const N_LON = 24; // longitude segments – more = smoother, more organic
const MODEL_W = 400;
const MODEL_H = 520;
const CX = MODEL_W / 2; // 200
const FOCAL = 3200;

// ─── Rings: define a feminine bust viewed from front ─────────────────────────
// Head is taller than wide (vertical oval), narrow graceful neck, broad shoulders.
// Each ring: y = vertical position, rx = horizontal radius, rz = front-back depth.
const RINGS = [
  // ── head (elongated vertical oval) ───────────────────────────────────────
  { y: 10, rx: 7, rz: 6 }, //  0 crown tip
  { y: 32, rx: 55, rz: 48 }, //  1 upper skull
  { y: 62, rx: 88, rz: 76 }, //  2 temple / widest skull
  { y: 90, rx: 95, rz: 82 }, //  3 forehead / temple (widest)
  { y: 118, rx: 92, rz: 79 }, //  4 eye level
  { y: 144, rx: 86, rz: 74 }, //  5 nose level
  { y: 166, rx: 76, rz: 66 }, //  6 upper lip
  { y: 184, rx: 64, rz: 56 }, //  7 mouth
  { y: 200, rx: 46, rz: 40 }, //  8 chin
  // ── neck ─────────────────────────────────────────────────────────────────
  { y: 216, rx: 28, rz: 24 }, //  9 under chin
  { y: 234, rx: 26, rz: 22 }, // 10 mid neck
  { y: 254, rx: 28, rz: 24 }, // 11 lower neck
  // ── shoulders / chest ────────────────────────────────────────────────────
  { y: 272, rx: 88, rz: 44, rot: 0.08 }, // 12 collarbone flare
  { y: 290, rx: 145, rz: 62, rot: 0.1 }, // 13 shoulder top (dramatic)
  { y: 316, rx: 158, rz: 74 }, // 14 upper chest
  { y: 348, rx: 155, rz: 82 }, // 15 chest mid
  { y: 384, rx: 151, rz: 88 }, // 16 chest lower
  { y: 424, rx: 148, rz: 92 }, // 17 chest bottom
  { y: 468, rx: 145, rz: 94 }, // 18 frame bottom
];

// ─── Build mesh ───────────────────────────────────────────────────────────────
function buildMesh() {
  const verts: Vert[] = [];
  const edges: Edge[] = [];
  const starts: number[] = [];

  // Vertices ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < RINGS.length; i++) {
    starts.push(verts.length);
    const { y, rx, rz, rot = 0 } = RINGS[i];
    for (let j = 0; j < N_LON; j++) {
      const theta = (j / N_LON) * Math.PI * 2 + rot;
      verts.push({
        ox: rx * Math.cos(theta),
        oy: y,
        oz: rz * Math.sin(theta),
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        px: 0,
        py: 0,
        depth: 0,
      });
    }
  }
  for (const v of verts) {
    v.x = v.ox;
    v.y = v.oy;
    v.z = v.oz;
  }

  // Horizontal ring edges (skip tiny crown ring) ──────────────────────────────
  for (let i = 0; i < RINGS.length; i++) {
    if (RINGS[i].rx < 14) continue;
    const base = starts[i];
    for (let j = 0; j < N_LON; j++) edges.push({ a: base + j, b: base + ((j + 1) % N_LON) });
  }

  // Vertical + diagonal between adjacent rings ────────────────────────────────
  for (let i = 0; i < RINGS.length - 1; i++) {
    const b0 = starts[i],
      b1 = starts[i + 1];
    for (let j = 0; j < N_LON; j++) {
      edges.push({ a: b0 + j, b: b1 + j }); // straight down
      edges.push({ a: b0 + j, b: b1 + ((j + 1) % N_LON) }); // diagonal right
    }
  }

  // Irregular "skip" edges — connect every 3rd vertex across 2 rings apart.
  // This creates the organic Delaunay-like criss-cross seen in the reference.
  for (let i = 0; i < RINGS.length - 2; i++) {
    if (RINGS[i].rx < 20) continue;
    const b0 = starts[i],
      b2 = starts[i + 2];
    for (let j = 0; j < N_LON; j += 3) {
      edges.push({ a: b0 + j, b: b2 + ((j + 2) % N_LON) });
      edges.push({ a: b0 + j, b: b2 + ((j + N_LON - 2) % N_LON) });
    }
  }

  // Extra diagonal skips on the face region (rings 0–8) for dense facial mesh
  for (let i = 0; i < 8; i++) {
    const b0 = starts[i],
      b1 = starts[i + 1];
    for (let j = 0; j < N_LON; j += 2) {
      edges.push({ a: b0 + j, b: b1 + ((j + 2) % N_LON) });
    }
  }

  return { verts, edges };
}

const MESH = buildMesh();

// ─── Component ────────────────────────────────────────────────────────────────
export default function MasterFaceCanvas({
  state,
  amplitude = 0,
  width = 400,
  height = 520,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<FaceState>(state);
  const ampRef = useRef<number>(amplitude);
  const rafRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const DPR = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const scaleX = (width * DPR) / MODEL_W;
    const scaleY = (height * DPR) / MODEL_H;
    canvas.width = width * DPR;
    canvas.height = height * DPR;

    const CY_MODEL = MODEL_H * 0.5;
    const { verts, edges } = MESH;
    const c: HTMLCanvasElement = canvas;
    const x: CanvasRenderingContext2D = ctx;

    function project(v: Vert) {
      const s = FOCAL / (FOCAL - v.z);
      v.px = CX + v.x * s;
      v.py = CY_MODEL + (v.y - CY_MODEL) * s;
      v.depth = Math.max(0, Math.min(1, (v.z + 94) / 188));
    }

    let lastTs = 0;

    function render(ts: number) {
      rafRef.current = requestAnimationFrame(render);
      const dt = Math.min((ts - lastTs) / 1000, 0.05);
      lastTs = ts;
      timeRef.current += dt;
      const t = timeRef.current;
      const cs = stateRef.current;
      const amp = Math.min(1, ampRef.current);

      x.clearRect(0, 0, c.width, c.height);

      // ── deep background glow (navy core, black outer) ──────────────────────
      {
        const gx = c.width * 0.5;
        const gy = c.height * 0.42;
        const gr = Math.max(c.width, c.height) * 0.8;
        const ci =
          cs === 'speaking'
            ? 0.32 + amp * 0.22
            : cs === 'listening'
              ? 0.22 + Math.sin(t * 3) * 0.06
              : cs === 'thinking'
                ? 0.18 + Math.sin(t * 1.4) * 0.04
                : 0.15 + Math.sin(t * 0.5) * 0.01;
        const g = x.createRadialGradient(gx, gy, 0, gx, gy, gr);
        g.addColorStop(0, `hsla(225, 60%, 14%, ${ci})`);
        g.addColorStop(0.45, `hsla(218, 70%, 9%,  ${ci * 0.7})`);
        g.addColorStop(1, 'transparent');
        x.fillStyle = g;
        x.fillRect(0, 0, c.width, c.height);
      }

      // ── outer body aura (blue-purple haze behind the figure) ───────────────
      {
        const ax = c.width * 0.5;
        const ay = c.height * 0.55;
        const ag = x.createRadialGradient(ax, ay, 0, ax, ay, c.height * 0.55);
        const aInt = cs === 'speaking' ? 0.22 + amp * 0.14 : 0.12 + Math.sin(t * 0.8) * 0.02;
        ag.addColorStop(0, `hsla(210, 100%, 55%, ${aInt})`);
        ag.addColorStop(0.5, `hsla(240, 80%,  40%, ${aInt * 0.5})`);
        ag.addColorStop(1, 'transparent');
        x.fillStyle = ag;
        x.fillRect(0, 0, c.width, c.height);
      }

      x.save();
      x.scale(scaleX, scaleY);

      // ── spring-animate vertices ─────────────────────────────────────────────
      for (const v of verts) {
        let tx = v.ox,
          ty = v.oy,
          tz = v.oz;
        let stiff = 9,
          damp = 0.87;

        // gentle breathing — stronger in chest area
        ty += Math.sin(t * 0.7) * 2.8 * (v.oy / MODEL_H);

        if (cs === 'speaking') {
          // radial wave from face centre (y ≈ 118, eye level)
          const dx = v.ox,
            dy = v.oy - 118;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const nd = dist / (MODEL_W * 0.5);
          const wave = Math.sin(t * 13 - nd * 9 + v.oz * 0.05) * (5 + amp * 16);
          const waveZ = Math.cos(t * 10 - nd * 7) * (3 + amp * 11);
          tx += (dx / dist) * wave * 0.4;
          ty += (dy / dist) * wave * 0.28;
          tz += waveZ;
          stiff = 5;
          damp = 0.82;
        } else if (cs === 'listening') {
          tx += Math.sin(t * 2.1 + v.oz * 0.09) * 2.2;
          tz += Math.cos(t * 1.8 + v.ox * 0.04) * 3.8;
          stiff = 7;
          damp = 0.87;
        } else if (cs === 'thinking') {
          const sw = t * 0.85 + (v.oy / MODEL_H) * Math.PI * 1.4;
          tx += Math.sin(sw + v.oz * 0.06) * 4.2;
          tz += Math.cos(sw * 0.62 + v.ox * 0.05) * 5.2;
          stiff = 4;
          damp = 0.88;
        } else {
          tx += Math.sin(t * 0.5 + v.oy * 0.008) * 1.1;
        }

        v.vx = (v.vx + (tx - v.x) * stiff * dt) * damp;
        v.vy = (v.vy + (ty - v.y) * stiff * dt) * damp;
        v.vz = (v.vz + (tz - v.z) * stiff * dt) * damp;
        v.x += v.vx;
        v.y += v.vy;
        v.z += v.vz;
        project(v);
      }

      // ── draw edges in 10 depth buckets ─────────────────────────────────────
      const BUCKETS = 10;
      const buckets: Edge[][] = Array.from({ length: BUCKETS }, () => []);
      for (const e of edges) {
        const d = (verts[e.a].depth + verts[e.b].depth) * 0.5;
        buckets[Math.min(BUCKETS - 1, Math.floor(d * BUCKETS))].push(e);
      }

      const baseHue =
        cs === 'thinking' ? 210 + Math.sin(t * 1.8) * 14 : cs === 'speaking' ? 200 + amp * 18 : 205;

      for (let bi = 0; bi < BUCKETS; bi++) {
        const bk = buckets[bi];
        if (!bk.length) continue;
        const depth = (bi + 0.5) / BUCKETS;
        const alpha =
          cs === 'speaking'
            ? 0.12 + depth * 0.68 + amp * 0.16
            : cs === 'listening'
              ? 0.12 + depth * 0.65 + 0.05
              : 0.1 + depth * 0.62;
        const light = 48 + depth * 34; // 48 % back … 82 % front
        const sat = 85 + depth * 15; // more saturated on front

        // soft glow halo pass
        x.beginPath();
        for (const e of bk) {
          x.moveTo(verts[e.a].px, verts[e.a].py);
          x.lineTo(verts[e.b].px, verts[e.b].py);
        }
        x.strokeStyle = `hsla(${baseHue}, ${sat}%, ${light}%, ${alpha * 0.28})`;
        x.lineWidth = 4.0;
        x.stroke();

        // sharp bright core
        x.beginPath();
        for (const e of bk) {
          x.moveTo(verts[e.a].px, verts[e.a].py);
          x.lineTo(verts[e.b].px, verts[e.b].py);
        }
        x.strokeStyle = `hsla(${baseHue}, ${sat}%, ${light}%, ${alpha})`;
        x.lineWidth = 0.7;
        x.stroke();
      }

      // ── glowing vertex nodes ────────────────────────────────────────────────
      const vHue = cs === 'thinking' ? 212 + Math.sin(t * 2) * 16 : cs === 'speaking' ? 198 : 208;
      for (const v of verts) {
        const r = 0.8 + v.depth * 1.8;
        const a = 0.3 + v.depth * 0.7;
        const l = 58 + v.depth * 36;
        // outer halo
        x.beginPath();
        x.arc(v.px, v.py, r * 5, 0, Math.PI * 2);
        x.fillStyle = `hsla(${vHue}, 100%, 80%, ${v.depth * 0.22})`;
        x.fill();
        // inner bright dot
        x.beginPath();
        x.arc(v.px, v.py, r, 0, Math.PI * 2);
        x.fillStyle = `hsla(${vHue}, 100%, ${l}%, ${a})`;
        x.fill();
      }

      // ── state overlays ──────────────────────────────────────────────────────
      if (cs === 'listening') {
        for (let p = 0; p < 2; p++) {
          const phase = (t * 0.65 + p * 0.5) % 1;
          x.strokeStyle = `hsla(205, 100%, 70%, ${(1 - phase) * 0.15})`;
          x.lineWidth = 1.5;
          x.beginPath();
          x.arc(CX, 118, phase * 240, 0, Math.PI * 2);
          x.stroke();
        }
      }

      if (cs === 'thinking') {
        const sy = 8 + ((t * 55) % (MODEL_H - 16));
        const sh = 60;
        const sg = x.createLinearGradient(0, sy - sh * 0.5, 0, sy + sh * 0.5);
        sg.addColorStop(0, 'transparent');
        sg.addColorStop(0.5, `hsla(210, 100%, 65%, 0.09)`);
        sg.addColorStop(1, 'transparent');
        x.fillStyle = sg;
        x.fillRect(0, sy - sh * 0.5, MODEL_W, sh);
      }

      if (cs === 'speaking' && amp > 0.1) {
        const count = Math.floor(amp * 9);
        for (let i = 0; i < count; i++) {
          const v = verts[Math.floor(Math.random() * verts.length)];
          const fr = (0.6 + Math.random() * 2.4) * (1 + amp * 0.9);
          x.beginPath();
          x.arc(v.px, v.py, fr, 0, Math.PI * 2);
          x.fillStyle = `rgba(180, 230, 255, ${amp * 0.9})`;
          x.fill();
        }
      }

      if (cs === 'idle') {
        const ip = (Math.sin(t * 1.05) * 0.5 + 0.5) * 0.08 + 0.02;
        const ig = x.createRadialGradient(CX, 118, 0, CX, 118, 140);
        ig.addColorStop(0, `hsla(208, 88%, 62%, ${ip})`);
        ig.addColorStop(1, 'transparent');
        x.fillStyle = ig;
        x.fillRect(CX - 140, 0, 280, 280);
      }

      x.restore();
    }

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: 'block' }}
      aria-label="AI avatar wireframe visualisation"
    />
  );
}
