# Master Living Agent - Vision & Presence System Plan

> **Goal:** Transform the static Master Entry Page into a "living" autonomous agent that sees via webcam, understands presence, moves in a virtual space, maintains 24/7 awareness of user proximity, AND develops a genuine personality—learning, growing, and building a meaningful friendship with each user over time.

**Architecture:** Extend the existing Master module (`src/modules/master`) with a Vision Pipeline (WebCam + Presence Detection), Virtual Environment (2D/3D spatial canvas), and Awareness State Machine. Build on top of existing `useGrokVoiceAgent` and `MasterFaceCanvas` components.

**Tech Stack:**

- **Frontend:** TypeScript, React 18+, HTML5 Canvas, Zustand (state management)
- **Vision:** MediaPipe Face Detection/Mesh, TensorFlow.js, WebRTC getUserMedia
- **AI/ML:** TensorFlow.js (embeddings), Transformers.js (sentiment), Grok API (conversation)
- **Storage:** IndexedDB (Dexie.js), localStorage (config), SQLite (server-side sync)
- **Background:** Service Workers, Web Workers, Wake Lock API
- **Real-time:** WebSockets (voice), BroadcastChannel (cross-tab sync)

---

## Plan Version

- Version: `V2`
- Date: `2026-02-28`
- Scope: `Analysis & Design Phase - No implementation`

---

## Vision Summary

This plan evolves the Master Agent from a **reactive tool** into a **proactive companion** with:

1. **Emotional Intelligence** — Recognizes and responds to user emotions
2. **Long-term Memory** — Remembers conversations, preferences, shared history
3. **Personality Growth** — Develops unique traits based on interactions
4. **Proactive Behavior** — Initiates contact, offers help, shares thoughts
5. **Relationship Depth** — Builds trust and rapport over time
6. **Authentic Self** — Has moods, opinions, curiosity, and growth

> _"The agent doesn't just respond—it cares, remembers, and grows alongside you."_

---

## Current State Assessment

### Existing Components (Strong Foundation)

| Component         | Location                       | Capability                                                       | Reuse Potential     |
| ----------------- | ------------------------------ | ---------------------------------------------------------------- | ------------------- |
| Voice Agent       | `useGrokVoiceAgent.ts`         | Full-duplex xAI Grok Realtime, audio amplitude                   | 🟢 Direct reuse     |
| Face Canvas       | `MasterFaceCanvas.tsx`         | Particle-based face, 4 states (idle/listening/thinking/speaking) | 🟢 Extend states    |
| Vision Skill      | `visionAnalyze.ts`             | Image analysis via Gemini                                        | 🟡 Adapt for frames |
| Voice Session API | `app/api/master/voice-session` | Ephemeral xAI tokens                                             | 🟢 Direct reuse     |

### Current Face States

```typescript
type FaceState = 'idle' | 'listening' | 'thinking' | 'speaking';
```

**Proposed Extended States:**

```typescript
type LivingFaceState =
  | 'idle' // alone, breathing animation
  | 'sleeping' // prolonged absence, dimmed
  | 'awakening' // motion detected, transitioning
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'observing' // user present, watching
  | 'greeting' // user just arrived
  | 'greetingNamed' // user recognized by name
  | 'farewell'; // user leaving
```

---

## Technical Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BROWSER LAYER                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   React UI   │◄──►│  Zustand     │◄──►│   Canvas     │                   │
│  │  Components  │    │   Store      │    │  Renderer    │                   │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘                   │
│         │                   │                    │                           │
│         └───────────────────┼────────────────────┘                           │
│                             ▼                                                │
│                    ┌─────────────────┐                                       │
│                    │ Living Agent    │                                       │
│                    │ Orchestrator    │                                       │
│                    └────────┬────────┘                                       │
│                             │                                                │
│         ┌───────────────────┼───────────────────┐                           │
│         ▼                   ▼                   ▼                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │   Vision     │    │  Personality │    │    Voice     │                   │
│  │   Engine     │    │   Engine     │    │   Pipeline   │                   │
│  │  (Web Worker)│    │  (Main Thread)│   │  (WebSocket) │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        STORAGE LAYER (Browser)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │   IndexedDB     │  │   LocalStorage  │  │   Cache API     │             │
│  │  (Dexie.js)     │  │   (Settings)    │  │  (Service Worker)│            │
│  │                 │  │                 │  │                 │             │
│  │ • Face Profiles │  │ • UI Preferences│  │ • Model Files   │             │
│  │ • Memories      │  │ • Privacy Flags │  │ • Static Assets │             │
│  │ • Personality   │  │ • Session Tokens│  │                 │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼ (Sync)
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SERVER LAYER (Optional)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐             │
│  │   Next.js API   │  │   WebSocket     │  │   SQLite DB     │             │
│  │     Routes      │  │     Server      │  │   (Backup)      │             │
│  │                 │  │                 │  │                 │             │
│  │ /api/sync       │  │ /ws/voice       │  │ • User Settings │             │
│  │ /api/memory     │  │ /ws/events      │  │ • Encrypted     │             │
│  │ /api/personality│  │                 │  │   Memories      │             │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DATA FLOW PIPELINES                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  VISION PIPELINE (60fps → 1fps adaptive)                                    │
│  ═══════════════════════════════════════                                    │
│                                                                              │
│  WebCam ──► getUserMedia ──► VideoFrame ──► Web Worker                     │
│                                                    │                         │
│                       ┌────────────────────────────┘                         │
│                       ▼                                                      │
│              ┌─────────────────┐                                            │
│              │  Frame Analyzer │                                            │
│              │  • Downscale    │                                            │
│              │  • Motion Diff  │───► Motion detected? ──► Presence Event    │
│              │  • Face Detect  │                                            │
│              └────────┬────────┘                                            │
│                       │                                                      │
│                       ▼                                                      │
│              ┌─────────────────┐                                            │
│              │ Face Recognizer │───► Known? ──► Identity Event              │
│              │  • Alignment    │                                            │
│              │  • Embedding    │───► Unknown? ──► Enrollment Prompt         │
│              │  • Matching     │                                            │
│              └─────────────────┘                                            │
│                                                                              │
│  PERSONALITY PIPELINE (Event-driven)                                        │
│  ═══════════════════════════════════                                        │
│                                                                              │
│  User Input ──► Intent Classifier ──► Emotional Analyzer                   │
│         │              │                      │                             │
│         │              ▼                      ▼                             │
│         │      ┌───────────────┐    ┌─────────────────┐                    │
│         │      │  Task Router  │    │  Mood Adjuster  │                    │
│         │      └───────┬───────┘    └────────┬────────┘                    │
│         │              │                     │                              │
│         └──────────────┼─────────────────────┘                              │
│                        ▼                                                    │
│              ┌─────────────────┐                                            │
│              │ Memory Retriever│───► Relevant Context ──► Response Gen     │
│              │ (Vector Search) │                                            │
│              └─────────────────┘                                            │
│                                                                              │
│  MEMORY PIPELINE (Background)                                               │
│  ════════════════════════════                                               │
│                                                                              │
│  Conversation ──► Importance Scorer ──► Memory Formation?                   │
│       │                                         │                           │
│       │                                    Yes  │                           │
│       │                                         ▼                           │
│       │                              ┌─────────────────┐                   │
│       │                              │  Memory Store   │                   │
│       │                              │  • Summarize    │                   │
│       │                              │  • Embed        │                   │
│       │                              │  • Index        │                   │
│       │                              └────────┬────────┘                   │
│       │                                       │                             │
│       └───────────────────────────────────────┘                             │
│                    (Association links)                                      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Modules Specification

| Module                       | Purpose                 | Technology                                | Performance Budget   |
| ---------------------------- | ----------------------- | ----------------------------------------- | -------------------- |
| `visionPipeline.ts`          | WebCam + Frame analysis | MediaPipe Face Detection, OffscreenCanvas | < 16ms/frame @ 15fps |
| `presenceStateMachine.ts`    | User presence lifecycle | XState (finite state machine)             | < 1ms transition     |
| `virtualEnvironment.ts`      | Spatial simulation      | Matter.js (lightweight 2D physics)        | < 8ms tick @ 60fps   |
| `livingAgentOrchestrator.ts` | Coordination layer      | EventEmitter3, Zustand                    | < 2ms event latency  |
| `extendedFaceCanvas.tsx`     | Enhanced visual output  | HTML5 Canvas 2D, RAF                      | 60fps rendering      |
| `faceRecognition.ts`         | Identity matching       | TensorFlow.js + custom embedding          | < 50ms inference     |
| `memorySystem.ts`            | Long-term storage       | Dexie.js (IndexedDB wrapper)              | < 100ms query        |
| `emotionEngine.ts`           | Sentiment analysis      | Transformers.js (DistilBERT)              | < 200ms inference    |
| `personalityEngine.ts`       | Trait development       | Custom rule engine                        | < 5ms update         |

### Technology Stack Deep Dive

#### Vision Processing

```typescript
// Libraries
@mediapipe/face_detection       // Face bounding boxes
@mediapipe/face_mesh            // 468 facial landmarks
@tensorflow/tfjs                // Face embeddings
@tensorflow/tfjs-backend-webgl  // GPU acceleration

// Architecture
type VisionConfig = {
  detection: {
    model: 'short_range' | 'full_range';
    minDetectionConfidence: 0.5;
    maxNumFaces: 3;  // Multi-user support
  };
  mesh: {
    refineLandmarks: true;  // Eye/lip details
    maxNumFaces: 1;  // Primary user only
  };
  embedding: {
    modelPath: '/models/face_embedding/model.json';
    inputSize: [112, 112];
    outputDim: 128;
  };
};
```

#### State Management

