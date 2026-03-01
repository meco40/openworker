# Master TalkingHead Big-Bang Implementation

Date: 2026-03-01

## Scope

Complete replacement of the previous `MasterFaceCanvasThree` custom avatar engine with:

- `@met4citizen/talkinghead` (`avatarOnly` mode)
- `@met4citizen/headaudio` for audio-driven viseme updates
- Existing Grok Realtime voice pipeline as audio source

No visible fallback to legacy 2D/old 3D engine is retained.

## Implemented Changes

1. Runtime dependencies added:

- `@met4citizen/talkinghead@1.7.0`
- `@met4citizen/headaudio@0.1.0`

2. Voice hook upgrade:

- `useGrokVoiceAgent` now emits structured output-audio stream events
- API adds `subscribeOutputAudio(listener) => unsubscribe`
- `replay()` re-broadcasts the latest audio event sequence

3. Canvas engine migration:

- `MasterFaceCanvasThree` now initializes TalkingHead in `avatarOnly` mode
- Existing camera + pointer drag + wheel zoom interactions preserved
- `outputAudioStream` prop consumed via TalkingHead `streamStart/streamAudio/streamNotifyEnd`
- 3D-only Retry overlay preserved

4. Avatar asset + validation:

- `public/models/master-avatar-rigged.glb`
- `public/models/master-avatar-rigged.manifest.json`
- `scripts/avatar/validate-master-avatar.mjs`

5. HeadAudio runtime assets:

- `public/vendor/headaudio/headworklet.mjs`
- `public/vendor/headaudio/model-en-mixed.bin`
- Sync script: `scripts/avatar/sync-headaudio-assets.mjs`

## Scripts

- `npm run avatar:sync-headaudio`
- `npm run avatar:validate`
- `postinstall` now runs `avatar:sync-headaudio`

## Notes

- `assets/avatar/master-avatar.blend` is currently a placeholder marker file and must be replaced by a real Blender source file for production art pipeline continuity.
