import React, { useEffect, useRef, useState } from 'react';

interface LiveCanvasProps {
  onClose: () => void;
  isVisionEnabled?: boolean;
}

export const LiveCanvas: React.FC<LiveCanvasProps> = ({ onClose, isVisionEnabled = false }) => {
  const [visionMode, setVisionMode] = useState(false);
  const [streamHealth, setStreamHealth] = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let healthTimer: ReturnType<typeof setInterval> | null = null;

    const startStream = async () => {
      if (!isVisionEnabled) {
        setStreamHealth(0);
        setStreamError(null);
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setStreamError(null);
        setStreamHealth(100);

        healthTimer = setInterval(() => {
          const track = stream.getVideoTracks()[0];
          if (!track || track.readyState !== 'live' || track.muted) {
            setStreamHealth(0);
            return;
          }
          setStreamHealth(100);
        }, 1500);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to access camera.';
        setStreamError(message);
        setStreamHealth(0);
      }
    };

    startStream();

    return () => {
      if (healthTimer) clearInterval(healthTimer);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, [isVisionEnabled]);

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-[500px] transform flex-col border-l border-indigo-500/20 border-zinc-800 bg-[#0c0c0c] shadow-[0_0_50px_rgba(0,0,0,0.5)] transition-transform duration-500 ease-out">
      <div className="flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-6 backdrop-blur-md">
        <div className="flex items-center space-x-3">
          <div className="relative">
            <div
              className={`h-2.5 w-2.5 rounded-full ${isVisionEnabled ? 'animate-pulse bg-rose-500' : 'bg-zinc-700'}`}
            />
          </div>
          <div>
            <h3 className="text-[11px] font-black tracking-[0.2em] text-white uppercase">
              Vision_Relay_Alpha
            </h3>
            <div className="flex items-center space-x-2">
              <span className="font-mono text-[8px] text-zinc-500">
                Signal: {isVisionEnabled ? streamHealth.toFixed(1) : '0.0'}%
              </span>
              <span className="text-zinc-800">|</span>
              <span
                className={`font-mono text-[8px] uppercase ${isVisionEnabled ? 'text-emerald-500' : 'text-rose-500'}`}
              >
                {isVisionEnabled ? 'Secure_P2P' : 'Skill_Required: Live Vision'}
              </span>
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 transition-all hover:text-white"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M6 18L18 6M6 6l12 12" strokeWidth="2" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-black">
        {!isVisionEnabled ? (
          <div className="flex h-full flex-col items-center justify-center space-y-6 p-12 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900 text-3xl grayscale">
              👁️
            </div>
            <div className="space-y-2">
              <h4 className="font-bold text-white">Vision Component Locked</h4>
              <p className="text-xs leading-relaxed text-zinc-500">
                Install the <span className="font-mono text-indigo-400">Live Vision</span> skill in
                the Skill Registry to activate real-time telemetry and object detection.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6 p-6">
            <div className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
              <div className="relative aspect-video overflow-hidden bg-black">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`h-full w-full object-cover ${visionMode ? 'brightness-50 grayscale' : ''}`}
                />
                {visionMode && (
                  <div className="absolute inset-0 border-2 border-indigo-500/20">
                    <div className="absolute top-10 left-10 h-20 w-20 border border-emerald-500 bg-emerald-500/10" />
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between bg-zinc-950 p-4">
                <span className="font-mono text-[10px] text-zinc-500 uppercase">
                  Telemetry_Active
                </span>
                <button
                  onClick={() => setVisionMode(!visionMode)}
                  className="rounded bg-indigo-600 px-3 py-1 text-[9px] font-black text-white uppercase"
                >
                  {visionMode ? 'Vision: ON' : 'Vision: OFF'}
                </button>
              </div>
            </div>
            {streamError && (
              <div className="rounded-xl border border-rose-900/40 bg-rose-950/30 p-3 text-xs text-rose-400">
                Camera stream error: {streamError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