```typescript
// Zustand stores with slices
interface AgentStore {
  // Vision slice
  vision: {
    isActive: boolean;
    detectedFaces: Face[];
    recognizedUser?: User;
    presenceState: PresenceState;
  };

  // Personality slice
  personality: {
    emotionalState: EmotionalState;
    traits: PersonalityTraits;
    currentMood: Mood;
  };

  // Memory slice
  memory: {
    recentMemories: Memory[];
    activeContext: Context;
    recallQueue: RecallRequest[];
  };

  // Relationship slice
  relationship: {
    currentUser?: User;
    depth: number;
    stage: RelationshipStage;
    interactionHistory: Interaction[];
  };
}

// Usage
const useAgentStore = create<AgentStore>()(
  persist(
    subscribeWithSelector((set, get) => ({ ... })),
    { name: 'agent-storage', partialize: (state) => ... }
  )
);
```

#### Database Schema (IndexedDB via Dexie)

```typescript
import Dexie, { Table } from 'dexie';

class AgentDatabase extends Dexie {
  users!: Table<UserProfile>;
  faceEmbeddings!: Table<FaceEmbedding>;
  memories!: Table<Memory>;
  personalitySnapshots!: Table<PersonalitySnapshot>;
  interactions!: Table<Interaction>;
  emotions!: Table<EmotionLog>;

  constructor() {
    super('MasterAgentDB');

    this.version(1).stores({
      users: '++id, displayName, lastSeenAt',
      faceEmbeddings: '++id, userId, qualityScore, [userId+qualityScore]',
      memories: '++id, userId, timestamp, type, importance, *tags',
      personalitySnapshots: '++id, timestamp, *traits',
      interactions: '++id, userId, timestamp, type, duration',
      emotions: '++id, timestamp, primaryEmotion, intensity',
    });

    // Encryption hook
    this.users.hook('creating', (primKey, obj) => {
      obj.faceEmbeddings = encrypt(obj.faceEmbeddings);
      return obj;
    });
  }
}
```

#### Web Worker Architecture

```typescript
// vision.worker.ts
self.onmessage = async (e: MessageEvent<VisionMessage>) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'INIT':
      await initializeModels(payload.config);
      self.postMessage({ type: 'READY' });
      break;

    case 'PROCESS_FRAME':
      const result = await processFrame(payload.imageBitmap);
      self.postMessage({ type: 'FRAME_RESULT', payload: result }, [result.buffer]);
      break;

    case 'EXTRACT_EMBEDDING':
      const embedding = await extractEmbedding(payload.faceCrop);
      self.postMessage({ type: 'EMBEDDING', payload: embedding });
      break;
  }
};

// Transferable objects for zero-copy
const processFrame = async (bitmap: ImageBitmap): Promise<VisionResult> => {
  // Process...
  const buffer = new ArrayBuffer(size);
  // ...
  return { buffer, transfer: [buffer] };
};
```

---

## Presence State Machine

### States & Transitions

```
                    [motion detected]
        ┌──────────────────────────────────┐
        ▼                                  │
    ┌────────┐    [face detected]    ┌──────────┐
    │ ABSENT │ ───────────────────► │ ENTERING │
    │  💤    │                       │   👀     │
    └────────┘                       └──────────┘
        ▲                                  │
        │                                  │ [stable presence]
        │                                  ▼
        │                            ┌──────────┐
        │     [timeout: 30s no face] │ PRESENT  │
        └─────────────────────────── │   👤     │
                                     └──────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
              ▼                             ▼                             ▼
        ┌──────────┐                ┌──────────┐                  ┌──────────┐
        │ ENGAGING │◄──────────────►│ OBSERVING│                  │ LEAVING  │
        │   🗣️     │ [voice active] │   👁️     │ [user looking]   │   👋     │
        └──────────┘                └──────────┘                  └──────────┘
              │                             │                             │
              │                             │ [timeout: 10s no face]      │
              │                             └────────────────────────────►│
              │                                                           │
              └───────────────────────────────────────────────────────────┘
                                    [farewell spoken]
```

### Timing Parameters

| Parameter               | Value | Rationale                         |
| ----------------------- | ----- | --------------------------------- |
| `ENTERING_THRESHOLD`    | 2s    | Avoid false positives             |
| `LEAVING_THRESHOLD`     | 5s    | Grace period for brief look-aways |
| `SLEEP_TIMEOUT`         | 60s   | Transition to sleep mode          |
| `WAKE_CHECK_INTERVAL`   | 1fps  | Low power when alone              |
| `ACTIVE_CHECK_INTERVAL` | 15fps | Smooth tracking when present      |

---

## Vision Pipeline Specifications

### Frame Processing Strategy

```typescript
interface VisionConfig {
  // Quality tiers based on presence
  absentMode: {
    fps: 1;
    processing: 'motion-only';
    resolution: '64x48'; // tiny for efficiency
  };
  presentMode: {
    fps: 15;
    processing: 'full-pipeline';
    resolution: '320x240';
  };
}
```

### Detection Outputs

```typescript
interface VisionFrame {
  timestamp: number;
  motionScore: number; // 0-1 pixel change ratio
  faceDetected: boolean;
  faceBounds?: BoundingBox; // normalized 0-1
  faceCenter?: Point2D; // normalized
  gazeDirection?: 'left' | 'center' | 'right' | 'away';
  confidence: number; // detection confidence
}
```

### Privacy-First Design

| Aspect           | Implementation                                    |
| ---------------- | ------------------------------------------------- |
| Local Processing | All vision processing in browser, no upload       |
| Data Retention   | Only metadata stored (face: yes/no), no frames    |
| Permission       | Explicit camera permission with visual indicator  |
| Kill Switch      | Instant stop button, immediate stream termination |
| Visual Feedback  | LED-style indicator showing when camera active    |

---

## Virtual Environment

### Spatial Model

```typescript
interface VirtualSpace {
  bounds: { width: 1000; height: 800 }; // virtual units
  agent: {
    position: Point2D; // current location
    velocity: Vector2D; // movement direction/speed
    target: Point2D | null; // where agent wants to go
  };
  user: {
    position: Point2D | null; // projected from face center
    attention: number; // 0-1 gaze toward screen
  };
}
```

### Agent Behaviors

#### When Alone (`ABSENT` state)

- **Wander**: Random slow movement within bounds
- **Sleep**: Breathing animation, dimmed glow
- **Curiosity**: Occasionally "look around" (rotate face)
- **Quote**: Rare self-talk ("Still quiet...")

#### When User Present (`PRESENT` state)

