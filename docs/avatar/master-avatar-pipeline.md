# Master Avatar Pipeline

## Files

- Source marker: `assets/avatar/master-avatar.blend`
- Source GLB copy: `assets/avatar/master-avatar-source.glb`
- Runtime GLB: `public/models/master-avatar-rigged.glb`
- Manifest: `public/models/master-avatar-rigged.manifest.json`

## Required Technical Contract

The exported GLB must contain at least:

- Mixamo-compatible core skeleton (`Armature`, `Hips`, `Spine`, `Head`, limbs)
- Oculus viseme blendshapes:
  - `viseme_aa`, `viseme_E`, `viseme_I`, `viseme_O`, `viseme_U`
  - `viseme_PP`, `viseme_SS`, `viseme_TH`, `viseme_DD`, `viseme_FF`
  - `viseme_kk`, `viseme_nn`, `viseme_RR`, `viseme_CH`, `viseme_sil`
- ARKit-near expression blendshapes (minimum expected):
  - `jawOpen`, `eyeBlinkLeft`, `eyeBlinkRight`

## Validation

Run:

```bash
npm run avatar:validate
```

Validation checks:

1. Manifest exists and contains required arrays.
2. Runtime GLB, source GLB and blend source path exist.
3. Required bone and blendshape names are detectable in the runtime GLB binary.

## HeadAudio Runtime Asset Sync

Run:

```bash
npm run avatar:sync-headaudio
```

This copies from installed `@met4citizen/headaudio` package:

- `dist/headworklet.min.mjs` -> `public/vendor/headaudio/headworklet.mjs`
- `dist/model-en-mixed.bin` -> `public/vendor/headaudio/model-en-mixed.bin`

The sync command is also executed on `postinstall`.
