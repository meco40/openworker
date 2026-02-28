'use client';

import React, { useEffect, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Particle {
  // home position (normalized 0–1)
  hx: number;
  hy: number;
  // current position
  x: number;
  y: number;
  // velocity
  vx: number;
  vy: number;
  // visual
  baseSize: number;
  size: number;
  opacity: number;
  hue: number; // 0–360
  brightness: number;
  // animation phase offset
  phase: number;
  speed: number;
  // explode vector (normalised)
  ex: number;
  ey: number;
}

interface Props {
  state: FaceState;
  /** 0–1 audio amplitude when speaking/listening */
  amplitude?: number;
  width?: number;
  height?: number;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Sample N evenly-spaced points along an ellipse arc */
function sampleEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n: number,
  startAngle = 0,
  endAngle = Math.PI * 2,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = startAngle + (i / n) * (endAngle - startAngle);
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

/** Sample points along a cubic bezier */
function sampleBezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  n: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = 1 - t;
    const x = u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0];
    const y = u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1];
    pts.push([x, y]);
  }
  return pts;
}

/** Sample points along a quadratic bezier */
function sampleQuad(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  n: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = 1 - t;
    const x = u ** 2 * p0[0] + 2 * u * t * p1[0] + t ** 2 * p2[0];
    const y = u ** 2 * p0[1] + 2 * u * t * p1[1] + t ** 2 * p2[1];
    pts.push([x, y]);
  }
  return pts;
}

/** Add scattered fill particles inside a circle */
function sampleCircleFill(cx: number, cy: number, r: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const angle = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * r;
    pts.push([cx + Math.cos(angle) * rad, cy + Math.sin(angle) * rad]);
  }
  return pts;
}

/** Scatter points in a region uniformly */
function sampleScatter(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    pts.push([cx + (Math.random() - 0.5) * 2 * rx, cy + (Math.random() - 0.5) * 2 * ry]);
  }
  return pts;
}

// ─── Build face particle positions (on a 400×500 canvas) ─────────────────────
// Feminine proportions: narrow oval, large almond eyes, high-arched thin brows,
// small delicate nose, Cupid's bow lips, V-jaw, high cheekbones, slim neck.