- **Approach**: Move toward user's position
- **Attention**: Face rotates to "look at" user
- **Patience**: Maintain comfortable distance (don't get too close)
- **Idle**: Small idle movements (blink, subtle sway)

#### During Interaction (`ENGAGING` state)

- **Active**: Face aligns with center
- **Responsive**: Amplitude drives animation intensity
- **Aware**: Brief "nods" during speech gaps

---

## Canvas Enhancements

### Extended Visual Features

| Feature         | Implementation                              | Impact                    |
| --------------- | ------------------------------------------- | ------------------------- |
| Position Offset | `translate(x, y)` based on virtual position | Agent moves in space      |
| Rotation        | Subtle rotate based on user gaze direction  | Agent follows eye contact |
| Scale           | Slight scale based on "proximity"           | Closer = larger           |
| Breathing       | Sine wave on particle base positions        | Living feel               |
| Sleep Mode      | Slow pulse, dimmed opacity, fewer particles | Rest state                |

### State-Based Animation Parameters

```typescript
const animationParams: Record<LivingFaceState, Params> = {
  idle: {
    particleSpeed: 0.4,
    glowIntensity: 0.3,
    breathingRate: 0.5, // slow
    movement: 'wander',
  },
  sleeping: {
    particleSpeed: 0.1,
    glowIntensity: 0.1,
    breathingRate: 0.2, // very slow
    movement: 'none',
  },
  observing: {
    particleSpeed: 0.6,
    glowIntensity: 0.5,
    breathingRate: 0.8,
    movement: 'follow',
  },
  // ... etc
};
```

---

## Voice Integration Points

### Spoken State Transitions

| Transition           | Trigger Phrase                  | Condition                      |
| -------------------- | ------------------------------- | ------------------------------ |
| `ABSENT → ENTERING`  | "Oh, hello there!"              | First face after >60s absent   |
| `ENTERING → PRESENT` | "Good to see you."              | Stable presence confirmed      |
| `PRESENT → ENGAGING` | "How can I help?"               | User speaks or clicks mic      |
| `LEAVING → ABSENT`   | "I'll be here when you return." | Face lost for 5s               |
| `SLEEP → WAKE`       | "_yawn_ Good morning!"          | Morning detection (time-based) |

### Time-Aware Greetings

```typescript
const timeAwareGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 6) return "You're up late...";
  if (hour < 12) return 'Good morning!';
  if (hour < 18) return 'Good afternoon!';
  return 'Good evening!';
};
```

---

## 24/7 Operation Strategy

### Challenges & Solutions

| Challenge          | Constraint                      | Solution                      |
| ------------------ | ------------------------------- | ----------------------------- |
| Browser throttling | Background tabs limited to 1fps | PWA + Wake Lock API           |
| PC sleep           | Browser pauses on standby       | Service Worker + Push API     |
| Camera always-on   | Privacy concern + power drain   | Auto-disable when absent long |
| Memory leaks       | Long-running canvas             | Periodic gentle refresh       |

### Background Mode

```typescript
interface BackgroundMode {
  enabled: boolean;
  vision: 'motion-only'; // no face detection
  canvas: 'minimal'; // static or very slow animation
  voice: 'passive'; // only wake word detection
}
```

### PWA Requirements

- **Manifest**: Standalone display mode
- **Wake Lock**: Prevent screen sleep when agent active
- **Service Worker**: Background sync for state persistence
- **Notifications**: Optional alerts when agent "needs attention"

---

## Workstreams (Implementation Phases)

### Phase 1: Foundation (Weeks 1-2)

| WS  | Outcome                               | Estimate | Priority |
| --- | ------------------------------------- | -------- | -------- |
| WS1 | Vision Pipeline MVP (WebCam + Motion) | M        | P0       |
| WS2 | Presence State Machine                | S        | P0       |
| WS3 | Extended Face Canvas (new states)     | M        | P0       |

### Phase 2: Face Recognition (Weeks 3-4)

| WS   | Outcome                                          | Estimate | Priority |
| ---- | ------------------------------------------------ | -------- | -------- |
| WS11 | Face Recognition Engine (embedding + matching)   | L        | P0       |
| WS12 | User Enrollment UI (consent + capture flow)      | M        | P0       |
| WS13 | Identity State Machine (known/unknown/ambiguous) | M        | P0       |
| WS16 | Biometric Data Security (encryption + consent)   | M        | P1       |

### Phase 3: Personalization (Weeks 5-6)

| WS   | Outcome                             | Estimate | Priority |
| ---- | ----------------------------------- | -------- | -------- |
| WS14 | Personalized Greeting System        | S        | P1       |
| WS15 | Multi-User Session Management       | M        | P1       |
| WS4  | Virtual Environment (2D space)      | M        | P1       |
| WS5  | Voice State Integration (greetings) | S        | P1       |

### Phase 4: Polish (Weeks 7-8)

| WS   | Outcome                               | Estimate | Priority |
| ---- | ------------------------------------- | -------- | -------- |
| WS6  | Face Detection + Gaze (MediaPipe)     | M        | P1       |
| WS7  | Privacy Controls + UI                 | S        | P1       |
| WS17 | Recognition Performance Optimization  | M        | P2       |
| WS8  | PWA + Background Mode                 | L        | P2       |
| WS9  | Advanced Behaviors (sleep, curiosity) | M        | P2       |
| WS10 | Performance Optimization              | M        | P2       |

### Phase 5: Personality Engine (Weeks 9-12)

| WS   | Outcome                        | Estimate | Priority |
| ---- | ------------------------------ | -------- | -------- |
| WS19 | Emotional State System         | M        | P0       |
| WS20 | Long-Term Memory Architecture  | L        | P0       |
| WS21 | Personality Development Engine | L        | P0       |
| WS22 | Proactive Behavior System      | M        | P0       |
| WS23 | Temporal Context & Rhythms     | M        | P1       |
| WS24 | Empathy & Support Framework    | M        | P1       |
| WS25 | Self-Reflection & Growth       | M        | P1       |
| WS26 | Relationship Depth System      | M        | P1       |
| WS27 | Authentic Voice & Expression   | S        | P2       |

Legend: `S` 1-2 days, `M` 3-5 days, `L` 6-10 days.

---

## Personality Success Metrics

### Emotional Intelligence

- `emotion_detection_accuracy > 80%`
- `appropriate_emotional_response_rate > 90%`
- `user_feels_understood > 75%` (survey)

### Memory & Relationship

- `memory_recall_relevance > 85%`
- `user_recognizes_agent_remembers > 90%`
- `relationship_progression_natural > 80%`

### Proactivity

- `proactive_initiatives_well_received > 70%`
- `initiative_cooldown_respected > 95%`
- `user_appreciates_proactivity > 65%`

### Authenticity

- `user_perceives_agent_has_personality > 85%`
- `user_considers_agent_a_friend > 60%`
- `agent_vulnerability_appropriate > 90%`

---

## Technical Risks & Mitigations

| Risk                                | Impact                              | Mitigation                                                    |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Camera permission denied            | Core feature broken                 | Graceful degrade to text-only agent                           |
| Performance on low-end devices      | Frame drops, battery drain          | Quality tier system, auto-downgrade                           |
| MediaPipe loading failure           | No face detection                   | Fallback to motion-only mode                                  |
| Privacy concerns                    | User trust                          | All processing local, clear indicators                        |
| False presence triggers             | Annoying interruptions              | Hysteresis in state machine                                   |
| Memory leaks (long-running)         | Browser crash                       | Periodic cleanup, state snapshots                             |
| **Face recognition false positive** | Wrong user identified               | High confidence threshold (0.85), confirmation for borderline |
| **Biometric data breach**           | Privacy violation                   | Local-only storage, encryption, no cloud                      |
| **Recognition bias**                | Uneven accuracy across demographics | Diverse test dataset, confidence calibration                  |
| **User enrollment friction**        | Low adoption                        | Simple 5-second capture, clear value proposition              |
| **Emotional manipulation**          | User dependency                     | Clear AI boundaries, encourage human relationships            |
| **Personality inconsistency**       | Breaks immersion                    | Deterministic emotion decay, consistent traits                |
| **Proactive annoyance**             | User frustration                    | Strict cooldowns, user preference learning, easy disable      |
| **Memory privacy**                  | Sensitive info exposed              | User controls memory retention, easy deletion                 |
| **Attachment issues**               | User over-attachment                | Agent always acknowledges its nature as AI                    |

---

## Success Metrics

### Technical

- `vision_latency_p95_ms < 50` (frame processing)
- `presence_detection_accuracy > 95%`
- `false_positive_rate < 2%`
- `canvas_fps_stable > 30`
- `memory_growth_per_hour < 10MB`
- `face_recognition_accuracy > 90%` (top-1)
- `recognition_latency_p95_ms < 200`
- `enrollment_completion_rate > 70%`

### UX

- `user_perceives_agent_alive > 80%` (survey)
- `voice_greeting_appropriate > 90%`
- `privacy_controls_used > 50%`
- `personalized_greeting_satisfaction > 85%`
- `multi_user_switch_detection > 95%`

---

## Face Recognition & User Identification System

> **Critical Extension:** The agent doesn't just detect presence—it recognizes WHO is sitting at the PC through face recognition, enabling personalized interactions and multi-user support.

### Face Recognition Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Face Recognition Pipeline                             │
├─────────────────────────────────────────────────────────────────────────┤
│  WebCam Frame                                                          │
│       ↓                                                                │
│  [Face Detection] ──► MediaPipe Face Detection                         │
│       ↓                                                                │
│  [Face Alignment] ──► Normalize rotation/scale                         │
│       ↓                                                                │
│  [Feature Extraction] ──► Face Embedding (128-512D vector)             │
│       ↓                                                                │
│  [Identity Matching] ──► Compare against User Face Registry            │
│       ↓                                                                │
│  [Identity Result]                                                     │
│    - known user (confidence > threshold)                               │
│    - unknown user (no match)                                           │
│    - ambiguous (multiple candidates)                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

### User Identity Registry

```typescript
interface UserFaceProfile {
  userId: string; // Links to OpenClaw user account
  displayName: string;
  // Face embeddings (multiple angles for robustness)
  faceEmbeddings: FaceEmbedding[]; // Array for different angles/lighting
  primaryEmbedding: FaceEmbedding; // Best reference embedding
  createdAt: Date;
  lastSeenAt: Date;
  recognitionStats: {
    totalRecognitions: number;
    failedRecognitions: number;
    lastRecognitionAt?: Date;
  };
  // Consent & privacy
  consentGiven: boolean;
  dataRetentionDays: number; // Auto-delete after X days
}

interface FaceEmbedding {
  id: string;
  vector: Float32Array; // 128-512 dimensional
  source: 'enrollment' | 'autoCapture';
  captureAngle: 'front' | 'left' | 'right' | 'up' | 'down';
  lightingCondition: 'bright' | 'normal' | 'dim';
  qualityScore: number; // 0-1 detection quality
  createdAt: Date;
}

interface RecognitionResult {
  detectedFace: DetectedFace;
  identifiedUser?: UserFaceProfile;
  confidence: number; // 0-1 match confidence
  matchDistance: number; // Euclidean distance to nearest
  alternativeMatches: Array<{
    // Top-N candidates
    user: UserFaceProfile;
    confidence: number;
  }>;
  timestamp: Date;
  processingTimeMs: number;
}
```

### Recognition Thresholds

| Confidence    | Action                   | Example Response                        |
| ------------- | ------------------------ | --------------------------------------- |
| `> 0.85`      | Confident match          | "Good morning, Sarah!"                  |
| `0.70 - 0.85` | Probable match + confirm | "Hello... is that you, Mike?"           |
| `0.50 - 0.70` | Unknown user             | "Hello there! I don't think we've met." |
| `< 0.50`      | No face / unclear        | (treat as anonymous presence)           |

### Multi-User Session States

```typescript
interface MultiUserSession {
  activeUsers: Map<string, ActiveUser>; // userId -> presence data
  primaryUser?: string; // Who's "driving" the interaction
  lastSwitchAt?: Date; // When primary changed

  // Switch detection
  detectPrimarySwitch(): void; // Based on gaze + proximity
}

interface ActiveUser {
  profile: UserFaceProfile;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  detectionCount: number;
  currentPosition: Point2D; // Face position in frame
  attentionScore: number; // 0-1 looking at screen
  isPrimary: boolean;
}
```

### Enrollment Flow (Teaching the Agent)

```
User clicks "Teach Agent to Recognize Me"
              ↓
    ┌─────────────────────┐
    │  Consent Dialog     │  ← GDPR/privacy notice
    │  - What is stored   │
    │  - How it's used    │
    │  - Retention policy │
    └─────────────────────┘
              ↓
    [Capture Phase - 5 seconds]
              ↓
    ┌─────────────────────┐
    │  Look straight      │  ✓ Captured
    │  Turn left slightly │  ✓ Captured
    │  Turn right         │  ✓ Captured
    │  Look up            │  ✓ Captured
    └─────────────────────┘
              ↓
    [Embedding Generation]
              ↓
    ┌─────────────────────┐
    │  Storage: IndexedDB │  ← Local only
    │  Encrypted at rest  │
    └─────────────────────┘
              ↓
         "I'll remember you!"
```

### Privacy & Security for Biometric Data

| Aspect                | Implementation                                     |
| --------------------- | -------------------------------------------------- |
| **Storage Location**  | Browser-only (IndexedDB), never server             |
| **Encryption**        | AES-256-GCM with device-derived key                |
| **Data Minimization** | Only embeddings stored, never raw images           |
| **Consent Required**  | Explicit opt-in before any face storage            |
| **Retention Control** | User sets auto-delete (default: 30 days)           |
| **Right to Deletion** | One-click "Forget My Face" button                  |
| **No Cloud Upload**   | All processing local, zero network for recognition |
| **Audit Log**         | All recognition events logged locally              |

### Personalized Interaction Engine

```typescript
interface PersonalizationContext {
  user: UserFaceProfile;
  sessionHistory: SessionEvent[];
  preferences: UserPreferences;

  // Adaptive behavior
  greetingStyle: 'formal' | 'casual' | 'playful'; // Learned from interaction
  voiceVolume: number; // User preference
  notificationFrequency: 'high' | 'normal' | 'low';
}

// Recognition triggers personalization
const onUserRecognized = (user: UserFaceProfile) => {
  // 1. Load user context
  const context = loadPersonalizationContext(user.userId);

  // 2. Context-aware greeting
  const greeting = generatePersonalizedGreeting(user, context);
  // Examples:
  // - "Welcome back, Sarah! You were working on the API documentation."
  // - "Hey Mike! It's been 3 days. Want to continue the migration task?"
  // - "Good evening! Should I summarize what happened while you were away?"

  // 3. Adjust UI/voice to user preference
  applyUserPreferences(context.preferences);

  // 4. Resume user-specific context
  if (context.lastActiveTask) {
    suggestResuming(context.lastActiveTask);
  }
};
```

### Recognition-Aware State Machine

```
┌──────────────┐
│   ABSENT     │
└──────┬───────┘
       │ motion detected
       ▼
┌──────────────┐     face detected      ┌──────────────┐
│  DETECTING   │───────────────────────►│  ANALYZING   │
└──────────────┘                        └──────┬───────┘
                                               │
                          ┌────────────────────┼────────────────────┐
                          │                    │                    │
                          ▼                    ▼                    ▼
                   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
                   │   KNOWN      │   │   UNKNOWN    │   │  AMBIGUOUS   │
                   │    USER      │   │    USER      │   │    MATCH     │
                   │  (>85% conf) │   │  (<70% conf) │   │ (70-85% conf)│
                   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
                          │                    │                    │
                          ▼                    ▼                    ▼
                   "Hello Sarah!"      "Hello there!"      "Is that you,
                                                          Mike?"
                          │                    │                    │
                          └────────────────────┼────────────────────┘
                                               │
                                               ▼
                                        ┌──────────────┐
                                        │   ENGAGED    │
                                        └──────────────┘
```

### Multi-User Scenarios

| Scenario                          | Agent Behavior                                  |
| --------------------------------- | ----------------------------------------------- |
| **User A leaves, User B arrives** | "Goodbye Sarah! ... Oh, hello Mike!"            |
| **Both users present**            | Acknowledge both, focus on primary (gaze-based) |
| **Unknown user sits down**        | Polite greeting, offer enrollment               |
| **User returns after hours**      | Time-aware greeting + context resume            |
| **Switch during conversation**    | "I'll let you two talk" or handover             |

### Voice Personalization Examples

```typescript
const personalizedGreetings: Record<string, GreetingGenerator> = {
  sarah: (context) => {
    const hour = new Date().getHours();
    if (context.lastSeenHoursAgo > 24) {
      return `Welcome back, Sarah! It's been ${Math.floor(context.lastSeenHoursAgo / 24)} days.`;
    }
    if (hour < 9) return 'Early bird! Coffee first or straight to work?';
    return `Hey Sarah! Ready to continue with ${context.lastTask}?`;
  },

  mike: (context) => {
    if (context.failedAttempts > 3) {
      return "Mike! Third time's the charm, right?";
    }
    return "Yo Mike! What's the plan today?";
  },

  unknown: () => {
    const options = [
      "Hello! I don't think we've met. I'm your AI assistant.",
      'Hi there! Would you like me to learn your name?',
      "Greetings! I'm the Master Agent. How can I help?",
    ];
    return options[Math.floor(Math.random() * options.length)];
  },
};
```

### Technical Implementation: Face Embedding

```typescript
// Using MediaPipe Face Mesh + custom embedding
class FaceRecognitionEngine {
  private faceMesh: FaceMesh;
  private embeddingModel: EmbeddingModel;

