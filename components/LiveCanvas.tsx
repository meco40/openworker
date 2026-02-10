
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
    <div className="fixed inset-y-0 right-0 w-[500px] bg-[#0c0c0c] border-l border-zinc-800 shadow-[0_0_50px_rgba(0,0,0,0.5)] z-50 flex flex-col transform transition-transform duration-500 ease-out border-indigo-500/20">
      
      <div className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-950/50 backdrop-blur-md">
        <div className="flex items-center space-x-3">
          <div className="relative">
            <div className={`w-2.5 h-2.5 rounded-full ${isVisionEnabled ? 'bg-rose-500 animate-pulse' : 'bg-zinc-700'}`} />
          </div>
          <div>
            <h3 className="text-[11px] font-black text-white uppercase tracking-[0.2em]">Vision_Relay_Alpha</h3>
            <div className="flex items-center space-x-2">
               <span className="text-[8px] font-mono text-zinc-500">Signal: {isVisionEnabled ? streamHealth.toFixed(1) : '0.0'}%</span>
               <span className="text-zinc-800">|</span>
               <span className={`text-[8px] font-mono uppercase ${isVisionEnabled ? 'text-emerald-500' : 'text-rose-500'}`}>
                 {isVisionEnabled ? 'Secure_P2P' : 'Skill_Required: Live Vision'}
               </span>
            </div>
          </div>
        </div>
        <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-white transition-all">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12" strokeWidth="2" /></svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-black">
        {!isVisionEnabled ? (
          <div className="h-full flex flex-col items-center justify-center p-12 text-center space-y-6">
             <div className="w-20 h-20 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-3xl grayscale">👁️</div>
             <div className="space-y-2">
               <h4 className="text-white font-bold">Vision Component Locked</h4>
               <p className="text-xs text-zinc-500 leading-relaxed">Install the <span className="text-indigo-400 font-mono">Live Vision</span> skill in the Skill Registry to activate real-time telemetry and object detection.</p>
             </div>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            <div className="relative group bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl">
              <div className="aspect-video relative overflow-hidden bg-black">
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`w-full h-full object-cover ${visionMode ? 'grayscale brightness-50' : ''}`}
                />
                {visionMode && (
                  <div className="absolute inset-0 border-2 border-indigo-500/20">
                    <div className="absolute top-10 left-10 w-20 h-20 border border-emerald-500 bg-emerald-500/10" />
                  </div>
                )}
              </div>
              <div className="p-4 bg-zinc-950 flex items-center justify-between">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Telemetry_Active</span>
                <button 
                  onClick={() => setVisionMode(!visionMode)}
                  className="px-3 py-1 bg-indigo-600 text-white rounded text-[9px] font-black uppercase"
                >
                  {visionMode ? 'Vision: ON' : 'Vision: OFF'}
                </button>
              </div>
            </div>
            {streamError && (
              <div className="text-xs text-rose-400 bg-rose-950/30 border border-rose-900/40 rounded-xl p-3">
                Camera stream error: {streamError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