function buildFacePoints(): Array<[number, number]> {
  const W = 400;
  const H = 500;
  const cx = W / 2; // 200
  const cy = H * 0.42; // 210 — slightly higher to give room for neck

  const pts: Array<[number, number]> = [];

  // ── FACE SHAPE: narrow oval tapering to V-jaw ─────────────────────────────
  // Upper arc (wider at temples/cheekbones)
  pts.push(...sampleEllipse(cx, cy - 15, 128, 170, 175, -Math.PI, 0));
  // Lower arc (narrower jaw taper)
  pts.push(...sampleEllipse(cx, cy + 20, 110, 170, 130, 0, Math.PI));
  // Inner density layer
  pts.push(...sampleEllipse(cx, cy, 110, 155, 55));

  // ── FOREHEAD: high, rounded ───────────────────────────────────────────────
  pts.push(...sampleScatter(cx, cy - 140, 60, 22, 28));
  pts.push(...sampleScatter(cx, cy - 95, 40, 16, 18));

  // ── LEFT EYE: large, almond-shaped, high set ──────────────────────────────
  const lex = cx - 68;
  const ley = cy - 58;
  // Outer almond ellipse
  pts.push(...sampleEllipse(lex, ley, 40, 20, 65));
  // Upper eyelid — curves dramatically upward (feminine arch)
  pts.push(
    ...sampleBezier(
      [lex - 40, ley + 5],
      [lex - 8, ley - 30],
      [lex + 8, ley - 30],
      [lex + 40, ley + 5],
      32,
    ),
  );
  // Inner eye / iris
  pts.push(...sampleEllipse(lex, ley, 23, 15, 36));
  pts.push(...sampleCircleFill(lex, ley, 12, 24));
  pts.push(...sampleEllipse(lex, ley, 17, 17, 28)); // iris ring
  // Lower lashline (flatter, feminine almond)
  pts.push(
    ...sampleBezier(
      [lex - 40, ley + 5],
      [lex - 12, ley + 16],
      [lex + 12, ley + 16],
      [lex + 40, ley + 5],
      20,
    ),
  );

  // ── RIGHT EYE ─────────────────────────────────────────────────────────────
  const rex = cx + 68;
  const rey = cy - 58;
  pts.push(...sampleEllipse(rex, rey, 40, 20, 65));
  pts.push(
    ...sampleBezier(
      [rex - 40, rey + 5],
      [rex - 8, rey - 30],
      [rex + 8, rey - 30],
      [rex + 40, rey + 5],
      32,
    ),
  );
  pts.push(...sampleEllipse(rex, rey, 23, 15, 36));
  pts.push(...sampleCircleFill(rex, rey, 12, 24));
  pts.push(...sampleEllipse(rex, rey, 17, 17, 28));
  pts.push(
    ...sampleBezier(
      [rex - 40, rey + 5],
      [rex - 12, rey + 16],
      [rex + 12, rey + 16],
      [rex + 40, rey + 5],
      20,
    ),
  );

  // ── LEFT EYEBROW: high arch, thin, peak at outer 2/3 ─────────────────────
  pts.push(
    ...sampleBezier(
      [lex - 36, ley - 44], // inner corner (lower start)
      [lex - 6, ley - 64], // rise steeply
      [lex + 18, ley - 62], // arch peak (outer 2/3)
      [lex + 38, ley - 50], // taper down to outer end
      20,
    ),
  );
  // Second thin pass slightly above for delicate double-line effect
  pts.push(
    ...sampleBezier(
      [lex - 30, ley - 47],
      [lex - 4, ley - 67],
      [lex + 16, ley - 65],
      [lex + 34, ley - 54],
      14,
    ),
  );

  // ── RIGHT EYEBROW ─────────────────────────────────────────────────────────
  pts.push(
    ...sampleBezier(
      [rex - 38, rey - 50],
      [rex - 18, rey - 62],
      [rex + 6, rey - 64],
      [rex + 36, rey - 44],
      20,
    ),
  );
  pts.push(
    ...sampleBezier(
      [rex - 34, rey - 54],
      [rex - 16, rey - 65],
      [rex + 4, rey - 67],
      [rex + 30, rey - 47],
      14,
    ),
  );

  // ── NOSE: small, delicate, button tip ─────────────────────────────────────
  const noseTop = cy - 6;
  const noseBot = cy + 42;
  // Left bridge (very narrow, subtle)
  pts.push(
    ...sampleBezier(
      [lex + 28, noseTop],
      [cx - 10, noseTop + 16],
      [cx - 8, noseBot - 10],
      [cx - 15, noseBot],
      12,
    ),
  );
  // Right bridge
  pts.push(
    ...sampleBezier(
      [rex - 28, noseTop],
      [cx + 10, noseTop + 16],
      [cx + 8, noseBot - 10],
      [cx + 15, noseBot],
      12,
    ),
  );
  // Nose tip — small, soft
  pts.push(...sampleEllipse(cx, noseBot + 3, 13, 7, 14, 0, Math.PI));
  // Delicate nostrils
  pts.push(...sampleEllipse(cx - 13, noseBot + 3, 6, 4, 8, Math.PI * 0.5, Math.PI * 1.5));
  pts.push(...sampleEllipse(cx + 13, noseBot + 3, 6, 4, 8, -Math.PI * 0.5, Math.PI * 0.5));

  // ── LIPS: full Cupid's bow upper, plump lower ─────────────────────────────
  const mouthY = cy + 88;
  // Upper lip — left arch of Cupid's bow
  pts.push(
    ...sampleBezier(
      [cx - 54, mouthY + 2],
      [cx - 26, mouthY - 10],
      [cx - 7, mouthY - 18],
      [cx, mouthY - 11], // centre dip (philtrum valley)
      20,
    ),
  );
  // Upper lip — right arch of Cupid's bow
  pts.push(
    ...sampleBezier(
      [cx, mouthY - 11],
      [cx + 7, mouthY - 18],
      [cx + 26, mouthY - 10],
      [cx + 54, mouthY + 2],
      20,
    ),
  );
  // Lower lip — full and rounded
  pts.push(
    ...sampleBezier(
      [cx - 54, mouthY + 2],
      [cx - 26, mouthY + 32],
      [cx + 26, mouthY + 32],
      [cx + 54, mouthY + 2],
      40,
    ),
  );
  // Lower lip body fill
  pts.push(...sampleScatter(cx, mouthY + 18, 28, 8, 18));
  // Lip centre line
  pts.push(...sampleQuad([cx - 44, mouthY + 6], [cx, mouthY + 11], [cx + 44, mouthY + 6], 20));

  // ── CHIN: narrow, soft point ──────────────────────────────────────────────
  pts.push(...sampleEllipse(cx, cy + 176, 40, 14, 13, Math.PI * 0.18, Math.PI * 0.82));

  // ── CHEEKBONES: high and prominent (close to eyes) ────────────────────────
  pts.push(...sampleScatter(cx - 100, cy - 5, 28, 14, 26));
  pts.push(...sampleScatter(cx + 100, cy - 5, 28, 14, 26));
  // Subtle cheek hollow below cheekbones
  pts.push(...sampleScatter(cx - 95, cy + 38, 18, 12, 14));
  pts.push(...sampleScatter(cx + 95, cy + 38, 18, 12, 14));

  // ── JAW: V-shaped bezier curves ──────────────────────────────────────────
  pts.push(
    ...sampleBezier(
      [cx - 116, cy + 38],
      [cx - 88, cy + 112],
      [cx - 52, cy + 162],
      [cx, cy + 184],
      26,
    ),
  );
  pts.push(
    ...sampleBezier(
      [cx + 116, cy + 38],
      [cx + 88, cy + 112],
      [cx + 52, cy + 162],
      [cx, cy + 184],
      26,
    ),
  );

  // ── NECK: slim, graceful ──────────────────────────────────────────────────
  pts.push(
    ...sampleBezier(
      [cx - 36, cy + 190],
      [cx - 33, cy + 225],
      [cx - 32, cy + 255],
      [cx - 34, cy + 278],
      16,
    ),
  );
  pts.push(
    ...sampleBezier(
      [cx + 36, cy + 190],
      [cx + 33, cy + 225],
      [cx + 32, cy + 255],
      [cx + 34, cy + 278],
      16,
    ),
  );

  return pts;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MasterFaceCanvas({
  state,
  amplitude = 0,
  width = 400,
  height = 500,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<FaceState>(state);
  const ampRef = useRef<number>(amplitude);
  const particlesRef = useRef<Particle[]>([]);
  const rafRef = useRef<number>(0);
  const timeRef = useRef<number>(0);

  // keep refs in sync so animation loop reads latest without re-creating
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    ampRef.current = amplitude;
  }, [amplitude]);

  // ── Init particles once ──────────────────────────────────────────────────
  useEffect(() => {
    const CANVAS_W = 400;
    const CANVAS_H = 500;

    const pts = buildFacePoints();

    particlesRef.current = pts.map(([px, py]) => {
      const hx = px / CANVAS_W;
      const hy = py / CANVAS_H;
      const angle = Math.random() * Math.PI * 2;
      return {
        hx,
        hy,
        x: px + (Math.random() - 0.5) * 200,
        y: py + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        baseSize: 0.8 + Math.random() * 1.6,
        size: 1,
        opacity: 0.6 + Math.random() * 0.4,
        hue: 185 + Math.random() * 40, // cyan-blue range
        brightness: 70 + Math.random() * 30,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 0.6,
        ex: Math.cos(angle),
        ey: Math.sin(angle),
      } satisfies Particle;
    });
  }, []);

  // ── Animation loop ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const DPR = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const CANVAS_W = 400;
    const CANVAS_H = 500;
    const scaleX = (width * DPR) / CANVAS_W;
    const scaleY = (height * DPR) / CANVAS_H;

    // Resize backing store
    canvas.width = width * DPR;
    canvas.height = height * DPR;

    let lastTime = 0;
    let explodeProgress = 0; // 0..1 – ramp up on speaking

    function drawGlow(x: number, y: number, r: number, color: string, alpha: number) {
      const grad = ctx!.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, color.replace(')', `, ${alpha})`).replace('hsl(', 'hsla('));
      grad.addColorStop(1, 'transparent');
      ctx!.fillStyle = grad;
      ctx!.beginPath();
      ctx!.arc(x, y, r, 0, Math.PI * 2);
      ctx!.fill();
    }

    function render(ts: number) {
      rafRef.current = requestAnimationFrame(render);

      const dt = Math.min((ts - lastTime) / 1000, 0.05);
      lastTime = ts;
      timeRef.current += dt;
      const t = timeRef.current;

      const currentState = stateRef.current;
      const amp = Math.min(1, ampRef.current);

      // ── Background ──────────────────────────────────────────────────────
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.fillStyle = 'rgba(0,0,0,0)';
      ctx!.fillRect(0, 0, canvas!.width, canvas!.height);

      // ── Ambient outer glow ───────────────────────────────────────────────
      {
        const glowAlpha =
          currentState === 'speaking'
            ? 0.07 + amp * 0.18
            : currentState === 'listening'
              ? 0.06 + Math.sin(t * 3) * 0.02
              : 0.04;
        const glowX = (width * DPR) / 2;
        const glowY = height * DPR * 0.45;
        const glowR = width * DPR * 0.6;
        const gradient = ctx!.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowR);
        gradient.addColorStop(0, `hsla(195, 100%, 70%, ${glowAlpha})`);
        gradient.addColorStop(0.5, `hsla(220, 100%, 55%, ${glowAlpha * 0.5})`);
        gradient.addColorStop(1, 'transparent');
        ctx!.fillStyle = gradient;
        ctx!.fillRect(0, 0, canvas!.width, canvas!.height);
      }

      // ── Update explode progress ──────────────────────────────────────────
      const targetExplode = currentState === 'speaking' ? Math.min(1, 0.35 + amp * 0.65) : 0;
      explodeProgress += (targetExplode - explodeProgress) * Math.min(1, dt * 5);

      ctx!.save();
      ctx!.scale(scaleX, scaleY);

      // ── Update + draw particles ──────────────────────────────────────────
      const particles = particlesRef.current;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        const homeX = p.hx * CANVAS_W;
        const homeY = p.hy * CANVAS_H;

        let targetX: number;
        let targetY: number;
        let stiffness: number;
        let damping: number;
        let sizeMultiplier: number;
        let brightnessAdd: number;
        let extraHue: number;

        if (currentState === 'speaking') {
          const burstDist = 60 + amp * 120 + explodeProgress * 80;
          const wavePulse = Math.sin(t * 8 + p.phase) * 15 * amp;
          targetX = homeX + p.ex * burstDist * explodeProgress + Math.sin(t * 3 + p.phase) * 4;
          targetY =
            homeY +
            p.ey * burstDist * explodeProgress +
            Math.cos(t * 3 + p.phase + 1) * 4 +
            wavePulse * 0.3;
          stiffness = 4;
          damping = 0.82;
          sizeMultiplier = 1 + amp * 1.8 + explodeProgress * 0.8;
          brightnessAdd = 20 + amp * 40;
          extraHue = -15; // shift toward white-gold when speaking
        } else if (currentState === 'listening') {
          const listenPulse = Math.sin(t * 4 + p.phase) * 6;
          targetX = homeX + Math.sin(t * 1.5 + p.phase) * 3;
          targetY = homeY + Math.cos(t * 1.5 + p.phase * 0.7) * 3 + listenPulse * 0.2;
          stiffness = 6;
          damping = 0.88;
          sizeMultiplier = 1.1 + Math.sin(t * 4 + p.phase) * 0.2;
          brightnessAdd = 10;
          extraHue = 20; // shift toward purple
        } else if (currentState === 'thinking') {
          const swirl = t * 1.2 + p.phase;
          targetX = homeX + Math.sin(swirl) * 8;
          targetY = homeY + Math.cos(swirl * 0.7) * 8;
          stiffness = 3;
          damping = 0.85;
          sizeMultiplier = 0.95 + Math.sin(t * 2 + p.phase) * 0.15;
          brightnessAdd = 5;
          extraHue = 10;
        } else {
          // idle
          targetX = homeX + Math.sin(t * p.speed + p.phase) * 2.5;
          targetY = homeY + Math.cos(t * p.speed * 0.7 + p.phase) * 2.5;
          stiffness = 2.5;
          damping = 0.9;
          sizeMultiplier = 0.9 + Math.sin(t * p.speed + p.phase) * 0.1;
          brightnessAdd = 0;
          extraHue = 0;
        }

        // spring physics
        const ax = (targetX - p.x) * stiffness;
        const ay = (targetY - p.y) * stiffness;
        p.vx = (p.vx + ax * dt) * damping;
        p.vy = (p.vy + ay * dt) * damping;
        p.x += p.vx * dt;
        p.y += p.vy * dt;

        p.size = p.baseSize * sizeMultiplier;

        const finalHue = p.hue + extraHue;
        const finalBrightness = Math.min(100, p.brightness + brightnessAdd);
        const sat = currentState === 'idle' ? 85 : 95;
        const alpha = p.opacity * (currentState === 'speaking' ? 0.75 + amp * 0.25 : 0.8);

        // draw glow aura
        if (p.size > 1.5 || currentState === 'speaking') {
          const glowR = p.size * (currentState === 'speaking' ? 6 : 4);
          const glowA = alpha * 0.25;
          ctx!.beginPath();
          ctx!.arc(p.x, p.y, glowR, 0, Math.PI * 2);
          ctx!.fillStyle = `hsla(${finalHue}, ${sat}%, ${finalBrightness}%, ${glowA})`;
          ctx!.fill();
        }

        // draw particle core
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx!.fillStyle = `hsla(${finalHue}, ${sat}%, ${finalBrightness}%, ${alpha})`;
        ctx!.fill();
      }

      // ── Bright sparkle flashes when speaking ──────────────────────────────
      if (currentState === 'speaking' && amp > 0.2) {
        const sparkCount = Math.floor(amp * 8);
        for (let i = 0; i < sparkCount; i++) {
          const si = Math.floor(Math.random() * particles.length);
          const sp = particles[si];
          const sr = (1 + Math.random() * 3) * sizeMultiplierForFlash(amp);
          drawGlow(sp.x, sp.y, sr * 6, 'hsl(200, 100%, 90%)', 0.4 * amp);
          ctx!.beginPath();
          ctx!.arc(sp.x, sp.y, sr, 0, Math.PI * 2);
          ctx!.fillStyle = `rgba(255,255,255,${0.6 * amp})`;
          ctx!.fill();
        }
      }

      // ── Scanning pulse ring when listening ────────────────────────────────
      if (currentState === 'listening') {
        const pulsePhase = (t * 1.5) % 1;
        const pr = pulsePhase * 180;
        const pa = (1 - pulsePhase) * 0.15;
        ctx!.strokeStyle = `hsla(200, 100%, 70%, ${pa})`;
        ctx!.lineWidth = 2;
        ctx!.beginPath();
        ctx!.arc(200, 225, pr, 0, Math.PI * 2);
        ctx!.stroke();
      }

      ctx!.restore();
    }

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  return <canvas ref={canvasRef} style={{ width, height }} aria-label="AI face visualisation" />;
}

function sizeMultiplierForFlash(amp: number) {
  return 1 + amp * 1.5;
}