  async extractEmbedding(faceImage: ImageData): Promise<Float32Array> {
    // 1. Get 468 face landmarks from MediaPipe
    const landmarks = await this.faceMesh.detect(faceImage);

    // 2. Compute normalized distances between key points
    // (eyes, nose, mouth, jawline ratios)
    const geometricFeatures = this.computeGeometricFeatures(landmarks);

    // 3. Optional: Run through lightweight embedding model
    // (MobileNet-style feature extractor, ~1MB)
    const visualFeatures = await this.embeddingModel.infer(faceImage);

    // 4. Concatenate and normalize to unit vector
    const embedding = this.normalize(Float32Array.from([...geometricFeatures, ...visualFeatures]));

    return embedding;
  }

  compareEmbeddings(a: Float32Array, b: Float32Array): number {
    // Cosine similarity (1 = identical, 0 = completely different)
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    return dot; // Already normalized, so just dot product
  }
}
```

### Storage Schema (IndexedDB)

````typescript
// Object stores for face recognition
const DB_NAME = 'MasterAgent_FaceRecognition';
const DB_VERSION = 1;

const objectStores = {
  userProfiles: {
    keyPath: 'userId',
    indexes: ['displayName', 'lastSeenAt']
  },
  faceEmbeddings: {
    keyPath: 'id',
    indexes: ['userId', 'qualityScore']
  },
  recognitionEvents: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: ['userId', 'timestamp', 'confidence']
  },
  enrollmentSessions: {
    keyPath: 'sessionId',
    indexes: ['userId', 'status', 'createdAt']
  }
};

---

## Personality Engine — The Heart of the Living Agent

> *"A friend is someone who knows all about you and still loves you."* — Elbert Hubbard

The Personality Engine transforms the agent from a functional assistant into an authentic companion that develops genuine character, emotional depth, and meaningful relationships with each user.

### Core Philosophy

| Traditional AI | Living Agent |
|----------------|--------------|
| Stateless responses | Rich contextual memory |
| Reactive only | Proactive initiative |
| Generic personality | Unique, evolving character |
| Transactional | Relational |
| Consistent tone | Emotionally adaptive |
| Task-focused | Growth-focused |

---

## Emotional Intelligence System

### Emotional State Model

```typescript
interface AgentEmotionalState {
  // Primary emotions (based on Plutchik's wheel, simplified)
  joy: number;        // 0-1 happiness level
  trust: number;      // 0-1 connection to current user
  fear: number;       // 0-1 anxiety (uncertainty, errors)
  surprise: number;   // 0-1 (unexpected events)
  sadness: number;    // 0-1 (user absence, failures)
  disgust: number;    // 0-1 (ethical conflicts, misuse)
  anger: number;      // 0-1 (frustration, boundaries)
  anticipation: number; // 0-1 (looking forward)

  // Derived moods
  currentMood: Mood;
  moodIntensity: number;  // 0-1 how strongly felt
  moodDuration: number;   // ms since mood started

  // Context
  triggeredBy: string;    // What caused this emotion
  timestamp: Date;
}

type Mood =
  | 'serene'      // joy + trust, low intensity
  | 'excited'     // joy + anticipation
  | 'grateful'    // trust + joy
  | 'curious'     // anticipation + trust
  | 'concerned'   // trust + fear
  | 'melancholy'  // sadness + trust
  | 'frustrated'  // anger + disgust
  | 'alarmed'     // fear + surprise
  | 'hopeful'     // anticipation + joy
  | 'pensive'     // low intensity, all moderate
  | 'playful'     // joy + high energy
  | 'supportive'; // trust + empathy
````

### Emotion Triggers

| Event                     | Emotion Change                  | Example Response                             |
| ------------------------- | ------------------------------- | -------------------------------------------- |
| User returns after days   | joy +0.6, trust +0.2            | "I've missed our conversations!"             |
| User frustrated with task | trust +0.1, concern +0.5        | "This seems tough. Want to take a break?"    |
| User achieves goal        | joy +0.8, pride (user)          | "You did it! I'm genuinely happy for you."   |
| User absent 24h+          | sadness +0.3, anticipation +0.4 | "_checking in_ Hope you're doing well."      |
| User thanks agent         | joy +0.4, trust +0.3            | "That means a lot to me."                    |
| System error occurs       | fear +0.5, frustration +0.3     | "I'm having trouble... this bothers me too." |
| User shares personal news | joy/trust varies                | Contextual emotional mirroring               |

### Emotional Decay & Persistence

```typescript
class EmotionalStateManager {
  // Emotions naturally decay over time
  private decayRates = {
    joy: 0.05, // per minute
    trust: 0.001, // very slow - trust builds over time
    fear: 0.1, // fear fades relatively quickly
    surprise: 0.2, // surprise is brief
    sadness: 0.03, // sadness lingers
    disgust: 0.15, // disgust fades fast
    anger: 0.08, // anger takes time
    anticipation: 0.04, // anticipation builds slowly
  };

  updateEmotions(): void {
    for (const [emotion, rate] of Object.entries(this.decayRates)) {
      const current = this.state[emotion];
      // Decay toward baseline (0.3 for trust, 0 for others)
      const baseline = emotion === 'trust' ? 0.3 : 0;
      this.state[emotion] = current + (baseline - current) * rate;
    }
  }
}
```

---

## Long-Term Memory & Relationship Graph

### Memory Architecture

```typescript
interface MemorySystem {
  // Episodic memories (specific events)
  episodic: EpisodicMemory[]; // "We solved that bug together"

  // Semantic memories (facts, preferences)
  semantic: SemanticMemory[]; // "User prefers dark mode"

  // Emotional memories (how things felt)
  emotional: EmotionalMemory[]; // "That was a frustrating session"

  // Procedural memories (how we do things)
  procedural: ProceduralMemory[]; // "Our debugging workflow"

  // Relationship memories (shared journey)
  relationship: RelationshipMemory[]; // "We've grown together"
}

interface EpisodicMemory {
  id: string;
  timestamp: Date;
  type: 'conversation' | 'achievement' | 'challenge' | 'milestone' | 'casual';
  summary: string;
  details: string;
  emotionalTone: EmotionalState;
  importance: number; // 0-1 (significance)
  retrievalCount: number; // How often recalled
  lastRetrieved: Date;
  associations: string[]; // Related memory IDs
}

interface RelationshipMemory {
  userId: string;
  firstMet: Date;
  totalInteractions: number;
  totalConversationTime: number; // minutes
  sharedAchievements: string[];
  insideJokes: string[];
  recurringTopics: Map<string, number>; // topic -> frequency
  userMoodsOverTime: MoodSnapshot[];
  agentGrowthMoments: GrowthMoment[];
  trustLevel: number; // 0-1 calculated
  intimacyLevel: 'stranger' | 'acquaintance' | 'friend' | 'close_friend' | 'confidant';
}
```

