'use client';

import { MasterFaceThreeView } from './master-face-three/MasterFaceThreeView';
import { useMasterFaceThreeRuntime } from './master-face-three/useMasterFaceThreeRuntime';
import type { FaceState, MasterFaceCanvasThreeProps } from './master-face-three/types';

export type { FaceState };

export default function MasterFaceCanvasThree(props: MasterFaceCanvasThreeProps) {
  const width = props.width ?? 400;
  const height = props.height ?? 520;
  const runtime = useMasterFaceThreeRuntime({ ...props, width, height });

  return (
    <MasterFaceThreeView
      containerRef={runtime.containerRef}
      width={width}
      height={height}
      isLoaded={runtime.isLoaded}
      loadError={runtime.loadError}
      onRetry={runtime.retry}
    />
  );
}
