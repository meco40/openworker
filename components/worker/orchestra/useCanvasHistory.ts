'use client';

import { useCallback, useRef } from 'react';
import type { Node, Edge } from '@xyflow/react';

export interface CanvasSnapshot {
  nodes: Node[];
  edges: Edge[];
}

const MAX_HISTORY = 50;

/**
 * Undo/Redo hook for the Orchestra canvas.
 * Call `pushSnapshot` on discrete events (drag-stop, connect, delete, drop).
 * Ctrl+Z / Ctrl+Shift+Z are handled by the keyboard listener in OrchestraCanvas.
 */
export function useCanvasHistory(applySnapshot: (snapshot: CanvasSnapshot) => void) {
  const pastRef = useRef<CanvasSnapshot[]>([]);
  const futureRef = useRef<CanvasSnapshot[]>([]);

  const pushSnapshot = useCallback((snapshot: CanvasSnapshot) => {
    pastRef.current = [
      ...pastRef.current.slice(-(MAX_HISTORY - 1)),
      { nodes: structuredClone(snapshot.nodes), edges: structuredClone(snapshot.edges) },
    ];
    futureRef.current = [];
  }, []);

  const undo = useCallback(
    (currentSnapshot: CanvasSnapshot) => {
      if (pastRef.current.length === 0) return;
      const previous = pastRef.current[pastRef.current.length - 1]!;
      pastRef.current = pastRef.current.slice(0, -1);
      futureRef.current = [
        ...futureRef.current,
        {
          nodes: structuredClone(currentSnapshot.nodes),
          edges: structuredClone(currentSnapshot.edges),
        },
      ];
      applySnapshot(previous);
    },
    [applySnapshot],
  );

  const redo = useCallback(
    (currentSnapshot: CanvasSnapshot) => {
      if (futureRef.current.length === 0) return;
      const next = futureRef.current[futureRef.current.length - 1]!;
      futureRef.current = futureRef.current.slice(0, -1);
      pastRef.current = [
        ...pastRef.current,
        {
          nodes: structuredClone(currentSnapshot.nodes),
          edges: structuredClone(currentSnapshot.edges),
        },
      ];
      applySnapshot(next);
    },
    [applySnapshot],
  );

  const canUndo = useCallback(() => pastRef.current.length > 0, []);
  const canRedo = useCallback(() => futureRef.current.length > 0, []);

  return { pushSnapshot, undo, redo, canUndo, canRedo };
}
