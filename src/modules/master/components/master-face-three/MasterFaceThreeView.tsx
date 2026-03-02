'use client';

import type { RefObject } from 'react';

interface MasterFaceThreeViewProps {
  containerRef: RefObject<HTMLDivElement | null>;
  width: number;
  height: number;
  isLoaded: boolean;
  loadError: string | null;
  onRetry: () => void;
}

export function MasterFaceThreeView({
  containerRef,
  width,
  height,
  isLoaded,
  loadError,
  onRetry,
}: MasterFaceThreeViewProps) {
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
      aria-label="AI avatar 3D visualisation"
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
            onClick={onRetry}
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