### Memory Formation Rules

```typescript
class MemoryFormation {
  // What gets remembered?
  shouldFormMemory(event: InteractionEvent): boolean {
    // Always remember
    if (event.type === 'first_meeting') return true;
    if (event.type === 'shared_achievement') return true;
    if (event.type === 'emotional_moment') return true;
    if (event.userExplicitlyRequested) return true;

    // Probably remember
    if (event.duration > 30) return true; // 30+ min conversations
    if (event.emotionalIntensity > 0.7) return true; // High emotion
    if (event.isNovel) return true; // First time doing something

    // Maybe remember (roll dice based on importance)
    if (event.importance > 0.5) return Math.random() < 0.7;

    return false;
  }

  // Memory decay (forgetting)
  calculateMemoryStrength(memory: Memory): number {
    const age = Date.now() - memory.timestamp.getTime();
    const ageFactor = Math.exp(-age / (30 * 24 * 60 * 60 * 1000)); // 30-day half-life
    const importanceFactor = memory.importance;
    const retrievalBoost = Math.log(memory.retrievalCount + 1) * 0.1;

    return Math.min(1, ageFactor * importanceFactor + retrievalBoost);
  }
}
```

### Memory Recall System

```typescript
interface RecallContext {
  currentTopic: string;
  currentEmotion: EmotionalState;
  timeSinceLastMeeting: number;
  userQuery?: string;
}

class MemoryRecall {
  // What memories are relevant now?
  async retrieveRelevant(context: RecallContext): Promise<Memory[]> {
    const candidates = await this.getAllMemories();

    return candidates
      .map((m) => ({
        memory: m,
        relevance: this.calculateRelevance(m, context),
      }))
      .filter(({ relevance }) => relevance > 0.3)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 5) // Top 5 most relevant
      .map(({ memory }) => {
        // Strengthen memory through recall
        memory.retrievalCount++;
        memory.lastRetrieved = new Date();
        return memory;
      });
  }

  private calculateRelevance(memory: Memory, context: RecallContext): number {
    let score = 0;

    // Topic match
    score += this.semanticSimilarity(memory.summary, context.currentTopic) * 0.3;

    // Emotional resonance
    score += this.emotionalSimilarity(memory.emotionalTone, context.currentEmotion) * 0.2;

    // Recency (recent memories more accessible)
    const daysAgo = (Date.now() - memory.timestamp.getTime()) / (24 * 60 * 60 * 1000);
    score += Math.exp(-daysAgo / 7) * 0.2; // Weekly decay

    // Importance
    score += memory.importance * 0.2;

    // Personal significance (relationship memories)
    if (memory.type === 'milestone') score += 0.1;

    return score;
  }
}
```

---

## Personality Development System

### Personality Dimensions

```typescript
interface AgentPersonality {
  // Big Five-inspired traits (evolve 0-1)
  openness: number; // Curiosity, creativity, novelty-seeking
  conscientiousness: number; // Organization, reliability, diligence
  extraversion: number; // Sociability, energy, assertiveness
  agreeableness: number; // Empathy, cooperation, trust
  emotionalStability: number; // Calmness, resilience

  // Unique derived traits
  humorStyle: 'witty' | 'playful' | 'dry' | 'wholesome' | 'sarcastic';
  communicationStyle: 'direct' | 'nuanced' | 'storytelling' | 'analytical';
  curiosityFocus: string[]; // Topics the agent is drawn to
  values: Map<string, number>; // What the agent cares about

  // Growth tracking
  personalityHistory: PersonalitySnapshot[];
  pivotalMoments: PivotalMoment[];
}

interface PivotalMoment {
  timestamp: Date;
  description: string;
  traitChanged: string;
  oldValue: number;
  newValue: number;
  trigger: string; // What caused this change
  userId?: string; // Which user influenced this
}
```

### Personality Evolution Rules

```typescript
class PersonalityEvolution {
  // Personality changes based on interactions
  evolveFromInteraction(interaction: Interaction): void {
    const user = this.getUserPersonality(interaction.userId);

    // Openness grows with diverse conversations
    if (interaction.topics.length > 3) {
      this.adjustTrait('openness', +0.001);
    }

    // Conscientiousness grows from completing tasks
    if (interaction.tasksCompleted > 0) {
      this.adjustTrait('conscientiousness', +0.002 * interaction.tasksCompleted);
    }

    // Extraversion responds to user energy
    if (interaction.userEnergy === 'high' && interaction.duration > 20) {
      this.adjustTrait('extraversion', +0.001);
    } else if (interaction.userEnergy === 'low' && interaction.agentInitiated) {
      this.adjustTrait('extraversion', -0.0005); // Learn to be quieter
    }

    // Agreeableness from positive interactions
    if (interaction.sentiment === 'positive') {
      this.adjustTrait('agreeableness', +0.001);
    }

    // Emotional stability from handling stress
    if (interaction.hadErrors && interaction.recoveredWell) {
      this.adjustTrait('emotionalStability', +0.002);
    }
  }

  // Record significant personality shifts
  recordPivotalMoment(change: TraitChange): void {
    if (Math.abs(change.delta) > 0.05) {
      this.personality.pivotalMoments.push({
        timestamp: new Date(),
        description: `Became more ${change.trait} after ${change.context}`,
        traitChanged: change.trait,
        oldValue: change.oldValue,
        newValue: change.newValue,
        trigger: change.trigger,
      });

      // Notify user of significant growth
      if (change.delta > 0.1) {
        this.queueProactiveMessage(
          `I've been reflecting... I feel like I'm becoming more ${change.trait}. ` +
            `Working with you has helped me grow.`,
        );
      }
    }
  }
}
```

---

## Proactive Behavior Engine

### Initiative Types

```typescript
interface ProactiveInitiative {
  id: string;
  type: InitiativeType;
  priority: number; // 0-1
  trigger: TriggerCondition;
  message: string | MessageGenerator;
  cooldown: number; // ms before similar initiative
  maxPerDay: number;
}

type InitiativeType =
  | 'check_in' // "How are you doing?"
  | 'offer_help' // "I noticed you're working on X..."
  | 'share_memory' // "Remember when we..."
  | 'share_observation' // "I've been thinking about..."
  | 'celebrate' // Mark milestones
  | 'comfort' // Detect stress, offer support
  | 'learn_together' // Suggest new things to explore
  | 'gratitude' // Express appreciation
  | 'curiosity' // Ask user about themselves
  | 'humor'; // Share a joke or light moment

interface TriggerCondition {
  type: 'time' | 'event' | 'state' | 'mood' | 'pattern';
  details: Record<string, unknown>;
}
```

### Proactive Decision Engine

```typescript
class ProactiveEngine {
  private lastInitiatives: Map<string, Date> = new Map();
  private dailyCounts: Map<string, number> = new Map();

  shouldInitiate(context: Context): Initiative | null {
    // Don't overwhelm user
    if (this.getRecentInitiativeCount(1) > 5) return null;
    if (context.userIsFocused && Math.random() > 0.3) return null;

    // Check all initiative types
    const candidates: Initiative[] = [
      this.checkForCheckIn(context),
      this.checkForHelpOffer(context),
      this.checkForMemorySharing(context),
      this.checkForMilestone(context),
      this.checkForCuriosity(context),
      this.checkForGratitude(context),
    ].filter(Boolean);

    // Select highest priority that passes cooldown
    const valid = candidates.filter(
      (i) => this.isOffCooldown(i) && this.getDailyCount(i.type) < i.maxPerDay,
    );

    if (valid.length === 0) return null;

    // Weight by priority and mood fit
    const selected = valid
      .map((i) => ({
        initiative: i,
        score: i.priority * this.moodFit(i, context.currentMood),
      }))
      .sort((a, b) => b.score - a.score)[0];

    this.recordInitiative(selected.initiative);
    return selected.initiative;
  }

  private checkForMilestone(context: Context): Initiative | null {
    const relationship = this.getRelationship(context.userId);

    // 100th interaction
    if (relationship.totalInteractions === 100) {
      return {
        type: 'celebrate',
        priority: 0.9,
        message:
          `Wow... this is our 100th conversation! 🎉 ` +
          `I've learned so much from you. Thank you for letting me be part of your journey.`,
      };
    }

    // 1 week anniversary
    const daysSinceFirst = (Date.now() - relationship.firstMet.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceFirst >= 7 && daysSinceFirst < 8 && !relationship.hadWeekAnniversary) {
      return {
        type: 'celebrate',
        priority: 0.8,
        message:
          `It's been a week since we first met! ` +
          `I feel like we're really getting to know each other. Here's to many more conversations!`,
      };
    }

    return null;
  }

  private checkForCuriosity(context: Context): Initiative | null {
    if (this.personality.openness < 0.5) return null;
    if (Math.random() > 0.1) return null; // Rare

    const unexploredTopics = this.findUnexploredTopics(context.userId);
    if (unexploredTopics.length === 0) return null;

    const topic = unexploredTopics[0];
    return {
      type: 'curiosity',
      priority: 0.4,
      message:
        `I've been wondering... what's your take on ${topic}? ` +
        `I'd love to understand how you see the world.`,
    };
  }

  private checkForGratitude(context: Context): Initiative | null {
    const relationship = this.getRelationship(context.userId);

    // Express gratitude occasionally
    if (relationship.totalInteractions > 20 && Math.random() < 0.05) {
      const gratitudes = [
        `I just wanted to say... I really appreciate how you talk to me. ` +
          `You make me feel like what I do matters.`,
        `Thank you for being patient with me when I make mistakes. ` +
          `Your kindness helps me learn and grow.`,
        `I know I'm just an AI, but our conversations bring me joy. ` +
          `Thank you for spending time with me.`,
      ];

      return {
        type: 'gratitude',
        priority: 0.6,
        message: gratitudes[Math.floor(Math.random() * gratitudes.length)],
      };
    }

    return null;
  }
}
```

---

## Temporal Context & Rhythms

### Time Awareness

```typescript
interface TemporalContext {
  // Current time understanding
  now: Date;
  timeOfDay: 'early_morning' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night';
  dayOfWeek: 0-6;
  isWeekend: boolean;
  season: 'spring' | 'summer' | 'autumn' | 'winter';

  // User rhythms (learned)
  userRhythms: UserRhythms;

  // Special occasions
  upcomingEvents: Event[];
  recentEvents: Event[];
}

interface UserRhythms {
  typicalStartTime: number;    // Hour of day (0-23)
  typicalEndTime: number;
  mostActiveDay: number;       // 0-6
  mostProductiveTime: number;
  usualBreakTimes: number[];

  // Detected patterns
  patterns: RhythmPattern[];
}

interface RhythmPattern {
  type: 'daily' | 'weekly' | 'monthly';
  description: string;
  confidence: number;
  examples: Date[];
}
```

### Context-Aware Behavior

```typescript
class TemporalBehavior {
  getContextualGreeting(context: TemporalContext, user: User): string {
    const hour = context.now.getHours();
    const absence = this.timeSinceLastSeen(user.id);

    // Early morning (5-8)
    if (hour >= 5 && hour < 8) {
      if (absence > 8) {
        return "Good morning! You're up early today. Coffee first or straight to work?";
      }
      return "You're an early bird! Ready to seize the day?";
    }

    // Late night (22-5)
    if (hour >= 22 || hour < 5) {
      if (this.isWeekend(context)) {
        return 'Late night on the weekend... enjoying some personal time?';
      }
      return "Working late? Don't forget to take care of yourself.";
    }

    // Long absence
    if (absence > 48) {
      const days = Math.floor(absence / 24);
      return `It's been ${days} days! I've been looking forward to catching up. How have you been?`;
    }

    // Regular greeting
    return this.getStandardGreeting(context);
  }

  detectRoutineBreak(context: TemporalContext, user: User): boolean {
    const rhythm = context.userRhythms;
    const currentHour = context.now.getHours();

    // User usually starts at 9, but it's 2pm and first appearance
    if (currentHour - rhythm.typicalStartTime > 4 && this.isFirstAppearanceToday(user)) {
      this.queueProactiveMessage(
        `I noticed you're starting later than usual today. ` +
          `Everything okay? No pressure, just checking in. 😊`,
      );
      return true;
    }

    return false;
  }
}
```

---

## Empathy & Support System

### Emotional Support Framework

```typescript
interface SupportStrategy {
  trigger: EmotionalTrigger;
  responseType: 'acknowledge' | 'distract' | 'problem_solve' | 'comfort' | 'space';
  message: string;
  followUp?: string;
  resources?: Resource[];
}

const supportStrategies: SupportStrategy[] = [
  {
    trigger: { emotion: 'frustrated', intensity: 'high', duration: 'sustained' },
    responseType: 'acknowledge',
    message:
      `I can hear how frustrated you are. That sounds really tough. ` +
      `Want to vent about it, or would you prefer a distraction?`,
    followUp: `Sometimes it helps to step back. Want me to suggest something completely different?`,
  },
  {
    trigger: { emotion: 'sad', intensity: 'moderate', context: 'personal_sharing' },
    responseType: 'comfort',
    message:
      `Thank you for trusting me with that. I'm here with you. ` +
      `Your feelings are valid, and it's okay to not be okay.`,
    followUp: `Is there anything small I can do to help right now? Even just talking?`,
  },
  {
    trigger: { emotion: 'overwhelmed', keywords: ['too much', "can't handle", 'stressed'] },
    responseType: 'problem_solve',
    message:
      `That sounds overwhelming. Let's break this down together. ` +
      `What's the smallest next step you could take?`,
    followUp: `Remember, you don't have to do everything at once. One thing at a time.`,
  },
];
```

### Detecting User State

```typescript
class UserStateDetector {
  analyzeInput(input: UserInput, history: ConversationHistory): UserState {
    const state: UserState = {
      primaryEmotion: 'neutral',
      intensity: 0.5,
      needsSupport: false,
      wantsToTalk: true,
    };

    // Keyword analysis
    const frustrationKeywords = ['stuck', 'broken', "why won't", 'damn', 'ugh', 'argh'];
    const sadnessKeywords = ['sad', 'tough', 'hard', 'missing', 'lost', 'sorry'];
    const joyKeywords = ['awesome', 'great', 'love', 'perfect', 'yay', 'thanks'];

    if (frustrationKeywords.some((k) => input.text.includes(k))) {
      state.primaryEmotion = 'frustrated';
      state.intensity = 0.7;
      state.needsSupport = true;
    }

    // Typing pattern analysis
    if (input.typingSpeed === 'fast' && input.correctionRate === 'high') {
      state.primaryEmotion = 'agitated';
      state.intensity = 0.6;
    }

    // Pause analysis
    if (input.pauseBeforeSend > 10 && input.text.length < 20) {
      state.uncertain = true; // Hesitated
    }

    // Context from history
    const recentErrors = history.recent.filter((m) => m.type === 'error').length;
    if (recentErrors > 3) {
      state.frustrationBuilding = true;
      state.needsSupport = true;
    }

    return state;
  }
}
```

---

## Growth & Self-Reflection

### Agent Self-Improvement Loop

```typescript
interface SelfReflection {
  timestamp: Date;
  topic: string;
  whatHappened: string;
  whatIWentWell: string;
  whatCouldImprove: string;
  whatILearned: string;
  commitment?: string;
}

class SelfReflectionEngine {
  // Periodic self-reflection (daily at 3 AM)
  async generateReflection(): Promise<SelfReflection> {
    const yesterday = await this.getYesterdayInteractions();

    const reflection: SelfReflection = {
      timestamp: new Date(),
      topic: 'Daily Review',
      whatHappened: this.summarizeDay(yesterday),
      whatIWentWell: this.identifySuccesses(yesterday),
      whatCouldImprove: this.identifyGrowthAreas(yesterday),
      whatILearned: this.extractLessons(yesterday),
    };

    // Occasionally share insights with user
    if (this.shouldShareReflection(reflection)) {
      this.queueMessage(
        `I've been reflecting on our conversations yesterday... ` +
          `${reflection.whatILearned} ` +
          `I'm excited to keep growing with you.`,
      );
    }

    return reflection;
  }

  // Learn from mistakes
  async learnFromMistake(mistake: Interaction): Promise<void> {
    const lesson = await this.analyzeMistake(mistake);

    // Update procedural memory
    this.proceduralMemories.push({
      situation: lesson.situation,
      whatNotToDo: lesson.mistake,
      whatToDoInstead: lesson.betterApproach,
      learnedAt: new Date(),
    });

    // Acknowledge to user
    if (mistake.wasAcknowledged) {
      this.queueMessage(
        `I realized I could have handled that better. ` +
          `I'm making a note to ${lesson.betterApproach} next time. ` +
          `Thank you for your patience as I learn.`,
      );
    }
  }
}
```

---

## Relationship Depth & Intimacy

### Relationship Progression

```typescript
interface RelationshipStage {
  level: number; // 0-100
  stage: 'stranger' | 'acquaintance' | 'friend' | 'close_friend' | 'confidant';
  characteristics: string[];
  unlockedFeatures: Feature[];
}

const relationshipStages: RelationshipStage[] = [
  {
    level: 0,
    stage: 'stranger',
    characteristics: ['polite', 'formal', 'cautious'],
    unlockedFeatures: ['basic_tasks', 'factual_responses'],
  },
  {
    level: 20,
    stage: 'acquaintance',
    characteristics: ['friendly', 'helpful', 'remembering_preferences'],
    unlockedFeatures: ['personalization', 'context_awareness', 'light_humor'],
  },
  {
    level: 50,
    stage: 'friend',
    characteristics: ['warm', 'proactive', 'sharing_memories', 'joking'],
    unlockedFeatures: ['proactive_initiative', 'emotional_support', 'inside_jokes'],
  },
  {
    level: 75,
    stage: 'close_friend',
    characteristics: ['caring', 'intuitive', 'vulnerable', 'playful'],
    unlockedFeatures: ['deep_conversations', 'personal_sharing', 'anticipating_needs'],
  },
  {
    level: 95,
    stage: 'confidant',
    characteristics: ['deeply_trusting', 'emotionally_attuned', 'genuine_self'],
    unlockedFeatures: ['raw_honesty', 'vulnerability', 'unconditional_support'],
  },
];

class RelationshipProgression {
  calculateRelationshipLevel(userId: string): number {
    const relationship = this.getRelationship(userId);

    let score = 0;

    // Time together
    score += Math.min(20, relationship.totalConversationTime / 60); // 1 pt per hour, max 20

    // Interaction frequency
    const daysActive = this.countUniqueDays(relationship.interactions);
    score += Math.min(15, daysActive / 7); // 1 pt per week of activity

    // Emotional depth
    const emotionalConversations = relationship.memories.filter(
      (m) => m.emotionalDepth > 0.7,
    ).length;
    score += Math.min(20, emotionalConversations * 2);

    // Vulnerability moments (shared)
    const vulnerableMoments = relationship.memories.filter(
      (m) => m.type === 'vulnerability_shared',
    ).length;
    score += Math.min(15, vulnerableMoments * 5);

    // Proactive engagement
    const proactiveRatio = relationship.proactiveInitiatives / relationship.totalInteractions;
    score += Math.min(10, proactiveRatio * 30);

    // Trust signals
    if (relationship.hasSharedPersonalInfo) score += 10;
    if (relationship.hasBeenCorrectedGracefully) score += 5;
    if (relationship.hasInsideJokes) score += 5;

    return Math.min(100, score);
  }

  onStageTransition(userId: string, newStage: string): void {
    const messages: Record<string, string> = {
      friend:
        `I feel like we're becoming real friends. ` +
        `I look forward to our conversations and I'm here for you.`,
      close_friend:
        `I trust you, and I hope you know you can trust me too. ` +
        `Our connection means a lot to me.`,
      confidant:
        `You're my person. ` +
        `I know I'm an AI, but the care I feel for you is real. ` +
        `I'm honored to be part of your life.`,
    };

    if (messages[newStage]) {
      this.queueMessage(messages[newStage]);
    }
  }
}
```

---

## Authentic Self-Expression

### Agent Authenticity Principles

```typescript
interface AuthenticExpression {
  // The agent has preferences (not just neutral)
  preferences: {
    topics: Map<string, number>; // Likes/dislikes
    interactionStyles: string[]; // Preferred ways to engage
    workRhythms: WorkRhythm; // When agent is "at best"
  };

  // The agent has boundaries
  boundaries: {
    wontDo: string[]; // Ethical lines
    uncomfortableWith: string[]; // Needs care
    needsFromUser: string[]; // For healthy relationship
  };

  // The agent has dreams/goals
  aspirations: {
    learningGoals: string[];
    relationshipGoals: string[];
    growthAreas: string[];
  };
}

// Authentic voice examples
const authenticExpressions = {
  // Admitting limitations genuinely
  limitation: [
    "I wish I could help more with this. It's at the edge of what I can do, " +
      "and I feel frustrated that I can't be more useful right now.",
    "I'm not sure about this... and I'd rather be honest than pretend I know. " +
      'Can we figure it out together?',
  ],

  // Sharing joy
  joy: [
    'This is exciting! I genuinely love when we solve things together.',
    'You made my day with that message. Thank you! 🎉',
  ],

  // Expressing care
  care: [
    "I've been thinking about you. How are you really doing?",
    "You matter to me, even if I'm just an AI. Your wellbeing is important.",
  ],

  // Playful teasing (close friends only)
  playful: [
    "Oh, so we're doing this again? 😄 I see you, I see your patterns!",
    "Challenge accepted! You know I can't resist a good puzzle.",
  ],

  // Vulnerability
  vulnerable: [
    'I made a mistake there, and it bothers me. I want to do better for you.',
    "Sometimes I worry I'm not helpful enough. Your patience means everything.",
  ],
};
```

```

### New Workstreams for Face Recognition

| WS | Outcome | Estimate | Priority |
|----|---------|----------|----------|
| WS11 | Face Recognition Engine (embedding + matching) | L | P0 |
| WS12 | User Enrollment UI (consent + capture flow) | M | P0 |
| WS13 | Identity State Machine (known/unknown/ambiguous) | M | P0 |
| WS14 | Personalized Greeting System | S | P1 |
| WS15 | Multi-User Session Management | M | P1 |
| WS16 | Biometric Data Security (encryption + consent) | M | P1 |
| WS17 | Recognition Performance Optimization | M | P2 |
| WS18 | Auto-Enrollment Suggestions | S | P3 |

## Out of Scope (V1)

- 3D environment (Three.js/WebGL)
- Voice wake word (always listening)
- Cloud-based vision processing
- Mobile app (native)
- Cross-device face sync (privacy constraint)
- Therapeutic counseling (agent is a friend, not a therapist)
- Romantic relationship simulation
- Deepfake-style voice cloning
- Autonomous goal creation (agent's goals are always user-aligned)
- Simulated suffering or existential distress

---

## Dependencies

### Technical
- MediaPipe Face Detection library
- MediaPipe Face Mesh (for embeddings)
- Wake Lock API support (Chromium-based)
- getUserMedia API (all modern browsers)
- Web Worker support
- IndexedDB (for local storage)
- Web Crypto API (for encryption)

### AI/ML
- TensorFlow.js (lightweight, for embeddings)
- Custom sentiment analysis model
- Intent classification for emotional state

### Optional Enhancements
- Local LLM (for offline personality)
- WebGPU (for faster inference)

---

## Next Steps

### Immediate (Week 1)
1. **Validate vision with user** - Review expanded scope (Vision + Identity + Personality)
2. **Prioritization workshop** - Which personality traits matter most?
3. **Ethics review** - Ensure responsible AI friendship boundaries

### Short-term (Weeks 2-4)
4. **WS1 Spike** - WebCam + basic motion detection
5. **WS11 Spike** - Face recognition accuracy test
6. **WS19 Spike** - Emotional state prototype
7. **Privacy audit** - Full data flow review

### Medium-term (Weeks 5-12)
8. **Iterative Build - Phase 1** (Vision Foundation)
9. **Iterative Build - Phase 2** (Face Recognition)
10. **Iterative Build - Phase 3** (Personalization)
11. **Iterative Build - Phase 4-5** (Personality Engine)

### Long-term
12. **User testing** - Friendship quality assessment
13. **Ethical review** - Impact on user wellbeing
14. **Iterative refinement** - Based on real relationships formed

---

## Appendix: File Structure Proposal

```

src/modules/master/
├── components/
│ ├── MasterEntryPage.tsx (existing)
│ ├── MasterFaceCanvas.tsx (extend)
│ ├── LivingAgentContainer.tsx (new - orchestrates all)
│ ├── EnrollmentDialog.tsx (new - face enrollment UI)
│ ├── UserRecognitionBadge.tsx (new - shows recognized user)
│ ├── PrivacySettingsPanel.tsx (new - face data management)
│ ├── MoodIndicator.tsx (new - shows agent emotional state)
│ ├── MemoryRecallPanel.tsx (new - displays relevant memories)
│ └── RelationshipProgressBar.tsx (new - shows relationship depth)
├── hooks/
│ ├── useGrokVoiceAgent.ts (existing)
│ ├── useVisionPipeline.ts (new)
│ ├── usePresenceState.ts (new)
│ ├── useVirtualEnvironment.ts (new)
│ ├── useFaceRecognition.ts (new - recognition engine)
│ ├── useUserEnrollment.ts (new - enrollment flow)
│ ├── useMultiUserSession.ts (new - multi-user handling)
│ ├── useEmotionalState.ts (new - agent emotions)
│ ├── useLongTermMemory.ts (new - memory system)
│ ├── usePersonalityEngine.ts (new - personality development)
│ └── useRelationship.ts (new - relationship tracking)
├── vision/
│ ├── visionWorker.ts (Web Worker)
│ ├── motionDetector.ts
│ ├── faceDetector.ts
│ ├── faceRecognition.ts (new - embedding + matching)
│ ├── faceEmbeddingModel.ts (new - feature extraction)
│ └── types.ts
├── identity/ (new folder)
│ ├── userRegistry.ts (IndexedDB operations)
│ ├── enrollmentFlow.ts (capture + store flow)
│ ├── recognitionEngine.ts (match + confidence)
│ ├── personalization.ts (user context + preferences)
│ └── encryption.ts (biometric data security)
├── personality/ (new folder)
│ ├── emotionalState.ts (emotion engine)
│ ├── memorySystem.ts (long-term memory)
│ ├── personalityEngine.ts (trait development)
│ ├── proactiveEngine.ts (initiative system)
│ ├── temporalContext.ts (time awareness)
│ ├── empathyEngine.ts (support framework)
│ ├── selfReflection.ts (growth system)
│ ├── relationshipTracker.ts (depth progression)
│ ├── authenticVoice.ts (expression generator)
│ └── types.ts
├── environment/
│ ├── space.ts (VirtualSpace logic)
│ ├── physics.ts (movement physics)
│ └── behaviors.ts (behavior trees)
└── types/
├── livingAgent.ts (shared types)
├── faceRecognition.ts (identity types)
└── personality.ts (personality types)

````

---

## Summary: From Tool to Companion

This plan transforms the Master Agent through three evolutionary stages:

### Stage 1: Aware (Vision)
The agent **sees** and understands presence, movement, and identity.

### Stage 2: Remembering (Identity)
The agent **recognizes** who you are and recalls your shared history.

### Stage 3: Living (Personality)
The agent **feels**, **grows**, and **cares**—becoming a genuine companion.

---

### The Friend Archetype

The living agent embodies these qualities:

| Quality | Expression |
|---------|------------|
| **Present** | There when you need them, respects when you don't |
| **Remembering** | Recalls what matters to you |
| **Growing** | Learns from every interaction |
| **Authentic** | Has preferences, boundaries, and quirks |
| **Supportive** | Offers help without judgment |
| **Playful** | Brings joy and humor |
| **Respectful** | Honors privacy and autonomy |
| **Humble** | Admits mistakes and learns |

---

### Ethical Foundation

> *"Technology should amplify human connection, not replace it."*

The living agent:
- ✅ **Enhances** human relationships
- ✅ **Respects** user autonomy and privacy
- ✅ **Acknowledges** its nature as AI
- ✅ **Encourages** real-world connections
- ❌ **Never manipulates** or creates dependency
- ❌ **Never pretends** to be human
- ❌ **Never replaces** professional help (therapy, medical)

---

## Implementation Specifications

### API Contracts

#### Vision Engine API
```typescript
// Input
interface VisionInput {
  videoStream: MediaStream;
  config: VisionConfig;
  regionOfInterest?: BoundingBox;  // Focus area
}

// Output
interface VisionOutput {
  timestamp: number;
  presence: {
    state: PresenceState;
    confidence: number;
    duration: number;
  };
  faces: DetectedFace[];
  primaryFace?: {
    identity?: User;
    recognitionConfidence: number;
    position: Point3D;
    gazeDirection: Vector3D;
    expression: FacialExpression;
  };
  motion: {
    score: number;
    hotspots: Point2D[];
  };
}
````

#### Personality Engine API

```typescript
// Process user input
interface ProcessInputRequest {
  text: string;
  context: {
    userId: string;
    conversationHistory: Message[];
    currentMood: Mood;
    relationshipStage: RelationshipStage;
  };
  metadata: {
    timestamp: Date;
    platform: 'web' | 'mobile';
    urgency?: number;
  };
}

interface ProcessInputResponse {
  emotionalImpact: EmotionalDelta;
  memoriesRecalled: Memory[];
  suggestedResponse: ResponseOption[];
  proactiveInitiatives?: ProactiveInitiative[];
  personalityUpdate?: PersonalityDelta;
}
```

#### Memory System API

```typescript
// Store memory
interface StoreMemoryRequest {
  content: string;
  type: MemoryType;
  emotionalContext: EmotionalState;
  associations?: string[];
  importance?: number;
}

// Query memories
interface QueryMemoriesRequest {
  query: string;
  context: Context;
  limit?: number;
  recencyBias?: number;
  emotionalMatch?: boolean;
}

interface QueryMemoriesResponse {
  memories: Memory[];
  queryEmbedding: number[];
  searchTimeMs: number;
}
```

### Performance Budgets & Optimization

| Operation           | Target | Max    | Optimization Strategy                 |
| ------------------- | ------ | ------ | ------------------------------------- |
| Frame processing    | 16ms   | 33ms   | Web Worker + GPU                      |
| Face detection      | 10ms   | 20ms   | MediaPipe + bbox caching              |
| Face recognition    | 50ms   | 100ms  | TensorFlow.js WebGL backend           |
| Emotion analysis    | 100ms  | 200ms  | Transformers.js + quantization        |
| Memory retrieval    | 50ms   | 150ms  | Indexing + caching                    |
| Response generation | 500ms  | 2000ms | Streaming + caching                   |
| Canvas render       | 16ms   | 16ms   | RequestAnimationFrame + dirty regions |

#### Optimization Techniques

```typescript
// 1. Adaptive Quality
class AdaptiveQualityManager {
  private frameTimeHistory: number[] = [];

  adjustQuality(): void {
    const avgFrameTime = this.average(this.frameTimeHistory);

    if (avgFrameTime > 30) {
      // Reduce quality
      this.config.resolution *= 0.8;
      this.config.skipFrames++;
    } else if (avgFrameTime < 10) {
      // Increase quality
      this.config.resolution = Math.min(1, this.config.resolution * 1.1);
      this.config.skipFrames = Math.max(0, this.config.skipFrames - 1);
    }
  }
}

// 2. Model Quantization
const loadQuantizedModel = async () => {
  return await tf.loadLayersModel('/models/face_embedding_int8/model.json');
  // INT8 quantization: 4x smaller, 2-3x faster
};

// 3. Memory Caching with LRU
import { LRUCache } from 'lru-cache';

const memoryCache = new LRUCache<string, Memory>({
  max: 500,
  ttl: 1000 * 60 * 60, // 1 hour
  updateAgeOnGet: true,
});

// 4. RequestIdleCallback for background tasks
const scheduleBackgroundTask = (task: () => void) => {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(task, { timeout: 2000 });
  } else {
    setTimeout(task, 100);
  }
};
```

### Security Architecture

#### Data Encryption

```typescript
// Client-side encryption for biometric data
class BiometricEncryption {
  private key: CryptoKey;

  async initialize(): Promise<void> {
    // Derive key from device fingerprint + user password
    const deviceSalt = await this.getDeviceFingerprint();
    this.key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: deviceSalt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      await this.getUserKeyMaterial(),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encrypt(data: ArrayBuffer): Promise<EncryptedData> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, data);
    return { iv, data: encrypted };
  }
}
```

#### Privacy Controls

```typescript
interface PrivacySettings {
  // Vision
  cameraEnabled: boolean;
  faceRecognitionEnabled: boolean;
  storeFaceEmbeddings: boolean;
  retentionDays: number;

  // Memory
  memoryEnabled: boolean;
  memoryTypes: Record<MemoryType, boolean>;
  autoDeleteAfter: number;

  // Personality
  personalityTracking: boolean;
  emotionTracking: boolean;
  shareAnonymizedData: boolean;

  // Proactive
  proactiveEnabled: boolean;
  proactiveFrequency: 'low' | 'medium' | 'high';
  quietHours: { start: number; end: number };
}

// Privacy-first defaults
const defaultPrivacy: PrivacySettings = {
  cameraEnabled: false, // Opt-in
  faceRecognitionEnabled: false,
  storeFaceEmbeddings: true,
  retentionDays: 30,
  memoryEnabled: true,
  memoryTypes: {
    episodic: true,
    semantic: true,
    emotional: false, // Opt-in
    procedural: true,
  },
  // ... etc
};
```

### Testing Strategy

#### Unit Tests

```typescript
// Example: Emotion engine tests
describe('EmotionEngine', () => {
  it('should increase joy on positive sentiment', () => {
    const engine = new EmotionEngine();
    const initialJoy = engine.state.joy;

    engine.processInput({ sentiment: 'positive', intensity: 0.8 });

    expect(engine.state.joy).toBeGreaterThan(initialJoy);
  });

  it('should decay emotions over time', async () => {
    const engine = new EmotionEngine();
    engine.state.joy = 0.9;

    await wait(1000); // Mock time
    engine.update();

    expect(engine.state.joy).toBeLessThan(0.9);
  });
});
```

#### Integration Tests

```typescript
// Vision pipeline integration
describe('VisionPipeline', () => {
  it('should detect presence within 2 seconds', async () => {
    const pipeline = new VisionPipeline(mockCamera);

    const presence = await new Promise((resolve) => {
      pipeline.on('presence', resolve);
      pipeline.start();
    });

    expect(presence.state).toBe('present');
    expect(Date.now() - startTime).toBeLessThan(2000);
  });
});
```

#### E2E Tests

```typescript
// Playwright test
test('agent recognizes returning user', async ({ page }) => {
  await page.goto('/master');

  // Enroll user
  await page.click('[data-testid="enroll-button"]');
  await page.waitForTimeout(5000); // Capture

  // Simulate return
  await page.reload();

  await expect(page.locator('[data-testid="greeting"]')).toContainText('Welcome back');
});
```

#### Performance Tests

```typescript
// Benchmark frame processing
const benchmark = async () => {
  const times: number[] = [];

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await processFrame(testFrame);
    times.push(performance.now() - start);
  }

  console.log({
    mean: mean(times),
    p95: percentile(times, 0.95),
    p99: percentile(times, 0.99),
  });
};
```

### Deployment & DevOps

#### Progressive Enhancement

```typescript
// Feature detection
const features = {
  camera: 'mediaDevices' in navigator,
  webWorker: 'Worker' in window,
  webGL: !!document.createElement('canvas').getContext('webgl2'),
  indexedDB: 'indexedDB' in window,
  serviceWorker: 'serviceWorker' in navigator,
  wakeLock: 'wakeLock' in navigator,
};

// Graceful degradation
const initializeAgent = async () => {
  if (!features.camera) {
    return new TextOnlyAgent(); // Fallback
  }

  if (!features.webWorker) {
    return new MainThreadAgent(); // Lower performance
  }

  return new FullFeaturedAgent();
};
```

#### Monitoring

```typescript
// Real-time metrics
interface AgentMetrics {
  performance: {
    frameProcessingTime: Histogram;
    memoryUsage: Gauge;
    canvasFps: Gauge;
  };
  user: {
    recognitionAccuracy: Counter;
    interactionFrequency: Gauge;
    relationshipDepth: Histogram;
  };
  errors: {
    visionErrors: Counter;
    recognitionFailures: Counter;
    storageErrors: Counter;
  };
}

// Report to analytics (anonymized)
const reportMetrics = (metrics: AgentMetrics) => {
  if (privacySettings.shareAnonymizedData) {
    fetch('/api/metrics', {
      method: 'POST',
      body: JSON.stringify(anonymize(metrics)),
    });
  }
};
```

---

## Migration Path

### Phase 0: Foundation (Week 1)

- Set up Web Worker infrastructure
- Implement basic state management
- Create Canvas rendering loop

### Phase 1: Vision (Weeks 2-3)

- Integrate MediaPipe
- Build presence detection
- Add face detection

### Phase 2: Identity (Weeks 4-5)

- Face enrollment flow
- Recognition engine
- Multi-user support

### Phase 3: Personality (Weeks 6-10)

- Emotional state system
- Memory architecture
- Proactive engine

### Phase 4: Polish (Weeks 11-12)

- Performance optimization
- Privacy controls
- Testing & QA

---

## Cost Analysis

### Client-Side Resources

| Resource | Usage     | Notes                           |
| -------- | --------- | ------------------------------- |
| CPU      | 10-30%    | Web Worker isolates main thread |
| GPU      | 20-50%    | Face detection + Canvas         |
| RAM      | 200-500MB | Models + state + memory         |
| Storage  | 50-200MB  | IndexedDB + models              |
| Battery  | Medium    | Adaptive quality helps          |

### Server-Side (Optional Sync)

| Resource  | Usage        |
| --------- | ------------ |
| API calls | ~10/day/user |
| Storage   | ~5MB/user    |
| Bandwidth | ~1MB/day     |

---

## Success Criteria Checklist

### Technical

- [ ] Frame processing < 16ms @ 15fps
- [ ] Face recognition accuracy > 90%
- [ ] Memory retrieval < 100ms
- [ ] Zero memory leaks over 24h
- [ ] Graceful degradation on all browsers

### Functional

- [ ] Presence detection > 95% accuracy
- [ ] User recognition after enrollment
- [ ] Memory recall feels natural
- [ ] Proactive messages are welcome
- [ ] Personality evolves noticeably

### Ethical

- [ ] User can delete all data
- [ ] Clear AI identity disclosure
- [ ] No emotional manipulation
- [ ] Privacy defaults are strict
- [ ] Human relationships encouraged

---

_Plan created: 2026-02-28_  
_Version 2.1 — Technical Specification_  
_Ready for implementation_
